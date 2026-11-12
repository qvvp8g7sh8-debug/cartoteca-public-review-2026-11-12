const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { CookieJar } = require('jsdom');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');

for (const operation of ['logout', 'password-reset']) {
  test(
    `a delayed ${operation} response revokes only A and preserves the newer B cookie`,
    { timeout: 30000 },
    async (t) => {
      const f = await staffMaxFixture(t, { schema: 17 });
      const server = createMultiServer({
        dataDir: f.source,
        notificationSchema: 17,
        origin: 'https://synthetic.test',
        production: false,
        telegramAutostart: false,
        supportAutostart: false,
        maxAutostart: false,
        adminEmailAutostart: false,
        pushAutostart: false,
        sendMail: null,
        pushSend: () => {
          throw Error('External delivery is forbidden');
        },
      });
      let release, signalHeld, pending, waitTimer;
      const held = new Promise((resolve) => {
        signalHeld = resolve;
      });
      // Delay the complete header/body response, as two independent connections can arrive out of order.
      server.prependListener('request', (req, res) => {
        if (req.headers['x-synthetic-hold-auth-response'] !== '1') return;
        const writeHead = res.writeHead.bind(res),
          end = res.end.bind(res);
        let head,
          sent = false;
        res.writeHead = (...args) => {
          head = args;
          return res;
        };
        res.end = (...args) => {
          release = () => {
            if (sent) return;
            sent = true;
            res.writeHead = writeHead;
            res.end = end;
            if (head) writeHead(...head);
            end(...args);
          };
          signalHeld();
          return res;
        };
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      let cleaned = false;
      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(waitTimer);
        release?.();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await pending?.catch(() => {});
      };
      t.after(cleanup);
      const base = 'http://127.0.0.1:' + server.address().port;
      const origin = 'https://synthetic.test/';
      const jar = new CookieJar();
      const [a, b] = f.users;
      jar.setCookieSync(
        'cartoteca_v2_session=' + a.token + '; HttpOnly; SameSite=Strict; Path=/; Secure',
        origin,
      );
      const cookie = () => jar.getCookieStringSync(origin);
      function request(route, body, { actor, hold = false, explicitCookie } = {}) {
        const text = body === undefined ? '' : JSON.stringify(body);
        return new Promise((resolve, reject) => {
          const req = http.request(
            base + route,
            {
              method: text ? 'POST' : 'GET',
              headers: {
                host: 'synthetic.test',
                origin: 'https://synthetic.test',
                'X-Cartoteca-Request': '1',
                Cookie: explicitCookie ?? cookie(),
                ...(actor ? authContextHeaders(actor.login) : {}),
                ...(text
                  ? {
                      'Content-Type': 'application/json',
                      'Content-Length': Buffer.byteLength(text),
                    }
                  : {}),
                ...(hold ? { 'X-Synthetic-Hold-Auth-Response': '1' } : {}),
              },
            },
            (res) => {
              // Browsers process Set-Cookie when headers arrive, before JavaScript reads the body.
              for (const value of res.headers['set-cookie'] || []) jar.setCookieSync(value, origin);
              let responseText = '';
              res.setEncoding('utf8');
              res.on('data', (chunk) => {
                responseText += chunk;
              });
              res.on('error', reject);
              res.on('end', () => {
                try {
                  resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    value: JSON.parse(responseText),
                  });
                } catch (error) {
                  reject(error);
                }
              });
            },
          );
          req.on('error', reject);
          req.end(text);
        });
      }
      try {
        const otherA = await f.platform.login(
          'owner@staff-max.test',
          'Synthetic-staff-max-password',
        );
        const resetToken =
          operation === 'password-reset'
            ? f.platform.requestPasswordReset('owner@staff-max.test')
            : null;
        pending = request(
          operation === 'logout' ? '/api/auth/logout' : '/api/auth/reset',
          operation === 'logout'
            ? {}
            : { token: resetToken, password: 'Synthetic-new-reset-password' },
          { actor: operation === 'logout' ? a : null, hold: true },
        );
        pending.catch(() => {});
        await Promise.race([
          held,
          new Promise((resolve, reject) => {
            waitTimer = setTimeout(
              () => reject(Error('Synthetic authentication response was not held')),
              10000,
            );
          }),
        ]);
        clearTimeout(waitTimer);
        const loginB = await request('/api/auth/login', {
          email: 'staff0@staff-max.test',
          password: 'Synthetic-staff-max-password',
        });
        assert.equal(loginB.status, 200);
        const cookieB = cookie();
        assert.ok(cookieB);
        assert.equal((await request('/api/auth/session')).value.user.id, b.accountId);
        release();
        const completedA = await pending;
        assert.equal(completedA.status, 200);
        assert.equal(
          Boolean(completedA.headers['set-cookie']),
          false,
          'A must not overwrite the shared browser cookie',
        );
        assert.ok(
          cookie() === cookieB,
          'The newer B browser cookie must survive the delayed A response',
        );
        assert.equal((await request('/api/auth/session')).value.user.id, b.accountId);
        assert.equal(
          (
            await request('/api/auth/session', undefined, {
              explicitCookie: 'cartoteca_v2_session=' + a.token,
            })
          ).value.user,
          null,
        );
        const otherSession = (
          await request('/api/auth/session', undefined, {
            explicitCookie: 'cartoteca_v2_session=' + otherA.token,
          })
        ).value.user;
        assert.equal(otherSession?.id || null, operation === 'logout' ? a.accountId : null);
      } finally {
        await cleanup();
      }
    },
  );
}
