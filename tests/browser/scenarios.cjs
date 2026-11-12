const assert = require('node:assert/strict');
const { authContextHeaders } = require('../helpers/account-context.cjs');

const appearance = require('./appearance.cjs');
const { checkLayout } = appearance;
async function chooseCalendarMode(page, mode) {
  const control = page
    .locator(`[data-calendar-mode=${mode}]:visible, [data-phone-calendar-mode]:visible`)
    .first();
  await control.waitFor();
  if ((await control.getAttribute('data-phone-calendar-mode')) !== null)
    await control.selectOption(mode);
  else await control.click();
  await page
    .locator(`[data-calendar-mode=${mode}][aria-pressed=true]`)
    .waitFor({ state: 'attached' });
  // The landscape controls move to their compact toolbar on the next frame.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}
async function openCard(page) {
  await page.locator('[data-view=clients]').click();
  await page.locator('[data-patient=p]').click();
  await page.locator('#new-patient-appointment').waitFor();
}
// The fixture's today+3 may belong to the next month/year. Use the UI's
// ordinary month controls before selecting that unchanged synthetic date.
async function chooseWorkDate(page, date) {
  await page.locator('[data-work-date]').first().waitFor();
  const target = page.locator(`[data-work-date="${date}"]`);
  if (!(await target.count())) await page.locator('[data-work-month="1"]').click();
  await target.click();
}
async function chooseBookingDate(page, date) {
  const month = page.locator('#booking-month');
  await month.waitFor();
  if ((await month.inputValue()) !== date.slice(0, 7)) {
    await month.fill(date.slice(0, 7));
    await month.dispatchEvent('change');
  }
  await page.locator(`[data-booking-date="${date}"]`).click();
}
async function discardEditor(page, selector = '#cancel-editor') {
  await page.locator(selector).click();
  if (await page.locator('#action-confirmation[open]').isVisible())
    await page.locator('#action-confirmation [data-confirm-accept]').click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
}
async function chooseAppointmentService(page, id) {
  const picker = page.locator('#appointment-service');
  if (!(await picker.evaluate((element) => element.open)))
    await picker.locator(':scope > summary').click();
  const button = page.locator(`[data-appointment-service="${id}"]`);
  const group = button.locator('xpath=ancestor::details[1]');
  if (!(await group.evaluate((element) => element.open))) await group.locator('summary').click();
  await button.click();
  assert.equal(await button.isDisabled(), true);
  assert.equal(await picker.evaluate((element) => element.open), false);
}
async function setInlineTime(page, selector, value) {
  const source = page.locator(selector);
  await source.waitFor({ state: 'attached' });
  const paired = await source.evaluate((element) => Boolean(element.closest('[data-work-time]')));
  const original = paired
    ? source.locator('xpath=ancestor-or-self::*[@data-work-time][1]')
    : source;
  const field = original.locator('xpath=preceding-sibling::*[1]');
  await field.waitFor({ state: 'visible' });
  assert.match(await field.getAttribute('class'), /time-picker-field/);
  const trigger = field.locator('[data-time-dropdown]');
  await trigger.click();
  const popup = page.locator('#' + (await trigger.getAttribute('aria-controls')));
  await popup.waitFor({ state: 'visible' });
  const previous = await source.inputValue();
  const option = popup.locator(`[data-time-choice="${value}"]`);
  assert.equal(await option.count(), 1, `Time picker does not allow ${value}`);
  await option.scrollIntoViewIfNeeded();
  assert.equal(await source.inputValue(), previous, 'Scrolling must not commit a new time');
  await option.click();
  assert.equal(await source.inputValue(), value);
  assert.equal(await popup.isVisible(), false);
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
}
async function runScenarios(page, fixture, check) {
  let expectedContext;
  const apiGet = (route) => {
    assert.ok(expectedContext, 'The synthetic UI login must return its actor first');
    return page.request.get(fixture.base + route, { headers: expectedContext });
  };
  const checkLayout = check.layout || appearance.checkLayout;
  const measure = check.appearance || ((name, inspect) => inspect(page));
  page.on('dialog', (dialog) => dialog.accept());
  await check('public-privacy-and-consent', async () => {
    await page.goto(fixture.base + '/privacy.html');
    assert.match(await page.locator('h1').textContent(), /Политика/);
    assert.match(await page.locator('main').textContent(), /000000000000/);
    assert.equal(
      (await page.locator('a[href="mailto:privacy@example.invalid"]').count()) > 0,
      true,
    );
    await checkLayout(page);
    await page.goto(fixture.base + '/consent.html#registration');
    assert.equal(await page.locator('#registration').isVisible(), true);
    assert.equal(await page.locator('#booking').isVisible(), false);
    await checkLayout(page);
    await page.goto(
      fixture.base + '/consent.html?organization=' + fixture.organizationId + '#booking',
    );
    await page.waitForFunction(() =>
      document.querySelector('#consent-organization')?.textContent.includes('Тестовая организация'),
    );
    assert.equal(await page.locator('#booking').isVisible(), true);
    assert.equal(await page.locator('#registration').isVisible(), false);
    await checkLayout(page);
  });
  await check('registration-consent-and-draft', async () => {
    await page.goto(fixture.base + '/login.html?switch-account=1');
    await page.locator('[data-auth-mode=register]').click();
    await page.locator('#auth-name').fill('Синтетический владелец');
    await page.locator('#auth-email').fill('draft@browser.test');
    const consent = page.locator('#auth-privacy-consent');
    assert.equal(await consent.isChecked(), false);
    assert.equal(await consent.evaluate((element) => element.required), true);
    await checkLayout(page);
    const popupPromise = page.waitForEvent('popup');
    await page.locator('#auth-privacy-field a').click();
    const documentPage = await popupPromise;
    try {
      await documentPage.locator('#registration').waitFor();
      assert.equal(await documentPage.locator('#booking').isVisible(), false);
      await checkLayout(documentPage);
    } finally {
      await documentPage.close();
    }
    assert.equal(await page.locator('#auth-email').inputValue(), 'draft@browser.test');
    assert.equal(await consent.isChecked(), false);
    await page.locator('[data-auth-mode=login]').click();
    assert.equal(await consent.isVisible(), false);
  });
  await check('login', async () => {
    await page.goto(fixture.base + '/login.html');
    await page.locator('#auth-email').fill(fixture.email);
    await page.locator('#auth-password').fill(fixture.password);
    const loginResponse = page.waitForResponse(
      (response) =>
        response.url() === fixture.base + '/api/auth/login' &&
        response.request().method() === 'POST',
    );
    await page.locator('#auth-submit').click();
    const authenticated = await loginResponse;
    assert.equal(authenticated.status(), 200);
    expectedContext = authContextHeaders(await authenticated.json());
    await page.locator('#calendar-new').waitFor();
    const install = page.locator('.install-app');
    if ((await page.evaluate(() => innerWidth)) < 700)
      await install.waitFor({ state: 'visible', timeout: 5000 });
    if (await install.isVisible()) {
      await measure('install-banner', appearance.installBanner);
      await install.locator('.install-app-close').click();
    }
    const initialMode = await page
      .locator('[data-calendar-mode][aria-pressed=true]')
      .getAttribute('data-calendar-mode');
    const today = await page.locator('.time-grid').getAttribute('data-dates');
    await chooseCalendarMode(page, 'week');
    const dates = (await page.locator('.time-grid').getAttribute('data-dates')).split(',');
    assert.equal(dates.length, 7);
    assert.equal(dates[0], today.split(',')[0]);
    for (let i = 1; i < dates.length; i++)
      assert.equal(Date.parse(dates[i]) - Date.parse(dates[i - 1]), 86400000);
    await chooseCalendarMode(page, initialMode);
    const early = page.locator('.early-hours-control [data-toggle-early-hours]');
    assert.equal(await early.isVisible(), true);
    assert.match(await early.textContent(), /Показать время до 07:00/);
    await measure('early-hours-control', appearance.earlyHours);
    await early.click();
    assert.equal(await page.locator('.time-grid').getAttribute('data-first-minute'), '0');
    await early.click();
    assert.equal(await page.locator('.time-grid').getAttribute('data-first-minute'), '420');
    await checkLayout(page);
  });
  await check('calendar-multiple-services', async () => {
    await page.locator('#calendar-new').click();
    await page.locator('#appointment-patient-search').fill('89990000001');
    await page.locator('[data-appointment-patient-index="0"]').click();
    await page.locator('#editor [name=date]').fill(fixture.dates[2]);
    await setInlineTime(page, '#editor [name=time]', '10:00');
    await chooseAppointmentService(page, 's1');
    await chooseAppointmentService(page, 's2');
    assert.equal(await page.locator('.appointment-procedure-row').count(), 2);
    assert.equal(await page.locator('#appointment-duration').inputValue(), '75');
    const picker = page.locator('#appointment-service');
    await picker.locator(':scope > summary').click();
    await picker.locator('.appointment-service-menu').waitFor({ state: 'visible' });
    await checkLayout(page, '#editor');
    const close = picker.locator('[data-close-service-picker]');
    if (await close.isVisible()) await close.click();
    else await picker.locator(':scope > summary').click();
    await picker.locator('.appointment-service-menu').waitFor({ state: 'hidden' });
    await checkLayout(page, '#editor');
    await page.locator('#save-editor').click();
    await page.locator('#editor').waitFor({ state: 'hidden' });
    const data = await (await apiGet('/api/cabinet')).json();
    const saved = data.patients[0].appointments.find((a) => a.id !== 'plan');
    assert.equal(saved.serviceItems.length, 2);
    assert.equal(saved.duration, 75);
    await checkLayout(page);
  });
  await check('clients-search-and-profile', async () => {
    await page.locator('[data-view=clients]').click();
    await page.locator('#search').fill('Тестовая пометка');
    await page.locator('[data-patient=p]').waitFor();
    await page.locator('#search').fill('89990000001');
    await page.locator('[data-patient=p]').click();
    await page.locator('#edit-patient').click();
    assert.equal(await page.locator('#editor [name=firstName]').inputValue(), 'Тестовая');
    await checkLayout(page, '#editor');
    await discardEditor(page, '#close-editor');
  });
  await check('appointment-actions-and-confirmation', async () => {
    await openCard(page);
    await page.locator('[data-card-appointment=plan]').click();
    await page.locator('#editor [data-manual-confirm=plan]').waitFor();
    await checkLayout(page, '#editor');
    await page.locator('#editor [data-manual-confirm=plan]').click();
    await page.locator('#action-confirmation [data-confirm-accept]').click();
    await page.waitForFunction(() =>
      /Подтверждена вручную/.test(document.querySelector('#editor').textContent),
    );
    await checkLayout(page, '#editor');
    await discardEditor(page, '#close-editor');
  });
  await check('complete-visit-with-photo', async () => {
    await openCard(page);
    await page.locator('#detail [data-complete-appointment=plan]').click();
    await page.locator('#visit-procedure').waitFor();
    assert.equal(
      await page.locator('#action-confirmation[open]').count(),
      0,
      'Opening a factual visit from the card must not require a second confirmation',
    );
    assert.equal(await page.locator('#editor [name=date]').inputValue(), fixture.dates[0]);
    const option = page.locator('#visit-procedure option[data-service-id=s2]');
    await page.locator('#visit-procedure').selectOption({ label: await option.textContent() });
    assert.equal(await page.locator('.visit-procedure-row').count(), 2);
    await setInlineTime(page, '#editor [name=time]', '14:00');
    const image = await require('sharp')({
      create: { width: 160, height: 120, channels: 3, background: '#bed6e0' },
    })
      .png()
      .toBuffer();
    await page.locator('#photo-input').setInputFiles([
      { name: 'synthetic-before.png', mimeType: 'image/png', buffer: image },
      { name: 'synthetic-after.png', mimeType: 'image/png', buffer: image },
      { name: 'synthetic-control.png', mimeType: 'image/png', buffer: image },
    ]);
    await page.waitForFunction(() => document.querySelectorAll('#upload-list img').length === 3);
    await page.locator('#photo-batch-caption').selectOption('До');
    assert.equal(await page.locator('[data-photo-caption="0"]').inputValue(), 'До');
    assert.equal(await page.locator('[data-photo-caption="1"]').inputValue(), 'До');
    assert.equal(await page.locator('[data-photo-caption="2"]').inputValue(), 'До');
    await page.locator('[data-photo-caption="1"]').selectOption('После');
    await page.locator('[data-photo-caption="2"]').selectOption('Контроль');
    await checkLayout(page, '#editor');
    await page.locator('#save-editor').click();
    await page.locator('#editor').waitFor({ state: 'hidden' });
    const data = await (await apiGet('/api/cabinet')).json();
    const appointment = data.patients[0].appointments.find((a) => a.id === 'plan');
    assert.equal(appointment.status, 'completed');
    const visit = data.patients[0].visits.find((v) => v.id === appointment.completedVisitId);
    assert.equal(visit.serviceItems.length, 2);
    assert.equal(visit.photos.length, 3);
    assert.deepEqual(
      visit.photos.map((photo) => photo.caption),
      ['До', 'После', 'Контроль'],
    );
    assert.equal(appointment.date, visit.date);
    await page.locator('[data-tab="photos"]').click();
    const procedures = await page.locator('.photo-item-procedure').allTextContents();
    assert.equal(procedures.filter((text) => text === visit.procedure).length, 3);
    await checkLayout(page);
  });
  await check('walk-in-visit', async () => {
    await openCard(page);
    await page.locator('#new-visit').click();
    await page.locator('#visit-procedure').waitFor();
    await setInlineTime(page, '#editor [name=time]', '12:15');
    await checkLayout(page, '#editor');
    await discardEditor(page);
  });
  await check('services-and-category', async () => {
    await page.locator('[data-view=services]').click();
    if (await page.locator('#service-category-select').isVisible())
      await page.locator('#service-category-select').selectOption('care');
    else await page.locator('[data-service-category-tab=care]').click();
    await page.locator('[data-select-service=s1]').click();
    await page.locator('[data-select-service=s2]').click();
    assert.equal(await page.locator('.selected-service-card').count(), 2);
    await checkLayout(page);
    await page.locator('#create-appointment-from-services').click();
    await page.locator('#appointment-duration').waitFor();
    assert.equal(await page.locator('#appointment-duration').inputValue(), '75');
    await checkLayout(page, '#editor');
    await discardEditor(page);
  });
  await check('settings', async () => {
    await page.locator('[data-view=settings]').click();
    await page.locator('#account-profile-form').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#work-schedules-settings').count(), 0);
    await checkLayout(page);
    const pages = page.locator('#global-view .settings-tiles > details');
    assert.deepEqual(
      await pages.evaluateAll((items) =>
        items.map((page) => [
          page.querySelector('.settings-accordion-content').id,
          page.querySelector('.settings-page-title').textContent,
        ]),
      ),
      [
        ['profile-settings', 'Мой профиль'],
        ['integrations-settings', 'Интеграции'],
        ['paid-services-settings', 'Пакеты и оплата'],
        ['team-settings', 'Сотрудники и доступ'],
        ['workspace-settings', 'Кабинеты и занятость'],
        ['online-booking-settings', 'Онлайн-запись'],
        ['telegram-settings', 'Напоминания клиентам'],
        ['support-settings', 'Техподдержка'],
        ['improvement-settings', 'Развитие Картотеки'],
      ],
      'Every owner settings page must be exercised in its expected order',
    );
    const summaries = pages.locator(':scope > summary');
    for (let index = 0; index < (await summaries.count()); index++) {
      const summary = summaries.nth(index);
      await summary.waitFor({ state: 'visible' });
      if (!(await summary.evaluate((el) => el.parentElement.open))) await summary.click();
      if (await page.locator('#paid-services-settings:visible').count()) {
        const card = page.locator('#paid-services-settings');
        await card.locator('.paid-package-current').waitFor({ state: 'visible' });
        await page.waitForFunction(
          () => !document.querySelector('#paid-services-settings').hasAttribute('aria-busy'),
        );
        const refreshed = page.waitForResponse(
          (response) =>
            response.url() === fixture.base + '/api/billing' &&
            response.request().method() === 'GET',
        );
        await card.locator('[data-paid-refresh]').click();
        assert.equal((await refreshed).status(), 200);
        await page.waitForFunction(
          () => !document.querySelector('#paid-services-settings').hasAttribute('aria-busy'),
        );
        assert.match(
          await card.locator('.paid-package-current').textContent(),
          /Активного пакета пока нет/,
        );
        assert.match(
          await card.locator('.paid-package-notice').textContent(),
          /Приём оплат ещё не подключён/,
        );
        assert.equal(await card.locator('[data-paid-checkout] button:not(:disabled)').count(), 0);
        assert.equal(await card.locator('[data-paid-message][data-status="error"]').count(), 0);
      }
      await checkLayout(page);
      if (await page.locator('#support-form:visible').count()) {
        assert.equal(await page.locator('#support-form textarea').count(), 1);
        assert.equal(
          await page
            .locator(
              '#support-include-details,#support-copy-message,#support-copy-report,#support-report,#support-version',
            )
            .count(),
          0,
        );
        const privacyHelp = page.locator('#support-privacy-help [data-settings-help]');
        assert.equal(await privacyHelp.count(), 1);
        const text = await privacyHelp.getAttribute('data-help-text');
        assert.match(text, /пароли, токены/);
        assert.match(text, /Автоматически прикладываются/);
        await privacyHelp.click();
        assert.equal(await page.locator('#settings-help-text').textContent(), text);
        await page.locator('[data-settings-help-close]').click();
      }
      const helpButtons = page.locator('.settings-label-row [data-settings-help]:visible');
      await measure('settings-help-targets', appearance.helpTargets);
      if (await helpButtons.count()) {
        const help = helpButtons.first();
        const dialogId = await help.getAttribute('aria-controls');
        assert.match(dialogId || '', /^[A-Za-z][A-Za-z0-9_-]*$/);
        const dialogSelector = '#' + dialogId;
        const dialog = page.locator(dialogSelector);
        await help.click();
        await dialog.waitFor({ state: 'visible' });
        assert.equal(await dialog.evaluate((element) => element.open), true);
        await checkLayout(page, dialogSelector);
        const close = dialog.locator('[data-settings-help-close],[data-calendar-help-close]');
        assert.equal(await close.count(), 1);
        await close.click();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(await dialog.evaluate((element) => element.open), false);
        assert.ok(await help.evaluate((el) => document.activeElement === el));
      }
      const back = summary.locator('..').locator('[data-settings-back]');
      if (await back.isVisible()) await back.click();
      else await summary.click();
    }
  });
  await check('staff-push-device-controls', async () => {
    let device = null,
      connectBody = null;
    const bindingExpectation = 'staff-push-binding-expectation-v1:' + '1'.repeat(64);
    const preferences = {
      events: ['new-request', 'confirmation', 'change', 'reminder'],
      leadMinutes: 30,
    };
    const pattern = '**/api/push/staff/*';
    await page.route(pattern, async (route) => {
      const kind = route.request().url().split('/').at(-1),
        body = route.request().postDataJSON();
      if (kind === 'connect') {
        connectBody = body;
        device = { id: 'synthetic-device', enabled: true, preferences };
      }
      if (kind === 'settings') device.preferences = route.request().postDataJSON().preferences;
      if (kind === 'disconnect') device = null;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          prepared: true,
          available: true,
          bindingExpectation: kind === 'status' && !body.endpoint ? null : bindingExpectation,
          publicKey: Buffer.alloc(65, 4).toString('base64url'),
          device,
          preferences,
        }),
      });
    });
    try {
      await page.evaluate(() => {
        window.__pushPermissionCalls = 0;
        Object.defineProperty(window, 'PushManager', { configurable: true, value: function () {} });
        Object.defineProperty(window, 'Notification', {
          configurable: true,
          value: {
            permission: 'default',
            requestPermission: async () => {
              window.__pushPermissionCalls++;
              window.Notification.permission = 'granted';
              return 'granted';
            },
          },
        });
        let sub = null;
        const manager = {
          getSubscription: async () => sub,
          subscribe: async () =>
            (sub = {
              endpoint: 'synthetic',
              toJSON: () => ({ endpoint: 'synthetic' }),
              unsubscribe: async () => {
                sub = null;
                return true;
              },
            }),
        };
        Object.defineProperty(navigator, 'serviceWorker', {
          configurable: true,
          value: { getRegistration: async () => ({ pushManager: manager }) },
        });
      });
      await page.locator('[data-view=calendar]').click();
      await page.locator('[data-view=settings]').click();
      await page.locator('details.settings-tile:has(#staff-push) > summary').click();
      await page.locator('#staff-push .connection-push').click();
      await page.locator('[data-push-connect]').waitFor();
      await page.waitForFunction(() => !document.querySelector('[data-push-connect]')?.disabled);
      assert.equal(await page.evaluate(() => window.__pushPermissionCalls), 0);
      await page.locator('[data-push-connect]').click();
      await page.locator('[data-push-preferences]').waitFor();
      assert.deepEqual(connectBody, {
        subscription: { endpoint: 'synthetic' },
        bindingExpectation,
      });
      assert.equal(
        await page.locator('#staff-push .staff-channel-status').textContent(),
        'Включены',
      );
      assert.match(
        await page.locator('#staff-push .connection-push').getAttribute('class'),
        /is-linked/,
      );
      assert.match(
        await page.locator('#staff-push .connection-push').getAttribute('aria-label'),
        /Включены/,
      );
      assert.equal(await page.evaluate(() => window.__pushPermissionCalls), 1);
      await checkLayout(page);
      await page.locator('[data-push-preferences] select').selectOption('45');
      await page.locator('[data-push-preferences] button[type=submit]').click();
      await page.waitForFunction(() =>
        document.querySelector('#staff-push').textContent.includes('События сохранены'),
      );
      await page.locator('[data-push-disconnect]').click();
      await page.locator('#action-confirmation [data-confirm-cancel]').click();
      assert.equal(device?.enabled, true);
      await page.locator('[data-push-disconnect]').click();
      await page.locator('#action-confirmation [data-confirm-accept]').click();
      await page.locator('[data-push-connect]').waitFor();
      assert.equal(device, null);
      await checkLayout(page);
    } finally {
      await page.unroute(pattern);
      await page.goto(fixture.base);
    }
  });
  await check('workday-editor', async () => {
    await page.locator('[data-view=calendar]').click();
    await page.locator('[data-open-work-schedule]:visible').first().click();
    await chooseWorkDate(page, fixture.dates[3]);
    await page.locator('[data-work-edit]').click();
    await page.locator('#work-day-status').waitFor();
    assert.equal(await page.locator('[data-work-start="0"]').inputValue(), '00:00');
    assert.equal(await page.locator('[data-work-end="0"]').inputValue(), '24:00');
    await setInlineTime(page, '[data-work-start="0"]', '14:00');
    await setInlineTime(page, '[data-work-end="0"]', '18:00');
    await checkLayout(page, '#editor');
    await discardEditor(page);
  });
  await check('telegram-invitation-layout-mocked', async () => {
    // Transport-only mock: no Telegram token, recipient or real message.
    const response = await apiGet('/api/telegram/patient?patientId=p');
    assert.equal(response.status(), 200);
    const telegramStatus = await response.json();
    telegramStatus.bot = { ...telegramStatus.bot, connected: true };
    // Snapshot the synthetic backend before interception. Forwarding a background
    // request with route.fetch races document/context teardown and can reject unhandled.
    await page.route('**/api/telegram/patient?*', (route) =>
      route.fulfill({ json: telegramStatus }),
    );
    await page.route('**/api/telegram/link', (route) =>
      route.fulfill({
        json: {
          url: 'https://t.me/Synthetic_test_bot?start=synthetic_only',
          expiresAt: Date.now() + 86400000,
          invitationText:
            'Здравствуйте! Подключите уведомления о записи. Тестовая организация, тестовый специалист.',
        },
      }),
    );
    await openCard(page);
    if (!(await page.locator('.patient-connections').evaluate((el) => el.open)))
      await page.locator('.patient-connections > summary').click();
    await page.locator('[data-telegram-link]').click();
    await page.locator('[data-telegram-share]').click();
    await page.locator('#telegram-share-dialog').waitFor();
    await checkLayout(page, '#telegram-share-dialog');
    for (const channel of ['telegram', 'whatsapp', 'sms'])
      assert.ok(await page.locator(`[data-share-channel=${channel}]`).getAttribute('href'));
    await page.locator('[data-close-telegram-share]').click();
    await page.locator('#telegram-share-dialog').waitFor({ state: 'hidden' });
  });
  await check('max-copy-status-inside-dialog-mocked', async () => {
    // Only synthetic transport/clipboard; never open MAX or change the real clipboard.
    await page.route('**/api/max/patient?*', (route) =>
      route.fulfill({
        json: { patientId: 'p', linked: false, compatible: true, canConnect: true },
      }),
    );
    await page.route('**/api/max/link', (route) =>
      route.fulfill({
        json: {
          url: 'https://max.ru/id000000000000_1_bot?start=' + 'a'.repeat(43),
          expiresAt: Date.now() + 86400000,
          invitationText: 'Синтетическое приглашение MAX',
        },
      }),
    );
    await openCard(page);
    if (!(await page.locator('.patient-connections').evaluate((el) => el.open)))
      await page.locator('.patient-connections > summary').click();
    await page.locator('[data-max-link]').click();
    await page.locator('#max-invitation-dialog').waitFor();
    await page.evaluate(() => {
      window.syntheticClipboardFailure = false;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            if (window.syntheticClipboardFailure) throw Error('Synthetic refusal');
          },
        },
      });
    });
    for (const kind of ['link', 'message']) {
      await page.locator(`[data-copy-max-invitation=${kind}]`).click();
      await page.locator('.max-invitation-status[data-kind=success]').waitFor();
      await measure('max-status-' + kind, appearance.maxStatus);
    }
    await page.evaluate(() => {
      window.syntheticClipboardFailure = true;
    });
    for (const kind of ['link', 'message']) {
      await page.locator(`[data-copy-max-invitation=${kind}]`).click();
      await page.locator('.max-invitation-status[data-kind=manual]').waitFor();
      assert.match(await page.locator('.max-invitation-status').textContent(), /вручную/);
      await checkLayout(page, '#max-invitation-dialog');
    }
    await page.locator('[data-close-max-invitation]').click();
    await page.locator('#max-invitation-dialog').waitFor({ state: 'hidden' });
    await page.locator('[data-max-invitation-status]').waitFor({ state: 'detached' });
    assert.equal(await page.locator('[data-max-invitation-status]').count(), 0);
  });
  await check('public-booking-real-backend', async () => {
    await page.goto(fixture.base + '/booking.html?organization=' + fixture.organizationId);
    await page.locator('[data-booking-service=s1]').check();
    await page.locator('[data-booking-next="2"]').click();
    await chooseBookingDate(page, fixture.dates[3]);
    assert.ok((await page.locator('[data-booking-time]').count()) <= 12);
    await page.locator('[data-booking-period=day]').click();
    assert.equal(await page.locator('[data-booking-time]').first().textContent(), '12:00');
    await page.locator('#booking-other-time').click();
    assert.equal(await page.locator('#booking-other-select').count(), 0);
    assert.ok((await page.locator('[data-booking-requested-time]').count()) <= 12);
    await checkLayout(page);
    await page.locator('#booking-other-time').click();
    await page.locator('[data-booking-time]').first().click();
    await page.locator('[data-booking-next="3"]').click();
    await page.locator('[name=firstName]').fill('Синтетический');
    await page.locator('[name=phone]').fill('+79990000002');
    await page.locator('[name=consent]').check();
    assert.equal(await page.locator('#booking-staff-section').isVisible(), false);
    await checkLayout(page);
    if (
      process.env.CARTOTECA_BROWSER_SCREENSHOTS === '1' &&
      process.env.CARTOTECA_BROWSER_REPORT &&
      [390, 1440].includes(await page.evaluate(() => innerWidth))
    ) {
      await page.locator('[data-booking-edit=time]').click();
      await page.locator('#booking-date-section').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: require('node:path').join(
          process.env.CARTOTECA_BROWSER_REPORT,
          `${page.context().browser().browserType().name()}-${await page.evaluate(() => innerWidth)}-booking-time.png`,
        ),
        fullPage: false,
      });
      await page.locator('[data-booking-next="3"]').click();
    }
    await page.waitForTimeout(1100); // Minimum anti-bot challenge age, synthetic request only.
    await page.locator('#booking-contact-form button[type=submit]').click();
    await page.waitForFunction(() =>
      /отправлен|создан/i.test(document.querySelector('#booking-page-status')?.textContent),
    );
    await checkLayout(page);
    assert.equal(await page.locator('#booking-result').isVisible(), true);
    assert.equal(await page.locator('#booking-flow').isVisible(), false);
    assert.match(await page.locator('#booking-result').textContent(), /Ожидает подтверждения/);
    if (
      process.env.CARTOTECA_BROWSER_SCREENSHOTS === '1' &&
      process.env.CARTOTECA_BROWSER_REPORT &&
      [390, 1440].includes(await page.evaluate(() => innerWidth))
    ) {
      await page.screenshot({
        path: require('node:path').join(
          process.env.CARTOTECA_BROWSER_REPORT,
          `${page.context().browser().browserType().name()}-${await page.evaluate(() => innerWidth)}-booking-success.png`,
        ),
        fullPage: false,
      });
    }
  });
  await check('booking-request-actions', async () => {
    await page.goto(fixture.base);
    await page.locator('[data-view=services]').click();
    await page.locator('[data-management-tab=requests]').click();
    await page.locator('[data-booking-request-action=accept]').waitFor();
    await checkLayout(page);
    await page.locator('[data-booking-request-action=accept]').click();
    await page.waitForFunction(() =>
      /Заявка принята/.test(document.querySelector('[data-booking-request-message]')?.textContent),
    );
    assert.equal(await page.locator('.booking-request').count(), 0);
    const settings = await (await apiGet('/api/online-booking/settings')).json();
    const create = async (key, phone) => {
      const response = await page.request.post(fixture.base + '/api/online-booking/requests', {
        headers: { Origin: fixture.base, 'X-Cartoteca-Request': '1', ...expectedContext },
        data: {
          key,
          date: fixture.dates[3],
          time: '10:00',
          serviceIds: ['s1'],
          staffId: settings.members[0].accountId,
          firstName: 'Синтетический',
          lastName: '',
          middleName: '',
          phone,
          consent: true,
          kind: 'other-time',
        },
      });
      assert.equal(response.status(), 200);
      await page.locator('[data-booking-request-action=choose]').waitFor({ timeout: 45000 });
      return response.json();
    };
    const chosen = await create('synthetic-browser-chosen-key', '+79990000003');
    await page.locator('[data-booking-request-action=choose]').click();
    await page.locator('[data-request-time]').first().waitFor();
    assert.ok((await page.locator('[data-request-time]').count()) <= 4);
    assert.equal(await page.locator('[data-request-time-save]').isEnabled(), false);
    await page.locator('[data-request-date]').fill(fixture.dates[2]);
    await page.locator('[data-request-time]').first().waitFor();
    const selectedTime = await page
      .locator('[data-request-time]')
      .first()
      .getAttribute('data-request-time');
    await page.locator('[data-request-time]').first().click();
    await checkLayout(page);
    await page.locator('[data-request-time-save]').click();
    await page.waitForFunction(() =>
      /Заявка принята/.test(document.querySelector('[data-booking-request-message]')?.textContent),
    );
    assert.equal(await page.locator('.booking-request').count(), 0);
    const cabinet = await (await apiGet('/api/cabinet')).json();
    const appointment = cabinet.patients
      .flatMap((p) => p.appointments)
      .find((a) => a.id === chosen.appointmentId);
    // Internal identifiers are not exposed in the request projection; locate by the new contact.
    const selectedAppointment =
      appointment || cabinet.patients.find((p) => p.phone === '+79990000003').appointments[0];
    assert.equal(selectedAppointment.date, fixture.dates[2]);
    assert.equal(selectedAppointment.time, selectedTime);
    await create('synthetic-browser-reject-key', '+79990000004');
    await page.locator('[data-booking-request-action=reject]').click();
    await page.waitForFunction(() =>
      /Заявка отклонена/.test(
        document.querySelector('[data-booking-request-message]')?.textContent,
      ),
    );
    assert.equal(await page.locator('.booking-request').count(), 0);
    await page.waitForFunction(() =>
      /Новых заявок пока нет/.test(
        document.querySelector('[data-booking-request-content]')?.textContent,
      ),
    );
    await checkLayout(page);
  });
  await check('classic-booking-settings-and-real-backend', async () => {
    await page.goto(fixture.base);
    await page.locator('[data-view=settings]').click();
    await page.locator('details.settings-tile:has(#online-booking-settings) > summary').click();
    await page.locator('[data-booking-kind="classic"]').click();
    assert.equal(await page.locator('[data-booking-reservation-field]').isVisible(), false);
    await checkLayout(page);
    await page.locator('#online-booking-settings-form button[type=submit]').click();
    await page.waitForFunction(() =>
      /сохран/i.test(document.querySelector('#booking-settings-result')?.textContent),
    );
    assert.equal(
      await page.locator('#action-confirmation[open]').count(),
      0,
      'Booking rules save directly without the removed mode-change dialog',
    );
    const savedRules = page.locator('#online-booking-settings-form button[type=submit]');
    assert.equal(await savedRules.textContent(), 'Сохранено');
    assert.equal(await savedRules.isDisabled(), true);
    assert.equal(
      await page.locator('#online-booking-settings-form [name=bookingMode]').inputValue(),
      'classic',
    );
    await measure('#online-booking-settings-form', (current) =>
      appearance.inlineForm(current, '#online-booking-settings-form'),
    );
    const before = await (await apiGet('/api/cabinet')).json();
    await page.goto(fixture.base + '/booking.html?organization=' + fixture.organizationId);
    await page.locator('[data-booking-service=s1]').check();
    await page.locator('[data-booking-next="2"]').click();
    await chooseBookingDate(page, fixture.dates[3]);
    await page.locator('[data-booking-time]').first().click();
    await page.locator('[data-booking-next="3"]').click();
    assert.equal(await page.locator('#booking-other-time').isVisible(), false);
    await page.locator('[name=firstName]').fill('Синтетический');
    await page.locator('[name=phone]').fill('+79990000005');
    await page.locator('[name=consent]').check();
    assert.equal(
      await page.locator('#booking-contact-form button[type=submit]').textContent(),
      'Записаться',
    );
    await checkLayout(page);
    await page.waitForTimeout(1100);
    await page.locator('#booking-contact-form button[type=submit]').click();
    await page.waitForFunction(() =>
      /Запись успешно создана/.test(document.querySelector('#booking-result')?.textContent),
    );
    assert.match(await page.locator('#booking-result').textContent(), /Подтверждена организацией/);
    assert.doesNotMatch(
      await page.locator('#booking-result').textContent(),
      /Ожидает подтверждения/,
    );
    await checkLayout(page);
    const after = await (await apiGet('/api/cabinet')).json();
    assert.equal(
      after.patients.flatMap((p) => p.appointments).length,
      before.patients.flatMap((p) => p.appointments).length + 1,
    );
    const p = after.patients.find((p) => p.phone.replace(/\D/g, '') === '79990000005');
    assert.ok(p, 'Successfully booked client must be persisted');
    assert.equal(p.visits.length, 0);
    assert.equal(p.appointments[0].status, 'scheduled');
    if (process.env.CARTOTECA_BROWSER_SCREENSHOTS === '1' && process.env.CARTOTECA_BROWSER_REPORT)
      await page.screenshot({
        path: require('node:path').join(
          process.env.CARTOTECA_BROWSER_REPORT,
          `classic-${await page.evaluate(() => innerWidth)}.png`,
        ),
        fullPage: true,
      });
  });
}
module.exports = { runScenarios, checkLayout, setInlineTime, chooseCalendarMode };
