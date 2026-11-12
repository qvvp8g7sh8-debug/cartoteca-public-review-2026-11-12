const { authContextHeaders } = require('./helpers/account-context.cjs');
const { assetPath } = require('./helpers/interface-assets.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createPlatformStore } = require('../platform-store.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const root = path.resolve(__dirname, '..');
test('real multi-user server supports unchanged owner UI on mobile and desktop and admin dashboard', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-v2-ui-')),
    windows = [];
  const platform = createPlatformStore(path.join(dir, 'platform'));
  const owner = await platform.registerOwner({
    email: 'owner@example.test',
    password: 'Owner-ui-password-2026',
    displayName: 'Test Owner',
    organizationName: 'Test Clinic',
  });
  platform.verifyEmail(owner.verificationToken);
  await platform.bootstrapGlobalAdmin({
    email: 'admin@example.test',
    password: 'Admin-ui-password-2026',
    displayName: 'Test Admin',
  });
  platform.close();
  const server = createMultiServer({ dataDir: dir, sendMail: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    windows.forEach((w) => w.close());
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function ui(email, password, page, width) {
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: base, 'X-Cartoteca-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0],
      context = authContextHeaders(await login.json()),
      errors = [];
    const html = await fetch(base + '/' + page + '.html', { headers: { Cookie: cookie } });
    assert.equal(html.status, 200);
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => {
      if (!e.message.includes('navigation')) errors.push(e.message);
    });
    const dom = new JSDOM(await html.text(), {
        url: base,
        runScripts: 'outside-only',
        virtualConsole: vc,
      }),
      w = dom.window;
    windows.push(w);
    w.fetch = (route, opts = {}) =>
      fetch(base + route, { ...opts, headers: { ...opts.headers, Origin: base, Cookie: cookie } });
    w.AbortController = AbortController;
    w.structuredClone = structuredClone;
    w.matchMedia = () => ({ matches: width <= 700, addEventListener() {} });
    w.confirm = () => true;
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    page === 'index'
      ? require('./helpers/client-bundle.cjs').evaluateClient(w)
      : w.eval(fs.readFileSync(assetPath(page === 'index' ? 'app.js' : 'admin.js'), 'utf8'));
    const deadline = Date.now() + 5000;
    while (
      page === 'index'
        ? w.document.body.classList.contains('app-loading')
        : w.document.querySelector('#admin-dashboard').hidden
    ) {
      if (Date.now() > deadline) throw Error('UI did not load');
      await new Promise((r) => setTimeout(r, 15));
    }
    return {
      w,
      errors,
      read: () => fetch(base + '/api/cabinet', { headers: { Cookie: cookie, ...context } }),
      $: (selector) => w.document.querySelector(selector),
    };
  }
  for (const width of [390, 1440]) {
    const h = await ui('owner@example.test', 'Owner-ui-password-2026', 'index', width);
    for (const view of ['clients', 'card', 'services', 'settings', 'calendar']) {
      h.$(`[data-view="${view}"]`).click();
      await new Promise((r) => setImmediate(r));
      assert.equal(h.$(`[data-view="${view}"]`).getAttribute('aria-current'), 'page');
    }
    h.$('[data-view="settings"]').click();
    const end = Date.now() + 5000;
    while (!h.$('#invite-member-form')) {
      if (Date.now() > end) throw Error('Team UI timeout');
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(h.$('#invite-member-form option[value="cosmetologist"]').textContent, 'Сотрудник');
    assert.equal(h.$('#invite-member-form option[value="staff"]'), null);
    h.$('[data-view="clients"]').click();
    await new Promise((r) => setImmediate(r));
    h.$('#add-patient').click();
    h.$('[name="firstName"]').value = 'Synthetic No Bot ' + width;
    assert.equal(h.$('[name="birth"]').required, false);
    assert.equal(h.$('[name="birth"]').type, 'date');
    assert.match(
      h.$('[name="birth"]').closest('label').textContent,
      /Дата рождения \(необязательно\)/,
    );
    h.$('#editor-form').dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
    const savedBy = Date.now() + 5000;
    while (h.$('#editor').open || h.$('#save-editor').disabled) {
      if (Date.now() > savedBy) throw Error('No-bot save timeout');
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(h.$('#detail h2').textContent, 'Synthetic No Bot ' + width);
    assert.equal(h.$('[data-telegram-share]'), null);
    assert.equal(h.$('[data-view="card"]').getAttribute('aria-current'), 'page');
    assert.equal(h.$('#form-error').textContent, '');
    const readPatient = async () => {
      const response = await h.read();
      assert.equal(response.status, 200);
      return (await response.json()).patients.find((p) => p.name === 'Synthetic No Bot ' + width);
    };
    assert.equal((await readPatient()).birth, '');
    async function saveBirth(value) {
      h.$('#edit-patient').click();
      assert.equal(h.$('[name="birth"]').required, false);
      h.$('[name="birth"]').value = value;
      h.$('#editor-form').dispatchEvent(
        new h.w.Event('submit', { bubbles: true, cancelable: true }),
      );
      const end = Date.now() + 5000;
      while (h.$('#editor').open || h.$('#save-editor').disabled) {
        if (Date.now() > end) throw Error('Birth save timeout');
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.equal(h.$('#form-error').textContent, '');
      assert.equal((await readPatient()).birth, value);
    }
    await saveBirth('1990-01-02');
    assert.match(h.$('.patient-header .contact').textContent, /2 января 1990/);
    assert.match(h.$('#patient-print').textContent, /Дата рождения/);
    h.$('#edit-patient').click();
    assert.equal(h.$('[name="birth"]').value, '1990-01-02');
    h.$('#cancel-editor').click();
    await saveBirth('');
    assert.match(h.$('.patient-header .contact').textContent, /дата рождения не указана/);
    assert.match(h.$('#patient-print').textContent, /Дата рожденияНе указано/);
    assert.doesNotMatch(h.$('#patient-print').textContent, /1990/);
    assert.deepEqual(h.errors, []);
  }
  const admin = await ui('admin@example.test', 'Admin-ui-password-2026', 'admin', 1440);
  admin.$('[data-admin-view="organizations"]').click();
  const listDeadline = Date.now() + 5000;
  while (!admin.$('#admin-organizations').textContent.includes('Test Clinic')) {
    if (Date.now() > listDeadline) throw Error('Admin organization list timeout');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.match(admin.$('#admin-organizations').textContent, /Test Clinic/);
  assert.deepEqual(admin.errors, []);
});
