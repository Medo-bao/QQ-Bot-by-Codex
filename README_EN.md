# QQ Bot

Use local Codex from QQ private chats, QQ groups and a desktop plugin interface to handle conversations, run tasks and deliver files.

**Current version: 0.0.5** · [中文](README.md) · [Changelog](CHANGELOG_EN.md) · [Source release](https://github.com/Medo-bao/QQ-Bot-by-Codex/releases/tag/v0.0.5)

QQ Bot connects Tencent's QQ Bot SDK to a local Codex App Server and reuses your Codex login, model providers and tools. DSH is not required. Adapted from [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot), under the MIT license.

## Features

| Feature | What it does |
| --- | --- |
| Independent conversations | Persistent context for each private chat and group, with names, models, workspaces, roles and additional prompts. |
| Group context | Shared group context with speaker identities, requester-specific replies, recent messages, quoted messages and attachments. |
| Native Codex tasks | Available command, file, search and tool capabilities, with public reasoning summaries, plans, progress and results in the UI. |
| Images and files | Receive attachments and deliver generated resources, with explicit file, preview and voice delivery choices. |
| Other project conversations | Browse existing Codex desktop chats, inspect recent replies and status, dispatch work and return final text to QQ. |
| Website login checks | Read-only checks through the attached Codex desktop browser. |
| Context management | Token usage, custom context-window lengths, native automatic compaction, manual compaction and reset feedback. |
| Local management UI | Collapsible bot groups, conversation settings, a bottom AI composer and a separate direct-send dialog. |

QQ role prompts are isolated from desktop personalization instructions. A shared background process serves multiple Codex chats. Loading the plugin can reconnect a bound bot when auto-start is enabled.

## Install

### Requirements

- Windows and PowerShell for the steps below.
- Node.js **22.13.0 or newer**.
- An installed, signed-in Codex with `app-server` and `plugin` commands.
- Mobile QQ for QR binding, or QQ Bot AppID / AppSecret credentials.
- Codex desktop running for project-conversation control and browser checks.

### Build from source

```powershell
git clone https://github.com/Medo-bao/QQ-Bot-by-Codex.git
cd QQ-Bot-by-Codex
npm.cmd ci --ignore-scripts
.\scripts\install.ps1
```

The script builds `release/codex-qqbot`, registers the local `qqbot-local` marketplace and installs `codex-qqbot`. Source releases omit build products, so complete the build before installing.

If the default `codex.cmd` lacks plugin support, specify a suitable executable:

```powershell
.\scripts\install.ps1 -CodexCommand "C:\Tools\Codex\codex.exe"
```

Reopen Codex or refresh its plugins, select **QQ Bot**, and ask to set it up. MCP Apps clients can show a sidebar or conversation panel. `qqbot_setup` also returns a local browser settings URL.

## First connection

1. Open settings and select a local task workspace.
2. Bind with mobile QQ, or enter AppID / AppSecret in the local settings page.
3. Configure access. Private chats default to an allowlist and groups default to disabled. Send a message to discover its OpenID under recent message sources.
4. Enable group access and allow the group and requester. Replies require **@bot** by default.
5. Start the connection and send a task through QQ or the plugin's AI composer. Auto-start is configurable in Runtime settings.

Group context depends on events delivered by QQ. To record messages without a mention, enable the corresponding QQ platform capability. The plugin records received messages permitted by its access rules.

## Everyday use

### Conversations and settings

Select a private chat or group in the sidebar. The bottom composer continues the same AI conversation and syncs replies to QQ. Rename it with the pencil icon. Conversation settings override the global model, effort, workspace, permissions, prompts or context length.

Changing a role or preset starts fresh context while retaining the old archive. Automatic compaction uses Codex's native policy; manual compaction and reset expose progress. Permission modes match the desktop choices. Full access stops per-operation approval prompts; requests for missing information remain available.

### Send text and attachments directly

Open **Direct send**, choose a QQ recipient conversation and add text or files through selection, drag-and-drop or paste. This sends as the bot without asking the AI to respond.

- `auto`: image/video previews, SILK/AMR voice messages, and original files for ordinary audio such as MP3.
- `file`: preserve the original downloadable file and filename, including images, video and MP3.
- `voice`: explicitly select voice delivery, subject to QQ's format and size support.

The AI's `qqbot_send_file` tool exposes the same `send_as` options. Failed delivery reports its reason so the file or configuration can be corrected before retrying.

### Dispatch work to another project conversation

Enable desktop conversation/browser access in Runtime settings and give the initiating QQ conversation **full access**.

1. Select the source QQ conversation and open **Project conversations**.
2. Filter by project or search; use **Load more** for older chats.
3. Select an existing conversation, inspect its recent replies and status, enter a task and click **Dispatch**.
4. Final text returns to the source QQ conversation by default. Failed QQ delivery can be retried.

You can also ask in QQ or the plugin's AI composer:

> List the conversations in a project and inspect the selected conversation's recent replies and status.
>
> Ask that conversation to perform this task: …, and return its result to QQ.

Busy targets wait until idle. Tasks keep the target's model, permissions and context. Pending dispatches can be cancelled; stop already-started work and handle its approvals in the original Codex conversation.

### Check website login state

With desktop access enabled, ask the bot to check a website's login state in the Codex browser. `qqbot_browser` distinguishes signed in, signed out and unknown. Connection failures or HTTP 403 do not imply signed out. Native account and website access checks remain in force; this feature does not enter credentials or bypass verification.

### QQ commands

| Command | Purpose |
| --- | --- |
| `/new`, `/reset`, `/clear` | Reset context while retaining settings and archived history |
| `/compact` | Manually compact context |
| `/model`, `/model <model>` | Inspect or change the model |
| `/preset`, `/preset <id>`, `/preset reset` | Inspect, select or restore a preset |
| `/effort`, `/effort high` | Inspect or change reasoning effort |
| `/stop` | Interrupt the current task and cancel queued tasks |
| `/bot-status` | Conversation, queue and OpenID information |
| `/bot-ping`, `/bot-version`, `/bot-help` | Connectivity, version and help |
| `/answer <request-id> <answer>` | Respond to a pending question or approval |

## Local data

Runtime data defaults to `$CODEX_HOME/qqbot`, usually `~/.codex/qqbot`. Set `QQBOT_DATA_DIR` to choose another fixed location.

| Location | Contents |
| --- | --- |
| `config.json` | Local QQ credentials and runtime settings |
| `sessions.json` | QQ-to-Codex thread mappings and conversation settings |
| `codex-home/` | The bot's separate Codex runtime data |
| `runtime.log` | Background logs |
| `desktop-jobs.json` | Local project-task dispatch records |

`storageDir` controls chat/resource archives and defaults to `storage` under the data directory:

```text
storage/bot-<AppID>/<private|group>/peer-<OpenID>/
  session.json
  history/<threadId>.md
  history/<threadId>.json
  attachments/
  files/<threadId>/
    images/
```

Renaming a chat retains its stable directory. Task workspaces and archives are separate, and resets retain old archives. The settings page listens on loopback only, and status tools do not return AppSecret.

**The repository and source releases contain only software source, tests, documentation and plugin icons. They exclude local credentials, configuration, conversations, logs, databases, attachments and generated files.**

## Local maintenance

```powershell
node dist/cli.js setup     # Open local settings
node dist/cli.js status    # Inspect the connection
node dist/cli.js start     # Start QQ
node dist/cli.js models    # List available models
node dist/cli.js stop      # Stop QQ and bot tasks
node dist/cli.js shutdown  # Close the shared service and settings page
```

After updating source, run `npm.cmd ci --ignore-scripts` and the installation script again. Wait for active tasks before shutting down and restarting the service. Existing local data is retained. See [src/config.ts](src/config.ts) for configuration and [CHANGELOG_EN.md](CHANGELOG_EN.md) for version history.

## License and upstream

MIT; see [LICENSE](LICENSE). Based on [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot), commit `ee980be` (2026-10-28, upstream 0.5.4).
