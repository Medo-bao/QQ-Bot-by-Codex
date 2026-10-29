import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
const ui = await build({ entryPoints: ['src/ui/app.ts'], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022', minify: true });
const styles = await readFile('src/ui/styles.css', 'utf8');
const shell = (await readFile('src/ui/index.html', 'utf8')).replace('__APP_STYLES__', () => styles);
await writeFile('dist/settings.html', shell.replace('__APP_SCRIPT__', () => ui.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')));
await build({
  entryPoints: ['src/cli.ts', 'src/index.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'bundle',
  external: ['silk-wasm', 'mpg123-decoder'],
  banner: { js: "import { createRequire as _createRequire } from 'node:module'; const require = _createRequire(import.meta.url);" },
  sourcemap: false,
  logLevel: 'info',
});
await writeFile('dist/package.json', '{"type":"module"}\n');
