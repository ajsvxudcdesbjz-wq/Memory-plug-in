/**
 * Smoke + safety test for dsh-memory.
 *
 * It exercises the real plugin against a throwaway store directory with a fake
 * Cordis context, so it never touches your DSH profile or your real memory.
 *
 * Run it where the DSH runtime packages resolve (the plugin installed under a
 * profile, or a repo checkout with a node_modules that can see @deepseek-ai/*):
 *
 *   node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config, inject, name } from 'dsh-memory'

const root = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'))
const storeDir = join(root, 'store')
let tool = null
let section = null

const ctx = {
  effect: (callback) => {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => undefined
  },
  on: () => () => undefined,
  tools: { register: (definition) => { tool = definition; return () => undefined } },
  systemPrompt: { section: (next) => { section = next; return () => undefined } },
}

const call = (args) => tool.execute(args, {})

try {
  assert.equal(name, 'dsh-memory')
  assert.deepEqual(inject, ['tools', 'systemPrompt'])
  // Schemastery returns a schema constructor, not a plain object.
  assert.ok(Config, 'Config must be exported for the loader')

  apply(ctx, { storeDir })
  assert.ok(tool, 'the memory tool must be registered')
  assert.ok(section, 'the prompt section must be registered')
  assert.equal(tool.name, 'memory')
  // defineTool normalises the parameter DSL into JSON Schema.
  const params = tool.parameters
  const actions = params && params.properties && params.properties.action
  assert.ok(actions && Array.isArray(actions.enum), 'the action parameter must reach the registry')
  for (const action of ['save', 'read', 'list', 'forget', 'search', 'scopes', 'doc', 'docs', 'export']) {
    assert.ok(actions.enum.includes(action), 'missing action ' + action)
  }

  // An empty store still renders a digest, and it starts out empty.
  assert.match(section.text(), /## Memory \(persistent\)/)
  assert.match(section.text(), /empty/)

  // Round-trip one durable fact.
  const saved = await call({ action: 'save', kind: 'fact', text: 'build command is pnpm build:web' })
  assert.equal(saved.ok, true)
  assert.ok(existsSync(join(storeDir, 'memory.json')), 'the store must be written')
  assert.match(section.text(), /build command is pnpm build:web/)

  // Documents land inside <storeDir>/sessions and come back by id.
  const documented = await call({ action: 'doc', text: '# Session summary\n\nWe built a memory plugin.' })
  assert.equal(documented.ok, true)
  const docId = documented.id
  const docFile = readdirSync(join(storeDir, 'sessions'))[0]
  assert.match(docFile, /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/, 'document names must be plain and safe')
  const pulled = await call({ action: 'read', id: docId })
  assert.match(pulled.message, /We built a memory plugin/)

  // A document name in the store is untrusted input: a hostile one must never
  // be read, and must never be deleted outside the sessions directory.
  const outside = join(root, 'escaped.md')
  writeFileSync(outside, 'TOP SECRET', 'utf8')
  const raw = JSON.parse(readFileSync(join(storeDir, 'memory.json'), 'utf8'))
  const scopeKey = Object.keys(raw.scopes)[0]
  raw.scopes[scopeKey].entries.push({ id: 'evil', kind: 'doc', doc: '../../escaped.md', text: 'hostile', pinned: false })
  writeFileSync(join(storeDir, 'memory.json'), JSON.stringify(raw), 'utf8')

  const hostileRead = await call({ action: 'read', id: 'evil' })
  assert.doesNotMatch(hostileRead.message, /TOP SECRET/, 'a traversal name must not be read')
  await call({ action: 'forget', id: 'evil' })
  assert.ok(existsSync(outside), 'a traversal name must not delete a file outside the store')

  // Nothing may be written outside the configured store directory.
  const exported = await call({ action: 'export' })
  assert.equal(exported.ok, true)
  assert.ok(existsSync(join(storeDir, 'MEMORY.md')), 'export must stay inside the store directory')
  assert.deepEqual(readdirSync(root).sort(), ['escaped.md', 'store'])

  console.log('dsh-memory smoke test: OK')
} finally {
  rmSync(root, { recursive: true, force: true })
}
