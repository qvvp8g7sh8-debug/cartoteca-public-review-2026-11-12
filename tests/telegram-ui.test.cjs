const { assetPath } = require('./helpers/interface-assets.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createPlatformStore } = require('../platform-store.cjs'),
  { createStorage } = require('../storage.cjs'),
  { createMultiServer } = require('../multi-server.cjs');
const root = path.resolve(__dirname, '..');
async function until(fn, context = () => '') {
  const end = Date.now() + 12000;
  while (!fn()) {
    if (Date.now() > end) throw Error('UI timeout: ' + context());
    await new Promise((r) => setTimeout(r, 20));
  }
}
test('Telegram settings, personal link and client confirmation render on mobile and desktop', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-telegram-ui-')),
    windows = [];
  const platform = createPlatformStore(path.join(dir, 'platform'));
  const owner = await platform.registerOwner({
    email: 'ui@example.test',
    password: 'Telegram-ui-test-password',
    displayName: 'Owner',
    organizationName: 'Test',
  });
  platform.verifyEmail(owner.verificationToken);
  const clinic = createStorage(path.join(dir, 'tenants', owner.organizationId));
  clinic.write({
    revision: 0,
    patients: [
      {
        id: 'p',
        name: 'UI Patient',
        phone: '8 (918) 123-45-67',
        visits: [],
        appointments: [
          {
            id: 'a',
            date: '2030-01-01',
            time: '12:00',
            service: 'Test Consultation',
            duration: 15,
            staffId: owner.accountId,
          },
        ],
      },
    ],
    services: [],
  });
  clinic.close();
  platform.close();
  await require('./helpers/working-days.cjs').workingDays(
    dir,
    'ui@example.test',
    'Telegram-ui-test-password',
    ['2030-01-01', '2030-01-02'],
  );
  const bot = {
    messages: [],
    async initialize() {
      return { username: 'cartoteca_ui_test_bot' };
    },
    async send(chatId, text, markup) {
      this.messages.push({ chatId, text, markup });
    },
    async answer() {},
  };
  const server = createMultiServer({
    dataDir: dir,
    telegramBot: bot,
    telegramAutostart: false,
    sendMail: null,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await server.telegramRuntime.initialize();
  t.after(async () => {
    windows.forEach((w) => {
      w.dispatchEvent(new w.Event('pagehide'));
      w.close();
    });
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const width of [390, 1440]) {
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: base, 'X-Cartoteca-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ui@example.test', password: 'Telegram-ui-test-password' }),
    });
    assert.equal(login.status, 200);
    const context = authContextHeaders(await login.json());
    const api = (route, options = {}) =>
      fetch(base + route, {
        ...options,
        headers: { ...options.headers, Origin: base, Cookie: cookie, ...context },
      });
    const cookie = login.headers.get('set-cookie').split(';')[0],
      errors = [],
      calls = [],
      vc = new VirtualConsole();
    vc.on('jsdomError', (e) => errors.push(e.message));
    const html = await (await fetch(base + '/index.html', { headers: { Cookie: cookie } })).text();
    const w = new JSDOM(html, {
      url: base,
      runScripts: 'outside-only',
      virtualConsole: vc,
      pretendToBeVisual: true,
    }).window;
    windows.push(w);
    w.fetch = async (route, opts = {}) => {
      const call = { route, method: opts.method || 'GET', status: 'pending' };
      calls.push(call);
      const response = await fetch(base + route, {
        ...opts,
        headers: { ...opts.headers, Origin: base, Cookie: cookie },
      });
      call.status = response.status;
      return response;
    };
    w.AbortController = AbortController;
    w.structuredClone = structuredClone;
    w.matchMedia = (query) => ({
      matches: query.includes('min-width')
        ? width >= Number(query.match(/\d+/)[0])
        : width <= Number(query.match(/\d+/)?.[0] || 700),
      addEventListener() {},
    });
    w.confirm = () => true;
    require('./helpers/action-confirmation.cjs').installActionConfirmation(w);
    let refreshTime = Date.now();
    w.Date.now = () => refreshTime;
    // Drive the real resume scheduler with a synthetic clock, rather than waiting 4s per poll.
    const refreshUntil = async (predicate) => {
      const deadline = Date.now() + 12000;
      while (!predicate()) {
        if (Date.now() > deadline) throw Error('Background refresh timeout');
        refreshTime += 5000;
        w.dispatchEvent(new w.Event('focus'));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const $ = (s) => w.document.querySelector(s);
    require('./helpers/client-bundle.cjs').evaluateClient(w);
    await until(() => !w.document.body.classList.contains('app-loading'));
    const styles = w.document.createElement('style');
    styles.textContent =
      fs.readFileSync(assetPath('style.css'), 'utf8') +
      '\n' +
      fs.readFileSync(assetPath('ui-extra.css'), 'utf8');
    w.document.head.append(styles);
    $('[data-view="settings"]').click();
    await until(() => $('#telegram-settings'));
    // Desktop opens Profile on mount; its queued native toggle must finish
    // before this test opens another page, as in the focused settings fixtures.
    await new Promise((resolve) => w.setTimeout(() => w.setTimeout(resolve, 0), 0));
    const telegramSettings = $('#telegram-settings').closest('details');
    assert.equal(telegramSettings.open, false);
    telegramSettings.querySelector('summary').click();
    assert.equal(telegramSettings.open, true);
    await until(
      () => $('#telegram-settings-form'),
      () =>
        JSON.stringify({
          width,
          hidden: w.document.hidden,
          visibility: w.document.visibilityState,
          path: w.location.pathname,
          connected: telegramSettings.isConnected,
          open: telegramSettings.open,
          hiddenAncestor: $('#telegram-settings')?.closest('[hidden]')?.id || null,
          pages: [...w.document.querySelectorAll('.settings-tiles > details[open]')].map(
            (page) => page.querySelector('.settings-accordion-content')?.id,
          ),
          errors,
          requests: calls.filter((call) =>
            [
              '/api/auth/session',
              '/api/account/profile',
              '/api/cabinet/time-zone',
              '/api/notifications/reminders',
            ].includes(call.route),
          ),
        }),
    );
    // Independent settings loaders must all finish before starting a mutation.
    // Keep the deadline and every assertion; include evidence if a loader fails.
    await until(
      () => $('#organization-time-zone-form') && $('#client-notification-settings-form'),
      () =>
        JSON.stringify({
          width,
          zone: Boolean($('#organization-time-zone-form')),
          notifications: Boolean($('#client-notification-settings-form')),
          requests: calls.filter((call) =>
            [
              '/api/account/profile',
              '/api/cabinet/time-zone',
              '/api/online-booking/settings',
              '/api/notifications/service-visibility',
            ].includes(call.route),
          ),
        }),
    );
    assert.match($('#telegram-bot-status').textContent, /Доступен/);
    assert.equal($('#telegram-bot-status').dataset.connectionState, 'connected');
    const form = $('#telegram-settings-form');
    assert.equal(form.elements.enabled, undefined);
    form.elements.leadMinutes.value = '60';
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await until(
      () =>
        $('#telegram-settings-form') &&
        $('#telegram-settings-form') !== form &&
        $('#client-notification-settings-form'),
    );
    assert.equal($('#telegram-settings-form').elements.leadMinutes.value, '60');
    assert.equal($('#telegram-settings').closest('details'), telegramSettings);
    assert.equal(telegramSettings.open, true);
    assert.equal($('#telegram-refresh'), null);
    assert.equal($('#telegram-settings-form').elements.showServices, undefined);
    assert.match($('#telegram-message-preview').textContent, /Услуги:/);
    const zones = [...$('#organization-time-zone-form').elements.timeZone.options].map(
      (option) => option.value,
    );
    assert.equal(zones.length, 11);
    assert.ok(zones.includes('Europe/Moscow'));
    assert.ok(zones.includes('Asia/Kamchatka'));
    assert.ok(!zones.includes('Asia/Yerevan') && !zones.includes('UTC'));
    assert.doesNotMatch(
      $('#telegram-settings').textContent,
      /после разрешения|При отсутствии разрешения/,
    );
    const previewForm = $('#telegram-settings-form'),
      messagesBeforePreview = bot.messages.length;
    previewForm.elements.leadMinutes.dispatchEvent(new w.Event('change', { bubbles: true }));
    await until(() =>
      $('#telegram-message-preview').textContent.includes('Услуги: Консультация, Уход'),
    );
    assert.equal($('#telegram-settings-form'), previewForm);
    assert.equal(bot.messages.length, messagesBeforePreview);
    previewForm.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await until(
      () =>
        $('#telegram-settings-form') &&
        $('#telegram-settings-form') !== previewForm &&
        $('#client-notification-settings-form'),
    );
    assert.equal($('#client-notification-settings-form').elements.showServices.checked, true);
    const dirtyForm = $('#telegram-settings-form'),
      before = calls.filter((c) => c.route === '/api/notifications/reminders').length;
    dirtyForm.elements.leadMinutes.value = '120';
    telegramSettings.querySelector('summary').click();
    assert.equal(telegramSettings.open, false);
    const sessionsBefore = calls.filter((call) => call.route === '/api/auth/session').length;
    refreshTime += 60000;
    w.dispatchEvent(new w.Event('focus'));
    await until(() => {
      const sessions = calls.filter((call) => call.route === '/api/auth/session');
      return sessions.length > sessionsBefore && sessions.at(-1).status !== 'pending';
    });
    assert.equal(
      calls.filter((call) => call.route === '/api/notifications/reminders').length,
      before,
    );
    assert.equal($('#telegram-settings-form'), dirtyForm);
    assert.equal(dirtyForm.elements.leadMinutes.value, '120');
    assert.equal(dirtyForm.elements.timeZone, undefined);
    assert.equal(telegramSettings.open, false);
    telegramSettings.querySelector('summary').click();
    await until(
      () => calls.filter((call) => call.route === '/api/notifications/reminders').length > before,
    );
    assert.equal($('#telegram-settings-form'), dirtyForm);
    assert.equal(dirtyForm.elements.leadMinutes.value, '120');
    $('[data-view="clients"]').click();
    await until(() => $('[data-view="clients"]').getAttribute('aria-current') === 'page');
    $('[data-client-filter="all"]').click();
    await until(() => $('[data-patient="p"]'));
    $('[data-patient="p"]').click();
    await until(() =>
      $(
        '#patient-telegram-connection [data-telegram-link],#patient-telegram-connection [data-telegram-unlink]',
      ),
    );
    assert.equal($('.telegram-patient-panel').tagName, 'SECTION');
    assert.equal($('.telegram-patient-panel > summary'), null);
    assert.equal($('[data-telegram-refresh]'), null);
    assert.equal(w.document.querySelectorAll('.patient-appointments').length, 1);
    const appointments = $('#detail > .patient-appointments'),
      tabsRow = $('#detail > .card-tabs-row');
    assert.ok(appointments && tabsRow);
    assert.equal(appointments.nextElementSibling, tabsRow);
    assert.equal(tabsRow.querySelector(':scope > nav.tabs'), $('#detail .tabs'));
    assert.match($('.appointment-service-line').textContent, /Test Consultation · 15 минут/);
    assert.equal(
      $('#detail').textContent.split($('.appointment-info-heading strong').textContent).length,
      2,
    );
    const testConnection = async () => {
      assert.equal($('.telegram-service-menu'), null);
      assert.ok($('.patient-connections'));
      assert.equal(w.document.querySelectorAll('.connection-service.is-future').length, 2);
      assert.ok(
        [...w.document.querySelectorAll('.connection-service.is-future')].every(
          (button) => button.disabled,
        ),
      );
      const count = calls.filter((c) => c.route.startsWith('/api/telegram/patient')).length;
      await refreshUntil(
        () => calls.filter((c) => c.route.startsWith('/api/telegram/patient')).length >= count + 2,
      );
      assert.equal($('.telegram-service-menu'), null);
      assert.equal($('#editor').open, false);
      assert.equal($('#patient-telegram-body').hasAttribute('data-appointment-id'), false);
    };
    if (width === 390) {
      assert.equal($('.telegram-service-menu'), null);
      assert.equal(
        $('[data-telegram-link] .connection-service-status').textContent,
        'Не подключён · подключить',
      );
      const beforeConnect = calls.filter((c) => c.route === '/api/telegram/link').length;
      $('[data-telegram-link]').click();
      assert.equal($('[data-telegram-link]').disabled, true);
      await until(() => $('[data-telegram-share]'));
      assert.equal(calls.filter((c) => c.route === '/api/telegram/link').length, beforeConnect + 1);
      assert.equal($('[data-telegram-link]'), null);
      assert.equal($('.telegram-service-menu'), null);
      assert.equal($('#telegram-share-dialog'), null);
      assert.equal(
        $('[data-telegram-share] .connection-service-status').textContent,
        'Отправить приглашение',
      );
      const issuedCount = calls.filter((c) => c.route === '/api/telegram/link').length;
      $('[data-telegram-share]').click();
      assert.equal($('#telegram-share-dialog').open, true);
      assert.equal($('#editor').open, false);
      assert.equal($('.telegram-share-recipient strong').textContent, 'UI Patient');
      assert.equal(new URL($('[data-share-channel="whatsapp"]').href).pathname, '/79181234567');
      assert.equal(
        new URL($('[data-share-channel="telegram"]').href).searchParams.get('text'),
        $('#telegram-share-dialog textarea').value,
      );
      assert.equal(bot.messages.length, 0);
      assert.match($('#telegram-share-dialog img').src, /^data:image\/png;base64,/);
      assert.equal(calls.filter((c) => c.route === '/api/telegram/link').length, issuedCount);
      const url = new URL($('[data-telegram-invitation-url]').value);
      assert.equal(url.hostname, 't.me');
      assert.equal(url.pathname, '/cartoteca_ui_test_bot');
      let copied;
      Object.defineProperty(w.navigator, 'clipboard', {
        value: {
          writeText: async (value) => {
            copied = value;
          },
        },
      });
      $('[data-copy-telegram-link]').click();
      await until(() => copied);
      assert.equal(copied, url.toString());
      const input = $('[data-telegram-invitation-url]'),
        polls = calls.filter((c) => c.route.startsWith('/api/telegram/patient')).length;
      await refreshUntil(
        () => calls.filter((c) => c.route.startsWith('/api/telegram/patient')).length >= polls + 2,
      );
      assert.equal($('[data-telegram-invitation-url]'), input);
      assert.equal(input.value, url.toString());
      assert.equal($('.telegram-service-menu'), null);
      $('#telegram-share-dialog [data-close-telegram-share]').click();
      assert.equal($('#telegram-share-dialog').children.length, 0);
      $('[data-telegram-share]').click();
      assert.equal($('[data-telegram-invitation-url]').value, url.toString());
      assert.equal(calls.filter((c) => c.route === '/api/telegram/link').length, issuedCount);
      await server.telegramRuntime.handleUpdate({
        message: {
          chat: { id: '1001', type: 'private' },
          from: { id: '1001' },
          text: '/start ' + url.searchParams.get('start'),
        },
      });
      await refreshUntil(
        () => $('[data-telegram-remind]') && !$('[data-telegram-remind]').disabled,
      );
      await until(() => !$('#telegram-share-dialog').open);
      assert.equal($('#telegram-share-dialog').children.length, 0);
      assert.equal($('[data-telegram-share]'), null);
      assert.equal($('[data-telegram-link]'), null);
      assert.match(
        $('[data-telegram-unlink] .connection-service-status').textContent,
        /✓.*Подключён/,
      );
      assert.match($('[data-telegram-remind]').textContent, /Отправить сейчас/);
      await testConnection();
      w.confirm = () => false;
      $('[data-telegram-unlink]').click();
      assert.equal(
        calls.some((c) => c.route === '/api/telegram/unlink'),
        false,
      );
      w.confirm = () => true;
      assert.equal($('#editor').open, false);
      $('[data-telegram-remind]').click();
      await until(() => $('#patient-telegram-body').textContent.includes('Напоминание в очереди'));
      await server.telegramRuntime.tick();
      await refreshUntil(() =>
        $('#patient-telegram-body').textContent.includes('Напоминание отправлено'),
      );
      assert.equal($('[data-telegram-remind]'), null);
      const message = bot.messages.find((m) =>
        m.markup?.inline_keyboard.flat().some((b) => b.callback_data.startsWith('confirm_')),
      );
      assert.ok(message);
      await server.telegramRuntime.handleUpdate({
        callback_query: {
          id: 'callback',
          from: { id: '1001' },
          message: { chat: { id: '1001', type: 'private' } },
          data: message.markup.inline_keyboard[0][0].callback_data,
        },
      });
      await refreshUntil(() =>
        $('#patient-telegram-body').textContent.includes('Подтверждена клиентом'),
      );
      assert.equal(w.getComputedStyle($('.appointment-status.is-confirmed')).cursor, 'default');
      assert.equal($('#detail').textContent.split('Подтверждена клиентом').length, 2);
      assert.equal($('[data-telegram-remind]'), null);
      $('.appointment-status').click();
      assert.equal($('#editor').open, false);
      const writes = calls.filter((c) => c.route === '/api/cabinet' && c.method === 'PUT').length;
      $('[data-telegram-edit]').click();
      await until(() => $('#editor').open);
      assert.equal($('#dialog-title').textContent, 'Изменить запись');
      assert.equal($('[name="time"]').value, '12:00');
      assert.equal($('[name="patientId"]').value, 'p');
      $('#cancel-editor').click();
      assert.equal(
        calls.filter((c) => c.route === '/api/cabinet' && c.method === 'PUT').length,
        writes,
      );
    } else {
      await testConnection();
      assert.match($('[data-telegram-unlink] .connection-service-status').textContent, /Подключён/);
      assert.match($('#patient-telegram-body').textContent, /Подтверждена клиентом/);
      let cabinet = await (await api('/api/cabinet')).json();
      cabinet.patients[0].appointments = [];
      assert.equal(
        (
          await api('/api/cabinet', {
            method: 'PUT',
            headers: { 'X-Cartoteca-Request': '1', 'Content-Type': 'application/json' },
            body: JSON.stringify(cabinet),
          })
        ).status,
        200,
      );
      await refreshUntil(() => $('.telegram-strip-content').textContent === 'Создайте запись');
      assert.equal($('[data-telegram-edit]'), null);
      assert.equal($('[data-telegram-create-appointment]'), null);
      assert.equal($('.telegram-strip-content button'), null);
      $('#new-patient-appointment').click();
      await until(() => $('#appointment-patient'));
      assert.equal($('#dialog-title').textContent, 'Новая запись');
      assert.equal($('[name="patientId"]').value, 'p');
      assert.ok($('[name="time"]'));
      assert.equal($('[name="reaction"]'), null);
      $('#cancel-editor').click();
      cabinet = await (await api('/api/cabinet')).json();
      cabinet.patients[0].appointments = [
        { id: 'external-new', date: '2030-01-01', time: '14:00', staffId: owner.accountId },
      ];
      assert.equal(
        (
          await api('/api/cabinet', {
            method: 'PUT',
            headers: { 'X-Cartoteca-Request': '1', 'Content-Type': 'application/json' },
            body: JSON.stringify(cabinet),
          })
        ).status,
        200,
      );
      await refreshUntil(() => $('[data-telegram-remind="external-new"]'));
      assert.equal($('[data-telegram-remind="external-new"]').disabled, false);
      $('[data-telegram-edit="external-new"]').click();
      await until(() => $('#editor').open);
      assert.equal($('[name="time"]').value, '14:00');
      $('#cancel-editor').click();
      cabinet = await (await api('/api/cabinet')).json();
      cabinet.patients[0].appointments.push({
        id: 'second',
        date: '2030-01-02',
        time: '16:00',
        staffId: owner.accountId,
      });
      assert.equal(
        (
          await api('/api/cabinet', {
            method: 'PUT',
            headers: { 'X-Cartoteca-Request': '1', 'Content-Type': 'application/json' },
            body: JSON.stringify(cabinet),
          })
        ).status,
        200,
      );
      await refreshUntil(() => $('[data-telegram-remind="second"]'));
      const selectedPolls = calls.filter((c) => c.route.startsWith('/api/telegram/patient')).length;
      await refreshUntil(
        () =>
          calls.filter((c) => c.route.startsWith('/api/telegram/patient')).length >=
          selectedPolls + 2,
      );
      assert.equal(w.document.querySelectorAll('[data-appointment-row]').length, 2);
      assert.equal($('#telegram-appointment-select'), null);
      $('[data-appointment-row="second"] strong').click();
      assert.equal($('#editor').open, false);
      await testConnection();
      cabinet = await (await api('/api/cabinet')).json();
      cabinet.patients[0].appointments.find((a) => a.id === 'second').time = '16:15';
      assert.equal(
        (
          await api('/api/cabinet', {
            method: 'PUT',
            headers: { 'X-Cartoteca-Request': '1', 'Content-Type': 'application/json' },
            body: JSON.stringify(cabinet),
          })
        ).status,
        200,
      );
      $('[data-telegram-edit="second"]').click();
      await until(() => $('#editor').open);
      assert.equal($('[name="time"]').value, '16:15');
      assert.equal($('[name="date"]').value, '2030-01-02');
      $('#cancel-editor').click();
      const requestCount = () =>
          calls.filter((c) => c.route.startsWith('/api/telegram/patient')).length,
        hiddenCount = requestCount();
      Object.defineProperty(w.document, 'visibilityState', { configurable: true, value: 'hidden' });
      w.document.dispatchEvent(new w.Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 150));
      assert.ok(requestCount() <= hiddenCount + 1);
      Object.defineProperty(w.document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      w.document.dispatchEvent(new w.Event('visibilitychange'));
      await refreshUntil(() => requestCount() > hiddenCount + 1);
    }
    $('#add-patient').click();
    $('#editor-form [name="firstName"]').value = 'Synthetic New ' + width;
    const linkCount = calls.filter((c) => c.route === '/api/telegram/link').length;
    $('#editor-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await until(
      () => $('#detail h2')?.textContent === 'Synthetic New ' + width && $('[data-telegram-share]'),
    );
    assert.equal($('#editor').open, false);
    assert.equal(calls.filter((c) => c.route === '/api/telegram/link').length, linkCount + 1);
    assert.equal($('[data-view="card"]').getAttribute('aria-current'), 'page');
    assert.equal($('#telegram-share-dialog')?.open || false, false);
    assert.equal($('.telegram-service-menu'), null);
    assert.equal(
      $('[data-telegram-share] .connection-service-status').textContent,
      'Отправить приглашение',
    );
    const stored = await (await api('/api/cabinet')).json();
    assert.ok(stored.patients.some((p) => p.name === 'Synthetic New ' + width));
    assert.deepEqual(errors, []);
    w.close();
  }
});
