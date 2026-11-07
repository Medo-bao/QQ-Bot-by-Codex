import { showFeedback } from './feedback.ts';

type AudioFile = { blob: Blob; base64: string; name: string };
export type DownloadAudio = (file: AudioFile) => Promise<void>;

function clockTime(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
}

export function bindSpeechPreview(retry: () => void, downloadWithHost?: DownloadAudio) {
  const native = document.querySelector<HTMLAudioElement>('#livePlayer')!;
  const inline = document.querySelector<HTMLElement>('#liveInlinePlayer')!;
  const play = document.querySelector<HTMLButtonElement>('#livePlay')!;
  const seek = document.querySelector<HTMLInputElement>('#liveSeek')!;
  const time = document.querySelector<HTMLOutputElement>('#liveTime')!;
  const download = document.querySelector<HTMLButtonElement>('#liveDownload')!;
  const retryButton = document.querySelector<HTMLButtonElement>('#liveRetryPreview')!;
  const notice = document.querySelector<HTMLElement>('#livePreviewStatus')!;
  const downloadNotice = document.querySelector<HTMLElement>('#liveDownloadStatus')!;
  native.hidden = inline.hidden = true;

  let file: AudioFile | undefined;
  let url: string | undefined;
  let context: AudioContext | undefined;
  let buffer: AudioBuffer | undefined;
  let source: AudioBufferSourceNode | undefined;
  let frame = 0, offset = 0, started = 0, revision = 0;

  const position = () => source ? Math.min(buffer!.duration, offset + context!.currentTime - started) : offset;
  const update = () => {
    const at = position();
    seek.value = String(at);
    time.value = `${clockTime(at)} / ${clockTime(buffer?.duration ?? 0)}`;
    play.textContent = source ? '暂停' : '播放';
  };
  const tick = () => {
    update();
    if (source) frame = requestAnimationFrame(tick);
  };
  const pause = () => {
    offset = position();
    if (source) {
      source.onended = null;
      source.stop();
      source.disconnect();
      source = undefined;
    }
    cancelAnimationFrame(frame);
    update();
  };
  const start = () => {
    const audio = context!.createBufferSource();
    const duration = buffer!.duration;
    if (offset >= duration) offset = 0;
    audio.buffer = buffer!;
    audio.connect(context!.destination);
    started = context!.currentTime;
    audio.start(0, offset);
    source = audio;
    audio.onended = () => {
      if (source !== audio) return;
      source = undefined;
      audio.disconnect();
      offset = duration;
      cancelAnimationFrame(frame);
      update();
    };
    tick();
  };

  const failed = (error: unknown) => {
    showFeedback(notice, error instanceof Error ? error.message : String(error), 'error');
    retryButton.hidden = false;
  };
  const clear = () => {
    revision++;
    pause();
    buffer = file = undefined;
    offset = 0;
    seek.max = '0';
    play.disabled = seek.disabled = download.disabled = true;
    native.hidden = inline.hidden = true;
    download.textContent = '下载 WAV';
    download.setAttribute('aria-busy', 'false');
    if (url) {
      native.pause();
      native.removeAttribute('src');
      native.load();
      URL.revokeObjectURL(url);
      url = undefined;
    }
    retryButton.hidden = true;
    showFeedback(notice, '');
    showFeedback(downloadNotice, '');
    update();
  };

  native.onloadedmetadata = () => {
    if (!file) return;
    native.hidden = false;
    showFeedback(notice, '');
  };
  native.onerror = () => { if (file) failed('播放器无法读取这段音频，可重试试听或下载 WAV。'); };
  retryButton.onclick = retry;
  play.onclick = async () => {
    if (!buffer || !context) return;
    if (source) { pause(); return; }
    const ticket = revision;
    play.disabled = true;
    try {
      await context.resume();
      if (revision === ticket) start();
    } catch {
      if (revision === ticket) failed('无法开始播放，可重试试听或下载 WAV。');
    } finally { if (revision === ticket) play.disabled = false; }
  };
  seek.oninput = () => {
    if (!buffer) return;
    const at = seek.valueAsNumber, wasPlaying = Boolean(source);
    pause();
    offset = at;
    if (wasPlaying && offset < buffer.duration) start();
    else update();
  };
  download.onclick = async () => {
    const audio = file;
    if (!audio) return;
    if (!downloadWithHost) {
      const link = document.createElement('a');
      link.href = url!;
      link.download = audio.name;
      link.click();
      return;
    }
    download.disabled = true;
    download.textContent = '正在下载…';
    download.setAttribute('aria-busy', 'true');
    showFeedback(downloadNotice, '');
    try { await downloadWithHost(audio); }
    catch (error) {
      if (file === audio) showFeedback(downloadNotice, error instanceof Error ? error.message : String(error), 'error');
    } finally {
      if (file === audio) {
        download.disabled = false;
        download.textContent = '下载 WAV';
        download.setAttribute('aria-busy', 'false');
      }
    }
  };
  window.addEventListener('pagehide', event => {
    if (event.persisted) { pause(); native.pause(); return; }
    clear();
    void context?.close();
    context = undefined;
  });

  return {
    clear,
    failed,
    loading() {
      clear();
      showFeedback(notice, '正在读取试听音频…', 'pending');
    },
    async load(dataUrl: unknown, name: string): Promise<void> {
      const prefix = 'data:audio/wav;base64,';
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix) || dataUrl.length === prefix.length) {
        throw new Error('未收到完整的试听音频，可重试加载。');
      }
      const base64 = dataUrl.slice(prefix.length);
      const decoded = atob(base64);
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
      file = { blob: new Blob([bytes], { type: 'audio/wav' }), base64, name };
      download.disabled = false;
      if (!downloadWithHost) {
        url = URL.createObjectURL(file.blob);
        native.src = url;
        return;
      }
      // Decode the audio bytes directly in the embedded app, where media URLs can be blocked.
      const ticket = revision;
      context ||= new AudioContext();
      const result = await context.decodeAudioData(bytes.buffer);
      if (revision !== ticket) return;
      buffer = result;
      inline.hidden = false;
      seek.max = String(result.duration);
      play.disabled = seek.disabled = false;
      showFeedback(notice, '');
      update();
    },
  };
}
