# QQ Bot

Current plugin version: **0.0.3**.

The conversation view follows Codex typography, blue user bubbles, Markdown and
collapsible activity, with code/reply copying, image previews and a latest-message button.
Public reasoning summaries, plans and command output update while a turn runs and
remain available in chronological, collapsible activity when revisiting history.
Received group attachments are cached even without a mention or quote. Follow-up
questions can use their local paths and the latest attachment message's images;
unavailable downloads are identified rather than replaced with unrelated files.
Sessions can override execution scope, approvals, command networking and web search;
empty settings inherit global values. These changes preserve the existing context.
The Node HTTPS download command avoids PowerShell TLS failures in the Windows sandbox
while retaining native network and write permissions. Intermediate tool failures stay
in local activity unless QQ tool-result synchronization is enabled. Final delivery
errors appear locally without recursively sending errors through an unavailable channel.

Local Codex plugin adapted from `tencent-connect/dsh-qqbot` main at `ee980be` (upstream 0.5.4).

QQ private/group messages are routed to persistent local Codex App Server threads.
The plugin includes a local QR/manual credential page, streaming direct-chat replies,
image inputs, local-file delivery, per-peer context, and QQ approval/question interactions.
The full settings MCP App registers global sidebar and conversation-panel entrypoints.
Its Sessions / Settings tabs and collapsible bot groups use the same search-list and detail-pane layout
as the host plugins. Binding/login, access, models/presets, prompts, media, runtime
and session management remain available. A local browser URL opens the same UI when MCP Apps are unavailable.
The Sessions detail pane is a live conversation window with paginated history and
a composer. Desktop input continues the same AI thread and syncs replies to QQ.
The sidebar is 240px wide, and the composer stays at the bottom in both embedded and standalone views. Its context indicator uses the last model request's token usage rather than cumulative billing totals. Automatic compaction defaults to 80% of the reported context window before the next reply, with global and per-session controls, progress feedback and preserved chat history.
The Session settings button opens a separate dialog; new sessions follow global
settings by default, with optional overrides and a restore-global action.
Use the pencil beside the conversation title to rename it. Names persist across
restarts and appear in the list, header and search; an empty name restores the default.

Requires Node.js >=22.13.0 (built-in SQLite for refreshing persisted tool indexes)
and an installed, signed-in Codex CLI with App Server.
The bot-owned process defaults to HTTP streaming for the built-in OpenAI provider,
avoiding repeated WebSocket connection timeouts without changing the selected model
or reasoning effort. Runtime settings can restore automatic transport selection;
custom providers retain their configured transport.

```powershell
git clone https://github.com/Medo-bao/QQ-Bot-by-Codex.git
cd QQ-Bot-by-Codex
npm.cmd ci --ignore-scripts
.\scripts\install.ps1
```

Reopen Codex, select **QQ Bot**, and request setup. Or run
`node dist/cli.js setup` and open the returned local URL.

Default private access is allowlist; group access is disabled. Send an initial QQ message,
read the observed OpenID on the setup page, and add the intended user. Group execution
also requires group permission and an allowed initiating user.
Group members share one AI context with sender names and stable IDs. The conversation
view labels each author and reply recipient; QQ text replies mention the current requester.
Each turn reads the received group history before the current question. The SDK's
truncated history is no longer duplicated, and clarification answers join the same history.
Fallback group reply IDs must belong to that requester.
Received group messages and successful bot replies persist per group in
`group-messages.jsonl`, with recent context in `context.json`. Each turn includes
the configured number of complete preceding messages (10 by default), preserving
speaker IDs and available attachment paths instead of truncating text at 200 characters.
Authorized non-mention messages are recorded without triggering replies. Current
native group history is backfilled on first update and survives service restarts.
Queued requests exclude user messages received later. Explicit resets or role changes
start clean recent context while retaining the archive; unseen QQ history cannot be reconstructed.
The embedded and standalone Sessions views use an inline composer at the bottom.
The entire plugin fills the available page height. Direct send opens a separate
dialog for sending text and attachments through the bot without invoking AI.

The plugin uses your existing Codex login and model configuration. QQ threads are separate
from the desktop conversation. A shared local background process owns the QQ connection.
Select a private or group conversation in Sessions to set its model, provider,
effort, preset, workspace and role prompt independently. A custom session prompt
replaces the bot's default and preset prompts for that conversation. Saving does
not restart other sessions; changing prompts or presets starts new context while retaining the original thread history. Context resets
keep the per-conversation settings.
QQ uses a separate `codex-home`, seeded with the existing file-based login while
retaining provider and installed-tool configuration. QQ threads supply their own base instructions and exclude automatic Codex personal
instructions, AGENTS and memory injection. Legacy threads start clean context on
their next message; their original history remains in Codex.
API calls and access tokens use `api.bot.qq.com`. Passive replies share the
official per-message budget across ordinary messages, files and complete streams:
four replies within 60 minutes in private chats; five within five minutes in groups.
Message age starts at the original timestamp and redelivery does not extend it.
File delivery permits the current thread's `generated_images/<threadId>` folder
alongside workspaces, downloaded media and configured extra roots. Other threads'
generated-image folders are not automatically allowed.
File sending and image analysis resolve local `file:` URLs and `sandbox:` references
as well as absolute paths. One file is delivered once per turn even when both a tool
and a final Markdown link refer to it. Failure notifications include the actual reason.
`qqbot_send_file` accepts `send_as: "auto" | "file" | "voice"` in both entry points.
MP3 and other ordinary audio default to original files, without ZIP wrapping. Use
`file` to force a downloadable file (including images/videos), or `voice` when a
voice message is requested. Auto keeps image/video previews and native SILK/AMR
voice messages. The direct-send dialog exposes these choices for each attachment.
On the first cold resume after an upgrade, the bridge refreshes the persisted file
tool definition and index, retaining the thread ID and context so existing chats
also discover `send_as` and `voice`.
Full-access sessions copy requested files outside the allowed roots into the current
conversation archive before sending, preserving the filename. Other conversations'
archives remain isolated; restricted sessions still obey the send-root allowlist.
Parallel file calls share deduplication and per-turn quotas. Conversation cards
retain the delivered archive path and media kind, including original image files;
media-message receipts also restore quoted attachments.
`storageDir` selects the conversation archive root separately from the task workspace;
it defaults to `storage` under the local data directory. Files are grouped by bot ID,
private/group scope and stable peer ID. Each peer has `session.json`, Markdown/JSON
history per thread, incoming `attachments` and generated `files/<threadId>/images`.
Existing image folders migrate with their original native paths retained as directory
links. Names can change without moving files. Existing history is backfilled once,
then updated after each turn. Generated files and transcripts are retained; incoming
attachments follow the configured TTL. Native AI context and credentials remain in
the bot-owned runtime profile. Existing project files keep their current locations.
Use `node dist/cli.js stop` to stop the bridge, and `shutdown` to exit the background service.

Full setup, configuration and validation commands: [Chinese README](./README.md).

MIT. Upstream attribution and license are retained. Bundled third-party components
retain their own licenses; this adaptation is not an official Tencent/OpenAI release.
