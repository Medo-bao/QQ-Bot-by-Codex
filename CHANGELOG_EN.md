# Changelog

## 0.0.8 - 2026-11-11

- Add an optional OpenAI Images API mode for generation and reference-image edits. Save results in the conversation so they can be resent if QQ delivery fails.
- Send GIFs through the QQ image channel by default. Reuse uploaded media when QQ reports an expired reply message ID, and fix lookup and display of URL-encoded filenames.
- Recover desktop task results from matching local completion records when the target history exceeds the read limit, and deliver them after QQ reconnects.
- Clarify expired desktop connection errors and improve Windows image processing and local GPT-SoVITS narration of long text.

## 0.0.7 - 2026-11-07

- Add Alibaba Cloud CosyVoice, MiniMax Speech, Xiaomi MiMo, and local GPT-SoVITS. Cloud services retain separate keys, models, and voices. Preview or download WAV clips, send them to QQ, and retry delivery independently.
- Tune speed and sampling in local GPT-SoVITS, load it on demand, and unload it when idle. Optional automatic narration follows text replies and skips turns that already sent voice.
- Mention individual members or everyone in the group direct-send dialog. Fall back to senders from group history when the QQ roster is unavailable, and retain unsent text after partial delivery.
- Resume Codex threads with their saved model provider to fix qqbot-openai-http and openai mismatches. Explicit provider changes continue in a fork and preserve the original thread.
- Show sent audio cards on voice-only replies in plugin conversations and preserve the association in the JSON archive.
- Improve settings save, loading, and error feedback. Keep the Windows daemon running after the Codex client exits and reduce tool and reasoning overhead for image analysis.

## 0.0.6 - 2026-11-03

- Restore the locally saved desktop/browser attachment after a QQ daemon restart and refresh it from parent-session status metadata; retain native account and browser permission checks.
- Add GPT-Live speech clips and prompt-created voices, local masked key setup, playback/download, cancellable background jobs, and file or QQ voice delivery with independent retry. Keep Codex task models, conversation archives and network permissions.
- Adapt upstream 0.5.5 image-format detection, merge-before-save session persistence, isolated atomic-write temporary files, `/bot-me`, QR failure fallback and binding-state refresh, retaining native Codex conversations and existing access settings.
- Add an off-by-default “Reply to @everyone” setting. It controls everyone-only mentions independently while preserving direct bot mentions and group-context recording.
- Deliver completed native image-generation results to QQ without waiting for a text answer or file link, sharing deduplication, limits, opt-out and failure feedback with explicit file sends. In mention-only mode, everyone-only mentions remain in group history without triggering replies.
- Retry transient download connection errors once within the original deadline and retain the underlying cause. Apply the same handling to web downloads and QQ attachments, preserve size limits and partial-file cleanup, and clarify waiting for background command results.
- Render native file citations in QQ replies and plugin chats; automatically deliver declared outputs without resending source files. Preserve Unicode across streaming and long-message boundaries.
- Set UTF-8 for Python tools, clarify available PDF readers instead of assuming fitz is installed, and decode child diagnostics across UTF-8 chunk boundaries.
- Read authenticated webpage content through the desktop browser, select exact URLs, preserve user tabs, allow canonical domain redirects and report truncation/blocked/unavailable states. Update tool routing so failed public fetches can use browser reads instead of login checks alone.
- Align package, plugin, MCP, UI, QQ version command and SDK metadata at 0.0.6; release source, tests, documentation and icons only.

## 0.0.5 - 2026-10-31

- Add desktop project-conversation browsing, recent replies/status, task dispatch, queueing and final-text delivery to QQ.
- Match results with a unique task marker to avoid unrelated turns; rotate polling across targets and retain pending cancellation and delivery retries.
- Add read-only website login checks through the desktop browser, distinguish signed in/out/unknown, and preserve native account/origin checks.
- Restore plugin MCP loading and QQ auto-start after desktop restarts with supported manifests, working-directory resolution and environment forwarding.
- Fix tool-index initialization while native rollout and database records are still being persisted, retaining original conversations and history.
- Preserve long Chinese text and emoji across UTF-8 chunks in local communication.
- Confirm final private-stream updates and closure before marking delivery; fall back to a complete reply on failure and index only confirmed sent text.
- Rewrite the Chinese and English README around installation, access, file delivery, project tasks and local data.
- Align package, plugin, MCP, UI, QQ command and SDK versions at 0.0.5; publish source, tests, documentation and icons only.

## 0.0.4 - 2026-10-31

- Delegate automatic compaction entirely to Codex, remove plugin toggles, percentage thresholds and retired settings, and retain native progress feedback and manual compaction.
- Add global and per-conversation context-window lengths in tokens, preserve Codex defaults and conversation history, and refresh usage statistics after the next response.
- Log Node runtime warnings, including SQLite experimental notices and trace hints, at WARN while retaining ERROR for actual failures.
- Read the effective catalog from compaction checkpoints and native tool-update records; append a catalog update so compacted conversations discover `voice` without rewriting history or shifting its indexed offsets.
- Synchronize all QQ tool definitions and indexes on cold resume, restore question and image-analysis tools missing from partial indexes, and leave rollout files untouched for index-only repairs.
- Align plugin metadata, MCP services, UI, QQ version commands and SDK identification at 0.0.4.

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
