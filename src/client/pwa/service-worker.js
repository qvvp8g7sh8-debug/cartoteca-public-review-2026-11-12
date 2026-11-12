const CACHE_VERSION = 'cartoteca-shell-v2';
const PUSH_EVENTS = new Set(['new-request', 'confirmation', 'change', 'reminder', 'test']);
// No patient details on the lock screen. The server sends only neutral text.
self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let message;
      try {
        message = event.data?.json();
      } catch {
        return;
      }
      if (
        !message ||
        !PUSH_EVENTS.has(message.data?.event) ||
        message.title !== 'Картотека' ||
        typeof message.body !== 'string' ||
        message.body.length > 160 ||
        typeof message.data?.url !== 'string' ||
        !message.data.url.startsWith('/#staff-push=')
      )
        return;
      await self.registration.showNotification('Картотека', {
        body: message.body,
        tag: message.tag,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: message.data,
      });
    })(),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const value = event.notification.data?.url;
      if (typeof value !== 'string' || !value.startsWith('/#staff-push=') || value.length > 4096)
        return;
      const url = new URL(value, self.location.origin);
      if (url.origin !== self.location.origin || url.pathname !== '/') return;
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = clients.find((client) => new URL(client.url).origin === self.location.origin);
      // Open a fresh authenticated page, never navigate away from an unsaved editor.
      if (client && client.url === url.href) {
        await client.focus();
        return;
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
const SHELL = [
  '/style.css',
  '/ui-extra.css',
  '/auth.css',
  '/login.js',
  '/install-app.css',
  '/install-app.js',
  '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  // Real pages use content-versioned URLs. Cache those exact requests on demand.
  event.waitUntil(caches.open(CACHE_VERSION));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('cartoteca-shell-') && key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

const OFFLINE_HTML = `<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Картотека · подключение</title><style>
body{margin:0;background:#f5f8fa;color:#173747;font:16px/1.5 system-ui,sans-serif}
main{max-width:36rem;margin:16vh auto;padding:24px}h1{font-size:1.5rem;line-height:1.25}
p{margin:16px 0 24px}a{display:inline-block;padding:12px 20px;background:#244c64;color:#fff;
border-radius:12px;text-decoration:none}a:focus-visible{outline:3px solid #244c64;outline-offset:4px}
</style><main><h1>Не удалось подключиться</h1>
<p role="status">Проверьте интернет и откройте картотеку ещё раз. Для загрузки календаря нужно соединение с сервером.</p>
<a href="/">Повторить загрузку</a></main></html>`;
function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}
async function navigationResponse(request) {
  const controller = new AbortController();
  let reader,
    timer,
    expired = false;
  const cancel = () => {
    controller.abort();
    reader?.cancel().catch(() => {});
  };
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(Error('Navigation deadline'));
      cancel();
    }, 4000);
  });
  try {
    const load = (async () => {
      // Include the small HTML body in the deadline: headers alone cannot start the app.
      const response = await fetch(request, { signal: controller.signal });
      reader = response.body?.getReader();
      if (expired) {
        cancel();
        throw Error('Navigation expired');
      }
      const chunks = [];
      let size = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 512 * 1024) throw Error('Navigation body exceeds shell budget');
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const headers = new Headers(response.headers);
      // Fetch streams are already decoded; do not label the reconstructed body as compressed.
      headers.delete('Content-Encoding');
      headers.delete('Content-Length');
      return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    })();
    // The page is never stored; every successful opening rechecks the session.
    return await Promise.race([load, deadline]);
  } catch {
    cancel();
    return offlineResponse();
  } finally {
    clearTimeout(timer);
  }
}
async function publicResource(request, versioned) {
  let cache, previous;
  try {
    cache = await caches.open(CACHE_VERSION);
    previous = await cache.match(request);
  } catch {
    // Storage may be disabled or full. It must never block a successful network read.
  }
  if (versioned && previous) return previous;
  try {
    const response = await fetch(request);
    if (cache && response.ok && versioned && response.type !== 'opaque') {
      try {
        await cache.put(request, response.clone());
        const keys = await cache.keys();
        // Preserve several exact versions for existing tabs without unbounded growth.
        await Promise.all(
          keys.slice(0, Math.max(0, keys.length - 64)).map((key) => cache.delete(key)),
        );
      } catch {
        // Caching is optional; the original response is still usable.
      }
    }
    return response;
  } catch (error) {
    if (previous) return previous;
    throw error;
  }
}
// Never cache API responses, authenticated pages, client cards, photos or protected code.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  )
    return;
  if (
    event.request.mode === 'navigate' &&
    ['/', '/index.html', '/login.html'].includes(url.pathname)
  ) {
    event.respondWith(navigationResponse(event.request));
    return;
  }
  if (!SHELL.includes(url.pathname)) return;
  const versioned =
    /^[a-f0-9]{16}$/.test(url.searchParams.get('v') || '') &&
    [...url.searchParams.keys()].every((name) => name === 'v');
  event.respondWith(publicResource(event.request, versioned));
});
