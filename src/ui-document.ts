import { readFileSync } from 'node:fs';

export function uiDocument(mode: 'mcp' | 'http'): string {
  return readFileSync(new URL('./settings.html', import.meta.url), 'utf8').replace('__MODE__', mode);
}
