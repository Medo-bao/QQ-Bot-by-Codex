import type { PublicBotConfig } from '../config.ts';
import { speechPresets, speechProviderInfo, speechProviders, type KeyedSpeechProvider, type SpeechProvider } from '../speech-providers.ts';
import { sovitsParameters, type SovitsParameter } from '../sovits-settings.ts';
import { showFeedback, showModuleBadge, type FeedbackTone } from './feedback.ts';
import { bindSpeechPreview, type DownloadAudio } from './live-preview.ts';

type Api = (action: string, payload?: Record<string, unknown>) => Promise<any>;
type SpeechConfig = PublicBotConfig['live'];
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);
const selectedProvider = () => select('liveProvider').value as SpeechProvider | '';
const profileFor = (config: SpeechConfig, provider: KeyedSpeechProvider) => provider === 'openai' ? config : config[provider];
const hasProvider = (config: SpeechConfig, provider: SpeechProvider) =>
  Boolean(provider === 'sovits' ? config.sovits : profileFor(config, provider));
const providerReady = (config: SpeechConfig, provider: SpeechProvider) =>
  provider === 'sovits' ? config.sovits?.available === true : Boolean(profileFor(config, provider)?.keyConfigured);
let active = false, creating = false, savingSettings = false, settingsDirty = false;
let switchingProvider: SpeechProvider | undefined;
let settingsResult: 'success' | 'error' | undefined;
let syncSettings: ((config: SpeechConfig) => void) | undefined;
let current: { id: string; target: Record<string, string>; sendAs: string; fileName?: string } | undefined;
let previewed = '';
let pollFailures = 0;
let readOwner = '';
let resumeLatest: (() => Promise<void>) | undefined;
export const hasLiveSettingsChanges = () => settingsDirty;

export function refreshLiveUi(state: any): void {
  const config: SpeechConfig | undefined = state?.config?.live;
  if (!config) return;
  syncSettings?.(config);
  const activeProvider = config.provider || 'openai';
  const local = activeProvider === 'sovits';
  const ready = config.enabled && providerReady(config, activeProvider);
  const voiceId = local ? config.sovits?.voice : profileFor(config, activeProvider)?.voice;
  const voice = local ? voiceId : activeProvider === 'openai' && config.customVoiceId ? '自定义音色'
    : speechPresets[activeProvider][voiceId || ''] || voiceId;
  const status = $('liveConfigurationStatus');
  const statusText = ready ? `当前音色 · ${voice}` : !config.enabled ? '语音合成已关闭'
    : local ? '本地安装未就绪' : '待配置 API Key';
  if (status.textContent !== statusText) status.textContent = statusText;
  const settingsBusy = savingSettings || creating || Boolean(switchingProvider);
  for (const button of $('liveQuickProviders').querySelectorAll<HTMLButtonElement>('button')) {
    const provider = button.value as SpeechProvider;
    const supported = hasProvider(config, provider);
    const configured = providerReady(config, provider);
    const inUse = config.enabled && provider === activeProvider;
    button.disabled = !supported || active || settingsBusy || settingsDirty;
    button.setAttribute('aria-pressed', String(inUse));
    const badge = button.lastElementChild!;
    badge.textContent = provider === switchingProvider ? '切换中…' : !supported ? '需更新后台'
      : configured ? inUse ? '使用中' : provider === 'sovits' ? '已就绪' : '已配置' : provider === 'sovits' ? '待安装' : '待配置';
  }
  $<HTMLFieldSetElement>('liveSettingsControls').disabled = settingsBusy;
  const save = $<HTMLButtonElement>('saveLiveSettings');
  save.disabled = !settingsDirty || settingsBusy;
  save.textContent = savingSettings ? '保存中…' : '保存设置';
  save.setAttribute('aria-busy', String(savingSettings));
  $('discardLiveSettings').hidden = !settingsDirty;
  const moduleState = savingSettings || switchingProvider ? ['处理中', 'pending'] as const
    : settingsResult === 'error' ? ['操作失败', 'error'] as const
      : settingsDirty ? ['未保存', 'pending'] as const
        : settingsResult === 'success' ? ['已保存', 'success'] as const : ['', 'info'] as const;
  const [statusLabel, statusTone] = moduleState;
  showFeedback($('liveSettingsState'), statusLabel, statusTone);
  showModuleBadge('live', statusLabel, statusTone);
  const provider = selectedProvider();
  const keyed = provider && provider !== 'sovits' ? provider : undefined;
  const profile = keyed ? profileFor(config, keyed) : undefined;
  input('liveKeyInput').disabled = !profile || profile.keyFromEnvironment;
  input('liveKeyInput').placeholder = profile?.keyFromEnvironment && keyed ? `使用 ${speechProviderInfo[keyed].keyEnv}`
    : profile?.keyConfigured ? '已保存 · 留空保留' : '填写该供应商的 API Key';
  $('removeLiveKey').hidden = !profile?.keyConfigured || profile.keyFromEnvironment;
  $('liveVoiceDesign').hidden = provider !== 'openai';
  $<HTMLButtonElement>('createLiveVoice').disabled = settingsBusy || settingsDirty || !ready || activeProvider !== 'openai';
  const destination = select('liveTarget');
  const previous = destination.value;
  const options = [{ key: '', title: '仅试听' }, ...(state.sessions || []).map((session: any) => ({
    key: `${session.scope}:${session.peerId}`, title: session.name || `${session.scope === 'group' ? '群聊' : '私聊'} · ${session.peerId}`,
  }))];
  if (JSON.stringify(options) !== destination.dataset.options && !active) {
    destination.replaceChildren(...options.map(option => new Option(option.title, option.key)));
    destination.dataset.options = JSON.stringify(options);
    destination.value = options.some(option => option.key === previous) ? previous : '';
  }
  const delivery = select('liveSendAs');
  $('liveDeliveryField').hidden = !destination.value;
  if (!destination.value) delivery.value = '';
  const sending = Boolean(destination.value && delivery.value);
  const destinationLabel = destination.selectedOptions[0]?.textContent || '';
  const destinationStatus = $('liveDestinationStatus');
  destinationStatus.textContent = destination.value
    ? `${delivery.value === 'voice' ? 'QQ 语音' : delivery.value === 'file' ? 'WAV 文件' : '仅归档'} · ${destinationLabel}` : '仅试听';
  destinationStatus.title = destinationStatus.textContent;
  destination.disabled = active;
  delivery.disabled = active;
  const text = $<HTMLTextAreaElement>('liveText');
  $('liveTextCount').textContent = `${text.value.length} / ${text.maxLength}`;
  text.disabled = active;
  $<HTMLButtonElement>('liveUseSample').disabled = active || Boolean(text.value.trim());
  const hint = switchingProvider ? '正在切换供应商…' : settingsDirty ? '请先保存或取消服务设置中的修改。'
    : !ready ? config.enabled && local ? '请在服务设置中检查 GPT-SoVITS 的安装目录。' : '请选择已就绪的合成服务。'
      : sending && !state.connected ? '连接 QQ 后即可发送。' : '';
  $('liveGenerateHint').textContent = active ? '' : hint;
  const generate = $<HTMLButtonElement>('generateLiveAudio');
  generate.disabled = active || settingsBusy || Boolean(hint) || !text.value.trim();
  generate.textContent = active ? '正在处理…' : sending ? '生成并发送' : '生成语音';
  generate.setAttribute('aria-busy', String(active));
  const owner = `${state.config.appId}:${destination.value}`;
  if (!active && readOwner !== owner && resumeLatest) { readOwner = owner; void resumeLatest(); }
}

export function bindLiveUi(api: Api, state: () => any, downloadWithHost?: DownloadAudio): void {
  const showError = (error: unknown) => { $('liveError').textContent = error instanceof Error ? error.message : String(error); };
  const target = (): Record<string, string> => {
    const value = select('liveTarget').value;
    const separator = value.indexOf(':');
    return value ? { scope: value.slice(0, separator), target_id: value.slice(separator + 1) } : {};
  };
  const update = () => refreshLiveUi(state());
  select('liveProvider').append(...speechProviders.map(provider => new Option(speechProviderInfo[provider].label, provider)));
  const settings = $<HTMLDetailsElement>('liveSettings');
  const providerFeedback = $('liveProviderFeedback');
  const feedback = (message: string, tone?: FeedbackTone) => showFeedback(providerFeedback, message, tone);
  const settingsMessage = (message: string, tone?: FeedbackTone) => {
    settingsResult = tone === 'error' || tone === 'success' ? tone : undefined;
    showFeedback($('liveSettingsMessage'), message, tone);
  };
  const parameterKeys = Object.keys(sovitsParameters) as SovitsParameter[];
  const slider = (key: SovitsParameter) => input(`liveSovits-${key}`);
  const showSliderValue = (key: SovitsParameter) => {
    const control = slider(key);
    const suffix = key === 'speedFactor' ? '×' : key === 'idleMinutes' ? ' 分钟' : key === 'maxChars' ? ' 字' : '';
    const value = key === 'idleMinutes' && control.value === '0' ? '常驻' : control.value + suffix;
    $(control.id + '-value').textContent = value;
    control.setAttribute('aria-valuetext', value);
  };
  for (const key of parameterKeys) {
    const spec = sovitsParameters[key];
    const label = document.createElement('label'); label.className = 'field speech-slider';
    const header = document.createElement('span'); header.className = 'speech-slider-label';
    const title = document.createElement('span'); title.textContent = spec.label;
    const output = document.createElement('span'); output.className = 'speech-slider-value'; output.id = `liveSovits-${key}-value`;
    output.setAttribute('aria-hidden', 'true');
    header.append(title, output);
    const control = document.createElement('input'); control.type = 'range'; control.id = `liveSovits-${key}`;
    control.min = String(spec.min); control.max = String(spec.max); control.step = String(spec.step);
    control.setAttribute('aria-label', spec.label);
    const hint = document.createElement('small'); hint.id = control.id + '-hint'; hint.textContent = spec.hint;
    control.setAttribute('aria-describedby', hint.id);
    label.append(header, control, hint);
    $('liveSovitsParameters').append(label);
    control.addEventListener('input', () => showSliderValue(key));
  }
  let profileEdited = false;
  let displayedProvider: SpeechProvider | '' = '';
  for (const provider of speechProviders) {
    const button = document.createElement('button');
    const label = document.createElement('span');
    const badge = document.createElement('small');
    label.textContent = speechProviderInfo[provider].label;
    button.type = 'button';
    button.value = provider;
    button.disabled = true;
    button.append(label, badge);
    button.onclick = async () => {
      const config: SpeechConfig = state().config.live;
      if (button.disabled || !hasProvider(config, provider)) return;
      feedback('');
      settingsMessage('');
      const ready = providerReady(config, provider);
      if (!ready || config.enabled && (config.provider || 'openai') === provider) {
        settings.open = true;
        select('liveProvider').value = provider;
        renderProfile(config);
        if (!ready && provider !== 'sovits') { editSettings(); input('liveKeyInput').focus(); }
        else update();
        return;
      }
      switchingProvider = provider;
      feedback('正在切换合成服务…', 'pending');
      update();
      try {
        Object.assign(state(), await api('configure', { live: { provider, enabled: true } }));
        settings.open = false;
        settingsResult = 'success';
        feedback(`已切换到 ${speechProviderInfo[provider].label}`, 'success');
      } catch (error) {
        settingsResult = 'error';
        feedback(error instanceof Error ? error.message : String(error), 'error');
      }
      finally { switchingProvider = undefined; update(); }
    };
    $('liveQuickProviders').append(button);
  }
  const showSetting = (label: string, id: string, visible: boolean) => {
    $(label).hidden = !visible;
    $<HTMLInputElement>(id).disabled = !visible;
  };
  const showVoiceInput = () => {
    const provider = selectedProvider();
    showSetting('liveVoiceField', 'liveVoice', Boolean(provider && provider !== 'sovits' && !select('liveVoicePreset').value));
  };
  const renderProfile = (config: SpeechConfig) => {
    const provider = selectedProvider();
    displayedProvider = provider;
    const local = provider === 'sovits';
    const cloud = Boolean(provider && !local);
    $('liveProviderFields').hidden = !provider;
    $('liveLocalProfile').hidden = !local;
    $('liveCloudProfile').hidden = !cloud;
    select('liveVoicePreset').disabled = !cloud;
    input('liveDuration').disabled = !provider;
    input('liveDuration').value = String(config.maxDurationSeconds);
    showSetting('liveModelField', 'liveModel', cloud);
    showSetting('liveRegionField', 'liveRegion', provider === 'dashscope' || provider === 'minimax');
    showSetting('liveWorkspaceField', 'liveWorkspace', provider === 'dashscope');
    showSetting('liveCustomVoiceField', 'liveCustomVoice', provider === 'openai');
    showSetting('liveSilenceField', 'liveSilence', provider === 'openai');
    showSetting('liveInstructionsField', 'liveInstructions', provider === 'openai' || provider === 'mimo');
    input('liveKeyInput').value = '';
    if (local) {
      $('liveLocalVoice').textContent = config.sovits?.voice || '未找到可用音色包';
      $('liveLocalDirectory').textContent = config.sovits?.directory || '';
      $('liveLocalHint').textContent = config.sovits?.available
        ? '本机按需启动，首次合成需要加载模型。' : '检查此目录中的 GPT-SoVITS 安装，或在本机设置 QQBOT_SOVITS_ROOT。';
      for (const key of parameterKeys) {
        slider(key).value = String(config.sovits?.[key] ?? sovitsParameters[key].value);
        showSliderValue(key);
      }
      input('liveSovitsAutoSpeak').checked = config.sovits?.autoSpeak === true;
    }
    if (!provider || local) { showVoiceInput(); return; }
    const defaults = speechProviderInfo[provider];
    const profile = profileFor(config, provider);
    input('liveVoice').value = profile?.voice || defaults.voice;
    input('liveVoice').maxLength = provider === 'openai' ? 128 : 256;
    const presets = select('liveVoicePreset');
    presets.replaceChildren(...Object.entries(speechPresets[provider]).map(([id, label]) => new Option(label, id)), new Option('输入其他音色…', ''));
    presets.value = Object.hasOwn(speechPresets[provider], input('liveVoice').value) ? input('liveVoice').value : '';
    showVoiceInput();
    input('liveModel').value = profile?.model || defaults.model;
    if (provider === 'dashscope' || provider === 'minimax') {
      const region = select('liveRegion');
      region.replaceChildren(new Option(provider === 'dashscope' ? '中国大陆 · 北京' : '中国大陆', 'china'),
        new Option(provider === 'dashscope' ? '国际 · 新加坡' : '国际', 'international'));
      region.value = config[provider]?.region || 'china';
    }
    input('liveWorkspace').value = config.dashscope?.workspaceId || '';
    input('liveCustomVoice').value = config.customVoiceId;
    $('liveVoiceNote').hidden = provider !== 'openai' || !config.customVoiceId;
    input('liveSilence').value = String(config.silenceMs);
    const style = $<HTMLTextAreaElement>('liveInstructions');
    style.maxLength = provider === 'mimo' ? 2000 : 6000;
    style.value = provider === 'mimo' ? config.mimo?.instructions || '' : config.instructions;
  };
  let settingsSnapshot = '';
  syncSettings = config => {
    const snapshot = JSON.stringify(config);
    if (settingsDirty || settingsSnapshot === snapshot) return;
    settingsSnapshot = snapshot;
    for (const option of select('liveProvider').options) {
      option.hidden = option.disabled = Boolean(option.value && !hasProvider(config, option.value as SpeechProvider));
    }
    select('liveProvider').value = config.enabled ? config.provider || 'openai' : '';
    renderProfile(config);
  };
  const editSettings = () => {
    settingsDirty = true;
    feedback('');
    settingsMessage('有待保存的修改', 'pending');
    update();
  };
  const settingsForm = $<HTMLFormElement>('liveSettingsForm');
  settingsForm.oninput = event => {
    if (event.target === select('liveProvider')) {
      if (profileEdited) {
        select('liveProvider').value = displayedProvider;
        settingsMessage('请先保存或取消当前服务的修改。', 'pending');
        return;
      }
      renderProfile(state().config.live);
    } else profileEdited = true;
    if (event.target === select('liveVoicePreset')) showVoiceInput();
    if (event.target === input('liveCustomVoice')) $('liveVoiceNote').hidden = !input('liveCustomVoice').value.trim();
    editSettings();
  };
  settingsForm.addEventListener('invalid', event => {
    if ((event.target as HTMLElement).closest('#liveAdvanced')) $<HTMLDetailsElement>('liveAdvanced').open = true;
  }, true);
  $('discardLiveSettings').onclick = () => {
    settingsDirty = false;
    profileEdited = false;
    settingsSnapshot = '';
    settings.open = false;
    settingsMessage('');
    feedback('已放弃本次修改');
    update();
    settings.querySelector('summary')?.focus();
  };
  settingsForm.onsubmit = async event => {
    event.preventDefault();
    if (savingSettings || !settingsDirty) return;
    const provider = selectedProvider();
    const patch: Record<string, unknown> = { enabled: Boolean(provider) };
    if (provider === 'sovits' && !providerReady(state().config.live, provider)) {
      settingsMessage('请先完成本地 GPT-SoVITS 安装。', 'error');
      update();
      return;
    }
    if (provider) {
      patch.provider = provider;
      patch.maxDurationSeconds = Number(input('liveDuration').value);
    }
    if (provider === 'sovits') patch.sovits = {
      ...Object.fromEntries(parameterKeys.map(key => [key, slider(key).valueAsNumber])),
      autoSpeak: input('liveSovitsAutoSpeak').checked,
    };
    if (provider && provider !== 'sovits') {
      const profile: Record<string, unknown> = { model: input('liveModel').value, voice: select('liveVoicePreset').value || input('liveVoice').value };
      const key = input('liveKeyInput');
      if (!key.disabled && key.value.trim()) profile.apiKey = key.value.trim();
      const style = $<HTMLTextAreaElement>('liveInstructions').value;
      if (provider === 'openai') Object.assign(patch, profile, { instructions: style, silenceMs: Number(input('liveSilence').value),
        customVoiceId: input('liveCustomVoice').value });
      else {
        if (provider !== 'mimo') profile.region = select('liveRegion').value;
        if (provider === 'dashscope') profile.workspaceId = input('liveWorkspace').value;
        if (provider === 'mimo') profile.instructions = style;
        patch[provider] = profile;
      }
    }
    savingSettings = true;
    settingsMessage('正在保存…', 'pending');
    update();
    try {
      Object.assign(state(), await api('configure', { live: patch }));
      settingsDirty = false;
      profileEdited = false;
      settingsSnapshot = '';
      settingsMessage(provider === 'sovits' ? '已保存 · 下次合成生效' : '服务设置已保存', 'success');
    } catch (error) { settingsMessage(error instanceof Error ? error.message : String(error), 'error'); }
    finally { savingSettings = false; update(); }
  };
  $('removeLiveKey').onclick = async () => {
    const provider = selectedProvider();
    if (!provider || provider === 'sovits' || savingSettings) return;
    savingSettings = true;
    settingsMessage('正在清除密钥…', 'pending');
    update();
    try {
      Object.assign(state(), await api('liveCredentials', { provider, clear: true }));
      input('liveKeyInput').value = '';
      settingsMessage('本机密钥已清除', 'success');
    } catch (error) { settingsMessage(error instanceof Error ? error.message : String(error), 'error'); }
    finally { savingSettings = false; update(); }
  };

  const requestPreview = async () => {
    const item = current;
    if (!item?.fileName || previewed === item.id) return;
    previewed = item.id;
    preview.loading();
    try {
      const result = await api('live', { action: 'preview', ...item.target, job_id: item.id });
      if (current === item && previewed === item.id) await preview.load(result?.dataUrl, item.fileName);
    } catch (error) {
      if (current === item && previewed === item.id) preview.failed(error);
    }
  };
  const preview = bindSpeechPreview(() => { previewed = ''; void requestPreview(); }, downloadWithHost);
  const clearPreview = () => {
    preview.clear();
    $('liveResult').hidden = true;
    $('retryLiveDelivery').hidden = true;
    $('liveProgress').textContent = $('liveError').textContent = '';
    previewed = '';
  };
  resumeLatest = async () => {
    const owner = readOwner, destination = target();
    current = undefined;
    clearPreview();
    try {
      const value = await api('live', { action: 'status', ...destination });
      if (readOwner !== owner || active) return;
      const job = value.jobs.at(-1);
      if (!job) return;
      current = { id: job.id, target: destination, sendAs: job.sendAs || 'file' };
      pollFailures = 0; await renderJob(job);
      if (active) void poll(job.id);
    } catch (error) { showError(error); }
  };
  $('liveTarget').onchange = update;
  $('liveSendAs').onchange = update;
  const text = $<HTMLTextAreaElement>('liveText');
  const generateForm = $<HTMLFormElement>('liveGenerateForm');
  const generateButton = $<HTMLButtonElement>('generateLiveAudio');
  text.oninput = update;
  text.onkeydown = event => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
    event.preventDefault();
    if (!generateButton.disabled) generateForm.requestSubmit();
  };
  $('liveUseSample').onclick = () => {
    if (text.value.trim()) return;
    text.value = '你好，很高兴见到你。今天也记得给自己留一点休息时间。';
    update();
    text.focus();
  };
  const labels: Record<string, string> = { connecting: '正在连接语音服务…', generating: '正在合成语音…', finalizing: '正在整理音频…', completed: '语音已生成', failed: '语音生成失败', cancelled: '已取消语音生成' };
  async function renderJob(job: any): Promise<void> {
    if (!current || current.id !== job.id) return;
    active = !['completed', 'failed', 'cancelled'].includes(job.status) || job.delivery === 'sending';
    $('cancelLiveAudio').hidden = !active || job.delivery === 'sending';
    $('retryLiveDelivery').hidden = job.delivery !== 'failed';
    const provider = speechProviderInfo[job.provider as SpeechProvider]?.label;
    const progress = job.provider === 'sovits' && job.status === 'connecting' ? '正在等待本地引擎…' : labels[job.status] || job.status;
    $('liveProgress').textContent = `${progress}${job.result ? ` · ${job.result.durationSeconds.toFixed(1)} 秒` : ''}${provider ? ` · ${provider}` : ''}${job.delivery === 'sent' ? ' · 已发送到 QQ' : job.delivery === 'sending' ? ' · 正在发送到 QQ…' : ''}`;
    $('liveError').textContent = job.error || job.deliveryError || '';
    if (job.result) {
      $('liveTranscript').textContent = job.result.transcript || '';
      $('liveTranscript').hidden = !job.result.transcript;
      $('liveOutputPath').textContent = job.result.path;
      current.fileName = job.result.path.split(/[\\/]/).at(-1) || 'voice.wav';
      $('liveResult').hidden = false;
      await requestPreview();
    }
    update();
  }
  async function poll(id: string): Promise<void> {
    if (current?.id !== id) return;
    try {
      const job = await api('live', { action: 'status', ...current.target, job_id: id });
      pollFailures = 0;
      await renderJob(job);
      if (active && current?.id === id) setTimeout(() => { void poll(id); }, 800);
    } catch (error) {
      showError(error);
      if (++pollFailures < 4 && current?.id === id) setTimeout(() => { void poll(id); }, 2000);
      else {
        $('liveProgress').textContent = '暂时无法读取进度，可点击「取消生成」停止任务，或重新打开设置后查看。';
        $('cancelLiveAudio').hidden = false;
      }
      update();
    }
  }
  generateForm.onsubmit = async event => {
    event.preventDefault();
    if (generateButton.disabled) return;
    const destination = target(), sendAs = select('liveSendAs').value;
    clearPreview();
    active = true; update(); $('liveProgress').textContent = '正在创建语音任务…';
    try {
      const job = await api('live', { action: 'generate', ...destination, text: text.value,
        send_to_qq: Boolean(sendAs && destination.scope), send_as: sendAs || 'file' });
      current = { id: job.id, target: destination, sendAs: sendAs || 'file' }; pollFailures = 0;
      $('cancelLiveAudio').hidden = false; await poll(job.id);
    } catch (error) { active = false; showError(error); update(); }
  };
  $('cancelLiveAudio').onclick = async () => {
    if (!current) return;
    const button = $<HTMLButtonElement>('cancelLiveAudio'); button.disabled = true;
    button.textContent = '取消中…';
    button.setAttribute('aria-busy', 'true');
    try {
      const job = await api('live', { action: 'cancel', ...current.target, job_id: current.id });
      await renderJob(job);
      if (active) { $('liveProgress').textContent = '正在取消并关闭会话…'; pollFailures = 0; void poll(current.id); }
    }
    catch (error) { showError(error); }
    finally { button.disabled = false; button.textContent = '取消生成'; button.setAttribute('aria-busy', 'false'); }
  };
  $('retryLiveDelivery').onclick = async () => {
    if (!current) return;
    const button = $<HTMLButtonElement>('retryLiveDelivery'); button.disabled = true;
    button.textContent = '重试中…';
    button.setAttribute('aria-busy', 'true');
    try { const job = await api('live', { action: 'retry_send', ...current.target, job_id: current.id, send_as: current.sendAs }); await renderJob(job); }
    catch (error) { showError(error); }
    finally { button.disabled = false; button.textContent = '重试发送'; button.setAttribute('aria-busy', 'false'); }
  };
  $('liveVoiceForm').onsubmit = async event => {
    event.preventDefault(); if ($<HTMLButtonElement>('createLiveVoice').disabled) return;
    creating = true; update(); showFeedback($('liveVoiceMessage'), '正在创建音色…', 'pending');
    try {
      const result = await api('live', { action: 'create_voice', name: $<HTMLInputElement>('liveVoiceName').value, prompt: $<HTMLTextAreaElement>('liveVoicePrompt').value });
      input('liveCustomVoice').value = result.id;
      $('liveVoiceNote').hidden = false;
      $<HTMLDetailsElement>('liveAdvanced').open = true;
      profileEdited = true;
      editSettings();
      showFeedback($('liveVoiceMessage'), `已创建 ${result.name}，保存语音设置后即可试听。`, 'success');
    } catch (error) { showFeedback($('liveVoiceMessage'), error instanceof Error ? error.message : String(error), 'error'); }
    finally { creating = false; update(); }
  };
}
