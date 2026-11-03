type Api = (action: string, payload?: Record<string, unknown>) => Promise<any>;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let active = false, creating = false, savingKey = false;
let current: { id: string; target: Record<string, string>; sendAs: string } | undefined;
let previewed = '';
let pollFailures = 0;
let readOwner = '';
let resumeLatest: (() => Promise<void>) | undefined;

export function refreshLiveUi(state: any): void {
  const config = state?.config?.live;
  if (!config) return;
  $('liveConfigurationStatus').textContent = `${config.enabled ? '已启用' : '尚未启用'} · ${config.keyConfigured ? config.keyFromEnvironment ? '使用环境变量中的密钥' : '已配置本机密钥' : '尚未配置 API Key'}`;
  $<HTMLInputElement>('liveKeyInput').disabled = savingKey || config.keyFromEnvironment;
  $<HTMLButtonElement>('saveLiveKey').disabled = savingKey || config.keyFromEnvironment;
  $<HTMLButtonElement>('removeLiveKey').disabled = savingKey || config.keyFromEnvironment || !config.keyConfigured;
  $<HTMLButtonElement>('createLiveVoice').disabled = creating || !config.enabled || !config.keyConfigured;
  $<HTMLButtonElement>('generateLiveAudio').disabled = active || !config.enabled || !config.keyConfigured;
  const select = $<HTMLSelectElement>('liveTarget');
  const previous = select.value;
  const options = [{ key: '', title: '仅试听，保存到机器人试听目录' }, ...(state.sessions || []).map((session: any) => ({
    key: `${session.scope}:${session.peerId}`, title: session.name || `${session.scope === 'group' ? '群聊' : '私聊'} · ${session.peerId}`,
  }))];
  if (JSON.stringify(options) !== select.dataset.options && !active) {
    select.replaceChildren(...options.map(option => { const element = document.createElement('option'); element.value = option.key; element.textContent = option.title; return element; }));
    select.dataset.options = JSON.stringify(options); select.value = options.some(option => option.key === previous) ? previous : '';
  }
  const send = $<HTMLInputElement>('liveSendToQQ');
  send.disabled = active || !select.value || !state.connected;
  if (!select.value || !state.connected) send.checked = false;
  select.disabled = active;
  $<HTMLSelectElement>('liveSendAs').disabled = active;
  $<HTMLTextAreaElement>('liveText').disabled = active;
  const owner = `${state.config.appId}:${select.value}`;
  if (!active && readOwner !== owner && resumeLatest) { readOwner = owner; void resumeLatest(); }
}

export function bindLiveUi(api: Api, state: () => any, useVoice: (id: string, prompt: string) => void): void {
  const showError = (error: unknown) => { $('liveError').textContent = error instanceof Error ? error.message : String(error); };
  const target = (): Record<string, string> => {
    const value = $<HTMLSelectElement>('liveTarget').value;
    const separator = value.indexOf(':');
    return value ? { scope: value.slice(0, separator), target_id: value.slice(separator + 1) } : {};
  };
  const update = () => refreshLiveUi(state());
  resumeLatest = async () => {
    const owner = readOwner, destination = target();
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
  $('liveKeyForm').onsubmit = async event => {
    event.preventDefault(); if (savingKey) return;
    const input = $<HTMLInputElement>('liveKeyInput');
    savingKey = true; update(); $('liveKeyMessage').textContent = '正在保存…';
    try { await api('liveCredentials', { apiKey: input.value }); $('liveKeyMessage').textContent = '密钥已保存，页面不会回显；启用语音生成后点击「保存设置」。'; }
    catch (error) { $('liveKeyMessage').textContent = error instanceof Error ? error.message : String(error); }
    finally { input.value = ''; savingKey = false; await refresh(); }
  };
  $('removeLiveKey').onclick = async () => {
    if (savingKey) return;
    savingKey = true; update();
    try { await api('liveCredentials', { clear: true }); $('liveKeyMessage').textContent = '已移除本机 API Key。'; }
    catch (error) { $('liveKeyMessage').textContent = error instanceof Error ? error.message : String(error); }
    finally { $<HTMLInputElement>('liveKeyInput').value = ''; savingKey = false; await refresh(); }
  };
  // The outer app owns configuration state; refresh it after dedicated credential writes.
  async function refresh(): Promise<void> {
    try { const latest = await api('status'); Object.assign(state(), latest); update(); }
    catch (error) { showError(error); update(); }
  }
  const labels: Record<string, string> = { connecting: '正在连接 GPT-Live…', generating: '正在生成语音…', finalizing: '正在确认会话结束…', completed: '语音已生成', failed: '语音生成失败', cancelled: '已取消语音生成' };
  async function renderJob(job: any): Promise<void> {
    if (!current || current.id !== job.id) return;
    active = !['completed', 'failed', 'cancelled'].includes(job.status) || job.delivery === 'sending';
    $('cancelLiveAudio').hidden = !active || job.delivery === 'sending';
    $('retryLiveDelivery').hidden = job.delivery !== 'failed';
    $('liveProgress').textContent = `${labels[job.status] || job.status}${job.result ? ` · ${job.result.durationSeconds.toFixed(1)} 秒` : ''}${job.delivery === 'sent' ? ' · 已发送到 QQ' : job.delivery === 'sending' ? ' · 正在发送到 QQ…' : ''}`;
    $('liveError').textContent = job.error || job.deliveryError || '';
    if (job.result) {
      $('liveTranscript').textContent = job.result.transcript || '';
      $('liveOutputPath').textContent = job.result.path;
      if (previewed !== job.id) {
        previewed = job.id;
        try {
          const result = await api('live', { action: 'preview', ...current.target, job_id: job.id });
          if (current?.id === job.id) {
            const player = $<HTMLAudioElement>('livePlayer'); player.src = result.dataUrl; player.hidden = false;
            const download = $<HTMLAnchorElement>('liveDownload'); download.href = result.dataUrl; download.download = `gpt-live-${job.id}.wav`; download.hidden = false;
          }
        } catch (error) { previewed = ''; showError(error); }
      }
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
  $('liveGenerateForm').onsubmit = async event => {
    event.preventDefault(); if (active) return;
    active = true; update(); $('liveError').textContent = ''; $('liveProgress').textContent = '正在创建语音任务…';
    $('retryLiveDelivery').hidden = true;
    const player = $<HTMLAudioElement>('livePlayer'); player.pause(); player.removeAttribute('src'); player.hidden = true;
    $('liveDownload').hidden = true; $('liveTranscript').textContent = ''; $('liveOutputPath').textContent = '';
    const destination = target(), sendAs = $<HTMLSelectElement>('liveSendAs').value;
    try {
      const job = await api('live', { action: 'generate', ...destination, text: $<HTMLTextAreaElement>('liveText').value,
        send_to_qq: $<HTMLInputElement>('liveSendToQQ').checked, send_as: sendAs });
      current = { id: job.id, target: destination, sendAs }; previewed = ''; pollFailures = 0;
      $('cancelLiveAudio').hidden = false; await poll(job.id);
    } catch (error) { active = false; showError(error); update(); }
  };
  $('cancelLiveAudio').onclick = async () => {
    if (!current) return;
    const button = $<HTMLButtonElement>('cancelLiveAudio'); button.disabled = true;
    try {
      const job = await api('live', { action: 'cancel', ...current.target, job_id: current.id });
      await renderJob(job);
      if (active) { $('liveProgress').textContent = '正在取消并关闭会话…'; pollFailures = 0; void poll(current.id); }
    }
    catch (error) { showError(error); }
    finally { button.disabled = false; }
  };
  $('retryLiveDelivery').onclick = async () => {
    if (!current) return;
    const button = $<HTMLButtonElement>('retryLiveDelivery'); button.disabled = true;
    try { const job = await api('live', { action: 'retry_send', ...current.target, job_id: current.id, send_as: current.sendAs }); await renderJob(job); }
    catch (error) { showError(error); }
    finally { button.disabled = false; }
  };
  $('liveVoiceForm').onsubmit = async event => {
    event.preventDefault(); if (creating) return;
    creating = true; update(); $('liveVoiceMessage').textContent = '正在创建音色…';
    try {
      const result = await api('live', { action: 'create_voice', name: $<HTMLInputElement>('liveVoiceName').value, prompt: $<HTMLTextAreaElement>('liveVoicePrompt').value });
      useVoice(result.id, result.prompt); $('liveVoiceMessage').textContent = `已创建 ${result.name}（${result.id}），已填入设置草稿，点击「保存设置」后可试听。`;
    } catch (error) { $('liveVoiceMessage').textContent = error instanceof Error ? error.message : String(error); }
    finally { creating = false; update(); }
  };
}
