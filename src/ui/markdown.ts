import { Marked } from 'marked';
import DOMPurify from 'dompurify';

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const local = (path: string) => /^(?:[a-z]:[\\/]|\/|file:|sandbox:)/i.test(path);
const markdown = new Marked({ gfm: true, breaks: true, renderer: {
  html: ({ text }) => escape(text),
  link(token) { return local(token.href) ? `<span data-qq-file="${escape(token.href)}">${this.parser.parseInline(token.tokens)}</span>` : false; },
  image({ href, text }) { return `<span data-qq-file="${escape(href)}">${escape(text || '图片')}</span>`; },
} });

export function renderMarkdown(text: string): HTMLElement {
  const element = document.createElement('div'); element.className = 'message-text markdown';
  element.innerHTML = DOMPurify.sanitize(markdown.parse(text, { async: false }), { USE_PROFILES: { html: true }, FORBID_ATTR: ['style', 'id'], FORBID_TAGS: ['img'] });
  for (const link of element.querySelectorAll<HTMLAnchorElement>('a')) { link.target = '_blank'; link.rel = 'noreferrer noopener'; }
  for (const table of element.querySelectorAll('table')) { const wrap = document.createElement('div'); wrap.className = 'table-scroll'; table.replaceWith(wrap); wrap.append(table); }
  for (const pre of element.querySelectorAll('pre')) {
    const code = pre.querySelector('code'); const heading = document.createElement('div'); heading.className = 'code-heading';
    const language = document.createElement('span'); language.textContent = code?.className.replace('language-', '') || '代码';
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制'; copy.setAttribute('aria-label', '复制代码');
    copy.onclick = async () => { try { await navigator.clipboard.writeText(code?.textContent || ''); copy.textContent = '已复制'; } catch { copy.textContent = '复制失败'; } };
    heading.append(language, copy); pre.prepend(heading);
  }
  return element;
}
