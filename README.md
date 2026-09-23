# dsh-memory

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的**持久记忆插件**：把重要设定、决策和任务状态写进长期记忆，并以**极低的 token 成本**在每一步自动带回来。

> 目标：任务跨轮次、跨会话、跨上下文压缩都能接着跑；成本接近「一条短提示词」，而不是每次回读历史。

---

## 它解决什么问题

长任务里最贵的两件事：

1. **重复推导**——上下文被压缩或换会话后，模型忘了「用户要求中文」「构建命令是 `pnpm build:web`」「迁移盘符的决定」，只能重新翻历史或重新问用户。历史越长，翻一次越贵。
2. **任务断线**——上下文一压缩，正在做的事、下一步计划、已完成清单就丢了，任务跑不完。

`dsh-memory` 用三个设计把这两件事压到几乎零成本：

| 设计 | 做法 | token 成本 |
| --- | --- | --- |
| **常驻 digest** | 一个 prompt section（order 8500）始终渲染记忆摘要，模型不用再回查历史 | 固定上限，默认约 1050 字符（≈300 CJK token），无 I/O |
| **单工具** | 只注册一个 `memory` 工具，用 `action` 切换 save/read/list/forget/export | 一个工具 schema，而不是五个 |
| **免费沉淀压缩摘要** | 监听 `compaction/summary`，把宿主**已经花钱生成**的摘要抄进记忆 | **0** 额外模型调用 |

再加上一条纪律：`kind=task` 且 `pinned=true` 的条目**永远**出现在 digest 里，所以「当前任务 + 下一步」不会因为摘要预算被挤掉。

---

## 安装

### 方式一：从 GitHub 直接装（推荐自测）

在你的 DSH profile 目录（例如 `$DSH_HOME/profiles/desktop`）里：

```bash
# 1. 加依赖（换成你自己的仓库地址）
pnpm add git+https://github.com/<you>/dsh-memory.git

# 2. 把它列进 profile 的 bundles
```

编辑同目录的 `package.json`：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-memory"          // ← 加这一行
      ],
      "patchReload": "live"
    }
  }
}
```

重启 DSH 后插件挂载。`dsh-memory` 自带的 `cordis.patch.yml` 会插入 `id: memory` 这一行，不需要你手改组合。

### 方式二：本地目录 / 开发调试

```bash
pnpm add file:/path/to/dsh-memory
```

### 配置（全部可选）

在 profile 的 `cordis.patch.yml` 里按 loader patch 覆盖：

```yaml
- id: memory
  config:
    storeDir: ''          # 记忆存放目录，默认 $DSH_HOME/dsh-memory
    digestChars: 1050     # 注入 digest 的硬上限（字符）
    maxEntries: 240       # 每个 scope 的条目上限，超出丢最旧的未 pinned 条目
    captureCompaction: true   # 是否自动沉淀压缩摘要
    injectDigest: true    # false = 只留工具，不往提示词注入任何东西
```

想更省 token 就把 `digestChars` 调到 `600`；想记得更多就调大，代价线性。

---

## 模型怎么用它

插件只暴露**一个**工具：

```
memory(action, id?, text?, kind?, pinned?, scope?)
```

| action | 作用 |
| --- | --- |
| `save` | 存一条。带 `id` 就是覆盖已有条目 |
| `read` | 读全文（给 `id` 读单条；不给就按最近更新顺序输出全部） |
| `list` | 只列 `id/kind/摘要`，省 token |
| `forget` | 删掉一条 |
| `export` | 导出成 `MEMORY.md`（同时把 Markdown 返回对话） |

`kind` ∈ `fact | decision | task | preference | note | digest`；`scope` ∈ `project`（默认，当前工作区）| `global`（所有工作区通用，比如「用户偏好中文」）。

典型写法：

```jsonc
// 记住长期偏好（跨项目）
{ "action": "save", "scope": "global", "kind": "preference",
  "text": "用户要求：回答与交付物都用中文；文件命名用中文。" }

// 记住当前任务状态，让任务能续跑
{ "action": "save", "kind": "task", "pinned": true,
  "text": "正在做 dsh-memory 正式包：lib/index.js 已写，README 待补，尚未在真实 profile 安装验证。" }
```

注入到提示词里的样子（默认上限内）：

```
## Memory (persistent)
Durable facts, user preferences, decisions and task state recorded earlier. Trust them instead of re-deriving them; maintain them with the `memory` tool.
- pinned [m2|task] 正在做 dsh-memory 正式包：lib/index.js 已写…
- ■ [m1|preference] 用户要求：回答与交付物都用中文…
- [m7|digest] 本轮完成 X、Y，下一步 Z…
```

这样模型**不需要**「往前找」——重要内容本来就在眼前。

---

## 数据与隐私

- 存储位置：`$DSH_HOME/dsh-memory/memory.json`（原子写入：写临时文件后 rename）。
- 导出：`memory action=export` 生成同目录 `MEMORY.md`，可以直接提交进仓库或分享。
- 文件格式（v1，迁移友好）：

```json
{
  "v": 1,
  "scopes": {
    "global":            { "seq": 3, "entries": [] },
    "project:D:\\Harness": { "seq": 7, "entries": [
      { "id": "m1", "kind": "fact", "text": "…", "pinned": true,
        "ts": 1760000000000, "upd": 1760000000000, "src": "compaction" }
    ] }
  }
}
```

- 插件只读 Agent/Session 的**标量**字段（工作目录），不复制会话对象，不额外调用模型。
- 记忆以**明文**存在本机；`export` 出来的 Markdown 也由你自己决定去哪。

---

## 已知限制

- **注入的 digest 只有一个「当前项目」**：进程里同时开多个工作区时，digest 显示最近一次接触的工作区；`memory` 工具写读本身仍然是按工作区正确分 scope 的。要做成每个会话独立注入，需要挂到 `agent.ctx` 的 scoped prompt section 上，这是下一版的事。
- 注入的 section 变了会让该段提示词缓存失效——所以只在 `save/forget/压缩摘要` 时变化，正常对话里是稳定的。
- `digest` 用的是字符上限而不是精确 token 计数，CJK 与英文混排时体感会有差异。

## 路线图

- [ ] 每条会话独立的 scoped 注入（`agent.ctx`）
- [ ] 可选：重复条目自动去重 / 相似合并
- [ ] 可选：`memory search <关键词>` 做子串检索
- [ ] 导出为 Obsidian 友好的分文件结构

## License

MIT
