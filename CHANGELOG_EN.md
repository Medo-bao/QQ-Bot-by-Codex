# Changelog

## 0.0.3 - 2026-10-30

- Refresh persisted file-tool metadata and indexes on cold resume so existing conversations discover `voice` without resetting context.

- Serialize parallel attachment delivery to enforce deduplication and quotas, and index media-message receipts for quotes.
- Preserve archived paths and delivery kinds in file cards, avoid duplicate image previews, and support BMP previews.

- Send ordinary audio such as MP3 as original files by default; add automatic, file and voice modes to delivery tools and the direct-send dialog.

- Archive requested external local files before sending from full-access sessions while retaining conversation isolation.
- Include tool failure details in logs and conversation activities, and clarify the supported image-generation parameters.

- Align plugin metadata, MCP services, UI, QQ version commands and SDK identification at 0.0.3.
- Include recent public reasoning summaries, settings reload and ordinary attachment retrieval fixes.

## 0.0.2 - 2026-10-30

- Cache ordinary group attachments, restore recent local paths before follow-ups, pass the latest attachment images to the model and retain cached downloads across redelivery and restarts.
- Release an idle thread subscription before resuming changed settings so cached sessions apply model and execution overrides without interrupting other tasks.
- Stream public reasoning summaries, plans and command output in chronological conversation activity, preserving history, folds and reading positions.
- Align plugin metadata, MCP services, UI, QQ version commands and SDK identification at 0.0.2.
- Reuse the existing daemon when concurrent plugin startups compete for the same address.
- Exclude desktop notification commands from bot workers and remove obsolete settings from the bot-owned config copy.
- Include timestamps and severity levels on every runtime log line.
- Default to HTTP streaming and provide received group history before the current question.

## 0.0.1 - 2026-10-29

Initial source release.

- Persist complete group context, backfill existing native threads, retain received non-mention messages without replying, and include preceding multi-user messages plus bot replies on each turn.
- Preserve group context across restarts, prevent queued turns from seeing later user messages, and respect explicit context resets.

- Match Codex conversation typography, blue user bubbles, Markdown, code and tables; collapse per-turn activity and retain group sender identity.
- Preview local conversation images, copy replies and code, and return to the latest message.
- Add per-conversation execution scope, confirmation, network and search settings with global inheritance.
- Provide a Node HTTPS downloader for Windows sandbox TLS failures while respecting native network and filesystem permissions.
- Keep tool diagnostics in local activity unless QQ synchronization is enabled; report final delivery failures locally without recursively sending through a failed channel.
- Preserve QQ binding, shared group context, targeted mentions, prompt isolation, session names and dialogs, and per-conversation archives.
