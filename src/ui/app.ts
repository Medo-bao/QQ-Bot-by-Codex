import { App } from '@modelcontextprotocol/ext-apps';
import { renderMarkdown } from './markdown.ts';
import { permissionPicker, closePermissionMenus } from './permissions.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const mode = (window as any).__QQBOT_MODE__ as 'mcp' | 'http';
let app: App | undefined;
let state: any;
let draft: any;
let dirty = false;
let lastQr = '';
let busy = false;
let draftRevision = 0;
let savingGlobal = false;
let refreshFlight: Promise<void> | undefined;
let refreshAgain = false;
let connectionError: string | undefined;
let exited = false;
type View = 'sessions' | 'settings';
let view: View = 'sessions';
let selectedRobot = false;
let selectedSession: string | undefined;
let selectedSetting: string | undefined;
const collapsedBots = new Set<string>();
try { for (const id of JSON.parse(localStorage.getItem('qqbot.sidebar.collapsed') || '[]')) collapsedBots.add(id); } catch { /* Some embedded hosts do not provide local storage. */ }
let activeSearchQuery = '';
let searchGroupCollapsed = false;
let globalPermissionPicker: ReturnType<typeof permissionPicker> | undefined;
const directMessageDrafts = new Map<string, string>();
type DirectFile = { file: File; sendAs: 'auto' | 'file' | 'voice'; preview?: string; path?: string; status?: string };
const directFileDrafts = new Map<string, DirectFile[]>();
let directSending = false;
const dirtySessions = new Set<string>();
const sessionEditors = new Map<string, HTMLElement>();
const contextRequests = new Map<string, any>();
type ChatRecord = { threadId?: string | null; turnIds: string[]; messages: any[]; activities: any[]; activityOpen: Map<string, boolean>; previews: Map<string, string>; activeTurnId?: string; pending: any[]; optimistic: any[]; draft: string; draftRevision: number; scrollTop: number; followLatest: boolean; loaded: boolean; loading: boolean; olderLoaded: boolean; nextCursor?: string | null; lastActive?: number; error?: string; taskError?: string; sending?: boolean };
const chats = new Map<string, ChatRecord>();
const chatRecord = (key: string): ChatRecord => {
  if (!chats.has(key)) chats.set(key, { turnIds: [], messages: [], activities: [], activityOpen: new Map(), previews: new Map(), pending: [], optimistic: [], draft: '', draftRevision: 0, scrollTop: 0, followLatest: true, loaded: false, loading: false, olderLoaded: false });
  return chats.get(key)!;
};
type Field = { path: string; label: string; kind?: 'boolean' | 'number' | 'textarea' | 'lines' | 'select' | 'json'; options?: string[]; help?: string; wide?: boolean; list?: string; min?: number; max?: number };
const fields: Record<string, Field[]> = {
  connectionFields: [{ path: 'cwd', label: '工作目录', wide: true, help: 'Codex 执行任务与保存交付文件的位置。' }],
  accessFields: [
    { path: 'access.c2cMode', label: '私聊访问', kind: 'select', options: ['allowlist', 'open', 'disabled'] },
    { path: 'access.groupMode', label: '群聊访问', kind: 'select', options: ['disabled', 'allowlist', 'open'] },
    { path: 'access.c2cAllow', label: '允许的用户 OpenID', kind: 'lines', help: '每行一个。' },
    { path: 'access.groupAllow', label: '允许的群 OpenID', kind: 'lines', help: '每行一个。' },
  ],
  modelFields: [
    { path: 'modelProvider', label: '模型提供商', list: 'providers', help: '留空继承 Codex；可选择已配置的提供商。' },
    { path: 'model', label: '模型名称', list: 'models' },
    { path: 'effort', label: '推理强度', kind: 'select', options: ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { path: 'preset', label: '默认预设', help: '填入下方的预设 ID，留空使用普通会话。' },
  ],
  promptFields: [
    { path: 'requireMention', label: '群聊仅回复 @机器人的消息', kind: 'boolean', wide: true },
    { path: 'streaming', label: '私聊流式回复', kind: 'boolean', wide: true },
    { path: 'showToolResults', label: '显示工具执行结果', kind: 'boolean', wide: true },
    { path: 'directPrompt', label: '私聊额外提示词', kind: 'textarea', wide: true },
    { path: 'groupPrompt', label: '群聊额外提示词', kind: 'textarea', wide: true },
    { path: 'textChunkLimit', label: '单条消息字符上限', kind: 'number' },
    { path: 'historyLimit', label: '每轮补充的群聊历史条数', kind: 'number', help: '按群持久保存，补入完整消息和机器人回复；0 表示不额外补入。仅在 @机器人时触发回复。' },
  ],
  mediaFields: [
    { path: 'storageDir', label: '会话与资源存储目录', wide: true, help: '按机器人和会话分别归档聊天记录、附件及生成文件。留空使用本机数据目录下的 storage。' },
    { path: 'media.enabled', label: '接收图片与附件', kind: 'boolean', wide: true },
    { path: 'media.maxMB', label: '附件下载上限（MB）', kind: 'number' },
    { path: 'media.ttlHours', label: '附件保留时间（小时）', kind: 'number', help: '0 为永久保留。' },
    { path: 'vision.enabled', label: '启用图片理解', kind: 'boolean', wide: true },
    { path: 'vision.provider', label: '视觉模型提供商', list: 'providers', help: '留空继承对话模型。' },
    { path: 'vision.model', label: '视觉模型名称', list: 'models' },
    { path: 'vision.defaultPrompt', label: '默认图片分析提示词', kind: 'textarea', wide: true },
    { path: 'vision.maxBytes', label: '视觉输入大小上限（字节）', kind: 'number' },
    { path: 'vision.maxOutputChars', label: '图片分析回复字符上限', kind: 'number' },
    { path: 'vision.timeoutMs', label: '图片分析超时（毫秒）', kind: 'number' },
    { path: 'sendFile.sendPresentedFiles', label: '自动发送回复中声明的交付文件', kind: 'boolean', wide: true },
    { path: 'sendFile.restrictPaths', label: '限制文件发送目录', kind: 'boolean', wide: true, help: '开启时隔离其他会话的归档。完全访问会话可将外部文件自动归档到当前会话后发送，受限会话仍遵守目录白名单。' },
    { path: 'sendFile.maxFiles', label: '单轮最多发送文件数', kind: 'number' },
    { path: 'sendFile.extraRoots', label: '额外允许发送的目录', kind: 'lines', wide: true, help: '工作目录和媒体目录已自动允许；每行一个绝对目录。' },
  ],
  permissionFields: [
    { path: 'approvalPolicy', label: '操作确认方式', kind: 'select', options: ['on-request', 'untrusted', 'never'] },
    { path: 'sandbox', label: '执行范围', kind: 'select', options: ['workspace-write', 'read-only', 'danger-full-access'] },
    { path: 'approvalsReviewer', label: '审批处理方式', kind: 'select', options: ['user', 'auto_review'] },
    { path: 'networkAccess', label: '允许命令联网', kind: 'boolean', wide: true },
  ],
  runtimeFields: [
    { path: 'responsesTransport', label: 'OpenAI 模型连接方式', kind: 'select', options: ['http', 'auto'], help: '默认使用 HTTP 流式，避免 WebSocket 连接反复超时后才开始回复；自定义模型提供商保持原连接方式。' },
    { path: 'autoStart', label: '随 Codex 启动 QQ Bot', kind: 'boolean', wide: true, help: '默认开启：插件加载后自动连接已绑定的机器人。手动停止后，状态刷新不会重新启动连接。' },
    { path: 'webSearch', label: '网页搜索', kind: 'select', options: ['live', 'cached', 'indexed', 'disabled'] },
    { path: 'autoCompact', label: '默认自动压缩上下文', kind: 'boolean', wide: true },
    { path: 'autoCompactThreshold', label: '默认自动压缩阈值（%）', kind: 'number', min: 10, max: 95, help: '达到模型上下文容量的此比例后，在下一次回复前压缩；保留聊天记录。默认 80%。' },
    { path: 'sessionIdleTimeout', label: '空闲会话回收（毫秒）', kind: 'number' },
    { path: 'processingTimeoutMs', label: '单次任务超时（毫秒）', kind: 'number' },
    { path: 'askTimeoutMs', label: '问题与审批等待时间（毫秒）', kind: 'number' },
    { path: 'maxQueue', label: '每个会话最大排队数', kind: 'number' },
    { path: 'debug', label: '记录调试日志', kind: 'boolean', wide: true },
  ],
  advancedFields: [{ path: 'codexCommand', label: 'Codex 可执行文件', wide: true }, { path: 'codexArgs', label: 'App Server 附加启动参数', kind: 'lines', wide: true, help: '每行一个参数。' }],
};
const labels: Record<string, string> = { '': '跟随默认', http: 'HTTP 流式（稳定优先）', auto: '由 Codex 自动选择', enabled: '允许', live: '实时搜索', cached: '缓存搜索', indexed: '索引搜索', allowlist: '仅白名单', open: '开放', disabled: '关闭', 'on-request': '由 Codex 请求确认', untrusted: '不可信操作需要确认', never: '不请求确认', user: '由我批准', auto_review: 'Codex 自动审核', 'workspace-write': '可写工作目录', 'read-only': '只读', 'danger-full-access': '完全访问' };
const get = (object: any, path: string): any => path.split('.').reduce((value, key) => value?.[key], object);
const set = (object: any, path: string, value: any) => { const keys = path.split('.'); const final = keys.pop()!; const owner = keys.reduce((value, key) => value[key] ||= {}, object); owner[final] = value; };

async function api(action: string, payload: any = {}): Promise<any> {
  if (mode === 'mcp') {
    const result = await app!.callServerTool({ name: 'qqbot_ui', arguments: { action, payload } });
    const value: any = result.structuredContent || JSON.parse((result.content?.find((item: any) => item.type === 'text') as any)?.text || '{}');
    if (result.isError) throw new Error(value.error || '操作失败');
    return value;
  }
  const readOnly = ['status', 'models', 'catalog', 'account', 'qr'].includes(action);
  const response = await fetch(`/api/${action}`, readOnly ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '操作失败');
  return value;
}

function markDirty(): void { dirty = true; draftRevision++; globalPermissionPicker?.refresh(); $('saveStatus').textContent = '有尚未保存的设置'; $('feedback').textContent = ''; updateHeader(); }

const sessionKey = (session: any): string => `${session.scope}:${session.peerId}`;
const sessionIdentity = (session: any): string => `${session.scope === 'group' ? '群聊' : '私聊'} · ${session.peerId}`;
const sessionTitle = (session: any): string => session.name || sessionIdentity(session);

function updateHeader(): void {
  const button = $<HTMLButtonElement>('headerAction');
  button.disabled = savingGlobal || view === 'settings' && !dirty;
  button.textContent = view === 'settings' ? savingGlobal ? '保存中…' : '保存' : state?.config.credentialsConfigured ? '刷新' : '＋ 绑定';
  $<HTMLButtonElement>('save').disabled = savingGlobal || !dirty;
  $('save').textContent = savingGlobal ? '保存中…' : '保存';
  $<HTMLButtonElement>('reload').disabled = savingGlobal;
  $('collectionSummary').textContent = view === 'settings' ? '6 项设置' : `1 个机器人 · ${state?.sessions?.length || 0} 个会话`;
}

function showDetail(tab?: string): void {
  const wasSessionOpen = document.body.dataset.sessionOpen === 'true';
  document.querySelectorAll<HTMLElement>('.tab').forEach((section) => { section.hidden = section.id !== `tab-${tab}`; });
  $('emptyDetail').hidden = Boolean(tab);
  $('detailContent').hidden = !tab;
  $('detailFooter').hidden = !tab || tab === 'sessions';
  $('sessionTopbar').hidden = tab !== 'sessions';
  document.body.dataset.detailOpen = String(Boolean(tab));
  document.body.dataset.sessionOpen = String(tab === 'sessions');
  document.querySelector<HTMLElement>('.connection-actions')!.hidden = tab !== 'connection';
  $('emptyDetailText').textContent = view === 'sessions' ? '选择一项会话以查看' : '选择一项设置以查看';
  const key = ($('sessions').firstElementChild as HTMLElement | null)?.dataset.session;
  if (tab === 'sessions' && !wasSessionOpen && key) renderChatMessages(key);
}

function setView(next: View): void {
  view = next; document.body.dataset.view = view;
  document.querySelectorAll<HTMLButtonElement>('[data-view-button]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.viewButton === view)));
  $('botList').hidden = view !== 'sessions'; $('settingsNavigation').hidden = view !== 'settings';
  const search = $<HTMLInputElement>('listSearch');
  search.value = ''; search.placeholder = view === 'sessions' ? '搜索机器人或会话' : '搜索设置'; search.setAttribute('aria-label', search.placeholder);
  if (view === 'sessions') showDetail(selectedRobot ? 'connection' : selectedSession ? 'sessions' : undefined);
  else showDetail(selectedSetting);
  renderCollection(); updateHeader();
}

function selectSetting(tab: string): void {
  selectedSetting = tab;
  if (view !== 'settings') setView('settings');
  showDetail(tab);
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.tab === tab)));
  $('detailContent').scrollTop = 0;
}

function listRow(title: string, subtitle: string, meta: string, selected: boolean, active: boolean, clicked: () => void): HTMLButtonElement {
  const row = document.createElement('button'); row.className = 'list-row session-row'; row.dataset.selected = String(selected); row.dataset.busy = String(active); row.setAttribute('aria-pressed', String(selected)); row.title = `${title}\n${subtitle}`;
  const body = document.createElement('span'); body.className = 'row-body';
  const name = document.createElement('span'); name.className = 'row-title'; name.textContent = title;
  const status = document.createElement('span'); status.className = 'row-meta'; status.textContent = meta;
  body.append(name); row.append(body, status); row.onclick = clicked;
  return row;
}

function renderCollection(): void {
  if (!state) return;
  const query = $<HTMLInputElement>('listSearch').value.trim().toLowerCase();
  if (query !== activeSearchQuery) { activeSearchQuery = query; searchGroupCollapsed = false; }
  const binding = state.binding?.phase;
  const pending = ['starting', 'waiting', 'saving'].includes(binding);
  const subtitle = state.config.appId ? `AppID ${state.config.appId}` : '尚未绑定 · 使用手机 QQ 扫码连接';
  const botMatches = `QQ Bot ${subtitle}`.toLowerCase().includes(query);
  const matches = renderSessions(botMatches);
  $('botGroup').hidden = !botMatches && !matches;
  $('noMatchingSessions').hidden = botMatches || Boolean(matches);
  const expanded = query ? !searchGroupCollapsed : !collapsedBots.has(state.config.appId || 'unbound');
  $('toggleBotGroup').setAttribute('aria-expanded', String(expanded));
  $('toggleBotGroup').title = `${subtitle} · ${state.connected ? '已连接' : pending ? '等待扫码' : '未连接'}`;
  $('sessionList').hidden = !expanded;
  $('botSessionCount').textContent = String(matches);
  $('botGroupStatus').dataset.active = String(Boolean(state.connected || pending));
  $('botGroupStatus').title = state.connected ? '已连接' : pending ? '等待扫码' : '未连接';
  $('manageBot').setAttribute('aria-pressed', String(selectedRobot));
  if (view === 'sessions' && query) $('collectionSummary').textContent = `${matches} 个匹配会话`;
  let count = 0;
  document.querySelectorAll<HTMLButtonElement>('#settingsNavigation [data-tab]').forEach((button) => {
    button.hidden = !button.textContent?.toLowerCase().includes(query); if (!button.hidden) count++;
  });
  if (view === 'settings') $('collectionSummary').textContent = `${count} 项设置`;
}

function emptyList(container: HTMLElement, text: string): void {
  const message = document.createElement('p'); message.className = 'list-empty'; message.textContent = text; container.append(message);
}

function field(spec: Field, object: any, changed: () => void): HTMLElement {
  const label = document.createElement('label');
  label.className = `field ${spec.wide ? 'wide' : ''} ${spec.kind === 'boolean' ? 'toggle' : ''}`;
  const title = document.createElement('span'); title.textContent = spec.label; label.append(title);
  let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (['textarea', 'lines', 'json'].includes(spec.kind || '')) input = document.createElement('textarea');
  else if (spec.kind === 'select') {
    input = document.createElement('select');
    for (const value of spec.options || []) { const option = document.createElement('option'); option.value = value; option.textContent = labels[value] || value; input.append(option); }
  } else { input = document.createElement('input'); input.type = spec.kind === 'boolean' ? 'checkbox' : spec.kind === 'number' ? 'number' : 'text'; }
  input.setAttribute('data-field', spec.path);
  if (spec.min !== undefined) { input.setAttribute('min', String(spec.min)); input.setAttribute('required', ''); }
  if (spec.max !== undefined) input.setAttribute('max', String(spec.max));
  if (spec.list) input.setAttribute('list', spec.list);
  const value = get(object, spec.path);
  if (spec.kind === 'boolean') (input as HTMLInputElement).checked = Boolean(value);
  else input.value = spec.kind === 'lines' ? (value || []).join('\n') : spec.kind === 'json' ? JSON.stringify(value || {}, null, 2) : String(value ?? '');
  input.addEventListener('input', () => {
    try {
      const value = spec.kind === 'boolean' ? (input as HTMLInputElement).checked : spec.kind === 'number' ? Number(input.value)
        : spec.kind === 'lines' ? input.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : spec.kind === 'json' ? JSON.parse(input.value) : input.value;
      input.setCustomValidity(''); set(object, spec.path, value); changed();
    } catch { input.setCustomValidity('请输入合法的 JSON。'); changed(); }
  });
  label.append(input);
  if (spec.help) { const help = document.createElement('small'); help.textContent = spec.help; label.append(help); }
  return label;
}

function renderForm(): void {
  for (const [container, specs] of Object.entries(fields)) $(container).replaceChildren(...specs.map((spec) => field(spec, draft, markDirty)));
  globalPermissionPicker = permissionPicker(draft, $('tab-runtime'), markDirty);
  $('globalPermissions').replaceChildren(globalPermissionPicker.element);
  renderPresets();
}

function renderPresets(): void {
  $('presets').replaceChildren();
  for (const [id, value] of Object.entries(draft.presets || {})) {
    const preset = value as any;
    const card = document.createElement('div'); card.className = 'preset-card';
    const head = document.createElement('div'); head.className = 'card-head';
    const name = document.createElement('strong'); name.textContent = id;
    const remove = document.createElement('button'); remove.textContent = '删除'; remove.className = 'danger';
    remove.onclick = () => { delete draft.presets[id]; if (draft.preset === id) { draft.preset = ''; renderForm(); } else renderPresets(); markDirty(); };
    head.append(name, remove); card.append(head);
    const grid = document.createElement('div'); grid.className = 'fields';
    const specs: Field[] = [
      { path: 'name', label: '显示名称' }, { path: 'model', label: '模型', list: 'models' }, { path: 'modelProvider', label: '提供商', list: 'providers' },
      { path: 'effort', label: '推理强度', kind: 'select', options: ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { path: 'cwd', label: '工作目录覆盖', wide: true }, { path: 'prompt', label: '预设提示词', kind: 'textarea', wide: true },
      { path: 'skills', label: '技能名称', kind: 'lines', wide: true, help: '每行一个；会在新会话的首次请求中注入。' },
      { path: 'config', label: 'Codex 会话配置覆盖（JSON）', kind: 'json', wide: true },
    ];
    grid.append(...specs.map((spec) => field(spec, preset, markDirty))); card.append(grid); $('presets').append(card);
  }
  if (!Object.keys(draft.presets || {}).length) empty($('presets'), '还没有自定义预设。');
}

function empty(container: HTMLElement, text: string): void { const element = document.createElement('div'); element.className = 'empty'; element.textContent = text; container.append(element); }

async function action(name: string, payload: any = {}, success?: string): Promise<any> {
  if (busy) return;
  busy = true; $('error').textContent = ''; $('feedback').textContent = '';
  try { const result = await api(name, payload); if (success) $('feedback').textContent = success; if (name === 'shutdown') exited = true; else { exited = false; await refresh(true); } return result; }
  catch (error) { $('error').textContent = error instanceof Error ? error.message : String(error); }
  finally { busy = false; }
}

function renderPeers(): void {
  $('peers').replaceChildren();
  for (const [target, value] of Object.entries(state.observedPeers || {})) {
    const info = value as any;
    const card = document.createElement('div'); card.className = 'peer-card';
    const access = state.config.access;
    const groupId = target.startsWith('group:') ? target.slice(6) : '';
    const reason = info.allowed ? '已允许' : groupId && access.groupMode === 'disabled' ? '群聊访问已关闭'
      : groupId && access.groupMode === 'allowlist' && !access.groupAllow.includes(groupId) ? '此群不在允许列表'
      : !groupId && access.c2cMode === 'disabled' ? '私聊访问已关闭' : '发起人不在允许列表';
    const text = document.createElement('p'); text.textContent = `${target} · 用户 ${info.senderId} · ${reason}`; text.className = 'mono'; card.append(text);
    const allow = document.createElement('button'); allow.textContent = '允许此用户';
    allow.onclick = () => { draft.access.c2cAllow = [...new Set([...draft.access.c2cAllow, info.senderId])]; if (draft.access.c2cMode === 'disabled') draft.access.c2cMode = 'allowlist'; renderForm(); markDirty(); };
    card.append(allow);
    if (target.startsWith('group:')) {
      const group = document.createElement('button'); group.textContent = '允许此群';
      group.onclick = () => { draft.access.groupAllow = [...new Set([...draft.access.groupAllow, target.slice(6)])]; draft.access.groupMode = 'allowlist'; renderForm(); markDirty(); };
      card.append(group);
    }
    $('peers').append(card);
  }
  if (!$('peers').children.length) empty($('peers'), '连接后向机器人发送消息，来源会显示在这里。');
}

function renderSessions(botMatches?: boolean): number {
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.session-row')?.dataset.sessionKey;
  $('sessionList').replaceChildren();
  const query = $<HTMLInputElement>('listSearch').value.trim().toLowerCase();
  const showAll = botMatches ?? `QQ Bot ${state.config.appId || ''}`.toLowerCase().includes(query);
  let matches = 0;
  for (const session of state.sessions || []) {
    const key = sessionKey(session);
    const title = sessionTitle(session);
    if (showAll || `${title} ${sessionIdentity(session)} ${effectiveModel(session)} ${session.activePreset || ''}`.toLowerCase().includes(query)) {
      const row = listRow(title, `${sessionIdentity(session)} · ${effectiveModel(session)}`, session.busy ? '回复中' : session.queued ? '排队中' : '', key === selectedSession, session.busy, () => {
        selectedRobot = false; selectedSession = key; showDetail('sessions'); renderCollection();
      });
      row.dataset.sessionKey = key; $('sessionList').append(row); matches++;
    }
    if (key === selectedSession && view === 'sessions' && !selectedRobot) renderChat(session);
  }
  if (!$('sessionList').children.length) emptyList($('sessionList'), query ? '没有匹配的会话' : state.config.credentialsConfigured ? '收到 QQ 消息后，会话会显示在这里' : '绑定机器人后，会话会显示在这里');
  if (selectedSession && !(state.sessions || []).some((session: any) => sessionKey(session) === selectedSession)) {
    selectedSession = undefined; $('sessions').replaceChildren(); if (view === 'sessions') showDetail();
  }
  if (focused) Array.from($('sessionList').querySelectorAll<HTMLButtonElement>('.session-row')).find(row => row.dataset.sessionKey === focused)?.focus({ preventScroll: true });
  return matches;
}

function effectiveModel(session: any): string {
  const settings = session.settings || session;
  const model = settings.model && settings.model !== '(Codex default)' ? settings.model : '';
  return model || state.config.presets?.[settings.preset || state.config.preset]?.model || state.config.model || 'Codex 默认模型';
}

function renderChat(session: any): void {
  const key = sessionKey(session);
  const record = chatRecord(key);
  const current = $('sessions').firstElementChild as HTMLElement | null;
  if (current?.dataset.session !== key) {
    const panel = document.createElement('div'); panel.className = 'chat-window'; panel.dataset.session = key;
    const header = document.createElement('header'); header.className = 'chat-header';
    const heading = document.createElement('div'); heading.className = 'chat-heading';
    const titleRow = document.createElement('div'); titleRow.className = 'chat-title-row';
    const title = document.createElement('h2'); title.id = 'chatTitle';
    const rename = document.createElement('button'); rename.id = 'renameSession'; rename.className = 'rename-button'; rename.setAttribute('aria-label', '重命名会话'); rename.title = '重命名会话';
    rename.innerHTML = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m12.7 3.3 4 4M3 17l4.2-.8L17 6.4a1.8 1.8 0 0 0-3.4-3.4L3.8 12.8 3 17Z" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    rename.onclick = () => openRenameSession(state.sessions.find((item: any) => sessionKey(item) === key));
    const taskStatus = document.createElement('span'); taskStatus.id = 'chatTaskStatus'; taskStatus.className = 'chat-task-status'; taskStatus.setAttribute('role', 'status');
    titleRow.append(title, rename, taskStatus);
    const context = document.createElement('p'); context.id = 'chatContextOperation'; context.className = 'context-operation'; context.setAttribute('role', 'status');
    heading.append(titleRow);
    const actions = document.createElement('div'); actions.className = 'row chat-header-actions';
    const stop = document.createElement('button'); stop.id = 'chatStop'; stop.textContent = '中止';
    stop.onclick = async () => {
      const pending = new Set(record.optimistic.map(item => item.id));
      const result = await action('session', { scope: session.scope, target_id: session.peerId, action: 'stop' }, '已请求中止');
      if (result) { record.optimistic = record.optimistic.filter(item => !pending.has(item.id)); renderChatMessages(key); }
    };
    const settings = document.createElement('button'); settings.id = 'openSessionSettings'; settings.textContent = '会话设置';
    settings.onclick = () => openSessionSettings(state.sessions.find((item: any) => sessionKey(item) === key));
    actions.append(stop, settings);
    const direct = document.createElement('button'); direct.id = 'openDirectMessage'; direct.textContent = '直接发送'; direct.title = '通过机器人直接发送原文';
    direct.onclick = () => openDirectMessage(key); actions.append(direct);
    header.append(heading, actions);
    const history = document.createElement('div'); history.id = 'chatHistory'; history.className = 'chat-history'; history.setAttribute('aria-label', '聊天记录');
    const composer = document.createElement('form'); composer.className = 'chat-composer'; composer.id = 'chatComposer';
    const box = document.createElement('div'); box.className = 'composer-box';
    const input = document.createElement('textarea'); input.id = 'chatInput'; input.setAttribute('aria-label', '输入消息'); input.placeholder = '输入消息，继续这段会话'; input.value = record.draft;
    const tools = document.createElement('div'); tools.className = 'composer-actions';
    const shortcut = document.createElement('small'); shortcut.textContent = 'Enter 发送 · Shift+Enter 换行';
    const send = document.createElement('button'); send.id = 'chatSend'; send.className = 'primary'; send.type = 'submit'; send.textContent = '发送 ↑';
    const contextUsage = document.createElement('small'); contextUsage.id = 'chatContextUsage'; contextUsage.className = 'context-usage'; contextUsage.setAttribute('role', 'status');
    const info = document.createElement('div'); info.className = 'composer-info'; info.append(shortcut, contextUsage);
    tools.append(info, send); box.append(input, tools);
    const error = document.createElement('p'); error.id = 'chatSendError'; error.className = 'chat-error'; error.setAttribute('role', 'alert');
    const note = document.createElement('p'); note.className = 'composer-note'; note.textContent = '与 QQ 共用会话，AI 回复会同步到 QQ。';
    composer.append(box, error, note); composer.onsubmit = (event) => { event.preventDefault(); void submitChat(session); };
    const resize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(180, Math.max(62, input.scrollHeight))}px`; };
    input.oninput = () => { record.draft = input.value; record.draftRevision++; resize(); send.disabled = Boolean(record.sending) || !state.connected || !input.value.trim(); };
    input.onkeydown = (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!send.disabled) composer.requestSubmit(); } };
    const timeline = document.createElement('div'); timeline.className = 'chat-timeline';
    const latest = document.createElement('button'); latest.id = 'scrollToLatest'; latest.className = 'scroll-latest'; latest.textContent = '↓'; latest.setAttribute('aria-label', '回到最新消息'); latest.hidden = true;
    latest.onclick = () => history.scrollTo({ top: history.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    history.onscroll = () => {
      if (!history.clientHeight) return;
      record.scrollTop = history.scrollTop;
      record.followLatest = history.scrollHeight - history.scrollTop - history.clientHeight < 100;
      latest.hidden = record.followLatest;
    };
    timeline.append(history, latest); panel.append(context, timeline);
    $('sessionTopbar').replaceChildren(header);
    panel.append(composer);
    $('sessions').replaceChildren(panel); resize(); renderChatMessages(key);
  }
  $('chatTitle').textContent = sessionTitle(session); $('chatTitle').title = sessionIdentity(session);
  $('chatStorage').textContent = session.storage?.directory ? `存储目录：${session.storage.directory}` : '';
  $('chatStorage').title = session.storage?.directory || '';
  const permissions = session.permissions || state.config;
  $('chatPermissions').textContent = `${labels[permissions.sandbox] || ''} · ${labels[permissions.approvalPolicy] || ''} · ${permissions.networkAccess ? '允许联网' : '命令不联网'} · ${labels[permissions.webSearch] || '网页搜索'}`;
  record.taskError = session.lastError;
  const values = session.settings || session;
  const custom = ['model', 'modelProvider', 'effort', 'preset', 'cwd', 'sandbox', 'approvalPolicy', 'approvalsReviewer', 'networkAccess', 'webSearch'].some((name) => values[name] && values[name] !== '(Codex default)') || values.prompt != null || values.autoCompact != null || values.autoCompactThreshold != null;
  const operation = contextRequests.get(key) || session.contextOperation;
  const progress = operation?.status === 'running' ? operation.kind === 'compact' ? '正在压缩历史' : '正在重置上下文' : undefined;
  $('chatState').textContent = `${progress || (session.busy ? 'AI 正在回复' : session.queued ? '正在准备会话' : '已就绪')} · ${effectiveModel(session)} · ${custom ? '独立设置' : '跟随全局设置'}`;
  const waiting = state.pending?.some((item: any) => item.target.scope === session.scope && item.target.targetId === session.peerId);
  const taskStatus = progress || (waiting ? '等待回答' : session.busy ? `回复中${session.queued > 1 ? ` · 排队 ${session.queued - 1}` : ''}` : session.queued ? `排队 ${session.queued}` : '');
  $('chatTaskStatus').textContent = taskStatus; $('chatTaskStatus').hidden = !taskStatus;
  renderContextUsage(session);
  $<HTMLButtonElement>('chatStop').disabled = !session.busy && !session.queued;
  $<HTMLButtonElement>('openDirectMessage').disabled = !state.connected || directSending;
  $<HTMLButtonElement>('chatSend').disabled = !state.connected || !record.draft.trim() || Boolean(record.sending);
  $('chatSend').textContent = record.sending ? '提交中…' : '发送 ↑';
  if ($<HTMLDialogElement>('sessionSettingsDialog').open && $('sessionSettingsDialog').dataset.session === key) {
    $<HTMLButtonElement>('saveSession').disabled = Boolean(session.busy || session.queued || $('saveSession').dataset.saving) || !dirtySessions.has(key);
  }
  renderContextOperation(session);
  if (view === 'sessions' && (!record.loaded || record.threadId !== (session.threadId || null) || session.busy || session.queued || record.lastActive !== session.lastActive)) void loadConversation(session);
}

async function loadConversation(session: any, cursor?: string, force = false): Promise<void> {
  const key = sessionKey(session); const record = chatRecord(key);
  if (record.loading) return;
  if (!force && !cursor && record.loaded && !session.busy && !session.queued && record.lastActive === session.lastActive && record.threadId === (session.threadId || null)) return;
  record.loading = true; record.error = undefined;
  try {
    const data = await api('session', { scope: session.scope, target_id: session.peerId, action: 'history', ...(cursor ? { cursor } : {}) });
    if (record.threadId !== data.threadId) { record.turnIds = []; record.messages = []; record.activities = []; record.activityOpen.clear(); record.previews.clear(); record.scrollTop = 0; record.followLatest = true; record.olderLoaded = false; record.nextCursor = null; }
    record.threadId = data.threadId;
    const turns = new Set(data.turnIds || []);
    const order = [...(data.turnIds || [])].reverse();
    record.turnIds = [...new Set<string>(cursor ? [...order, ...record.turnIds] : [...record.turnIds.filter(id => !turns.has(id)), ...order])];
    const retained = record.messages.filter((message) => !turns.has(message.turnId));
    const combined = cursor ? [...data.messages, ...retained] : [...retained, ...data.messages];
    record.messages = [...new Map(combined.map((message: any) => [message.id, message])).values()];
    record.activities = [...new Map([...record.activities.filter((item) => !turns.has(item.turnId)), ...(data.activities || [])].map((item: any) => [item.id, item])).values()];
    record.activeTurnId = data.activeTurnId;
    if (cursor || !record.olderLoaded) record.nextCursor = data.nextCursor;
    if (cursor) record.olderLoaded = true;
    record.pending = data.pending || [];
    if (!cursor) for (const message of data.messages.filter((item: any) => item.role === 'user' && item.source === 'local')) {
      const index = record.optimistic.findIndex(item => item.text === message.text && !item.knownUserIds.includes(message.id));
      if (index < 0) continue;
      record.optimistic.splice(index, 1);
      for (const pending of record.optimistic) if (!pending.knownUserIds.includes(message.id)) pending.knownUserIds.push(message.id);
    }
    record.loaded = true; record.lastActive = session.lastActive;
  } catch (error) { record.error = error instanceof Error ? error.message : String(error); }
  finally { record.loading = false; if (selectedSession === key) renderChatMessages(key, Boolean(cursor)); }
}

function fileCard(file: { path: string; name: string; image?: boolean }, key: string): HTMLElement {
  const record = chatRecord(key); const card = document.createElement('figure'); card.className = 'message-file';
  card.dataset.filePath = file.path;
  const image = file.image ?? /\.(png|jpe?g|gif|webp|bmp)(?:\?.*)?$/i.test(file.path);
  const show = (url: string) => { const img = document.createElement('img'); img.src = url; img.alt = file.name; img.loading = 'lazy'; card.replaceChildren(img); const caption = document.createElement('figcaption'); caption.textContent = file.name; card.append(caption); };
  const cached = record.previews.get(file.path); if (cached && image) { show(cached); return card; }
  const button = document.createElement('button'); button.type = 'button'; button.className = 'file-button'; button.textContent = `${image ? '查看图片' : '复制文件路径'} · ${file.name}`; button.title = file.path;
  button.onclick = async () => {
    if (/^https?:/i.test(file.path)) { if (app) await app.openLink({ url: file.path }); else window.open(file.path, '_blank', 'noopener,noreferrer'); return; }
    if (!image) { try { await navigator.clipboard.writeText(file.path); button.textContent = '路径已复制'; } catch { button.textContent = file.path; } return; }
    button.disabled = true; button.textContent = '正在读取图片…';
    try { const session = state.sessions.find((item: any) => sessionKey(item) === key); const result = await api('session', { scope: session.scope, target_id: session.peerId, action: 'preview', file_path: file.path }); record.previews.set(file.path, result.dataUrl); show(result.dataUrl); }
    catch (error) { button.textContent = error instanceof Error ? error.message : String(error); button.disabled = false; }
  };
  card.append(button); return card;
}

function localFileKey(path: string): string {
  let local = path.replace(/^sandbox:/i, '');
  if (/^file:/i.test(local)) { try { local = decodeURIComponent(new URL(local).pathname).replace(/^\/([a-z]:)/i, '$1'); } catch { /* A malformed link stays a literal file reference. */ } }
  local = local.replace(/\\/g, '/');
  return /^[a-z]:/i.test(local) ? local.toLowerCase() : local;
}

function richText(text: string, key: string, files: Array<{ path: string; name: string; image?: boolean; aliases?: string[] }> = []): HTMLElement {
  const rendered = renderMarkdown(text);
  const shown = new Set<string>();
  for (const file of rendered.querySelectorAll<HTMLElement>('[data-qq-file]')) {
    const path = file.dataset.qqFile!;
    const sent = files.find(entry => [entry.path, ...(entry.aliases || [])].some(alias => localFileKey(alias) === localFileKey(path)));
    const fileKey = localFileKey(sent?.path || path);
    if (shown.has(fileKey)) { file.replaceWith(document.createTextNode(file.textContent || '')); continue; }
    shown.add(fileKey);
    file.replaceWith(fileCard(sent || { path, name: file.textContent || path.replace(/\\/g, '/').split('/').pop()! }, key));
  }
  for (const link of rendered.querySelectorAll<HTMLAnchorElement>('a[href]')) link.onclick = (event) => { if (app) { event.preventDefault(); void app.openLink({ url: link.href }); } };
  return rendered;
}

function renderChatMessages(key: string, older = false): void {
  if ($('sessions').firstElementChild?.getAttribute('data-session') !== key) return;
  const container = $('chatHistory'); const record = chatRecord(key);
  const focus = document.activeElement as HTMLElement | null;
  const focusedActivity = focus?.tagName === 'SUMMARY' && container.contains(focus) ? focus.parentElement?.dataset.activityKey : undefined;
  const logPositions = new Map<string, number>();
  for (const log of container.querySelectorAll<HTMLElement>('.activity-tool > pre')) {
    const activityKey = log.parentElement?.dataset.activityKey; if (activityKey) logPositions.set(activityKey, log.scrollTop);
  }
  const oldHeight = container.scrollHeight; const oldTop = container.scrollTop;
  const { scrollTop, followLatest } = record;
  const messages = document.createElement('div'); messages.className = 'chat-messages';
  if (record.nextCursor) {
    const more = document.createElement('button'); more.className = 'load-history'; more.textContent = '加载更早消息';
    more.onclick = async () => { const session = state.sessions.find((item: any) => sessionKey(item) === key); if (session) { more.disabled = true; more.textContent = '正在加载…'; await loadConversation(session, record.nextCursor!, true); } };
    messages.append(more);
  }
  const all = [...record.messages, ...record.optimistic]; const activityTurns = new Set<string>();
  const activityGroup = (turnId: string) => {
    if (!turnId || activityTurns.has(turnId)) return; activityTurns.add(turnId);
    const comments = all.filter((message) => message.turnId === turnId && message.phase === 'commentary');
    const tools = record.activities.filter((item) => item.turnId === turnId);
    if (!comments.length && !tools.length && turnId !== record.activeTurnId) return;
    const details = document.createElement('details'); details.className = 'turn-activity'; details.dataset.turn = turnId;
    details.dataset.activityKey = `turn:${turnId}`;
    details.open = record.activityOpen.get(turnId) ?? turnId === record.activeTurnId;
    let renderedOpen = details.open;
    details.ontoggle = () => { if (details.isConnected && details.open !== renderedOpen) { record.activityOpen.set(turnId, details.open); renderedOpen = details.open; } };
    const summary = document.createElement('summary');
    const thinking = tools.some(tool => tool.kind === 'reasoning' && tool.status === 'running');
    const label = document.createElement('span'); label.className = 'activity-label'; label.textContent = turnId === record.activeTurnId ? thinking ? '正在思考' : '正在处理' : tools.some(tool => tool.kind === 'reasoning') ? '思考与活动' : '活动';
    const count = document.createElement('span'); count.className = 'activity-count'; count.textContent = tools.length ? tools.map((tool) => tool.label).filter((label, index, values) => values.indexOf(label) === index).join(' · ') : comments.length ? `${comments.length} 条进展` : '等待模型响应…';
    summary.append(label, count); details.append(summary);
    const body = document.createElement('div'); body.className = 'activity-body';
    const entries = [...comments.map((comment, index) => ({ comment, tool: null as any, order: comment.order ?? index })),
      ...tools.map((tool, index) => ({ tool, comment: null as any, order: tool.order ?? comments.length + index }))].sort((a, b) => a.order - b.order);
    for (const { comment, tool } of entries) {
      if (comment) { const entry = richText(comment.text, key); entry.classList.add('activity-comment'); body.append(entry); continue; }
      const prose = tool.kind === 'reasoning' || tool.kind === 'plan';
      const entry = document.createElement('details'); entry.className = `activity-tool${prose ? ' activity-prose' : ''}`; entry.dataset.status = tool.status; entry.dataset.kind = tool.kind;
      const openKey = `tool:${tool.id}`;
      entry.dataset.activityKey = openKey;
      entry.open = record.activityOpen.get(openKey) ?? (prose && tool.status === 'running');
      let renderedOpen = entry.open;
      entry.ontoggle = () => { if (entry.isConnected && entry.open !== renderedOpen) { record.activityOpen.set(openKey, entry.open); renderedOpen = entry.open; } };
      const title = document.createElement('summary'); title.textContent = `${tool.status === 'failed' ? '未完成 · ' : ''}${tool.kind === 'reasoning' && tool.status === 'running' ? '正在思考' : tool.label}`; entry.append(title);
      if (tool.detail) {
        const detail = prose ? richText(tool.detail, key) : document.createElement('pre');
        if (!prose) detail.textContent = tool.detail;
        entry.append(detail);
      } else if (prose && tool.status === 'running') {
        const pending = document.createElement('p'); pending.className = 'activity-placeholder'; pending.textContent = tool.kind === 'reasoning' ? '正在等待思考摘要…' : '正在整理计划…'; entry.append(pending);
      }
      body.append(entry);
    }
    details.append(body); messages.append(details);
  };
  let activityPosition = 0;
  const positions = new Map(record.turnIds.map((id, index) => [id, index]));
  for (const message of all) {
    const position = positions.get(message.turnId);
    if (position !== undefined) while (activityPosition < position) activityGroup(record.turnIds[activityPosition++]!);
    if (message.role === 'assistant') activityGroup(message.turnId || '');
    if (message.phase === 'commentary') continue;
    const article = document.createElement('article'); article.className = 'chat-message'; article.dataset.role = message.role; article.dataset.phase = message.phase || '';
    const author = document.createElement('span'); author.className = 'message-author';
    const member = (name?: string, id?: string) => name && name !== id ? `${name}${id ? ` · ${id.slice(0, 6)}` : ''}` : id ? `成员 ${id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id}` : name || 'QQ 用户';
    author.textContent = message.role === 'assistant' ? message.replyToId || message.replyToName ? `QQ Bot → ${member(message.replyToName, message.replyToId)}` : ''
      : message.scope === 'group' ? member(message.authorName, message.authorId) : '';
    author.title = message.role === 'assistant' ? message.replyToId || '' : message.authorId || '';
    const text = message.role === 'assistant' ? richText(message.text, key, message.files) : document.createElement('div');
    if (message.role !== 'assistant') { text.className = 'message-text'; text.textContent = message.text; }
    article.append(author, text);
    for (const file of message.files || []) if (![...text.querySelectorAll<HTMLElement>('.message-file')].some(card => card.dataset.filePath === file.path)) article.append(fileCard(file, key));
    if (message.role === 'assistant' && message.text) {
      const copy = document.createElement('button'); copy.className = 'copy-message'; copy.type = 'button'; copy.textContent = '复制'; copy.setAttribute('aria-label', '复制回复');
      copy.onclick = async () => { try { await navigator.clipboard.writeText(message.text); copy.textContent = '已复制'; } catch { copy.textContent = '复制失败'; } };
      article.append(copy);
    }
    messages.append(article);
  }
  while (activityPosition < record.turnIds.length) activityGroup(record.turnIds[activityPosition++]!);
  for (const tool of record.activities) activityGroup(tool.turnId || '');
  if (record.activeTurnId) activityGroup(record.activeTurnId);
  if (!record.messages.length && !record.optimistic.length) {
    const emptyState = document.createElement('div'); emptyState.className = 'chat-empty';
    const title = document.createElement('strong'); title.textContent = record.loaded ? '开始这段对话' : '正在读取会话';
    const hint = document.createElement('span'); hint.textContent = 'QQ 与这里的消息会使用同一段 AI 上下文。';
    emptyState.append(title, hint); messages.append(emptyState);
  }
  for (const pending of record.pending) {
    const question = document.createElement('section'); question.className = 'chat-pending';
    const title = document.createElement('h3'); title.textContent = '等待你的回答';
    const text = document.createElement('p'); text.textContent = pending.text;
    const options = document.createElement('div'); options.className = 'row';
    for (const [index, label] of (pending.options || []).entries()) {
      if (pending.multiple) { const choice = document.createElement('span'); choice.textContent = `${index + 1}. ${label}`; options.append(choice); continue; }
      const button = document.createElement('button'); button.textContent = label;
      button.onclick = () => { const session = state.sessions.find((item: any) => sessionKey(item) === key); if (session) void submitChat(session, `/answer ${pending.token} ${index + 1}`); };
      options.append(button);
    }
    if (pending.multiple) { const hint = document.createElement('p'); hint.textContent = '在输入框填写多个编号，以逗号分隔。'; question.append(hint); }
    question.append(title, text, options); messages.append(question);
  }
  if (record.error || record.taskError) { const error = document.createElement('p'); error.textContent = record.error || record.taskError || ''; error.className = 'chat-error'; error.setAttribute('role', 'alert'); messages.append(error); }
  container.replaceChildren(messages);
  for (const log of container.querySelectorAll<HTMLElement>('.activity-tool > pre')) log.scrollTop = logPositions.get(log.parentElement?.dataset.activityKey || '') || 0;
  if (focusedActivity) {
    const restored = [...container.querySelectorAll<HTMLElement>('details[data-activity-key]')].find(item => item.dataset.activityKey === focusedActivity);
    restored?.querySelector<HTMLElement>(':scope > summary')?.focus({ preventScroll: true });
  }
  if (container.clientHeight) {
    container.scrollTop = older ? oldTop + container.scrollHeight - oldHeight : followLatest ? container.scrollHeight : scrollTop;
    record.scrollTop = container.scrollTop;
    record.followLatest = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    $('scrollToLatest').hidden = record.followLatest;
  }
}

async function submitChat(session: any, answer?: string): Promise<void> {
  const key = sessionKey(session); const record = chatRecord(key); const text = (answer || record.draft).trim();
  if (!text || record.sending) return;
  const restoreFocus = selectedSession === key && [document.getElementById('chatInput'), document.getElementById('chatSend')].includes(document.activeElement as HTMLElement);
  record.sending = true; record.error = undefined;
  record.followLatest = true;
  const submittedRevision = record.draftRevision;
  const knownUserIds = record.messages.filter(item => item.role === 'user' && item.source === 'local').map(item => item.id);
  if (selectedSession === key) $('chatSendError').textContent = '';
  if (selectedSession === key) { $<HTMLButtonElement>('chatSend').disabled = true; $('chatSend').textContent = '提交中…'; }
  try {
    await api('session', { scope: session.scope, target_id: session.peerId, action: 'chat', text });
    if (!record.pending.length) record.optimistic.push({ id: `local-pending-${Date.now()}`, role: 'user', source: 'local', text, knownUserIds });
    if (!answer && record.draftRevision === submittedRevision) {
      record.draft = '';
      if (selectedSession === key) { const input = $<HTMLTextAreaElement>('chatInput'); input.value = ''; input.style.height = '62px'; }
    }
    renderChatMessages(key); await refresh(true);
    const current = state.sessions.find((item: any) => sessionKey(item) === key);
    if (current) await loadConversation(current, undefined, true);
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    if (selectedSession === key) $('chatSendError').textContent = record.error;
    renderChatMessages(key);
  }
  finally {
    record.sending = false;
    if (selectedSession === key) {
      $<HTMLButtonElement>('chatSend').disabled = !state.connected || !record.draft.trim(); $('chatSend').textContent = '发送 ↑';
      const input = $('chatInput');
      if (restoreFocus && view === 'sessions' && !selectedRobot && !document.querySelector('dialog[open]') && [document.body, input, $('chatSend')].includes(document.activeElement as HTMLElement)) input.focus({ preventScroll: true });
    }
  }
}

const fileSize = (bytes: number): string => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function updateDirectSend(): void {
  const key = $('directMessageDialog').dataset.draft!;
  $<HTMLButtonElement>('sendDirectMessage').disabled = !state.connected || directSending ||
    (!$<HTMLTextAreaElement>('directMessageText').value.trim() && !directFileDrafts.get(key)?.length);
}

function renderDirectFiles(): void {
  const key = $('directMessageDialog').dataset.draft!;
  $('directFileList').replaceChildren(...(directFileDrafts.get(key) || []).map(entry => {
    const row = document.createElement('div'); row.className = 'direct-file';
    if (entry.preview) { const image = document.createElement('img'); image.src = entry.preview; image.alt = entry.file.name; row.append(image); }
    const body = document.createElement('div'); body.className = 'direct-file-body';
    const name = document.createElement('strong'); name.textContent = entry.file.name;
    const status = document.createElement('small'); status.textContent = `${fileSize(entry.file.size)} · ${entry.status || '等待发送'}`;
    body.append(name, status);
    const mode = document.createElement('select'); mode.setAttribute('aria-label', `${entry.file.name} 的发送方式`); mode.disabled = directSending;
    const audio = entry.file.type.startsWith('audio/') || /\.(mp3|wav|ogg|aac|flac|m4a|silk|amr)$/i.test(entry.file.name);
    for (const [value, label] of [['auto', '自动识别'], ['file', '按文件发送'], ...(audio ? [['voice', '按语音发送']] : [])]) {
      const option = document.createElement('option'); option.value = value!; option.textContent = label!; mode.append(option);
    }
    mode.value = entry.sendAs; mode.onchange = () => { entry.sendAs = mode.value as DirectFile['sendAs']; };
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除'; remove.disabled = directSending; remove.setAttribute('aria-label', `移除 ${entry.file.name}`);
    remove.onclick = () => {
      if (entry.preview) URL.revokeObjectURL(entry.preview);
      directFileDrafts.set(key, (directFileDrafts.get(key) || []).filter(item => item !== entry)); renderDirectFiles();
    };
    row.append(body, mode, remove); return row;
  }));
  $<HTMLButtonElement>('addDirectFiles').disabled = directSending;
  $('directFileLimit').textContent = `可拖入文件或粘贴图片 · 最多 ${state.config.sendFile.maxFiles} 个，每个不超过 ${state.config.media.maxMB} MB · MP3 等普通音频默认按文件发送`;
  updateDirectSend();
}

async function uploadDirectFile(session: any, entry: DirectFile): Promise<string> {
  const id = crypto.randomUUID();
  for (let offset = 0; offset < entry.file.size;) {
    const bytes = new Uint8Array(await entry.file.slice(offset, offset + 256 * 1024).arrayBuffer());
    let binary = '';
    for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
    const result = await api('session', { action: 'upload', scope: session.scope, target_id: session.peerId,
      upload_id: id, file_name: entry.file.name, file_size: entry.file.size, offset, data: btoa(binary) });
    offset = result.received;
    entry.status = `上传 ${Math.round(offset / entry.file.size * 100)}%`; renderDirectFiles();
    if (result.file_path) entry.path = result.file_path;
  }
  if (!entry.path) throw new Error('文件上传未完成。');
  return entry.path;
}

function openDirectMessage(key: string): void {
  if (directSending || !state.connected) return;
  const dialog = $<HTMLDialogElement>('directMessageDialog');
  const target = $<HTMLSelectElement>('directMessageTarget');
  target.replaceChildren(...state.sessions.map((session: any) => {
    const option = document.createElement('option'); option.value = sessionKey(session);
    option.textContent = `${sessionTitle(session)} · ${session.scope === 'group' ? '群聊' : '私聊'}`;
    return option;
  }));
  target.value = key;
  dialog.dataset.draft = `${state.config.appId}:${key}`;
  $<HTMLTextAreaElement>('directMessageText').value = directMessageDrafts.get(dialog.dataset.draft) || '';
  $('directMessageError').textContent = '';
  $('directMessageProgress').textContent = ''; renderDirectFiles();
  dialog.showModal(); $<HTMLTextAreaElement>('directMessageText').focus();
}

function renderContextUsage(session: any): void {
  const usage = session.contextUsage;
  const value = session.settings || session;
  const settings = session.contextSettings || { autoCompact: value.autoCompact ?? state.config.autoCompact, threshold: value.autoCompactThreshold ?? state.config.autoCompactThreshold };
  let text = !session.threadId ? '上下文：新会话' : '上下文：等待统计';
  if (usage && !usage.stale && usage.threadId === session.threadId) {
    const used = Number(usage.usedTokens).toLocaleString('zh-CN');
    text = usage.windowTokens ? `上下文 ${used} / ${Number(usage.windowTokens).toLocaleString('zh-CN')} Tokens · ${Math.round(usage.usedTokens / usage.windowTokens * 100)}%` : `上下文 ${used} Tokens · 容量未提供`;
  } else if (usage?.stale) text = '上下文：等待重新统计';
  $('chatContextUsage').textContent = text;
  $('chatContextUsage').title = '依据模型最近一次输入与输出 Token 统计，非累计计费用量。压缩后等待下一次回复更新。';
  $('contextUsageDetails').textContent = `${text} · ${settings.autoCompact ? `自动压缩阈值 ${settings.threshold}%` : '自动压缩已关闭'}`;
}

function renderContextOperation(session: any): void {
  const key = sessionKey(session); const operation = contextRequests.get(key) || session.contextOperation;
  const running = operation?.status === 'running';
  const elapsed = running ? ` · 已进行 ${Math.floor(Math.max(0, Date.now() - operation.startedAt) / 1000)} 秒` : '';
  const render = (element: HTMLElement | null) => {
    if (!element) return;
    element.hidden = !operation; element.dataset.status = operation?.status || '';
    element.textContent = operation ? operation.message + elapsed : '';
    element.setAttribute('aria-busy', String(Boolean(running)));
  };
  if ($('sessions').firstElementChild?.getAttribute('data-session') === key) render($('chatContextOperation'));
  if ($<HTMLDialogElement>('sessionSettingsDialog').open && $('sessionSettingsDialog').dataset.session === key) {
    render($('contextOperationStatus'));
    $<HTMLButtonElement>('compactContext').disabled = Boolean(running || session.busy || session.queued || !state.connected);
    $<HTMLButtonElement>('resetContext').disabled = Boolean(running || !state.connected);
    $<HTMLButtonElement>('compactContext').textContent = running && operation.kind === 'compact' ? '正在压缩…' : '压缩历史';
    $<HTMLButtonElement>('resetContext').textContent = running && operation.kind === 'reset' ? '正在重置…' : '重置上下文';
  }
}

async function contextAction(session: any, kind: string): Promise<void> {
  const key = sessionKey(session);
  if ((contextRequests.get(key) || session.contextOperation)?.status === 'running') return;
  contextRequests.set(key, { kind, status: 'running', startedAt: Date.now(), message: kind === 'reset' ? '正在重置上下文…' : '正在提交压缩请求…' });
  renderContextOperation(session);
  const pending = new Set(chatRecord(key).optimistic.map(item => item.id));
  try {
    state = await api('session', { scope: session.scope, target_id: session.peerId, action: kind });
    contextRequests.delete(key);
    if (kind === 'reset') chatRecord(key).optimistic = chatRecord(key).optimistic.filter(item => !pending.has(item.id));
    renderCollection(); await refresh(true);
    const current = state.sessions.find((item: any) => sessionKey(item) === key);
    if (current) renderContextOperation(current);
  } catch (error) {
    contextRequests.set(key, { kind, status: 'failed', message: `${kind === 'reset' ? '重置上下文' : '压缩历史'}失败：${error instanceof Error ? error.message : error}` });
    renderContextOperation(session);
  }
}

function openSessionSettings(session: any): void {
  if (!session) return;
  const key = sessionKey(session); const dialog = $<HTMLDialogElement>('sessionSettingsDialog');
  dialog.dataset.session = key;
  $('sessionSettingsPeer').textContent = session.name ? `${session.name} · ${sessionIdentity(session)}` : sessionIdentity(session);
  const cached = sessionEditors.get(key);
  if (cached) {
    $('sessionSettingsBody').replaceChildren(cached); dialog.showModal(); renderChat(session); renderContextOperation(session); return;
  }
  const value = session.settings || session;
  const model = value.model === '(Codex default)' ? '' : value.model || '';
  const overrides = ['modelProvider', 'effort', 'preset', 'cwd', 'sandbox', 'approvalPolicy', 'approvalsReviewer', 'networkAccess', 'webSearch'].some((name) => Boolean(value[name])) || Boolean(model) || value.prompt != null || value.autoCompact != null || value.autoCompactThreshold != null;
  const settings = { model, modelProvider: value.modelProvider || '', effort: value.effort || '', preset: value.preset || '', cwd: value.cwd || '',
    sandbox: value.sandbox || '', approvalPolicy: value.approvalPolicy || '', approvalsReviewer: value.approvalsReviewer || '', networkAccess: value.networkAccess || '', webSearch: value.webSearch || '',
    followGlobal: !overrides, useCustomPrompt: value.prompt != null, prompt: value.prompt || '', autoCompact: value.autoCompact ?? state.config.autoCompact, autoCompactThreshold: value.autoCompactThreshold ?? state.config.autoCompactThreshold };
  const editor = document.createElement('div'); editor.className = 'session-settings';
  const intro = document.createElement('p'); intro.className = 'notice'; intro.textContent = '默认跟随 QQ Bot 全局设置。关闭后可单独覆盖，留空的项目仍跟随全局。';
  const grid = document.createElement('div'); grid.className = 'fields';
  const note = document.createElement('p'); note.className = 'notice'; note.id = 'sessionSaveStatus'; note.textContent = '修改提示词或预设会开始新上下文，原线程历史保留。';
  const save = document.createElement('button'); save.id = 'saveSession'; save.className = 'primary'; save.textContent = '保存会话设置'; save.disabled = true;
  let revision = 0;
  note.setAttribute('role', 'status');
  let permissions: ReturnType<typeof permissionPicker> | undefined;
  const syncDisabled = () => {
    grid.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('[data-field]').forEach((input) => {
      input.disabled = input.dataset.field !== 'followGlobal' && (settings.followGlobal || (input.dataset.field === 'prompt' && !settings.useCustomPrompt) || (input.dataset.field === 'autoCompactThreshold' && !settings.autoCompact));
    });
    permissions?.refresh(settings.followGlobal);
  };
  const changed = () => {
    revision++; note.classList.remove('form-error');
    sessionEditors.set(key, editor);
    dirtySessions.add(key); const current = state.sessions.find((item: any) => sessionKey(item) === key);
    save.disabled = Boolean(current?.busy || current?.queued || save.dataset.saving); note.textContent = current?.busy || current?.queued ? '修改已暂存，当前任务结束后可保存；关闭窗口不会丢失修改。' : '本会话有尚未保存的设置，关闭窗口后可继续编辑'; discard.disabled = Boolean(save.dataset.saving); syncDisabled();
  };
  const specs: Field[] = [
    { path: 'followGlobal', label: '跟随全局设置', kind: 'boolean', wide: true },
    { path: 'modelProvider', label: '模型提供商', list: 'providers' }, { path: 'model', label: '模型', list: 'models' },
    { path: 'effort', label: '推理强度', kind: 'select', options: ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { path: 'preset', label: '预设', kind: 'select', options: ['', ...Object.keys(state.config.presets || {})] },
    { path: 'cwd', label: '工作目录', wide: true },
    { path: 'webSearch', label: '网页搜索', kind: 'select', options: ['', 'live', 'cached', 'indexed', 'disabled'] },
    { path: 'autoCompact', label: '自动压缩上下文', kind: 'boolean', wide: true },
    { path: 'autoCompactThreshold', label: '自动压缩阈值（%）', kind: 'number', min: 10, max: 95, help: '达到此比例后，在下一次回复前自动压缩，聊天记录保留。' },
    { path: 'useCustomPrompt', label: '使用会话专属提示词', kind: 'boolean', wide: true },
    { path: 'prompt', label: '角色与额外提示词', kind: 'textarea', wide: true, help: '开启后替代全局及预设的提示词；关闭则跟随全局，内容留空表示不附加角色。' },
  ];
  grid.append(...specs.map((spec) => field(spec, settings, changed)));
  const advanced = document.createElement('details'); advanced.className = 'wide session-permission-details';
  const summary = document.createElement('summary'); summary.textContent = '自定义权限'; advanced.append(summary);
  const advancedFields = document.createElement('div'); advancedFields.className = 'fields';
  advancedFields.append(...([
    { path: 'sandbox', label: '执行范围', kind: 'select', options: ['', 'read-only', 'workspace-write', 'danger-full-access'] },
    { path: 'approvalPolicy', label: '操作确认', kind: 'select', options: ['', 'on-request', 'untrusted', 'never'] },
    { path: 'approvalsReviewer', label: '审批处理方式', kind: 'select', options: ['', 'user', 'auto_review'] },
    { path: 'networkAccess', label: '命令联网', kind: 'select', options: ['', 'enabled', 'disabled'] },
  ] as Field[]).map(spec => field(spec, settings, changed))); advanced.append(advancedFields);
  permissions = permissionPicker(settings, grid, changed, true, state.config);
  const searchField = grid.querySelector('[data-field="webSearch"]')!.closest('.field');
  grid.insertBefore(permissions.element, searchField); grid.insertBefore(advanced, searchField);
  for (const input of grid.querySelectorAll<HTMLSelectElement>('select')) input.options[0]!.textContent = '跟随全局';
  for (const name of ['modelProvider', 'model', 'cwd']) grid.querySelector<HTMLInputElement>(`[data-field="${name}"]`)!.placeholder = state.config[name] || '跟随全局';
  syncDisabled();
  const actions = document.createElement('div'); actions.className = 'dialog-actions';
  const reset = document.createElement('button'); reset.textContent = '恢复全局设置';
  reset.onclick = () => { settings.followGlobal = true; (grid.querySelector('[data-field="followGlobal"]') as HTMLInputElement).checked = true; changed(); };
  const buttons = document.createElement('div'); buttons.className = 'row';
  const discard = document.createElement('button'); discard.id = 'discardSessionSettings'; discard.textContent = '放弃修改'; discard.disabled = true;
  discard.onclick = () => { dirtySessions.delete(key); sessionEditors.delete(key); dialog.close(); };
  const cancel = document.createElement('button'); cancel.textContent = '关闭'; cancel.onclick = () => dialog.close();
  buttons.append(discard, cancel, save); actions.append(reset, buttons);
  save.onclick = async () => {
    if (save.dataset.saving) return;
    const invalid = grid.querySelector<HTMLInputElement>(':invalid'); if (invalid) { invalid.reportValidity(); return; }
    const values = settings.followGlobal ? { model: '', modelProvider: '', effort: '', preset: '', cwd: '', prompt: null, sandbox: '', approvalPolicy: '', approvalsReviewer: '', networkAccess: '', webSearch: '', autoCompact: null, autoCompactThreshold: null }
      : { model: settings.model, modelProvider: settings.modelProvider, effort: settings.effort, preset: settings.preset, cwd: settings.cwd, prompt: settings.useCustomPrompt ? settings.prompt : null,
        sandbox: settings.sandbox, approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer, networkAccess: settings.networkAccess, webSearch: settings.webSearch,
        autoCompact: settings.autoCompact, autoCompactThreshold: settings.autoCompactThreshold };
    const submitted = revision;
    save.dataset.saving = 'true'; save.disabled = true; discard.disabled = true; save.textContent = '保存中…'; note.textContent = '正在保存会话设置…'; note.classList.remove('form-error');
    try {
      const result = await action('session', { scope: session.scope, target_id: session.peerId, action: 'configure', settings: values }, '会话设置已保存');
      if (result && revision === submitted && sessionEditors.get(key) === editor) { dirtySessions.delete(key); sessionEditors.delete(key); if (dialog.contains(save)) dialog.close(); }
      else if (result) note.textContent = '已保存提交的设置，仍有修改尚未保存。';
      else { note.textContent = $('error').textContent || '当前有其他操作正在进行，请稍后重试。'; note.classList.add('form-error'); }
    } finally {
      delete save.dataset.saving; save.textContent = '保存会话设置';
      const current = state.sessions.find((item: any) => sessionKey(item) === key);
      save.disabled = Boolean(current?.busy || current?.queued) || !dirtySessions.has(key);
      discard.disabled = !dirtySessions.has(key);
    }
  };
  const management = document.createElement('div'); management.className = 'section';
  const title = document.createElement('h3'); title.textContent = '上下文管理'; management.append(title);
  for (const [name, label] of [['compact', '压缩历史'], ['reset', '重置上下文']]) {
    const button = document.createElement('button'); button.id = `${name}Context`; button.textContent = label!; button.style.marginRight = '8px';
    button.onclick = () => { void contextAction(state.sessions.find((item: any) => sessionKey(item) === key) || session, name!); };
    management.append(button);
  }
  const progress = document.createElement('p'); progress.id = 'contextOperationStatus'; progress.className = 'context-operation'; progress.setAttribute('role', 'status');
  const help = document.createElement('p'); help.className = 'notice'; help.textContent = '压缩历史会整理 AI 上下文，聊天记录仍然保留。重置上下文会中止当前任务，让下一条消息开始新会话，保留历史存档和会话设置。';
  management.append(progress, help);
  editor.append(intro, grid, note, actions, management); $('sessionSettingsBody').replaceChildren(editor); dialog.showModal(); renderContextOperation(session);
}

function openRenameSession(session: any): void {
  if (!session) return;
  const dialog = $<HTMLDialogElement>('renameSessionDialog'); dialog.dataset.session = sessionKey(session);
  $('renameSessionPeer').textContent = sessionIdentity(session); $('renameSessionError').textContent = '';
  const input = $<HTMLInputElement>('sessionNameInput'); input.value = session.name || ''; input.placeholder = sessionIdentity(session);
  $<HTMLButtonElement>('saveSessionName').disabled = false; dialog.showModal(); input.focus(); input.select();
}

function refresh(fresh = false): Promise<void> {
  if (refreshFlight) { refreshAgain ||= fresh; return refreshFlight; }
  refreshFlight = (async () => { do { refreshAgain = false; await readStatus(); } while (refreshAgain); })()
    .finally(() => { refreshFlight = undefined; });
  return refreshFlight;
}

async function readStatus(): Promise<void> {
  try {
    state = await api('status');
    if (!draft) { draft = structuredClone(state.config); delete draft.credentialsConfigured; renderForm(); }
    $('connectionStatus').textContent = state.connected ? 'QQ Bot 已连接' : state.running ? '连接中' : '连接未启动';
    $('connectionStatus').dataset.connected = String(Boolean(state.connected));
    const phase = state.binding || { phase: 'idle' };
    const phaseLabel: Record<string, string> = { idle: state.config.credentialsConfigured ? `已保存机器人 ${state.config.appId}` : '尚未绑定机器人', starting: '正在获取二维码…', waiting: '请用手机 QQ 扫码连接', expired: '二维码已过期，请刷新扫码', saving: '正在保存凭据…', bound: '已绑定并连接', failed: `绑定失败：${phase.reason}` };
    $('bindingStatus').textContent = phaseLabel[phase.phase] || phase.phase;
    if (phase.qrUrl !== lastQr) {
      lastQr = phase.qrUrl || '';
      const qr = $<HTMLImageElement>('qr'); qr.style.display = lastQr ? 'block' : 'none';
      if (lastQr) qr.src = (await api('qr')).dataUrl;
      const link = $<HTMLAnchorElement>('qrLink'); link.href = lastQr; link.textContent = lastQr ? '打开 QQ 绑定链接' : '';
    }
    $('dataLocation').textContent = state.dataDirectory || '';
    $('archiveLocation').textContent = state.storageDirectory || '';
    if ($<HTMLDialogElement>('directMessageDialog').open) updateDirectSend();
    if (state.error) $('error').textContent = state.error;
    else if (connectionError && $('error').textContent === connectionError) $('error').textContent = '';
    connectionError = state.error;
    renderPeers(); updateHeader(); renderCollection();
  } catch (error) { $('error').textContent = error instanceof Error ? error.message : String(error); }
}

async function account(): Promise<void> {
  try { const value = await api('account'); $('accountStatus').textContent = value.authenticated ? `已登录 · ${value.type}${value.plan ? ' · ' + value.plan : ''}` : 'Codex 尚未登录，或当前提供商使用独立凭据。'; }
  catch (error) { $('accountStatus').textContent = `无法读取 Codex：${error instanceof Error ? error.message : error}`; }
}

async function catalog(): Promise<void> {
  try {
    const [models, catalog] = await Promise.all([api('models'), api('catalog')]);
    for (const [id, values] of [['models', models.data.map((item: any) => item.model || item.id)], ['providers', catalog.providers.map((item: any) => item.id)]] as Array<[string, string[]]>) {
      $(id).replaceChildren(...values.map((value) => { const option = document.createElement('option'); option.value = value; return option; }));
    }
    $('catalogInfo').textContent = `${models.data.length} 个模型 · ${catalog.skills.length} 个可用技能${catalog.skills.length ? '：' + catalog.skills.map((skill: any) => skill.name).join('、') : ''}`;
  } catch (error) { $('catalogInfo').textContent = `读取失败：${error instanceof Error ? error.message : error}`; }
}

function bindEvents(): void {
  document.addEventListener('click', event => { if (!(event.target as HTMLElement).closest('.permission-picker')) closePermissionMenus(); });
  window.addEventListener('resize', closePermissionMenus);
  const directDialog = $<HTMLDialogElement>('directMessageDialog');
  const directTarget = $<HTMLSelectElement>('directMessageTarget');
  const directText = $<HTMLTextAreaElement>('directMessageText');
  const directSend = $<HTMLButtonElement>('sendDirectMessage');
  const fileInput = $<HTMLInputElement>('directFileInput');
  for (const id of ['closeDirectMessage', 'cancelDirectMessage']) $(id).onclick = () => directDialog.close();
  directDialog.oncancel = event => { if (directSending) event.preventDefault(); };
  $('addDirectFiles').onclick = () => fileInput.click();
  const addFiles = (input: File[]) => {
    if (directSending) return;
    const key = directDialog.dataset.draft!, files = directFileDrafts.get(key) || [];
    const selected: File[] = [];
    for (const file of input) if (![...files.map(item => item.file), ...selected].some(item => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) selected.push(file);
    $('directMessageError').textContent = '';
    const skipped: string[] = [];
    let limitReached = false;
    for (const file of selected) {
      if (!file.size || file.size > state.config.media.maxMB * 1024 * 1024) { skipped.push(`${file.name}：文件须非空且不超过 ${state.config.media.maxMB} MB。`); continue; }
      if (files.length >= state.config.sendFile.maxFiles) { limitReached = true; continue; }
      files.push({ file, sendAs: 'auto', ...(file.type.startsWith('image/') ? { preview: URL.createObjectURL(file) } : {}) });
    }
    directFileDrafts.set(key, files); renderDirectFiles();
    if (limitReached) skipped.push(`已达 ${state.config.sendFile.maxFiles} 个文件的上限，其余文件未添加。`);
    $('directMessageError').textContent = skipped.join('\n');
  };
  fileInput.onchange = () => { addFiles([...(fileInput.files || [])]); fileInput.value = ''; };
  directText.onpaste = event => { const files = [...(event.clipboardData?.files || [])]; if (files.length) { event.preventDefault(); addFiles(files); } };
  const directForm = $<HTMLFormElement>('directMessageForm');
  directForm.ondragover = event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); directForm.classList.add('file-drag-over'); } };
  directForm.ondragleave = event => { if (!directForm.contains(event.relatedTarget as Node | null)) directForm.classList.remove('file-drag-over'); };
  directForm.ondrop = event => { const files = [...(event.dataTransfer?.files || [])]; if (files.length) { event.preventDefault(); directForm.classList.remove('file-drag-over'); addFiles(files); } };
  directTarget.onchange = () => {
    directMessageDrafts.set(directDialog.dataset.draft!, directText.value);
    directDialog.dataset.draft = `${state.config.appId}:${directTarget.value}`;
    directText.value = directMessageDrafts.get(directDialog.dataset.draft) || '';
    $('directMessageError').textContent = ''; $('directMessageProgress').textContent = ''; renderDirectFiles();
  };
  directText.oninput = () => { directMessageDrafts.set(directDialog.dataset.draft!, directText.value); updateDirectSend(); };
  directText.onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); if (!directSend.disabled) $<HTMLFormElement>('directMessageForm').requestSubmit(); } };
  $('directMessageForm').onsubmit = async event => {
    event.preventDefault(); if (directSending) return;
    const session = state.sessions.find((item: any) => sessionKey(item) === directTarget.value);
    const files = [...(directFileDrafts.get(directDialog.dataset.draft!) || [])];
    if (!session || (!directText.value.trim() && !files.length)) return;
    const draftKey = directDialog.dataset.draft!, text = directText.value;
    directSending = true; directSend.disabled = true; directTarget.disabled = true; directText.disabled = true;
    const open = document.getElementById('openDirectMessage') as HTMLButtonElement | null; if (open) open.disabled = true;
    for (const id of ['closeDirectMessage', 'cancelDirectMessage']) $<HTMLButtonElement>(id).disabled = true;
    renderDirectFiles();
    $('directMessageError').textContent = ''; directSend.textContent = '发送中…';
    let sent = 0;
    try {
      if (text.trim()) {
        $('directMessageProgress').textContent = '正在发送文字…';
        const result = await api('session', { action: 'send', scope: session.scope, target_id: session.peerId, text });
        if (!result.sent) throw new Error('消息未能发送。');
        sent++; directMessageDrafts.delete(draftKey); directText.value = '';
      }
      for (const [index, entry] of files.entries()) {
        try {
          $('directMessageProgress').textContent = `正在发送文件 ${index + 1}/${files.length}：${entry.file.name}`;
          const path = entry.path || await uploadDirectFile(session, entry);
          entry.status = '正在发送到 QQ…'; renderDirectFiles();
          const result = await api('session', { action: 'sendFile', scope: session.scope, target_id: session.peerId, file_path: path, send_as: entry.sendAs });
          if (!result.sent) throw new Error('文件未能发送。');
          sent++; if (entry.preview) URL.revokeObjectURL(entry.preview);
          directFileDrafts.set(draftKey, (directFileDrafts.get(draftKey) || []).filter(item => item !== entry)); renderDirectFiles();
        } catch (error) { entry.status = '发送失败，可重试'; throw new Error(`${entry.file.name}：${error instanceof Error ? error.message : error}`); }
      }
      directFileDrafts.delete(draftKey); directDialog.close();
      $('feedback').textContent = `已通过 QQ Bot 发送至 ${sessionTitle(session)}${files.length ? `，共 ${files.length} 个文件` : ''}`; await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      $('directMessageProgress').textContent = sent ? `已有 ${sent} 项发送成功，重试时仅发送未成功的内容。` : '';
      $('directMessageError').textContent = message; $('feedback').textContent = `直接发送失败：${message}`; await refresh();
    } finally {
      directSending = false; directTarget.disabled = false; directText.disabled = false; directSend.textContent = '发送到 QQ';
      for (const id of ['closeDirectMessage', 'cancelDirectMessage']) $<HTMLButtonElement>(id).disabled = false;
      renderDirectFiles(); const open = document.getElementById('openDirectMessage') as HTMLButtonElement | null; if (open) open.disabled = !state.connected;
    }
  };
  const renameDialog = $<HTMLDialogElement>('renameSessionDialog');
  for (const id of ['closeRenameSession', 'cancelRenameSession']) $(id).onclick = () => renameDialog.close();
  $('renameSessionForm').onsubmit = async (event) => {
    event.preventDefault(); const key = renameDialog.dataset.session!;
    const session = state.sessions.find((item: any) => sessionKey(item) === key); if (!session) return;
    const save = $<HTMLButtonElement>('saveSessionName'); save.disabled = true;
    try {
      await api('session', { scope: session.scope, target_id: session.peerId, action: 'rename', name: $<HTMLInputElement>('sessionNameInput').value.trim() });
      renameDialog.close(); await refresh();
    } catch (error) { $('renameSessionError').textContent = error instanceof Error ? error.message : String(error); }
    finally { save.disabled = false; }
  };
  const sessionDialog = $<HTMLDialogElement>('sessionSettingsDialog');
  $('closeSessionSettings').onclick = () => sessionDialog.close();
  document.querySelectorAll<HTMLButtonElement>('[data-view-button]').forEach((button) => { button.onclick = () => setView(button.dataset.viewButton as View); });
  document.querySelectorAll<HTMLButtonElement>('#settingsNavigation [data-tab]').forEach((button) => { button.onclick = () => selectSetting(button.dataset.tab!); });
  $('listSearch').oninput = () => renderCollection();
  $('listSearch').onkeydown = event => {
    if (event.isComposing) return;
    const search = $<HTMLInputElement>('listSearch');
    if (event.key === 'Escape' && search.value) { event.preventDefault(); search.value = ''; renderCollection(); return; }
    const results = view === 'sessions' ? [...document.querySelectorAll<HTMLButtonElement>('#sessionList .session-row')].filter(row => !row.closest('[hidden]')) : [...document.querySelectorAll<HTMLButtonElement>('#settingsNavigation button:not([hidden])')];
    if (results.length && ['Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); const result = event.key === 'ArrowUp' ? results[results.length - 1]! : results[0]!;
      if (event.key === 'Enter') { result.click(); if (view === 'sessions') $('chatInput')?.focus(); } else result.focus();
    }
  };
  $('toggleBotGroup').onclick = () => {
    const query = $<HTMLInputElement>('listSearch').value.trim();
    if (query) searchGroupCollapsed = !searchGroupCollapsed;
    else {
      const id = state.config.appId || 'unbound';
      if (collapsedBots.has(id)) collapsedBots.delete(id); else collapsedBots.add(id);
      try { localStorage.setItem('qqbot.sidebar.collapsed', JSON.stringify([...collapsedBots])); } catch { /* Fold state still persists for this page. */ }
    }
    renderCollection();
  };
  const openRobot = () => { selectedRobot = true; selectedSession = undefined; showDetail('connection'); renderCollection(); $('detailContent').scrollTop = 0; };
  $('manageBot').onclick = openRobot;
  $('backToList').onclick = () => {
    if (view === 'sessions') { selectedRobot = false; selectedSession = undefined; } else selectedSetting = undefined;
    showDetail(); renderCollection();
    document.querySelectorAll<HTMLButtonElement>('#settingsNavigation [data-tab]').forEach((button) => button.setAttribute('aria-selected', 'false'));
  };
  $('headerAction').onclick = () => {
    if (view === 'settings') $('save').click();
    else if (!state.config.credentialsConfigured) openRobot();
    else void refresh().then(() => { const session = state.sessions.find((item: any) => sessionKey(item) === selectedSession); if (session) void loadConversation(session, undefined, true); });
  };
  for (const name of ['start', 'stop', 'bind', 'cancelBind', 'unbind']) $(name).onclick = () => { void action(name); };
  $('save').onclick = async () => {
    if (savingGlobal || !dirty) return;
    const invalid = document.querySelector<HTMLInputElement>('.tab [data-field]:invalid');
    if (invalid) {
      const tab = invalid.closest<HTMLElement>('.tab');
      if (tab) document.querySelector<HTMLButtonElement>(`[data-tab="${tab.id.slice(4)}"]`)?.click();
      invalid.reportValidity(); return;
    }
    const patch = structuredClone(draft); delete patch.appId;
    if (!patch.effort) patch.effort = null;
    const submitted = draftRevision; savingGlobal = true; updateHeader();
    try {
      const result = await action('configure', patch, '设置已保存');
      if (result && submitted === draftRevision) { dirty = false; $('saveStatus').textContent = '设置已保存'; }
      else if (result) { $('saveStatus').textContent = '仍有修改尚未保存'; $('feedback').textContent = '已保存提交的设置，之后的修改仍保留在编辑器中。'; }
    } finally { savingGlobal = false; updateHeader(); }
  };
  $('reload').onclick = async () => { draft = undefined; dirty = false; await refresh(); $('saveStatus').textContent = '已重新读取设置'; updateHeader(); };
  $('refreshModels').onclick = () => { void catalog(); };
  $('refreshAccount').onclick = () => { void account(); };
  $('login').onclick = async () => { const result = await action('login'); if (result?.authUrl) { const link = $<HTMLAnchorElement>('loginLink'); link.href = result.authUrl; link.style.display = 'inline'; } };
  $('shutdown').onclick = async () => { const result = await action('shutdown'); if (result) { $('connectionStatus').textContent = '后台已退出'; $('feedback').textContent = '可从插件入口重新启动。'; } };
  $('addPreset').onclick = () => {
    const input = $<HTMLInputElement>('newPresetId'); const id = input.value.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) { $('error').textContent = '预设 ID 使用字母、数字、下划线或短横线。'; return; }
    if (draft.presets[id]) { $('error').textContent = '此预设 ID 已存在。'; return; }
    draft.presets[id] = { name: id, model: '', modelProvider: '', effort: '', cwd: '', prompt: '', skills: [], config: {} };
    input.value = ''; renderPresets(); markDirty();
  };
  $('credentials').onsubmit = async (event) => {
    event.preventDefault(); const form = event.currentTarget as HTMLFormElement;
    const id = form.elements.namedItem('appId') as HTMLInputElement; const secret = form.elements.namedItem('appSecret') as HTMLInputElement;
    await action('credentials', { appId: id.value, appSecret: secret.value }); secret.value = '';
  };
  window.addEventListener('beforeunload', (event) => { if (dirty || dirtySessions.size) { event.preventDefault(); event.returnValue = ''; } });
}

async function main(): Promise<void> {
  document.body.dataset.transport = mode;
  if (mode === 'mcp') {
    app = new App({ name: 'codex-qqbot-settings', title: 'QQ Bot', version: '0.0.3' }, {});
    app.onhostcontextchanged = (context) => { if (context.theme) document.body.dataset.theme = context.theme; };
    await app.connect();
    const theme = app.getHostContext()?.theme; if (theme) document.body.dataset.theme = theme;
  } else history.replaceState(null, '', location.pathname);
  bindEvents(); await refresh(); void account(); void catalog();
  setInterval(() => { if (!exited && document.visibilityState !== 'hidden' && !busy) void refresh(); }, 3000);
}
void main().catch((error) => { $('error').textContent = error.message; });
