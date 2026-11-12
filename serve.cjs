const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { configuredMailer } = require('./mail.cjs');
const { createBackup } = require('./backup.cjs');
const dikidi = require('./dikidi-adapter.cjs');
const { clientAddressResolver } = require('./client-address.cjs');
const { createStore, SESSION_MS, fail } = require('./auth-store.cjs');
const allowed = new Set(['index.html', 'style.css', 'ui-extra.css', 'app.js', 'app-settings.js', 'app-assistant.js', 'assistant-capture-worklet.js', 'login.html', 'login.js', 'auth.css', 'security.js']);
const publicFiles = new Set(['login.html', 'login.js', 'auth.css', 'style.css', 'ui-extra.css']);
const { clientRelease, versionedHtml } = require('./src/server/http/client-release.cjs');
const { publicAssetRoot } = require('./src/shared/web-assets.cjs');
const assetRoot = publicAssetRoot(__dirname);
const cookieName = 'cartoteca_session';
const json = (res, status, payload) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(status === 204 ? '' : JSON.stringify(payload));
};
const { readBody: readJsonBody } = require('./src/server/http/responses.cjs');
const { createJsonBodyScope } = require('./src/server/http/json-body-budget.cjs');
function tokenFrom(req) {
  return (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
}
function createServer({ dataDir = process.env.CARTOTECA_DATA_DIR || path.join(__dirname, 'data'), origin = process.env.APP_ORIGIN || '', additionalOrigins = [], sendMail = configuredMailer(), backups = false, production = process.env.NODE_ENV === 'production', trustedProxies = (process.env.TRUSTED_PROXIES || '').split(',') } = {}) {
  const clientAddress=clientAddressResolver(trustedProxies);
  const extraOrigins = additionalOrigins.map(value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) throw Error('Expected an exact HTTP(S) origin.');
    if ((production || origin.startsWith('https://')) && url.protocol !== 'https:') throw Error('HTTPS cannot be mixed with HTTP origins.');
    return url.origin;
  });
  const store = createStore(dataDir);
  if (production && (!origin.startsWith('https://') || !store.configured())) { store.close(); throw Error('Production requires an HTTPS origin and an existing owner account. Initialize locally before deployment.'); }
  const secure = origin.startsWith('https://');
  function setCookie(res, token) {
    res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? SESSION_MS / 1000 : 0}${secure ? '; Secure' : ''}`);
  }
  const server = http.createServer(async (req, res) => {
    const bodyScope=createJsonBodyScope(clientAddress(req));
    const readBody=(request,limit)=>readJsonBody(request,limit,undefined,bodyScope.options);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      const port = req.socket.localPort;
      const expectedOrigins = [...(origin ? [new URL(origin).origin] : [`http://127.0.0.1:${port}`, `http://localhost:${port}`]), ...extraOrigins];
      if (!expectedOrigins.some(value => new URL(value).host === req.headers.host)) throw fail(403, 'Адрес сервера не разрешён.');
      const url = new URL(req.url, expectedOrigins[0]);
      if (!['GET', 'HEAD'].includes(req.method)) {
        if (!expectedOrigins.includes(req.headers.origin) || new URL(req.headers.origin).host !== req.headers.host || req.headers['x-cartoteca-request'] !== '1') throw fail(403, 'Запрос должен быть отправлен из картотеки.');
      }
      const token = tokenFrom(req);
      const authenticated = store.session(token);
      const ip=clientAddress(req);
      const authorize=()=>{if(!store.session(token))throw fail(401,'Войдите в картотеку.');};
      const authorizedBody=async(limit)=>{const body=await readBody(req,limit);authorize();return body;};
      if (url.pathname === '/api/auth/session' && req.method === 'GET') return json(res, 200, { configured: store.configured(), user: authenticated ? store.user() : null });
      if (['/api/auth/setup', '/api/auth/login'].includes(url.pathname) && req.method === 'POST') {
        const body = await readBody(req);
        const method = url.pathname.endsWith('/setup') ? 'setup' : 'login';
        const nextToken = await store[method](body?.email, body?.password, ip, req.headers['user-agent']);
        store.logout(token);
        setCookie(res, nextToken);
        return json(res, 200, { user: store.session(nextToken) ? store.user() : null, requiresMfa: !store.session(nextToken) });
      }
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        store.logout(token);
        setCookie(res, '');
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/auth/verify' && req.method === 'POST') {
        const nextToken = store.verify(token, (await readBody(req)).code); setCookie(res, nextToken); return json(res, 200, { user: store.user() });
      }
      if (url.pathname === '/api/auth/forgot' && req.method === 'POST') return json(res, 200, await store.requestReset((await readBody(req)).email, sendMail, origin, ip));
      if (url.pathname === '/api/auth/reset' && req.method === 'POST') { const result = await store.resetPassword(await readBody(req), ip); setCookie(res, ''); return json(res, 200, result); }
      if (url.pathname.startsWith('/api/')) {
        if (!authenticated) throw fail(401, 'Войдите в картотеку.');
        if (url.pathname === '/api/security' && req.method === 'GET') return json(res, 200, { ...store.security(token), mailConfigured: Boolean(sendMail && origin) });
        if (url.pathname === '/api/security/revoke' && req.method === 'POST') return json(res, 200, store.revoke(token, (await authorizedBody()).id));
        if (url.pathname === '/api/security/mfa/prepare' && req.method === 'POST') return json(res, 200, await store.prepareMfa(token, await authorizedBody()));
        if (url.pathname === '/api/security/mfa/enable' && req.method === 'POST') return json(res, 200, store.enableMfa(token, (await authorizedBody()).code));
        if (url.pathname === '/api/security/mfa/disable' && req.method === 'POST') return json(res, 200, await store.disableMfa(token, await authorizedBody()));
        if (url.pathname === '/api/security/password' && req.method === 'POST') { const result = await store.changePassword(token, await authorizedBody()); setCookie(res, ''); return json(res, 200, result); }
        if (url.pathname === '/api/export' && req.method === 'GET') {
          const state = store.read();
          for (const p of state.patients) for (const v of p.visits) for (const ph of v.photos || []) { const image = store.photo(ph.data.split('/').pop()); ph.data = 'data:' + image.mime + ';base64,' + image.buffer.toString('base64'); }
          store.storage.audit('cabinet_exported');
          return json(res, 200, { format: 'cosmetology-card-backup', version: 1, createdAt: new Date().toISOString(), ...state });
        }
        if (url.pathname.startsWith('/api/photos/') && ['GET', 'HEAD'].includes(req.method)) { const image = store.photo(url.pathname.slice(12)); res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.buffer.length }); return res.end(req.method === 'HEAD' ? undefined : image.buffer); }
        if (url.pathname === '/api/cabinet' && req.method === 'GET') return json(res, 200, store.read());
        if (url.pathname === '/api/cabinet' && req.method === 'PUT') return json(res, 200, await store.storage.writeAsync(await authorizedBody(50 * 1024 * 1024), authorize));
        if (url.pathname === '/api/dikidi/status' && req.method === 'GET') return json(res, 200, dikidi.publicStatus());
        const match = url.pathname.match(/^\/api\/dikidi\/(clients|services|appointments)(?:\/([^/]+))?$/);
        if (match) {
          const [, resource, id] = match;
          try {
            if (req.method === 'GET') return json(res, 200, await dikidi.list(resource, Object.fromEntries(url.searchParams)));
            if (req.method === 'POST' && !id) { const body=await authorizedBody();authorize();return json(res, 201, await dikidi.create(resource, body)); }
            if (req.method === 'PATCH' && id) { const body=await authorizedBody();authorize();return json(res, 200, await dikidi.update(resource, id, body)); }
            if (req.method === 'DELETE' && id) { await dikidi.remove(resource, id); return json(res, 204, null); }
          } catch (error) { if(error.status===401)throw error; throw fail(502, 'Не удалось связаться с DIKIDI.'); }
        }
        throw fail(404, 'Маршрут не найден.');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw fail(405, 'Метод не поддерживается.');
      let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!allowed.has(file)) throw fail(404, 'Файл не найден.');
      if (!authenticated && file === 'index.html') file = 'login.html';
      else if (!authenticated && !publicFiles.has(file)) throw fail(401, 'Войдите в картотеку.');
      if (['app-settings.js', 'app-assistant.js', 'assistant-capture-worklet.js'].includes(file) && url.searchParams.get('v') !== (await clientRelease(assetRoot)))
        throw fail(409, 'Версия приложения обновилась. Обновите страницу.');
      let content = await fs.promises.readFile(path.join(assetRoot, file));
      if (file.endsWith('.html'))
        content = Buffer.from(versionedHtml(content.toString('utf8'), await clientRelease(assetRoot)));
      res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if(!req.complete && !res.headersSent){res.shouldKeepAlive=false;res.setHeader('Connection','close');res.once('finish',()=>req.destroy());}
      if(res.destroyed)return;
      if(error.retryAfter)res.setHeader('Retry-After',String(error.retryAfter));
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Не удалось сохранить или загрузить данные. Попробуйте ещё раз.', ...(error.code==='UPLOAD_CAPACITY' ? {code:error.code,outcomeUnknown:false} : {}) });
      else res.end();
    } finally {bodyScope.close();}
  });
  let timer, runningBackup;
  async function scheduledBackup() {
    if (runningBackup) return;
    const status = store.storage.get('backupStatus');
    if (status?.ok && Date.now() - status.time < 86400000) return;
    const dir = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
    runningBackup = createBackup(store.storage, dir, process.env.BACKUP_KEY_FILE || path.join(dir, 'backup.key'));
    try { await runningBackup; } catch { console.error('Не удалось создать резервную копию. Проверьте раздел безопасности.'); } finally { runningBackup = null; }
  }
  if (backups) { server.once('listening', scheduledBackup); timer = setInterval(scheduledBackup, 3600000); timer.unref(); }
  server.once('close', () => { clearInterval(timer); if (runningBackup) runningBackup.finally(() => store.close()).catch(() => {}); else store.close(); });
  return server;
}
if (require.main === module) {
  const server = createServer({ backups: true });
  server.listen(Number(process.env.PORT) || 4173, process.env.BIND_HOST || '127.0.0.1', () => console.log(`Картотека: http://127.0.0.1:${server.address().port} — вход по почте и паролю.`));
}
module.exports = { createServer };
