# Changelog

## 0.0.5 - 2026-10-31

- 新增 Codex 桌面跨项目会话浏览、近期回复与状态读取、任务派发、排队和文字结果回传。
- 以任务唯一标识核对回传内容，修复串轮风险；按目标会话轮换轮询，保留取消等待与回传失败重试。
- 新增只读网站登录检查，通过桌面内置浏览器区分已登录、未登录和无法确认，保留原生账号及网站访问权限检查。
- 修复插件重启后工具服务未加载与 QQ 未自动恢复，统一使用 Codex 桌面插件配置并修正工作目录及环境变量转发。
- 修复新会话文件和数据库记录异步落盘时的工具索引初始化错误，保留原有会话与历史。
- 修复本地通信在 UTF-8 分块边界损坏长中文文本和表情的问题。
- 私聊流式回复确认最终更新和关闭成功后再标记送达；失败时补发完整回复，媒体引用只记录已确认发送的文本。
- 更新中英文 README，整理安装、访问设置、文件发送、项目会话调度及本地数据说明。
- 统一软件包、插件、MCP、界面、QQ 版本命令和 SDK 标识为 0.0.5；发行仅包含软件源码、测试、文档和图标。

## 0.0.4 - 2026-10-31

- 自动压缩改为完全使用 Codex 原生触发策略，移除全局与会话的插件开关、百分比阈值及旧配置，保留原生进度反馈和手动压缩。
- 新增全局与会话独立的上下文长度设置（Tokens），默认跟随 Codex 模型配置；保存后下次回复生效，保留原会话并更新容量统计。
- 修正 Node 运行时告警被误记为错误的问题，SQLite 实验性提示及其诊断说明按 WARN 记录，实际错误仍保留 ERROR。
- 修复压缩恢复快照覆盖新工具目录的问题，按原生顺序读取实际目录并追加工具更新记录，使已压缩会话也能发现 `voice`，保留历史内容与索引偏移。
- 恢复旧会话时一次同步全部 QQ 工具定义与索引，补齐部分索引中缺失的提问和图片识别工具；仅修复索引时不改写会话文件。
- 统一插件清单、MCP 服务、界面、QQ 版本命令及 SDK 标识为 0.0.4。

## 0.0.3 - 2026-10-30

- 修复旧会话恢复过时文件工具定义的问题，同步更新会话元数据与工具索引，使 `voice` 选项实际可见且不重置上下文。

- 修复并发附件重复发送和数量上限竞态，补齐媒体回执的引用索引。
- 会话卡片保留实际归档路径与发送方式，避免图片原件被重复显示为预览，并补齐 BMP 预览。

- MP3 等普通音频默认按文件发送，发送工具与直接发送弹窗新增自动识别、按文件和按语音的发送方式。

- 修复完全访问会话发送外部本机文件时被目录校验拒绝的问题，自动归档后发送并保持会话隔离。
- 工具失败日志和会话活动补全具体原因，补充当前生图接口的参数提示。

- 统一插件清单、MCP 服务、界面、QQ 版本命令及 SDK 标识为 0.0.3。
- 包含近期的思考摘要展示、会话配置生效和非引用附件读取修复。

## 0.0.2 - 2026-10-30

- 修复未引用群聊附件只有名称而无法读取的问题：接收时缓存、回复前恢复近期路径、直接提供最近附件图片，并在重复推送和重启后复用已下载文件。
- 修复全局模型与执行配置保存后被已加载会话忽略的问题，下轮恢复前释放该会话的旧订阅，保留上下文与其他正在执行的任务。
- 会话界面接入实时思考摘要、计划与命令输出，按原生顺序展示进度和活动，保留历史回看、折叠状态与阅读位置。
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
