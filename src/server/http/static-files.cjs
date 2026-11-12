const { fail } = require('../../shared/errors.cjs');
const { prepareStatic, selectEncoding } = require('./static-snapshot.cjs');
const { files } = require('../../shared/web-assets.cjs');
const allowed = new Set(files);
const publicFiles = new Set([
  'product.html',
  'product.css',
  'product-content.css',
  'robots.txt',
  'sitemap.xml',
  'privacy.html',
  'consent.html',
  'legal.css',
  'legal.js',
  'booking.html',
  'booking.js',
  'booking.css',
  'login.html',
  'login.js',
  'auth.css',
  'style.css',
  'ui-extra.css',
  'admin.html',
  'admin.js',
  'admin.css',
  'manifest.webmanifest',
  'service-worker.js',
  'install-app.js',
  'install-app.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/contact-call-gloss-v1.png',
  'icons/contact-message-gloss-v1.png',
]);
// Only versioned interface code may use the browser cache. No HTML or user data.
const cacheableInterfaceFiles = new Set([
  'legal.css',
  'legal.js',
  'booking.js',
  'booking.css',
  'style.css',
  'ui-extra.css',
  'app.js',
  'app-settings.js',
  'app-assistant.js',
  'assistant-capture-worklet.js',
  'assistant-playback-worklet.js',
  'assistant-pcm-pump.js',
  'assistant-echo-train.js',
  'login.js',
  'auth.css',
  'security.js',
  'admin.js',
  'admin.css',
  'install-app.js',
  'install-app.css',
]);
async function serveStatic(req, res, url, session, root) {
  if (!['GET', 'HEAD'].includes(req.method)) throw fail(405, 'Метод не поддерживается.');
  // Exact public aliases only; other /product/* paths remain outside the allowlist.
  if (url.pathname === '/product' || url.pathname === '/product.html') {
    res.writeHead(308, { Location: '/product/', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (url.pathname === '/product/') file = 'product.html';
  // A short public address serves the same page without exposing a long redirect.
  if (/^\/b\/[a-z0-9]{8}$/.test(url.pathname)) file = 'booking.html';
  if (!allowed.has(file)) throw fail(404, 'Файл не найден.');
  if (!session && file === 'index.html') file = 'login.html';
  else if (!session && !publicFiles.has(file)) throw fail(401, 'Войдите в картотеку.');
  const snapshot = prepareStatic(root);
  const version = url.searchParams.get('v');
  const build = url.searchParams.get('build');
  const currentVersion = version === snapshot.version || version === snapshot.resources[file];
  if ((version && !currentVersion) || (build !== null && build !== snapshot.version))
    throw fail(409, 'Версия приложения обновилась. Обновите страницу.');
  // A deferred module must never resolve old shell URLs to new executable code.
  if (
    [
      'app-settings.js',
      'app-assistant.js',
      'assistant-capture-worklet.js',
      'assistant-playback-worklet.js',
      'assistant-pcm-pump.js',
      'assistant-echo-train.js',
    ].includes(file) &&
    (!currentVersion || (version !== snapshot.version && build !== snapshot.version))
  )
    throw fail(409, 'Версия приложения обновилась. Обновите страницу.');
  const representations = snapshot.assets.get(file);
  const encoding = selectEncoding(req.headers?.['accept-encoding'], representations);
  if (!encoding) throw fail(406, 'Поддерживаемый формат ответа не указан.');
  const content = representations[encoding];
  const cacheControl =
    cacheableInterfaceFiles.has(file) && currentVersion
      ? 'private, max-age=31536000, immutable'
      : 'no-store';
  res.writeHead(200, {
    'Cache-Control': cacheControl,
    Vary: 'Accept-Encoding',
    'Content-Length': content.length,
    ...(encoding === 'identity' ? {} : { 'Content-Encoding': encoding }),
    'Content-Type': file.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : file.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : file.endsWith('.png')
          ? 'image/png'
          : file.endsWith('.txt')
            ? 'text/plain; charset=utf-8'
            : file.endsWith('.xml')
              ? 'application/xml; charset=utf-8'
              : file.endsWith('.webmanifest')
                ? 'application/manifest+json; charset=utf-8'
                : 'text/javascript; charset=utf-8',
    ...(file === 'service-worker.js'
      ? { 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-cache' }
      : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : content);
}
module.exports = { serveStatic };
