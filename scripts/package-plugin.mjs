import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve('release/codex-qqbot');
await mkdir(output, { recursive: true });
for (const path of ['plugin.json', 'mcp.json']) await rm(resolve(output, path), { force: true });
for (const path of ['.codex-plugin', '.mcp.json', 'skills', 'assets', 'LICENSE', 'README.md']) {
  await cp(resolve(path), resolve(output, path), { recursive: true, force: true });
}
await mkdir(resolve(output, 'dist'), { recursive: true });
for (const path of ['cli.js', 'package.json', 'settings.html']) await cp(resolve('dist', path), resolve(output, 'dist', path));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile(resolve(output, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module' }, null, 2) + '\n');
console.log(output);
