import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { dataDirectory } from './config.ts';

/** A bot-owned home excludes the desktop's global AGENTS while retaining providers and tools. */
export function botCodexHome(): string {
  const source = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  const target = join(dataDirectory(), 'codex-home');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (source === target) return target;
  // Refresh provider/settings configuration; instruction fields are overridden by CodexClient.
  const config = join(source, 'config.toml');
  if (existsSync(config)) copyFileSync(config, join(target, 'config.toml'));
  // Seed the login and pick up newer desktop credentials for the same ChatGPT account.
  // Keep a newer bot login, or an explicitly selected different account, independent.
  for (const file of ['auth.json', '.credentials.json']) {
    const original = join(source, file), owned = join(target, file);
    if (!existsSync(original)) continue;
    if (!existsSync(owned)) { copyFileSync(original, owned); continue; }
    if (file !== 'auth.json') continue;
    const desktop = JSON.parse(readFileSync(original, 'utf8'));
    const bot = JSON.parse(readFileSync(owned, 'utf8'));
    if (desktop.auth_mode === 'chatgpt' && bot.auth_mode === 'chatgpt' && desktop.tokens?.account_id &&
      desktop.tokens.account_id === bot.tokens?.account_id && Date.parse(desktop.last_refresh) > Date.parse(bot.last_refresh)) {
      copyFileSync(original, owned);
    }
  }
  for (const directory of ['skills', 'plugins']) {
    if (existsSync(join(source, directory)) && !existsSync(join(target, directory))) {
      symlinkSync(join(source, directory), join(target, directory), process.platform === 'win32' ? 'junction' : 'dir');
    }
  }
  return target;
}
