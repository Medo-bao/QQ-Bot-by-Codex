# Changelog

## 0.0.2 - 2026-10-30

- 统一插件清单、MCP 服务、界面、QQ 版本命令及 SDK 标识为 0.0.2。
- 修复多个插件实例同时启动后台时的地址占用报错，共用现有连接。
- 隔离桌面通知命令，避免长回复触发 Windows 命令行长度错误；移除机器人配置副本中的失效配置项。
- 运行日志增加每行时间和级别，便于定位新问题。
- 默认使用 HTTP 流式连接，并在当前问题之前提供已接收的群聊前文。

## 0.0.1 - 2026-10-29

Initial source release.

- Prefer HTTP streaming for the built-in OpenAI provider in the bot-owned process to avoid repeated WebSocket connection timeouts, preserving the model, reasoning level and custom providers.
- Read complete local group context before the current question on every turn, record clarification answers and remove the duplicate truncated SDK history.
- Preserve conversation reading positions and expanded tool details, keep unfinished session settings when dialogs close, and separate their validation from global saves.
- Add keyboard search navigation and full-name tooltips, restore typing focus after sends, accept valid attachments up to the limit, and keep the direct-send button unavailable until the previous send finishes.
- Fill the available page height so the sidebar and conversation composer align with the bottom without an extra host-input spacer.
- Resolve pending approvals when full access is selected while preserving ordinary questions, and keep connection state accurate across gateway reconnect/resume.
- Preserve drafts edited during sends or saves, show save failures inside the session dialog, serialize status refreshes and order compaction activity chronologically.
- Keep repeated queued messages visible, clear discarded optimistic messages on stop/reset, and improve input growth, task status, attachment paste/drop and duplicate selection handling.
- Use a 240px sidebar, keep conversation title/actions in the top toolbar, and move model, permissions and storage details into the session settings dialog.
- Restore the conversation composer at the bottom and remove the arrow from Session settings.
- Show measured context token usage and capacity, restore existing statistics, and automatically compact at a configurable threshold before the next reply while preserving history and per-session inheritance.
- Add direct attachment sending with file selection/previews, bounded uploads, per-recipient drafts, progress and partial-failure retries without starting an AI turn.
- Show live reset/compaction progress, completion, cancellation and errors in conversation settings and the chat header without holding a long UI request open.
- Preserve the previous thread and per-session settings on context reset, keep new arrivals behind the reset boundary, and allow messages to continue after failed compaction.
- Apply model, prompt and permission changes without restarting active QQ tasks; keep connection changes from interrupting queued messages, and finish conversation archives before closing Codex.
- Merge bots and conversations into a Codex-style collapsible sidebar, preserving selection, search, bot management and saved fold state.
- Add a separate direct-message dialog that sends the operator's text through the bot without starting an AI turn.
- Add native-style permission modes for global and conversation settings, carry automatic-review configuration into Codex, and stop repeated approval prompts after Full Access is selected.
- Resolve complete, conversation-scoped quoted messages across restarts, preserving sender identity, nested references, bot reply receipts and available media.
- Reuse local quoted attachments, pass quoted images into the model, keep missing media explicit, and process quote-only requests without mixing their contents into the current question.
- Use explicit QQ Bot titles for MCP tools and server metadata.
- Automatically connect the saved bot when Codex initializes the plugin; provide a runtime setting, keep unbound and child instances dormant, and reuse the shared connection.
- Refresh older bot credentials from the desktop login for the same ChatGPT account, while preserving newer bot credentials and separately selected accounts.

- Persist complete group context, backfill existing native threads, retain received non-mention messages without replying, and include preceding multi-user messages plus bot replies on each turn.
- Preserve group context across restarts, prevent queued turns from seeing later user messages, and respect explicit context resets.

- Match Codex conversation typography, blue user bubbles, Markdown, code and tables; collapse per-turn activity and retain group sender identity.
- Preview local conversation images, copy replies and code, and return to the latest message.
- Add per-conversation execution scope, confirmation, network and search settings with global inheritance.
- Provide a Node HTTPS downloader for Windows sandbox TLS failures while respecting native network and filesystem permissions.
- Keep tool diagnostics in local activity unless QQ synchronization is enabled; report final delivery failures locally without recursively sending through a failed channel.
- Preserve QQ binding, shared group context, targeted mentions, prompt isolation, session names and dialogs, and per-conversation archives.
