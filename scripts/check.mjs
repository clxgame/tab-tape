import { readFile, readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3 || manifest.minimum_chrome_version !== '116') throw new Error('Unexpected manifest target');
if (manifest.host_permissions || manifest.content_scripts) throw new Error('This recorder should not request website access');
const required = ['tabCapture', 'activeTab', 'offscreen', 'downloads', 'storage'];
if (required.some(value => !manifest.permissions.includes(value)) || manifest.permissions.length !== required.length) throw new Error('Unexpected permissions');
for (const file of [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons)]) await access(resolve(root, file));

async function check(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (['releases', 'test-results', 'node_modules', '.git'].includes(item.name)) continue;
    const path = resolve(directory, item.name);
    if (item.isDirectory()) { await check(path); continue; }
    if (/\.(?:m?js)$/.test(item.name)) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      if (result.status) throw new Error(result.stderr);
    }
    if (/\.(?:html|m?js)$/.test(item.name)) {
      const text = await readFile(path, 'utf8');
      for (const match of text.matchAll(/(?:src|href)=["']([^"'#]+)["']/g)) {
        if (/^(?:https?:|chrome:|data:)/.test(match[1])) continue;
        await access(resolve(directory, match[1]));
      }
      for (const match of text.matchAll(/from ['"](\.[^'"]+)['"]/g)) await access(resolve(directory, match[1]));
    }
  }
}
await check(root);
console.log(`Manifest, local references, permissions, and JavaScript syntax verified: ${relative(process.cwd(), root) || '.'}`);
