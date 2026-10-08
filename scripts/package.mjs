import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync(process.execPath, [resolve(root, 'scripts/check.mjs')], { stdio: 'inherit' });
const { version } = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
mkdirSync(resolve(root, 'releases'), { recursive: true });
const output = resolve(root, `releases/tab-tape-${version}.zip`);
rmSync(output, { force: true });
const files = ['manifest.json', 'background.js', 'offscreen.html', 'offscreen.js', 'popup.html', 'popup.js', 'recordings.html', 'recordings.js', 'styles.css', 'audio', 'lib', 'icons', 'docs', 'scripts', 'tests', 'package.json', 'README.md', 'LICENSE'];
execFileSync('zip', ['-q', '-r', output, ...files], { cwd: root });
console.log(output);
