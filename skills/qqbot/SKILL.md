---
name: qqbot
description: 设置、绑定和管理 QQ Bot，让 QQ 私聊或群聊通过本机 Codex 执行任务、接收回复和文件。在用户明确要求连接 QQ、查看 QQ 机器人状态或向指定 QQ 会话发送内容时使用。
---

# QQ Bot

The current plugin version is 0.0.2. Change it only when explicitly requested.

Use this plugin's `qqbot_*` MCP tools. If they are absent, ask the user to install
and enable `codex-qqbot` from the local marketplace, then open a new chat.

## Set up

1. Call `qqbot_status` to inspect the current state and existing settings.
2. Call `qqbot_setup` to display the complete settings app. It registers a global
   sidebar entry and a conversation panel entry. If the current host cannot render
   an MCP App, show its returned local URL as a clickable link and use
   `open_in_codex` to open that URL when available. The user scans with mobile QQ
   or enters AppID/AppSecret on that page; never request secrets in the chat.
3. Choose the user's intended workspace with `qqbot_configure` (`changes.cwd`).
   Leave the model unspecified unless the user chooses one. Codex uses its local
   login and provider configuration; there is no DSH runtime or separate LLM key.
4. Start with `qqbot_start` if not already connected after binding. The user can
   send a message to the bot; `qqbot_status.observedPeers` then shows the QQ OpenID.
   Add the intended user to `access.c2cAllow`. Group tasks also need group access
   plus permission for the initiating user. Default private access is allowlist
   and default group access is disabled. Only select `open` when the user asks.
5. Check `qqbot_status.connected` and explain the exact current state. A saved
   configuration alone does not prove a live QQ connection.

## Manage

- `qqbot_status`: read connection status, observed peers, thread IDs and questions.
- `qqbot_models`: list models and supported reasoning efforts from local Codex.
- `qqbot_configure`: save the requested settings. Model, prompt and permission updates
  apply without restarting tasks; connection changes wait for active tasks to finish.
- `qqbot_stop`: stop the connection and its current tasks when requested.

Each QQ private peer or group has an independent persistent Codex thread. Each
session can configure its own model, provider, effort, preset, workspace and
role prompt through the Session settings dialog. The Sessions pane displays real
history and a bottom inline composer in both the embedded app and standalone
browser page; desktop input continues the same AI thread and sends AI
replies to QQ. New sessions follow global settings by default. A custom session prompt
replaces the bot's default and preset prompts for that conversation only. QQ
threads use bot-owned base instructions and exclude automatic personal AGENTS,
developer instruction and memory injection from the user's Codex configuration.
Legacy threads start clean context on their first message after this update;
their original Codex history remains available. Resetting context keeps settings.
`storageDir` controls the user-facing archive separately from `cwd`. Stable bot and
peer IDs group Markdown/JSON history, received attachments and generated files.
Sessions can also override sandbox, approval policy, command network access and
web search. Empty values inherit global settings; restore-global clears all overrides.
Activity details are local by default, including recovered tool failures. Only sync
those diagnostics to QQ when the configured showToolResults option is enabled.
Session names appear in the toolbar and storage paths in Session settings. Native image directories point
to the peer's archive; generated files and history persist across context resets.
Recent group context is persistent and includes complete received messages with
stable speaker IDs and bot replies. Existing current-thread history is backfilled;
only messages actually delivered to the bot can be recovered. Authorized non-mention
messages remain context without triggering replies. Explicit resets clear recent
context and preserve archived records. The plugin version remains 0.0.2.
Group messages require an @mention by default. `/new`, `/compact`, `/model`, `/effort`,
`/preset`, `/stop`, `/bot-status`, `/bot-help` and `/answer` work inside QQ. Codex approvals
and questions are delivered to QQ; QQ replies must come from the task's initiating
user, using buttons or numbered/text replies. The authenticated local conversation
window can also answer requests in its selected conversation. A timeout grants
nothing. Images go into the model as image inputs; other attachments are saved
locally for Codex tools to inspect. Video/audio analysis depends on installed
tools and the selected model; QQ voice ASR text is forwarded when supplied.

## Send content from this chat

Call `qqbot_send_message` or `qqbot_send_file` only after a human explicitly asks
to send to the specified QQ user/group. Never send status reports, test messages
or files to other people on your own initiative. A request received through a
configured QQ session authorizes the bridge's reply to that same conversation;
it does not authorize unrelated recipients. Preserve the chosen destination and
text. File sends obey the configured workspace and extra-root allowlist.

QQ conversation threads automatically receive scoped `qqbot_send_file` and
`qqbot_ask_question` tools. They do not start another bridge MCP instance.
