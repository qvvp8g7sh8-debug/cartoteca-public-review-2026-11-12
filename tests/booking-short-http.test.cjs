const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { serveStatic } = require('../src/server/http/static-files.cjs');
const { versionedHtml } = require('../src/server/http/client-release.cjs');
const { files } = require('../src/shared/web-assets.cjs');
const { routes } = require('../src/server/modules/booking/public-routes.cjs');
const { privateBookingHealth } = require('../src/server/modules/booking/readiness.cjs');

test('short booking shell is public, stays at its address and versions root-relative assets', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-short-shell-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of files) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      file === 'booking.html'
        ? '<head><link href="/booking.css"><script src="/booking.js"></script></head><main>Booking</main>'
        : 'Synthetic public asset',
    );
  }
  for (const method of ['GET', 'HEAD']) {
    let status, headers, body;
    const res = {
      writeHead: (s, h) => {
        status = s;
        headers = h;
      },
      end: (b) => {
        body = b;
      },
    };
    await serveStatic({ method }, res, new URL('https://booking.test/b/k7m4p9x2'), null, root);
    assert.equal(status, 200);
    assert.equal(headers['Content-Type'], 'text/html; charset=utf-8');
    assert.equal(headers.Location, undefined);
    if (method === 'GET') {
      assert.match(body.toString(), /href="\/booking\.css\?v=[a-f0-9]{16}"/);
      assert.match(body.toString(), /src="\/booking\.js\?v=[a-f0-9]{16}"/);
    } else assert.equal(body, undefined);
  }
  for (const pathname of ['/b/short', '/b/K7m4p9x2', '/b/k7m4p9x2/extra', '/b/platform.sqlite']) {
    await assert.rejects(
      serveStatic({ method: 'GET' }, {}, new URL(pathname, 'https://booking.test'), null, root),
      { status: 404 },
    );
  }
  await assert.rejects(
    serveStatic({ method: 'POST' }, {}, new URL('https://booking.test/b/k7m4p9x2'), null, root),
    { status: 405 },
  );
  const html = versionedHtml(
    '<head><script src="//other.test/app.js"></script><link href="/unknown.css"><script src="app.js"></script></head>',
    '1234567890abcdef',
  );
  assert.match(html, /src="\/\/other.test\/app.js"/);
  assert.match(html, /href="\/unknown.css"/);
  assert.match(html, /src="app.js\?v=1234567890abcdef"/);
});

function context(query, { denyBudget = false, missing = false } = {}) {
  const order = [];
  const unavailable = () => {
    throw Object.assign(new Error('Unavailable'), { status: 404 });
  };
  return {
    order,
    req: {},
    res: {},
    url: new URL('https://booking.test/api/public-booking/info' + query),
    clientAddress: () => 'synthetic-address',
    json: (_res, status, value) => ({ status, value }),
    platform: {
      bookingPublicLimits: {
        consumeReadAsync: async () => {
          order.push('budget');
          if (denyBudget) throw Object.assign(new Error('Limited'), { status: 429 });
        },
      },
      bookingShortLinks: {
        resolve: (code) => {
          order.push('resolve');
          assert.equal(code, 'k7m4p9x2');
          if (missing) unavailable();
          return { organizationId: 'synthetic-organization', staffId: 'synthetic-staff' };
        },
      },
      withReadSnapshot: (read) => read(),
      bookingPublication: {
        resolve: (org) => {
          order.push('publication');
          assert.equal(org, 'synthetic-organization');
          return { organizationId: org, name: 'Synthetic organization' };
        },
        state: () => ({ enabled: false }),
      },
    },
  };
}

test('short link resolves after read budget and uses ordinary paused-publication projection', async () => {
  const c = context('?link=k7m4p9x2');
  const result = await routes.find((r) => r.path === '/api/public-booking/info').handle(c);
  assert.deepEqual(c.order, ['budget', 'resolve', 'publication']);
  assert.equal(result.status, 200);
  assert.equal(result.value.selectedStaffId, 'synthetic-staff');
  assert.equal(result.value.organization.organizationId, 'synthetic-organization');
  assert.equal(result.value.health.reason, 'paused');
  assert.deepEqual(result.value.members, []);
  assert.deepEqual(result.value.services, []);
  assert.equal(result.value.challenge, undefined);
});

test('short link cannot bypass budget, unresolved code or mix alternate target parameters', async () => {
  const route = routes.find((r) => r.path === '/api/public-booking/info');
  const blocked = context('?link=k7m4p9x2', { denyBudget: true });
  await assert.rejects(route.handle(blocked), { status: 429 });
  assert.deepEqual(blocked.order, ['budget']);
  const unknown = context('?link=k7m4p9x2', { missing: true });
  await assert.rejects(route.handle(unknown), { status: 404 });
  assert.deepEqual(unknown.order, ['budget', 'resolve']);
  for (const suffix of ['&organization=other', '&staff=other', '&link=duplicate']) {
    const mixed = context('?link=k7m4p9x2' + suffix);
    await assert.rejects(route.handle(mixed), { status: 400 });
    assert.deepEqual(mixed.order, ['budget']);
  }
});

test('background publication health retains staff link map after reconciliation', () => {
  const publication = {
    canManage: true,
    enabled: true,
    revision: 2,
    path: '/b/k7m4p9x2',
    staffPaths: { synthetic: '/b/p6t3r5w9' },
  };
  let reconciled = false;
  const result = privateBookingHealth({
    token: 'synthetic-session',
    current: { organizationId: 'synthetic-organization' },
    platform: {
      withWriteLock: (write) => write(),
      withReadOnlySnapshot: (read) => read(),
      bookingPublication: {
        view: () => publication,
        inspectView: () => ({
          publication: { ...publication, enabled: !reconciled, revision: reconciled ? 3 : 2 },
          needsLinks: false,
          needsReconcile: !reconciled,
        }),
        reconcileInTransaction: () => {
          reconciled = true;
          return { canManage: true, enabled: false, revision: 3, path: publication.path };
        },
      },
    },
  });
  assert.deepEqual(result.publication.staffPaths, publication.staffPaths);
  assert.equal(result.publication.revision, 3);
  assert.equal(reconciled, true);
});
