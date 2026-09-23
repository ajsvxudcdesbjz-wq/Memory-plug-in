/**
 * dsh-memory — persistent, low-token memory for DeepSeek Harness.
 *
 * Three ideas keep this cheap enough to leave on all day:
 *
 * 1. One always-fresh digest. A single prompt section (order 8500) carries the
 *    durable facts, so the model never has to search conversation history
 *    again. It is hard-capped in characters (default 1050) and rendered from
 *    memory, so it costs no I/O per model step.
 * 2. One small Tool. `memory` exposes save / read / list / forget / export
 *    through a single action switch instead of five tool schemas, and returns
 *    full text only when the model actually asks for it.
 * 3. Free capture of compaction summaries. Compaction already spends tokens
 *    producing a summary; this plugin copies that summary into memory instead
 *    of paying for a second summarization pass, so a task survives even when
 *    the transcript no longer does.
 *
 * Storage is a single JSON document under `$DSH_HOME/dsh-memory`:
 * `{ "v": 1, "scopes": { "global": {...}, "project:<cwd>": {...} } }`
 *
 * @module dsh-memory
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-memory'

/** Registries this plugin contributes to. */
export const inject = ['tools', 'systemPrompt']

/** Schemastery validation for {@link Config}; every field is optional. */
export const Config = z.object({
  storeDir: z.string(),
  digestChars: z.number(),
  maxEntries: z.number(),
  captureCompaction: z.boolean(),
  injectDigest: z.boolean(),
})

/** Prompt-section name; a deployment can shadow it with a scoped section. */
const SECTION = 'memory:persistent'
/** Placed after the tool-instruction sections and before the deliverable block. */
const SECTION_ORDER = 8500
/** Scope key holding cross-project facts. */
const GLOBAL_SCOPE = 'global'
/** Default injected digest budget, in characters (roughly 300 CJK tokens). */
const DEFAULT_DIGEST_CHARS = 1050
/** Default per-scope entry ceiling before the oldest unpinned entries are dropped. */
const DEFAULT_MAX_ENTRIES = 240
/** Per-entry stored-text ceiling, in characters. */
const MAX_ENTRY_CHARS = 4000
/** Per-entry ceiling for a captured compaction summary, in characters. */
const MAX_DIGEST_ENTRY_CHARS = 6000

const HEAD =
  '## Memory (persistent)\n' +
  'Durable facts, user preferences, decisions and task state recorded earlier. ' +
  'Trust them instead of re-deriving them; maintain them with the `memory` tool.'

const STATE = {
  /** Whole store document, `{ v, scopes }`. */
  store: { v: 1, scopes: {} },
  /** Serialises writes so two concurrent tool calls cannot interleave. */
  queue: Promise.resolve(),
  /** Absolute path of the store document. */
  file: '',
  /** Project scope key backing the injected digest, or null before first contact. */
  activeProject: null,
  /** Resolved options. */
  digestChars: DEFAULT_DIGEST_CHARS,
  maxEntries: DEFAULT_MAX_ENTRIES,
  captureCompaction: true,
  injectDigest: true,
}

/** @returns {string} a short error string that is safe to show a model. */
function messageOf(error) {
  return error && error.message ? String(error.message) : String(error)
}

/** @returns {number} current epoch milliseconds. */
function nowMs() {
  return Date.now()
}

/** Clamp `value` to `limit` characters with a single-character ellipsis. */
function clip(value, limit) {
  const text = String(value)
  return text.length <= limit ? text : text.slice(0, limit - 1) + '…'
}

/** First non-blank line of `value`, clamped to `limit` characters. */
function firstLine(value, limit) {
  const parts = String(value).split('\n')
  for (const part of parts) {
    const line = part.trim()
    if (line.length > 0) return clip(line, limit)
  }
  return ''
}

/** Newest-updated first. */
function byUpdated(a, b) {
  return (b.upd || 0) - (a.upd || 0)
}

/** Fetch (creating if needed) one scope record. */
function scopeOf(key) {
  let scope = STATE.store.scopes[key]
  if (scope === null || scope === undefined || typeof scope !== 'object') {
    scope = { seq: 0, entries: [] }
    STATE.store.scopes[key] = scope
  }
  if (!Array.isArray(scope.entries)) scope.entries = []
  if (typeof scope.seq !== 'number') scope.seq = scope.entries.length
  return scope
}

/** Entries of one scope, always an array. */
function entriesOf(key) {
  const scope = STATE.store.scopes[key]
  return scope && Array.isArray(scope.entries) ? scope.entries : []
}

/** Latest update timestamp of one scope, for the fresh-process fallback. */
function scopeUpdated(key) {
  let newest = 0
  for (const entry of entriesOf(key)) newest = Math.max(newest, entry.upd || 0)
  return newest
}

/** Project scope key for one working directory. */
function projectKeyOf(cwd) {
  return cwd ? 'project:' + cwd : null
}

/** Short human label for a scope key. */
function labelOf(key) {
  if (key === GLOBAL_SCOPE) return 'global'
  const raw = key.slice('project:'.length)
  const parts = raw.split(/[\\/]+/).filter((part) => part.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : raw
}

/**
 * Read the working directory from a live Agent without touching Host objects
 * beyond the two scalar fields involved.
 */
function cwdOfAgent(agent) {
  try {
    const header = agent && agent.session && agent.session.header
    if (header && typeof header.cwd === 'string' && header.cwd.length > 0) return header.cwd
  } catch {
    /* a partially constructed agent is simply not usable as a scope source */
  }
  try {
    return typeof process !== 'undefined' && process.cwd ? process.cwd() : undefined
  } catch {
    return undefined
  }
}

/** Read the working directory from a Session's header, or undefined. */
function cwdOfSession(session) {
  try {
    const header = session && session.header
    if (header && typeof header.cwd === 'string' && header.cwd.length > 0) return header.cwd
  } catch {
    /* see cwdOfAgent */
  }
  return undefined
}

/** Scopes the injected digest draws from, most specific first. */
function digestScopes() {
  const keys = []
  if (STATE.activeProject && STATE.store.scopes[STATE.activeProject]) keys.push(STATE.activeProject)
  if (STATE.store.scopes[GLOBAL_SCOPE]) keys.push(GLOBAL_SCOPE)
  if (keys.length === 0) {
    const all = Object.keys(STATE.store.scopes).filter((key) => entriesOf(key).length > 0)
    if (all.length > 0) keys.push(all.sort((a, b) => scopeUpdated(b) - scopeUpdated(a))[0])
  }
  return keys
}

/** One digest line for an entry. */
function entryLine(entry, pinned, withScope, key) {
  const tag = withScope ? (key === GLOBAL_SCOPE ? '■ ' : '· ') : ''
  return (
    '- ' +
    tag +
    (pinned ? 'pinned ' : '') +
    '[' +
    entry.id +
    '|' +
    entry.kind +
    '] ' +
    firstLine(entry.text, pinned ? 140 : 95)
  )
}

/**
 * Render the prompt section. Pure and allocation-only: it runs on every prompt
 * assembly and therefore never touches the filesystem.
 */
function digest() {
  const keys = digestScopes()
  if (keys.length === 0) {
    return (
      HEAD +
      '\n- (empty. Record durable preferences, decisions and the current task with memory action=save.)'
    )
  }
  const multi = keys.length > 1
  let used = HEAD.length + 1
  const lines = []
  let shown = 0

  const push = (entry, pinned, key) => {
    const line = entryLine(entry, pinned, multi, key)
    if (used + line.length + 1 > STATE.digestChars) return false
    lines.push(line)
    used += line.length + 1
    shown += 1
    return true
  }

  let total = 0
  for (const key of keys) {
    const entries = entriesOf(key)
    total += entries.length
    const pinned = entries.filter((entry) => entry.pinned === true).sort(byUpdated)
    const rest = entries.filter((entry) => entry.pinned !== true).sort(byUpdated)
    for (const entry of pinned) if (!push(entry, true, key)) break
    for (const entry of rest) if (!push(entry, false, key)) break
  }

  let out = HEAD + '\n' + lines.join('\n')
  const hidden = total - shown
  if (hidden > 0) out += '\n(+' + hidden + ' more; memory action=list)'
  return out
}

/** Drop the oldest unpinned entries once a scope exceeds its ceiling. */
function prune(scope) {
  if (scope.entries.length <= STATE.maxEntries) return
  const pinned = scope.entries.filter((entry) => entry.pinned === true)
  const rest = scope.entries.filter((entry) => entry.pinned !== true).sort(byUpdated)
  scope.entries = pinned.concat(rest.slice(0, Math.max(0, STATE.maxEntries - pinned.length)))
}

/** Append or replace one entry; returns it. */
function putEntry(scopeKey, text, options) {
  const scope = scopeOf(scopeKey)
  const wanted = options && typeof options.id === 'string' ? options.id : ''
  let entry = wanted.length > 0 ? scope.entries.find((item) => item.id === wanted) : undefined
  const kind = options && typeof options.kind === 'string' ? options.kind : entry ? entry.kind : 'note'
  const pinned =
    options && typeof options.pinned === 'boolean' ? options.pinned : entry ? entry.pinned === true : kind === 'task'
  const body = clip(text, MAX_ENTRY_CHARS)
  if (entry) {
    entry.text = body
    entry.kind = kind
    entry.pinned = pinned
    entry.upd = nowMs()
  } else {
    scope.seq += 1
    entry = { id: 'm' + scope.seq, kind, text: body, pinned, ts: nowMs(), upd: nowMs() }
    scope.entries.push(entry)
  }
  prune(scope)
  return entry
}

/** Load the store document from disk; a missing or broken file yields an empty store. */
function load() {
  try {
    const parsed = JSON.parse(readFileSync(STATE.file, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.scopes && typeof parsed.scopes === 'object') {
      STATE.store = { v: 1, scopes: parsed.scopes }
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') console.error('dsh-memory: unreadable store: ' + messageOf(error))
  }
}

/** Persist the store document atomically, serialised behind a single queue. */
function persist() {
  const run = STATE.queue.then(() => {
    mkdirSync(dirname(STATE.file), { recursive: true })
    const temporary = STATE.file + '.tmp'
    writeFileSync(temporary, JSON.stringify({ v: 1, scopes: STATE.store.scopes }), 'utf8')
    renameSync(temporary, STATE.file)
  })
  STATE.queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Render every scope as one Markdown snapshot. */
function toMarkdown() {
  const out = ['# Memory export', '', 'Exported: ' + new Date(nowMs()).toISOString(), '']
  for (const key of Object.keys(STATE.store.scopes).sort()) {
    const entries = entriesOf(key).slice().sort(byUpdated)
    if (entries.length === 0) continue
    out.push('## ' + key)
    for (const entry of entries) {
      const flags = entry.kind + (entry.pinned ? ', pinned' : '')
      out.push('- **' + entry.id + '** (' + flags + '): ' + String(entry.text).split('\n').join(' '))
    }
    out.push('')
  }
  return out.join('\n')
}

/**
 * Mount the memory Tools, the injected digest, and free compaction capture.
 * @param ctx - plugin context carrying the tool and prompt registries.
 * @param config - optional deployment overrides for storage and budget.
 */
export function apply(ctx, config) {
  const options = config || {}
  STATE.digestChars = Number.isFinite(options.digestChars) ? Math.max(200, options.digestChars) : DEFAULT_DIGEST_CHARS
  STATE.maxEntries = Number.isFinite(options.maxEntries) ? Math.max(16, options.maxEntries) : DEFAULT_MAX_ENTRIES
  STATE.captureCompaction = options.captureCompaction !== false
  STATE.injectDigest = options.injectDigest !== false
  STATE.file = join(options.storeDir || dshHomePath('dsh-memory'), 'memory.json')
  STATE.activeProject = null
  load()

  if (STATE.injectDigest) {
    ctx.effect(() =>
      ctx.systemPrompt.section({ name: SECTION, order: SECTION_ORDER, text: () => digest() }),
    )
  }

  // A session starting is enough to know which project the digest should show,
  // so the first prompt of a fresh process is already scoped correctly.
  ctx.on('agent/session-start', (payload) => {
    const cwd = cwdOfAgent(payload && payload.agent)
    const key = projectKeyOf(cwd)
    if (key) STATE.activeProject = key
  })

  // Compaction already paid for its summary; copying it costs no model call.
  if (STATE.captureCompaction) {
    ctx.on('session/event', (session, event) => {
      if (!event || event.type !== 'compaction/summary') return
      const text = event.data && typeof event.data.summary === 'string' ? event.data.summary.trim() : ''
      if (text.length === 0) return
      const key = projectKeyOf(cwdOfSession(session)) || STATE.activeProject || GLOBAL_SCOPE
      const body = clip(text, MAX_DIGEST_ENTRY_CHARS)
      const entries = entriesOf(key)
      const previous = entries.length > 0 ? entries[entries.length - 1] : null
      if (previous && previous.kind === 'digest' && previous.text === body) return
      const scope = scopeOf(key)
      scope.seq += 1
      scope.entries.push({
        id: 'm' + scope.seq,
        kind: 'digest',
        text: body,
        pinned: false,
        ts: nowMs(),
        upd: nowMs(),
        src: 'compaction',
      })
      prune(scope)
      persist().catch((error) => console.error('dsh-memory: digest persist failed: ' + messageOf(error)))
    })
  }

  ctx.tools.register(
    defineTool({
      name: 'memory',
      description:
        'Persistent memory that survives across turns, sessions and context compaction; its digest is already in your prompt. ' +
        'Use action=save for durable facts, user preferences, decisions, and the current task state (kind=task, pinned=true) so unfinished work can resume; ' +
        'action=read or action=list for full text; action=forget to drop an entry; action=export to write a Markdown snapshot. ' +
        'Keep entries short and non-duplicated.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['save', 'read', 'list', 'forget', 'export'],
          description: 'Operation to perform.',
        },
        id: {
          type: 'string',
          description: 'Entry id: for read, for forget, or to overwrite an existing entry with save.',
        },
        text: { type: 'string', description: 'Entry text for save; Markdown allowed, max 4000 chars.' },
        kind: {
          type: 'string',
          enum: ['fact', 'decision', 'task', 'preference', 'note', 'digest'],
          description: 'Entry category; defaults to note (or the existing kind on overwrite).',
        },
        pinned: {
          type: 'boolean',
          description: 'Keep this entry in every prompt digest. Defaults to true for kind=task.',
        },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description: 'project (default, this workspace) or global (applies to all workspaces).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: value && typeof value.message === 'string' ? value.message : '' },
        ],
      },
      async execute(args, exec) {
        const input = args && typeof args === 'object' ? args : {}
        const action = typeof input.action === 'string' ? input.action : ''
        const cwd = cwdOfAgent(exec && exec.agent)
        const projectKey = projectKeyOf(cwd)
        if (projectKey) STATE.activeProject = projectKey
        const scopeKey = input.scope === 'global' || !projectKey ? GLOBAL_SCOPE : projectKey
        const scope = scopeOf(scopeKey)

        try {
          if (action === 'save') {
            const text = typeof input.text === 'string' ? input.text.trim() : ''
            if (text.length === 0) return { ok: false, message: 'memory save needs non-empty text' }
            const entry = putEntry(scopeKey, text, input)
            await persist()
            return {
              ok: true,
              message:
                'saved [' +
                entry.id +
                '|' +
                entry.kind +
                (entry.pinned ? '|pinned' : '') +
                '] ' +
                firstLine(entry.text, 70) +
                ' — ' +
                scope.entries.length +
                ' entries in ' +
                scopeKey,
            }
          }

          if (action === 'read') {
            const wanted = typeof input.id === 'string' ? input.id : ''
            if (wanted.length > 0) {
              const found = scope.entries.find((entry) => entry.id === wanted)
              if (!found) return { ok: false, message: 'no memory entry ' + wanted + ' in ' + scopeKey }
              return {
                ok: true,
                message:
                  '[' + found.id + '|' + found.kind + (found.pinned ? '|pinned' : '') + ']\n' + found.text,
              }
            }
            if (scope.entries.length === 0) return { ok: true, message: 'memory ' + scopeKey + ' is empty' }
            const body = scope.entries
              .slice()
              .sort(byUpdated)
              .map((entry) => '[' + entry.id + '|' + entry.kind + '] ' + entry.text)
              .join('\n\n')
            return { ok: true, message: clip(body, MAX_ENTRY_CHARS) }
          }

          if (action === 'list') {
            if (scope.entries.length === 0) return { ok: true, message: 'memory ' + scopeKey + ' is empty' }
            const lines = scope.entries
              .slice()
              .sort(byUpdated)
              .map((entry) => entryLine(entry, entry.pinned === true, false, scopeKey))
            return {
              ok: true,
              message:
                'memory ' +
                scopeKey +
                ' — ' +
                scope.entries.length +
                ' entries:\n' +
                clip(lines.join('\n'), 3500),
            }
          }

          if (action === 'forget') {
            const wanted = typeof input.id === 'string' ? input.id : ''
            const index = scope.entries.findIndex((entry) => entry.id === wanted)
            if (index < 0) return { ok: false, message: 'no memory entry ' + wanted + ' in ' + scopeKey }
            const gone = scope.entries.splice(index, 1)[0]
            await persist()
            return { ok: true, message: 'forgot ' + gone.id + ' (' + firstLine(gone.text, 50) + ')' }
          }

          if (action === 'export') {
            const markdown = toMarkdown()
            const file = join(dirname(STATE.file), 'MEMORY.md')
            let where = file
            try {
              mkdirSync(dirname(STATE.file), { recursive: true })
              writeFileSync(file, markdown, 'utf8')
            } catch (error) {
              where = 'not written (' + messageOf(error) + ')'
            }
            return { ok: true, message: 'memory export -> ' + where + '\n\n' + clip(markdown, 3000) }
          }

          return {
            ok: false,
            message: 'unknown action ' + action + '; use save, read, list, forget or export',
          }
        } catch (error) {
          return { ok: false, message: 'memory ' + action + ' failed: ' + messageOf(error) }
        }
      },
    }),
  )
}
