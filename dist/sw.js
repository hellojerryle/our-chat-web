'use strict';
const SHELL_SCOPE = new URL(self.registration.scope);
const CACHE_PREFIX = `our-chat-shell:${encodeURIComponent(SHELL_SCOPE.href)}:`;
const SHELL_CACHE = `${CACHE_PREFIX}v8`;
const SHELL_FILES = ['./', './index.html', './styles.css', './media.js', './app.js', './manifest.webmanifest', './icon.svg', './icon-180.png', './icon-192.png', './icon-512.png'];
const SHELL_PATHS = new Set(SHELL_FILES.map(file => new URL(file, SHELL_SCOPE).pathname));

async function deleteScopeShellCaches(keepCurrent = false) {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && (!keepCurrent || key !== SHELL_CACHE)).map(key => caches.delete(key)));
}

async function readShell(request, url) {
  let response;
  try {
    response = await fetch(request, {cache: 'no-store'});
  } catch (networkError) {
    // Only a rejected network request can use offline content. HTTP errors are server responses.
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request, {ignoreSearch: true});
    if (cached) return cached;
    throw networkError;
  }
  if (request.mode === 'navigate' && (response.status === 404 || response.status === 410)) {
    // The hosted page was removed. Forget this scope's shell; imported IndexedDB data stays intact.
    try { await deleteScopeShellCaches(); } catch (_) {}
    try { await self.registration.unregister(); } catch (_) {}
  } else if (response.ok && response.type === 'basic') {
    try {
      const cache = await caches.open(SHELL_CACHE);
      // Query strings do not create duplicate copies of these fixed static files.
      await cache.put(new URL(url.pathname, SHELL_SCOPE).href, response.clone());
    } catch (_) { /* A cache write failure must not hide a successful server response. */ }
  }
  return response;
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(deleteScopeShellCaches(true).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== SHELL_SCOPE.origin) return;
  // Cache only the fixed application shell. Imported records live only in IndexedDB.
  if (!SHELL_PATHS.has(url.pathname)) return;
  event.respondWith(readShell(request, url));
});
