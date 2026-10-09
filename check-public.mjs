import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const allowed = ['.nojekyll','app.js','icon-180.png','icon-192.png','icon-512.png','icon.svg','index.html','manifest.webmanifest','media.js','styles.css','sw.js'].sort();
assert.deepEqual(fs.readdirSync(root).sort(), allowed, 'Only public program files may be published');
for (const name of allowed) {
  const p = path.join(root, name);
  assert(fs.lstatSync(p).isFile(), 'No links or directories allowed');
  assert(fs.statSync(p).size < 100_000, 'Unexpected oversized program file');
  if (name.endsWith('.png')) continue;
  const text = fs.readFileSync(p, 'utf8');
  assert(!/data:image\/[^;]+;base64,/i.test(text), 'No embedded personal avatars');
  assert(!/https?:\/\//i.test(text.replaceAll('http://www.w3.org/2000/svg','')), 'No remote resources or old hosting links');
  assert(!/(?:ghp_|github_pat_|-----BEGIN [A-Z ]*PRIVATE KEY)/.test(text), 'No credentials');
}
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert(html.includes("connect-src 'none'"));
assert(!/<(?:iframe|form)\b/i.test(html));
for (const source of ['app.js','media.js']) {
  const text = fs.readFileSync(path.join(root, source), 'utf8');
  assert(!/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/.test(text), 'Imported data must remain local');
}
console.log('PASS: public file allowlist, local-only resources, no embedded avatars, no credentials, and no data-upload API.');
