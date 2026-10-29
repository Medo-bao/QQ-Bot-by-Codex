# Changelog

## 0.0.1 - 2026-10-29

The plugin version remains fixed at 0.0.1 for local updates.

- Persist complete group context, backfill existing native threads, retain received non-mention messages without replying, and include preceding multi-user messages plus bot replies on each turn.
- Preserve group context across restarts, prevent queued turns from seeing later user messages, and respect explicit context resets.

- Match Codex conversation typography, blue user bubbles, Markdown, code and tables; collapse per-turn activity and retain group sender identity.
- Preview local conversation images, copy replies and code, and return to the latest message.
- Add per-conversation execution scope, confirmation, network and search settings with global inheritance.
- Provide a Node HTTPS downloader for Windows sandbox TLS failures while respecting native network and filesystem permissions.
- Keep tool diagnostics in local activity unless QQ synchronization is enabled; report final delivery failures locally without recursively sending through a failed channel.
- Preserve QQ binding, shared group context, targeted mentions, prompt isolation, session names and dialogs, and per-conversation archives.
