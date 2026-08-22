# dsh-toolcall-id

A tiny **dsh host‑side plugin** that makes tool‑call ids unique per session.

## 背景

在 dsh Web GUI 中，使用 `openai‑completions`（例如 NVIDIA NIM）时，
同一会话的多个 step 会产生相同的工具调用 id（如 `read:0`）。
`dsh-client-ui-conversation` 把这个裸 id 直接当作上下文 key，
导致历史回放时抛出

```
conversation Context 9:tool-callread:0 received more than one start Match
```

这条错误只影响 **历史加载**，实际对话流程本身并不出错。

## 方案

dsh 为 LLM 流提供了 `llm/stream` **瀑布钩子**（`ctx.on("llm/stream", …)`），
所有模型请求都会走这条链。插件在此处包裹下游流，
对每个 `tool‑call‑delta` 和组装好的 `tool‑call` block 的 id 做一次
**去重**：

* 第一次出现的 `read:0` 保持不变。
* 之后在同一会话中再次出现的 `read:0` 会被改写为 `read:0~1`、`read:0~2` …
* 只影响重复的 id，原本唯一的 id（如 Anthropic 的 `toolu_…`）直接透传。

因为 id 的改写发生在 **流层**，后续的 Assistant 消息、`tool/call`
和 `tool/result` 事件全部使用改写后的 id，整个会话的持久化、重放、
以及后续的模型请求都保持一致。

## 安装

```bash
# 1. 把插件加入你的 web profile（profile 位于 $DSH_HOME/profiles/web）
#    下面的命令会把插件代码拉进 profile 的 node_modules

dsh plugin --profile web add github:qwc-ch/dsh-toolcall-id

# 2. 把插件放进 bundles 列表（手动编辑 profile 的 package.json）
#    在 "dsh.profile.bundles" 最后加上 "dsh-toolcall-id"
```

编辑完成后，重新启动 dsh（`dsh web`），插件会在 `llm/stream` 链上自动生效。

## 验证

* `dsh --profile web --dump-config | grep dsh-toolcall-id` 能看到插件节点。
* 启动 `dsh web --port 3199`（或你常用的端口）不再出现历史加载错误。
* 自测脚本（见插件源码）在同一会话的第二个 step 会输出 `read:0~1`，说明改写成功。

## 卸载

```bash
# 1. 从 bundles 中把 "dsh-toolcall-id" 删除
# 2. 移除插件依赖（可选）

dsh plugin --profile web uninstall dsh-toolcall-id
```

随后重启 dsh，插件即不再生效。

## 注意事项

* **旧会话**的存档里已经写入了重复的 id，插件只能防止以后新会话出错。要恢复旧会话，需要手动编辑对应的 `*.jsonl.zstd` 文件把重复 id 改写后重新压缩（不在本插件范围内）。
* 改写后的 id 仍然会随同在后续的模型请求中发送给提供商，OpenAI‑compatible 接口对 id 的格式没有限制，安全可靠。
* **重启兼容（v0.2.0）**：插件会在首次见到某个会话时，从该会话已持久化的事件日志里恢复已用过的 id（`tool/call` 和 assistant 消息里的 tool-call 块）。这样重启 dsh 后继续旧会话，新生成的后缀不会和已落盘的 id 撞车。
* 如果上游在未来的 dsh 版本中把 `toolDefinition` 的 `match` 改为带 `turn/step`，记得把插件删掉，行为是等价的。

## 许可证

MIT © 2026 qwc-ch

---

> 本插件是为了解决一个特定的 UI 回放 bug 而写，使用非常轻量（只有约 80 行代码），
> 如有需求请自行 fork 并根据实际情况扩展。
