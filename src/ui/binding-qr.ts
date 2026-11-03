export async function renderBindingQr(
  image: HTMLImageElement, link: HTMLAnchorElement, status: HTMLElement,
  url: string, load: () => Promise<{ dataUrl: string }>,
): Promise<void> {
  image.dataset.qrUrl = url;
  image.style.display = 'none'; image.removeAttribute('src');
  link.href = url; link.textContent = url ? '打开 QQ 绑定链接' : ''; link.hidden = !url;
  status.hidden = true; status.textContent = '';
  if (!url) return;
  const failed = () => {
    if (image.dataset.qrUrl !== url) return;
    image.style.display = 'none';
    status.textContent = '二维码暂时无法显示，请打开 QQ 绑定链接，或使用下方的手动绑定。';
    status.hidden = false;
  };
  image.onerror = failed;
  try {
    const result = await load();
    if (image.dataset.qrUrl !== url) return;
    if (typeof result?.dataUrl !== 'string' || !result.dataUrl.startsWith('data:image/')) throw new Error('无效的二维码图像。');
    image.src = result.dataUrl; image.style.display = 'block';
  } catch { failed(); }
}
