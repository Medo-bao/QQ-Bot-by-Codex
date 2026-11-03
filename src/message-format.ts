export interface FileCitation { path: string; purpose: 'source' | 'output'; }

// Codex renders these directives in its own chat. QQ needs a readable label, while
// the plugin can turn the local link into its existing file card.
const tokenStart = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|:{1,2}codex-file-citation\{/g;
const citationStart = ':codex-file-citation{';

function* messageTokens(text: string) {
  let consumed = 0;
  for (const match of text.matchAll(tokenStart)) {
    if (match.index < consumed) continue;
    let end = match.index + match[0].length;
    const directive = match[0].startsWith(':');
    if (directive) {
      let quoted = false, escaped = false, closed = false;
      for (let index = end; index < text.length; index++) {
        const character = text[index];
        if (escaped) { escaped = false; continue; }
        if (quoted && character === '\\') { escaped = true; continue; }
        if (character === '"') quoted = !quoted;
        if (character === '}' && !quoted) { end = index + 1; closed = true; break; }
      }
      if (!closed) end = text.length;
    }
    consumed = end;
    yield { start: match.index, end, text: text.slice(match.index, end), directive };
  }
}

function fileCitation(token: string): FileCitation | undefined {
  if (!token.startsWith(':') || !token.endsWith('}')) return;
  const attributes = Object.fromEntries([...token.matchAll(/(\w+)="((?:\\.|[^"\\])*)"/g)].map(match =>
    [match[1], match[2]!.replace(/\\"/g, '"')]));
  if (!attributes.path || !['source', 'output'].includes(attributes.purpose || '')) return;
  return { path: attributes.path, purpose: attributes.purpose as FileCitation['purpose'] };
}

export function fileCitations(text: string): FileCitation[] {
  return [...messageTokens(text)].flatMap(token => { const citation = fileCitation(token.text); return citation ? [citation] : []; });
}

export function assistantText(text: string, surface: 'qq' | 'ui', partial = false): string {
  let visible = '', position = 0, trailingCode = false;
  for (const token of messageTokens(text)) {
    visible += text.slice(position, token.start); position = token.end;
    if (!token.directive) { visible += token.text; trailingCode = token.end === text.length; continue; }
    const citation = fileCitation(token.text);
    if (!citation) continue;
    const name = citation.path.replace(/\\/g, '/').split('/').pop() || '文件';
    const label = `${citation.purpose === 'source' ? '来源' : '文件'}：${name.replace(/[\\`*_[\]<>]/g, '\\$&')}`;
    visible += surface === 'ui' ? `[${label}](<${citation.path.replace(/[\r\n]/g, '')}>)` : `（${label}）`;
  }
  visible += text.slice(position);
  if (partial) {
    // A directive or emoji may be split across deltas. Hold the unfinished suffix
    // until it can be rendered, instead of flashing metadata or a broken emoji.
    const suffix = /:{1,2}[^:\s]*$/.exec(visible);
    if (!trailingCode && suffix && citationStart.startsWith(suffix[0].replace(/^::/, ':'))) visible = visible.slice(0, suffix.index);
    visible = visible.replace(/[\uD800-\uDBFF]$/, '');
  }
  return visible;
}
