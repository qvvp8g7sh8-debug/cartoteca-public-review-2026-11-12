const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { root } = require('../config.cjs');
const { setupAssetRoot } = require('../../shared/web-assets.cjs');
const { readBody, json } = require('../http/responses.cjs');
const { fail } = require('../../shared/errors.cjs');
const { configuredMax } = require('../modules/notifications/max-adapter.cjs');
const { MAX_USERNAME } = require('../modules/notifications/max-connections.cjs');
const { syntheticMessagePreview } = require('../modules/notifications/notification-message.cjs');
const { setupProblem } = require('../modules/notifications/max-setup-diagnostics.cjs');
const assetRoot = setupAssetRoot(root);

// Separate temporary loopback tool. No sessions, patient DB, migrations or sending.
function createMaxSetupServer({ store, fetchImpl = fetch, lifetime = 30 * 60000 }) {
  const csrf = crypto.randomBytes(32).toString('base64url');
  const cookie = crypto.randomBytes(32).toString('base64url');
  let busy = false,
    verified = false,
    error = false,
    closed = false,
    problem = null;
  const state = () => ({
    saved: store.exists(),
    verified,
    state: error ? 'error' : verified ? 'ready' : store.exists() ? 'saved' : 'not_configured',
    label: error
      ? 'Ошибка проверки'
      : verified
        ? 'Готов к подключению'
        : store.exists()
          ? 'Токен сохранён'
          : 'Не настроен',
    nickname: MAX_USERNAME,
    sendingEnabled: false,
    problem,
  });
  const server = http.createServer(async (req, res) => {
    const origin = 'http://127.0.0.1:' + server.address().port;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    req.setTimeout(10000, () => req.destroy());
    try {
      if (
        closed ||
        req.headers.host !== new URL(origin).host ||
        !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
        (req.headers['sec-fetch-site'] === 'cross-site' && req.method !== 'GET')
      )
        throw fail(403, 'Окно доступно только на этом компьютере.');
      const url = new URL(req.url, origin);
      if (url.search) throw fail(400, 'Не передавайте токен в адресе.');
      if (req.method === 'GET') {
        if (url.pathname === '/') {
          res.setHeader(
            'Set-Cookie',
            `cartoteca_max_setup=${cookie}; HttpOnly; SameSite=Strict; Path=/`,
          );
          const page = fs
            .readFileSync(path.join(assetRoot, 'max-setup.html'), 'utf8')
            .replace('{{CSRF}}', csrf);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(page);
        }
        if (['/setup.js', '/setup.css'].includes(url.pathname)) {
          const filename = url.pathname === '/setup.js' ? 'max-setup.js' : 'max-setup.css';
          res.writeHead(200, {
            'Content-Type': filename.endsWith('.js')
              ? 'text/javascript; charset=utf-8'
              : 'text/css; charset=utf-8',
          });
          return res.end(fs.readFileSync(path.join(assetRoot, filename)));
        }
      }
      if (req.method !== 'POST') throw fail(405, 'Метод не поддерживается.');
      if (
        req.headers.origin !== origin ||
        req.headers['x-cartoteca-setup'] !== csrf ||
        !(req.headers.cookie || '')
          .split(';')
          .map((x) => x.trim())
          .includes('cartoteca_max_setup=' + cookie)
      )
        throw fail(403, 'Откройте локальное окно заново.');
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
        throw fail(415, 'Ожидается обычный JSON.');
      if (Number(req.headers['content-length'] || 0) > 4096)
        throw fail(413, 'Превышен размер локального запроса.');
      const values = await readBody(req, 4096);
      if (!values || typeof values !== 'object' || Array.isArray(values))
        throw fail(400, 'Некорректные параметры.');
      if (url.pathname === '/state')
        return json(res, 200, { ...state(), preview: syntheticMessagePreview() });
      if (busy) throw fail(409, 'Дождитесь завершения предыдущего действия.');
      busy = true;
      let phase = 'save';
      try {
        if (url.pathname === '/save') {
          if (
            Object.keys(values).some((x) => !['token', 'replace'].includes(x)) ||
            typeof values.token !== 'string' ||
            (values.replace !== undefined && typeof values.replace !== 'boolean')
          )
            throw fail(400, 'Некорректные параметры.');
          await store.save(values.token.trim(), { replace: values.replace === true });
          verified = false;
          error = false;
          problem = null;
          return json(res, 200, state());
        }
        if (url.pathname === '/verify') {
          if (Object.keys(values).length) throw fail(400, 'Проверка не принимает параметры.');
          phase = 'load';
          const saved = await store.load();
          phase = 'provider';
          const bot = configuredMax({ enabled: true, token: saved.token, fetchImpl });
          const identity = await bot.initialize();
          phase = 'identity';
          if (identity.username !== MAX_USERNAME)
            throw fail(409, 'Токен относится к другому боту.');
          verified = true;
          error = false;
          problem = null;
          return json(res, 200, state());
        }
        throw fail(404, 'Действие не найдено.');
      } catch (failure) {
        error = true;
        verified = false;
        problem = setupProblem(failure, phase);
        throw fail(400, problem.message);
      } finally {
        busy = false;
      }
    } catch (failure) {
      json(res, failure.status || 400, {
        error: failure.status ? failure.message : 'Локальная настройка недоступна.',
      });
    }
  });
  const timer = setTimeout(() => {
    closed = true;
    server.close();
    server.closeAllConnections();
  }, lifetime);
  timer.unref?.();
  server.once('close', () => clearTimeout(timer));
  return server;
}
module.exports = { createMaxSetupServer };
