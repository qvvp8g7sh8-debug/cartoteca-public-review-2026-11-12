const { fail } = require('../../shared/errors.cjs');
const { localOrigins } = require('./local-network.cjs');
const { internalContext } = require('./internal-ingress.cjs');
function secureRequest(req, res, origin, additionalOrigins = [], providerWebhook = false) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  const port = internalContext(req)?.localPort || req.socket.localPort;
  const origins = origin
    ? [new URL(origin).origin]
    : [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...localOrigins(additionalOrigins)];
  const expectedOrigin = origins.find((value) => new URL(value).host === req.headers.host);
  if (!expectedOrigin) throw fail(403, 'Адрес сервера не разрешён.');
  const maxWebhook =
    (providerWebhook === true || providerWebhook === 'max') &&
    req.method === 'POST' &&
    new URL(req.url, expectedOrigin).pathname === '/api/max/webhook';
  const paymentWebhook =
    providerWebhook === 'yookassa' &&
    req.method === 'POST' &&
    new URL(req.url, expectedOrigin).pathname === '/api/billing/yookassa/webhook';
  if (!['GET', 'HEAD'].includes(req.method) && !maxWebhook && !paymentWebhook) {
    if (req.headers.origin !== expectedOrigin || req.headers['x-cartoteca-request'] !== '1')
      throw fail(403, 'Запрос должен быть отправлен из картотеки.');
  }
  return expectedOrigin;
}
module.exports = { secureRequest };
