const { assetPath } = require('./helpers/interface-assets.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createStorage } = require('../storage.cjs'),
  { createPlatformStore } = require('../platform-store.cjs'),
  { createMultiServer } = require('../multi-server.cjs');
const { validateState } = require('../src/server/modules/cabinet/validation.cjs');
const password = 'Synthetic-video-consent-password',
  root = path.resolve(__dirname, '..');
const patient = (id, createdBy) => ({
  id,
  name: '',
  firstName: '',
  lastName: '',
  middleName: '',
  designation: 'Соседка от Ирины',
  phone: '+79000000000',
  createdBy,
  visits: [],
  appointments: [],
});
async function until(fn) {
  const deadline = Date.now() + 7000;
  while (!(await fn())) {
    if (Date.now() > deadline) throw Error('Consent UI timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}
test('missing FIO requires a designation or complete phone; consent accepts only the three explicit states', () => {
  const p = patient('p', 'staff'),
    data = { revision: 0, patients: [p], services: [] };
  assert.doesNotThrow(() => validateState(data));
  assert.doesNotThrow(() => validateState({ ...data, patients: [{ ...p, designation: '' }] }));
  for (const change of [
    { designation: '', phone: '+7' },
    { name: undefined },
    { name: null },
    { videoConsent: true },
    { videoConsent: 'yes' },
    { videoConsent: null },
  ])
    assert.throws(
      () => validateState({ ...data, patients: [{ ...p, ...change }] }),
      (e) => e.status === 400,
    );
  for (const videoConsent of ['unknown', 'granted', 'refused'])
    assert.doesNotThrow(() => validateState({ ...data, patients: [{ ...p, videoConsent }] }));
  assert.doesNotThrow(() =>
    validateState({
      ...data,
      patients: [{ ...p, lastName: 'Орлова', name: 'Орлова', designation: '' }],
    }),
  );
});
for (const width of [390, 1440])
  test(
    'all salon roles change only accessible video consent; unnamed cards remain searchable, editable and printable at ' +
      width,
    async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-video-consent-')),
        platform = createPlatformStore(path.join(dir, 'platform')),
        users = {};
      users.owner = await platform.registerOwner({
        email: 'owner@example.test',
        password,
        displayName: 'Synthetic owner',
        organizationName: 'Synthetic salon',
      });
      platform.verifyEmail(users.owner.verificationToken);
      for (const [name, role] of [
        ['staff', 'cosmetologist'],
        ['other', 'cosmetologist'],
        ['admin', 'salon_admin'],
      ]) {
        const invite = platform.createInvitation({
          organizationId: users.owner.organizationId,
          invitedBy: users.owner.accountId,
          role,
        });
        users[name] = await platform.acceptInvitation({
          token: invite.token,
          email: name + '@example.test',
          password,
          displayName: 'Synthetic ' + name,
        });
      }
      users.foreign = await platform.registerOwner({
        email: 'foreign@example.test',
        password,
        displayName: 'Foreign',
        organizationName: 'Foreign',
      });
      platform.verifyEmail(users.foreign.verificationToken);
      platform.close();
      const storage = createStorage(path.join(dir, 'tenants', users.owner.organizationId));
      storage.write({
        revision: 0,
        patients: [
          patient('own', users.staff.accountId),
          { ...patient('hidden', users.other.accountId), designation: 'Скрытая' },
        ],
        services: [],
      });
      storage.close();
      let w;
      const server = createMultiServer({
        dataDir: dir,
        telegramBot: null,
        sendMail: null,
        telegramAutostart: false,
        supportAutostart: false,
      });
      t.after(async () => {
        try {
          if (w) {
            w.dispatchEvent(new w.Event('pagehide'));
            w.close();
          }
        } finally {
          try {
            if (server.listening) {
              server.closeAllConnections();
              await new Promise((r) => server.close(r));
            }
          } finally {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        }
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const base = 'http://127.0.0.1:' + server.address().port;
      const request = async (name, route, body, method = body ? 'POST' : 'GET') => {
        const r = await fetch(base + route, {
          method,
          headers: {
            Origin: base,
            'X-Cartoteca-Request': '1',
            'Content-Type': 'application/json',
            Cookie: cookies[name] || '',
            ...contexts[name],
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        return {
          status: r.status,
          data: await r.json(),
          cookie: r.headers.get('set-cookie')?.split(';')[0],
        };
      };
      const cookies = {},
        contexts = {};
      for (const name of Object.keys(users)) {
        const login = await request(name, '/api/auth/login', {
          email: name + '@example.test',
          password,
        });
        assert.equal(login.status, 200);
        cookies[name] = login.cookie;
        contexts[name] = authContextHeaders(login.data);
      }
      async function change(name, id, status) {
        const data = (await request(name, '/api/cabinet')).data,
          before = data.patients.find((p) => p.id === id) || patient(id, users.staff.accountId);
        return request(
          name,
          '/api/cabinet/changes',
          {
            revision: data.revision,
            services: [],
            patients: [{ id, before, after: { ...before, videoConsent: status } }],
          },
          'PATCH',
        );
      }
      for (const name of ['owner', 'admin', 'staff'])
        for (const status of ['granted', 'refused', 'unknown'])
          assert.equal((await change(name, 'own', status)).status, 200);
      assert.equal((await change('other', 'own', 'granted')).status, 403);
      assert.equal((await change('foreign', 'own', 'granted')).status, 409);
      const before = (await request('staff', '/api/cabinet')).data;
      const tampered = { ...before.patients[0], videoConsent: 'granted', designation: 'Подмена' };
      assert.equal(
        (
          await request(
            'staff',
            '/api/cabinet/changes',
            {
              revision: before.revision,
              services: [],
              patients: [{ id: 'own', before: before.patients[0], after: tampered }],
            },
            'PATCH',
          )
        ).status,
        403,
      );
      let printed = 0;
      const errors = [],
        vc = new VirtualConsole();
      vc.on('jsdomError', (e) => errors.push(e.message));
      w = new JSDOM(fs.readFileSync(assetPath('index.html'), 'utf8'), {
        url: base,
        runScripts: 'outside-only',
        virtualConsole: vc,
      }).window;
      w.fetch = (route, options = {}) =>
        fetch(base + route, {
          ...options,
          headers: { ...options.headers, Origin: base, Cookie: cookies.owner },
        });
      w.AbortController = AbortController;
      w.structuredClone = structuredClone;
      w.matchMedia = () => ({ matches: width <= 700, addEventListener() {} });
      w.confirm = () => true;
      w.print = () => {
        printed++;
      };
      require('./helpers/action-confirmation.cjs').installActionConfirmation(w);
      const $ = (s) => w.document.querySelector(s),
        read = async () => (await request('owner', '/api/cabinet')).data;
      require('./helpers/client-bundle.cjs').evaluateClient(w);
      await until(() => !w.document.body.classList.contains('app-loading'));
      $('[data-view="clients"]').click();
      $('[data-client-filter="all"]').click();
      $('#search').value = 'Соседка';
      $('#search').dispatchEvent(new w.Event('input', { bubbles: true }));
      await until(() => $('[data-patient="own"]'));
      assert.equal($('#patient-list strong').textContent, '+7 (900) 000-00-00');
      $('[data-patient="own"]').click();
      await until(() => $('#patient-video-consent'));
      assert.equal($('.patient-header h2').textContent, '+7 (900) 000-00-00');
      assert.match($('#detail').textContent, /Обозначение: Соседка от Ирины/);
      assert.equal($('#patient-video-consent').checked, false);
      assert.equal($('.video-consent-status'), null);
      assert.equal($('#video-consent-reset'), null);
      assert.equal($('.patient-video-consent>small'), null);
      assert.ok($('.patient-video-consent [data-settings-help]'));
      $('.patient-video-consent [data-settings-help]').click();
      assert.equal($('#settings-help-dialog').open, true);
      assert.match($('#settings-help-text').textContent, /не заменяет юридическое согласие/);
      $('#settings-help-dialog').close();
      const grantedInput = $('#patient-video-consent');
      grantedInput.click();
      await until(
        async () =>
          !grantedInput.isConnected &&
          (await read()).patients.find((p) => p.id === 'own').videoConsent === 'granted',
      );
      assert.equal($('#patient-video-consent').checked, true);
      const refusedInput = $('#patient-video-consent');
      refusedInput.click();
      await until(
        async () =>
          !refusedInput.isConnected &&
          (await read()).patients.find((p) => p.id === 'own').videoConsent === 'refused',
      );
      assert.equal($('#patient-video-consent').checked, false);
      assert.equal($('.video-consent-status'), null);
      assert.equal($('#video-consent-reset'), null);
      $('#edit-patient').click();
      assert.equal($('[name="firstName"]').required, false);
      $('[name="designation"]').value = 'Соседка от Ирины, уточнить';
      $('#editor-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await until(() => !$('#editor').open && !$('#save-editor').disabled);
      assert.equal((await read()).patients.find((p) => p.id === 'own').name, '');
      $('#print-patient').click();
      await until(() => printed === 1);
      assert.match($('#patient-print').textContent, /Имя не указано/);
      assert.doesNotMatch($('#patient-print').textContent, /Соседка|videoConsent|видеосъёмк/);
      assert.deepEqual(errors, []);
    },
  );
