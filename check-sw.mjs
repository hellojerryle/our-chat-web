import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Synthetic-only Service Worker lifecycle and request tests. No browser, disk cache or network is used.
const source = fs.readFileSync(new URL('./dist/sw.js', import.meta.url), 'utf8');
const scope = 'https://example.github.io/our-chat-web/';
const prefix = `our-chat-shell:${encodeURIComponent(scope)}:`;
const current = `${prefix}v8`;
const otherPrefix = `our-chat-shell:${encodeURIComponent('https://example.github.io/other-app/')}:`;

class TestResponse {
  constructor(body, status = 200, type = 'basic') { this.body = body; this.status = status; this.type = type; this.ok = status >= 200 && status < 300; }
  clone() { return new TestResponse(this.body, this.status, this.type); }
  async text() { return this.body; }
}
const urlKey = value => new URL(typeof value === 'string' ? value : value.url, scope).href;
const noSearch = value => { const url = new URL(value); url.search = ''; return url.href; };
class TestCache {
  entries = new Map();
  failPut = false;
  async addAll(files) { for (const file of files) await this.put(urlKey(file), new TestResponse(`installed:${file}`)); }
  async put(request, response) {
    if (this.failPut) throw new Error('Synthetic cache quota failure');
    this.entries.set(urlKey(request), response.clone());
  }
  async match(request, options = {}) {
    const target = urlKey(request);
    for (const [key, response] of this.entries) {
      if (options.ignoreSearch ? noSearch(key) === noSearch(target) : key === target) return response.clone();
    }
  }
}
function harness() {
  const listeners = new Map(), cacheMap = new Map(), requests = [], fetchOptions = [], deleted = [];
  let unregistered = 0, claimed = 0, skipped = 0;
  let network = async () => new TestResponse('network-current');
  const caches = {
    async open(name) { if (!cacheMap.has(name)) cacheMap.set(name, new TestCache()); return cacheMap.get(name); },
    async keys() { return [...cacheMap.keys()]; },
    async delete(name) { deleted.push(name); return cacheMap.delete(name); }
  };
  const self = {
    location: new URL('sw.js', scope),
    registration: {scope, async unregister() { unregistered++; return true; }},
    clients: {async claim() { claimed++; }},
    async skipWaiting() { skipped++; },
    addEventListener(type, callback) { listeners.set(type, callback); }
  };
  const context = {URL, caches, self, async fetch(request, options) { requests.push(request.url); fetchOptions.push(options); return network(request); }};
  // Accessing private chat storage would fail this test, even if an exception were caught by the worker.
  let privateStorageAccesses = 0;
  Object.defineProperty(context, 'indexedDB', {get() { privateStorageAccesses++; throw new Error('Private storage must not be accessed'); }});
  vm.runInNewContext(source, context, {filename: 'sw.js'});
  return {
    cacheMap, caches, requests, fetchOptions, deleted,
    get unregistered() { return unregistered; }, get claimed() { return claimed; }, get skipped() { return skipped; },
    set network(callback) { network = callback; },
    assertPrivateStorageUntouched() { assert.equal(privateStorageAccesses, 0); },
    async lifecycle(type) {
      const waiting = [];
      listeners.get(type)({waitUntil(promise) { waiting.push(promise); }});
      await Promise.all(waiting);
    },
    async request(path = 'index.html', options = {}) {
      let responsePromise;
      const request = {url: new URL(path, scope).href, method: 'GET', mode: 'same-origin', ...options};
      listeners.get('fetch')({request, respondWith(promise) { responsePromise = promise; }});
      return responsePromise === undefined ? {handled: false} : {handled: true, response: await responsePromise};
    }
  };
}
let checks = 0;
async function check(name, callback) { await callback(); checks++; console.log(`Passed: ${name}`); }

await check('install precaches only relative shell paths in project scope', async () => {
  const h = harness(); await h.lifecycle('install');
  assert.equal(h.skipped, 1);
  assert.deepEqual([...h.cacheMap.keys()], [current]);
  const urls = [...h.cacheMap.get(current).entries.keys()];
  assert.equal(urls.length, 10); assert(urls.every(url => url.startsWith(scope)));
  assert(urls.includes(`${scope}media.js`)); assert(urls.includes(scope));
  h.assertPrivateStorageUntouched();
});
await check('activate deletes only this scope old versions', async () => {
  const h = harness();
  for (const key of [current, `${prefix}v5`, `${otherPrefix}v5`, 'our-chat-shell-v5', 'another-app-cache']) await h.caches.open(key);
  await h.lifecycle('activate');
  assert.deepEqual(h.deleted, [`${prefix}v5`]);
  assert(h.cacheMap.has(current)); assert(h.cacheMap.has(`${otherPrefix}v5`)); assert(h.cacheMap.has('our-chat-shell-v5'));
  assert.equal(h.claimed, 1); h.assertPrivateStorageUntouched();
});
await check('online requests return new server content and refresh canonical cache', async () => {
  const h = harness(); const cache = await h.caches.open(current);
  await cache.put(`${scope}index.html`, new TestResponse('cached-old'));
  const result = await h.request('index.html?version=latest');
  assert.equal(await result.response.text(), 'network-current');
  assert.equal(await (await cache.match(`${scope}index.html`)).text(), 'network-current');
  assert.equal(cache.entries.size, 1); assert.equal(h.requests.length, 1); h.assertPrivateStorageUntouched();
  assert.equal(h.fetchOptions[0].cache, 'no-store');
});
await check('network failure alone falls back to matching offline content', async () => {
  const h = harness(); const cache = await h.caches.open(current);
  await cache.put(`${scope}index.html`, new TestResponse('offline-saved'));
  h.network = async () => { throw new TypeError('Synthetic offline'); };
  assert.equal(await (await h.request('index.html?offline=1')).response.text(), 'offline-saved');
  assert.equal(h.unregistered, 0); h.assertPrivateStorageUntouched();
});
await check('offline cache miss preserves network failure', async () => {
  const h = harness(); const error = new TypeError('Synthetic offline cache miss');
  h.network = async () => { throw error; };
  await assert.rejects(h.request(), caught => caught === error); h.assertPrivateStorageUntouched();
});
await check('404 static resource never returns cached content', async () => {
  const h = harness(); const cache = await h.caches.open(current);
  await cache.put(`${scope}app.js`, new TestResponse('old-script'));
  h.network = async () => new TestResponse('server-missing-script', 404);
  const result = await h.request('app.js');
  assert.equal(result.response.status, 404); assert.equal(await result.response.text(), 'server-missing-script');
  assert.equal(h.unregistered, 0); assert(h.cacheMap.has(current)); h.assertPrivateStorageUntouched();
});
for (const status of [404, 410]) await check(`${status} navigation returns server response, clears only scope shell and unregisters`, async () => {
  const h = harness(); const cache = await h.caches.open(current);
  await cache.put(scope, new TestResponse('removed-app-old'));
  for (const key of [`${prefix}v5`, `${otherPrefix}v5`, 'another-app-cache']) await h.caches.open(key);
  h.network = async () => new TestResponse(`server-removed-${status}`, status);
  const result = await h.request('./', {mode: 'navigate'});
  assert.equal(result.response.status, status); assert.equal(await result.response.text(), `server-removed-${status}`);
  assert.equal(h.unregistered, 1);
  assert.deepEqual(new Set(h.deleted), new Set([current, `${prefix}v5`]));
  assert(h.cacheMap.has(`${otherPrefix}v5`)); assert(h.cacheMap.has('another-app-cache')); h.assertPrivateStorageUntouched();
});
await check('server 500 is returned without offline fallback or unregister', async () => {
  const h = harness(); const cache = await h.caches.open(current);
  await cache.put(scope, new TestResponse('offline-old'));
  h.network = async () => new TestResponse('server-error', 500);
  const result = await h.request('./', {mode: 'navigate'});
  assert.equal(result.response.status, 500); assert.equal(await result.response.text(), 'server-error');
  assert.equal(h.unregistered, 0); assert(h.cacheMap.has(current)); h.assertPrivateStorageUntouched();
});
await check('external, unknown, other-project and non-GET requests are not intercepted', async () => {
  const h = harness();
  for (const [path, options] of [
    ['https://external.invalid/app.js', {}], ['private.json', {}], ['assets/private.png', {}],
    ['/other-app/index.html', {}], ['app.js', {method: 'POST'}]
  ]) assert.equal((await h.request(path, options)).handled, false);
  assert.equal(h.requests.length, 0); assert.equal(h.cacheMap.size, 0); h.assertPrivateStorageUntouched();
});
await check('cache quota errors cannot hide a successful online response', async () => {
  const h = harness(); (await h.caches.open(current)).failPut = true;
  assert.equal(await (await h.request()).response.text(), 'network-current'); h.assertPrivateStorageUntouched();
});
console.log(`Service Worker synthetic checks passed: ${checks}.`);
