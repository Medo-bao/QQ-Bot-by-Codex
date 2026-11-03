# QQ Bot

在 QQ 私聊、群聊和 Codex 插件界面中使用本机 Codex，处理消息、执行任务并交付文件。

**当前版本：0.0.6** · [English](README_EN.md) · [更新日志](CHANGELOG.md) · [下载源码](https://github.com/Medo-bao/QQ-Bot-by-Codex/releases/tag/v0.0.6)

QQ Bot 通过腾讯 QQ Bot SDK 连接 QQ 与本地 Codex App Server，复用本机的 Codex 登录、模型提供商和工具配置，无需安装 DSH。项目改造自 [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)，采用 MIT 许可证。

## 主要功能

| 功能 | 说明 |
| --- | --- |
| 独立会话 | 每个私聊、每个群聊分别保存上下文；支持重命名、独立模型、工作目录、角色与额外提示词。 |
| 群聊上下文 | 共享群上下文并标记发言人，回复对应提问者；支持近期消息、引用消息与附件恢复。 |
| 原生任务能力 | 使用 Codex 可用的命令、文件、搜索和工具能力；界面显示公开的思考摘要、计划、进度与执行结果。 |
| 图片与文件 | 接收图片和附件，发送生成文件；可明确选择自动识别、按文件或语音通道交付。 |
| 桌面会话调度 | 浏览其他项目的已有 Codex 会话、读取近期回复和状态、派发任务并回传文字结果。 |
| 已登录网页读取 | 复用 Codex 桌面内置浏览器的登录会话读取指定网页，也可单独检查登录状态。 |
| 上下文管理 | 显示上下文用量，支持自定义上下文长度、原生自动压缩、手动压缩和重置反馈。 |
| 本地管理界面 | 可折叠的机器人与会话分组、会话设置窗口、底部 AI 输入框，以及直接发送弹窗。 |

QQ 会话的角色提示词与 Codex 桌面个性化指令隔离。共享后台可供多个 Codex 聊天使用；已绑定且启用自动启动时，加载插件会恢复 QQ 连接。

## 安装

### 环境要求

- Windows 与 PowerShell；下列安装步骤以 Windows 为例。
- Node.js **22.13.0 或更新版本**。
- 已安装并登录、支持 `app-server` 和 `plugin` 命令的 Codex。
- 用于扫码的手机 QQ，或 QQ Bot 的 AppID / AppSecret。
- 跨项目会话和网站登录检查需要 Codex 桌面保持打开。

### 从源码安装

```powershell
git clone https://github.com/Medo-bao/QQ-Bot-by-Codex.git
cd QQ-Bot-by-Codex
npm.cmd ci --ignore-scripts
.\scripts\install.ps1
```

安装脚本会构建项目、生成 `release/codex-qqbot`，并注册本地市场 `qqbot-local` 和插件 `codex-qqbot`。源码发行不包含构建产物，需要先完成上述构建步骤。

如果默认的 `codex.cmd` 不支持插件命令，可指定可用的 Codex 可执行文件：

```powershell
.\scripts\install.ps1 -CodexCommand "C:\Tools\Codex\codex.exe"
```

安装后重新打开 Codex 或刷新插件，选择 **QQ Bot**，输入“设置 QQ Bot 并连接到 Codex”。支持 MCP Apps 的客户端可使用侧栏或聊天侧面板；也可通过 `qqbot_setup` 打开本机设置页面。

## 首次连接

1. 打开 QQ Bot 设置页，选择本机任务工作目录。
2. 使用手机 QQ 扫码绑定，或在本机设置页填写 AppID / AppSecret。
3. 设置访问范围：默认私聊使用白名单，群聊关闭。给机器人发消息后，可在“最近消息来源”中查找对应 OpenID。
4. 使用群聊时开启群访问并配置允许的群和发起者；默认仅在 **@机器人** 时回复。可在「设置 → 回复与提示词」开启「@全体成员时回复」；默认关闭，关闭时仅 @全体成员不触发回复，同时 @机器人仍正常回复。
5. 启动连接，在 QQ 或插件底部输入框中发送任务。之后可在“运行设置”中管理自动启动。

群聊前文取决于 QQ 平台实际推送的消息。需要记录未 @机器人的发言时，应先在 QQ 平台开启相应消息接收能力；插件会保存收到且通过访问规则的消息。

## 常用操作

### 对话与会话设置

选择侧栏中的私聊或群聊，使用底部输入框继续同一个 AI 会话，回复会同步到 QQ。点击会话名称旁的铅笔可重命名；“会话设置”可单独调整模型、推理强度、工作目录、权限、提示词和上下文长度，未覆盖的项目跟随全局设置。

更换角色或预设会开始新上下文，旧记录仍保留。自动压缩使用 Codex 原生策略；也可手动压缩或重置，并在界面查看进度。权限模式可选择“请求批准”“帮我批准”或“完全访问权限”；完全访问模式不再逐项请求操作批准，信息补充问题仍可正常提出。

### 直接发送图片或文件

点击 **直接发送**，选择 QQ 接收会话，输入文字或通过选择、拖入、粘贴添加附件。此操作以机器人身份发送内容，不触发 AI 回复。

- `auto`：图片和视频使用预览，SILK / AMR 使用语音通道，MP3 等普通音频按文件发送。
- `file`：保留原始文件与文件名，图片、视频、MP3 也可按文件交付。
- `voice`：明确使用语音通道，具体格式和大小仍受 QQ 平台支持范围约束。

AI 发送工具 `qqbot_send_file` 提供相同的 `send_as` 选项。发送失败时显示具体原因，可在修正文件或设置后重试。

### GPT-Live 语音与自定义音色

在 **设置 → 语音与音色** 填写现有 OpenAI API Key，开启 GPT-Live 并保存。密钥仅保存在本机配置中，页面与状态接口不回显；也支持服务器环境变量 `OPENAI_API_KEY`。GPT-Live 使用独立 API 授权与计费，Codex 的登录不会自动提供这项额度。

- 默认模型为 `gpt-live-1`、音色为 `marin`。可填写其他受支持内置音色，或同一 API 项目中的自定义音色 ID；自定义 ID 优先。
- “用描述创建音色”会调用官方音色接口，返回 ID 并填入设置草稿；点击保存后可生成音频试听。已经获得授权并创建的录音音色也可通过 ID 使用。
- “生成与试听”生成 WAV、显示实际语音转录，并提供播放和下载。选择会话后可自动发送原始文件或 QQ 语音；发送失败可单独重试，无需再次生成。
- 音频按机器人、会话与线程保存到既有资源目录的 `audio` 子目录；仅试听的文件放入该机器人的 `voice-previews` 目录。
- QQ 会话可在用户要求语音时调用 `qqbot_live`，例如“用当前音色生成这段话，并按语音消息发送”。接口支持内置音色或 `voice_id` 覆盖，不改变 Codex 对话模型与角色。

GPT-Live 是连续对话语音模型；本插件将它封装为有时长上限的短片段生成，不保证逐字朗读，也不用于歌曲生成。官方没有整段音频完成事件，插件按可配置的静音窗口结束片段，并等待 `session.closed` 确认；超时、取消或连接中断不会交付残缺结果。遇到长停顿被截断时可调高静音时长。任务异步执行，可查看进度和取消。

从 Codex 调用 MCP `qqbot_live` 时，`action: "generate"` 返回任务 ID，再用 `action: "status"` 和同一目标、`job_id` 获取结果；只有明确指定 `send_to_qq: true` 才发送。QQ 原生会话中的同名工具会等待生成完成，再返回文件与发送回执。`action: "create_voice"` 只创建音色，不自动改变全局设置。

接口依据：[OpenAI GPT-Live WebSocket](https://developers.openai.com/api/docs/guides/voice-websockets)、[自定义音色](https://developers.openai.com/api/docs/guides/custom-voices)。

### 让其他项目的会话工作

桌面与浏览器绑定保存在本机数据目录，QQ 后台重启后自动恢复；从当前 Codex 会话打开插件或调用状态检查时会更新绑定。浏览器访问仍由 Codex 原生身份与站点权限校验；若 Codex 本身已退出或切换账号，需要重新打开插件以更新连接。

在“设置 → 运行设置”开启 **允许访问 Codex 桌面会话与网页**，并将发起操作的 QQ 会话设为 **完全访问权限**。

1. 选择发起任务的 QQ 会话，点击顶部 **项目会话**。
2. 筛选项目或搜索会话；较旧的会话可点击“加载更多”。
3. 选中原有会话，查看近期回复与状态，在“下达任务”中填写要求并点击“派发任务”。
4. 默认将完成后的文字结果回传当前 QQ 会话；回传失败可重试。

也可在 QQ 或插件的 AI 输入框中说：

> 列出某个项目的已有会话，先查看指定会话的近期回复和状态。
>
> 让刚才选中的会话执行以下任务：……，完成后将结果回传 QQ。

目标忙碌时先排队，任务沿用目标会话原有的模型、权限和上下文。尚未派发的任务可取消；已经开始的任务及其审批，在目标 Codex 会话中处理。

### 读取已登录网页与检查登录状态

满足上述桌面访问条件后，可要求机器人“用内置浏览器读取这个 X 帖子”或“查看某个 B站页面”。`qqbot_browser(action="read", url="完整地址")` 使用当前登录会话返回可见网页内容、来源地址和截断标记；普通网页抓取出现 403 或登录墙时，也可改用该通道。读取会定位指定地址，使用临时标签页时会在结束后关闭，保留原有标签页。

只询问登录情况时使用 `action="status"`，返回已登录、未登录或无法确认。登录检查成功不代表已经读到正文；读取会等待页面内容加载，未就绪、被阻止或不可用时会明确报告原因。两种操作均保留原生账号和网站访问权限检查，不代填凭据、发布内容或绕过网站验证。

### QQ 命令

| 命令 | 用途 |
| --- | --- |
| `/new`、`/reset`、`/clear` | 重置上下文，保留会话设置与历史归档 |
| `/compact` | 手动压缩上下文 |
| `/model`、`/model 模型` | 查看或切换模型 |
| `/preset`、`/preset 预设ID`、`/preset reset` | 查看、切换或恢复预设 |
| `/effort`、`/effort high` | 查看或切换推理强度 |
| `/stop` | 中止当前任务并取消排队任务 |
| `/bot-status` | 查看会话、队列和 OpenID |
| `/bot-me` | 查看当前发送者 OpenID；群聊同时显示本群 OpenID |
| `/bot-ping`、`/bot-version`、`/bot-help` | 连通检查、版本和帮助 |
| `/answer 请求编号 答案` | 回答待办问题或审批 |

以上命令支持已获准访问的私聊与群聊，并遵循访问范围与发起者校验。接收图片会按真实文件格式校正扩展名，保留原始字节；上游更新的移植范围见 [上游适配记录](docs/UPSTREAM_PORTS.md)。

## 数据与文件位置

运行数据默认保存到 `$CODEX_HOME/qqbot`，通常为 `~/.codex/qqbot`；可用 `QQBOT_DATA_DIR` 指定其他固定目录。

| 位置 | 内容 |
| --- | --- |
| `config.json` | 本机 QQ 凭据和运行设置 |
| `sessions.json` | QQ 会话与 Codex 线程的映射、独立设置 |
| `codex-home/` | QQ 会话使用的独立 Codex 运行数据 |
| `runtime.log` | 后台日志 |
| `desktop-jobs.json` | 跨项目任务的本地派发记录 |

会话归档目录由 `storageDir` 配置；留空时使用数据目录下的 `storage`。聊天记录、收到的附件和生成资源按机器人及私聊 / 群聊分别保存：

```text
storage/bot-<AppID>/<private|group>/peer-<OpenID>/
  session.json
  history/<threadId>.md
  history/<threadId>.json
  attachments/
  files/<threadId>/
    images/
```

重命名会话不改变这些稳定目录。任务工作目录与归档目录分开；重置上下文也不会删除旧归档。设置页只监听本机回环地址，状态工具不返回 AppSecret。

**本仓库和源码发行只包含软件源码、测试、文档及插件图标，不包含本机凭据、配置、会话、日志、数据库、附件或生成文件。**

## 本地维护

```powershell
node dist/cli.js setup     # 打开本机设置页
node dist/cli.js status    # 查看连接状态
node dist/cli.js start     # 启动 QQ 连接
node dist/cli.js models    # 查看可用模型
node dist/cli.js stop      # 停止 QQ 与机器人任务
node dist/cli.js shutdown  # 关闭共享后台和设置页
```

更新源码后重新运行 `npm.cmd ci --ignore-scripts` 和安装脚本。后台需要重载时，先等待任务结束，再 `shutdown` 并重新启动；本机数据目录会继续保留。更多配置项见 [src/config.ts](src/config.ts)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 许可与来源

MIT，详见 [LICENSE](LICENSE)。上游：[tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)，改造基线 `ee980be`（2026-10-28，上游 0.5.4）。
