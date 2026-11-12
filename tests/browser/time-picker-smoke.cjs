const assert = require('node:assert/strict');

async function login(page, fixture) {
  await page.goto(fixture.base + '/login.html');
  await page.locator('#auth-email').fill(fixture.email);
  await page.locator('#auth-password').fill(fixture.password);
  await page.locator('#auth-submit').click();
  await page.locator('#calendar-new').waitFor();
  const install = page.locator('.install-app');
  if (await install.isVisible()) await install.locator('.install-app-close').click();
}

async function openPicker(page, selector = '#editor [name=time]') {
  const source = page.locator(selector);
  await source.waitFor({ state: 'attached' });
  const field = source.locator('xpath=preceding-sibling::*[1]');
  const trigger = field.locator('[data-time-dropdown]');
  await trigger.click();
  const popup = page.locator('#' + (await trigger.getAttribute('aria-controls')));
  await popup.waitFor({ state: 'visible' });
  return {
    source,
    field,
    trigger,
    popup,
    list: popup.locator('[data-time-options]'),
  };
}

async function appointment(page) {
  await page.locator('#calendar-new').click();
  await page.locator('#editor[open]').waitFor();
  assert.equal(await page.locator('#dialog-title').textContent(), 'Новая запись');
  return openPicker(page);
}

async function formData(page) {
  return page.locator('#editor-form').evaluate((form) => [...new FormData(form).entries()]);
}

async function closeCleanEditor(page) {
  await page.locator('#cancel-editor').click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#action-confirmation[open]').count(), 0);
}

async function choiceStyle(popup, value) {
  return popup.locator(`[data-time-choice="${value}"]`).evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, weight: Number(style.fontWeight) };
  });
}

async function preview(list, value) {
  const { values, active } = await list.evaluate((element) => {
    const options = [...element.querySelectorAll('[data-time-choice]')];
    return {
      values: options.map((option) => option.dataset.timeChoice),
      active: options.findIndex(
        (option) => option.id === element.getAttribute('aria-activedescendant'),
      ),
    };
  });
  const index = values.indexOf(value);
  assert.ok(index >= 0, 'Allowed keyboard target: ' + value);
  assert.ok(active >= 0, 'The open list must identify its active option');
  // Navigate through real keys from the nearest endpoint/current option. Do not
  // repeatedly walk from midnight merely to reach a fixture's arbitrary target.
  const routes = [
    [[], active],
    [['Home'], 0],
    [['End'], values.length - 1],
  ].map(([keys, start]) => {
    const delta = index - start;
    const pages = Math.round(Math.abs(delta) / 7);
    const after = Math.max(0, Math.min(values.length - 1, start + Math.sign(delta) * pages * 7));
    return [
      ...keys,
      ...Array(pages).fill(delta < 0 ? 'PageUp' : 'PageDown'),
      ...Array(Math.abs(index - after)).fill(index < after ? 'ArrowUp' : 'ArrowDown'),
    ];
  });
  const keys = routes.sort((left, right) => left.length - right.length)[0];
  for (const key of keys) await list.press(key);
  assert.equal(await activeTime(list), value, 'Keyboard preview must reach the allowed target');
}

async function activeTime(list) {
  return list.evaluate(
    (element) =>
      document.getElementById(element.getAttribute('aria-activedescendant'))?.dataset.timeChoice,
  );
}

const cases = {
  async 'list-escape-clean-formdata'(page) {
    const { source, trigger, popup, list } = await appointment(page);
    const before = await source.inputValue(),
      data = await formData(page);
    assert.equal(await popup.getAttribute('data-time-emphasis'), 'true');
    assert.equal(await popup.locator('[data-time-choice]').count(), 288);
    assert.equal(await popup.locator('input, textarea, [contenteditable]').count(), 0);
    assert.equal(await list.evaluate((element) => document.activeElement === element), true);
    // Short, explicit expectations cover every command and both boundaries.
    // Targets are independent of the production navigation implementation.
    for (const [key, expected] of [
      ['Home', '00:00'],
      ['PageDown', '00:35'],
      ['ArrowDown', '00:40'],
      ['ArrowUp', '00:35'],
      ['End', '23:55'],
      ['PageUp', '23:20'],
    ]) {
      await list.press(key);
      assert.equal(await activeTime(list), expected, key + ' preview');
      assert.equal(await source.inputValue(), before, key + ' must not commit');
    }
    assert.equal(await popup.locator('[data-time-choice]').count(), 288);
    assert.equal(await source.inputValue(), before);
    assert.deepEqual(await formData(page), data, 'Navigation must not alter submitted fields');
    await list.press('Escape');
    assert.equal(await popup.isVisible(), false);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#editor').evaluate((element) => element.open), true);
    assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
    await closeCleanEditor(page);
  },
  async 'scroll-outside-clean'(page) {
    const { source, trigger, popup, list } = await appointment(page);
    const before = await source.inputValue();
    const options = popup.locator('[data-time-options]');
    const initialTop = await options.evaluate((element) => element.scrollTop);
    await options.evaluate((element) => {
      element.dataset.smokeScrolled = 'false';
      element.addEventListener(
        'scroll',
        () => {
          element.dataset.smokeScrolled = 'true';
        },
        { once: true },
      );
    });
    const mobileWebKit =
      page.context().browser().browserType().name() === 'webkit' &&
      (await page.evaluate(() => innerWidth)) < 700;
    if (mobileWebKit) {
      // Mobile WebKit rejects Playwright mouse.wheel; native scrolling still emits scroll.
      // This checks programmatic scrolling, not a physical touchscreen swipe.
      await options.evaluate((element) => element.scrollBy(0, 320));
    } else {
      await options.hover();
      await page.mouse.wheel(0, 320);
    }
    await page.waitForFunction(
      ({ id, top }) => {
        const element = document.getElementById(id);
        return element.scrollTop > top && element.dataset.smokeScrolled === 'true';
      },
      {
        id: await options.getAttribute('id'),
        top: initialTop,
      },
    );
    assert.equal(await source.inputValue(), before, 'Scrolling must not commit time');
    await list.press('ArrowDown');
    assert.equal(await source.inputValue(), before, 'Keyboard navigation must not commit time');
    await page.locator('#editor [name=date]').click();
    assert.equal(await popup.isVisible(), false);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await source.inputValue(), before);
    await closeCleanEditor(page);
  },
  async 'click-selection-and-save'(page, fixture) {
    const { source, popup, list } = await appointment(page);
    await source.evaluate((element) => {
      element.dataset.smokeChanges = '0';
      element.addEventListener('change', () => {
        element.dataset.smokeChanges = String(Number(element.dataset.smokeChanges) + 1);
      });
    });
    const choice = popup.locator('[data-time-choice="10:15"]');
    if ((await page.evaluate(() => innerWidth)) < 700) await choice.tap();
    else await choice.click();
    assert.equal(await source.inputValue(), '10:15');
    assert.equal(await source.getAttribute('data-smoke-changes'), '1');
    assert.equal(await popup.isVisible(), false);
    assert.equal((await formData(page)).find(([name]) => name === 'time')[1], '10:15');
    await page.locator('#appointment-patient-search').fill('89990000001');
    await page.locator('[data-appointment-patient-index="0"]').click();
    await page.locator('#editor [name=date]').fill(fixture.dates[2]);
    const picker = page.locator('#appointment-service');
    if (!(await picker.evaluate((element) => element.open)))
      await picker.locator(':scope > summary').click();
    const service = page.locator('[data-appointment-service="s1"]');
    const group = service.locator('xpath=ancestor::details[1]');
    if (!(await group.evaluate((element) => element.open))) await group.locator('summary').click();
    await service.click();
    await page.locator('#save-editor').click();
    await page.locator('#editor').waitFor({ state: 'hidden' });
    const response = await page.request.get(fixture.base + '/api/cabinet');
    assert.equal(response.ok(), true);
    const data = await response.json();
    const saved = data.patients[0].appointments.filter((record) => record.id !== 'plan');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].time, '10:15');
    assert.equal(saved[0].date, fixture.dates[2]);
  },
  async 'enter-selection-formdata'(page) {
    const { source, popup, list } = await appointment(page);
    const original = await source.inputValue();
    await preview(list, '11:30');
    await list.press('ArrowDown');
    assert.equal(await source.inputValue(), original);
    await list.press('Enter');
    assert.equal(await source.inputValue(), '11:35');
    assert.equal(await popup.isVisible(), false);
    assert.equal((await formData(page)).find(([name]) => name === 'time')[1], '11:35');
    // The shared full-suite helper must exercise this same dropdown for native/paired sources.
    await require('./scenarios.cjs').setInlineTime(page, '#editor [name=time]', '12:20');
    assert.equal(await source.inputValue(), '12:20');
  },
  async 'appointment-major-time-emphasis'(page) {
    const { popup, list } = await appointment(page);
    const major = await choiceStyle(popup, '11:00');
    const half = await choiceStyle(popup, '11:30');
    const minor = await choiceStyle(popup, '11:05');
    assert.deepEqual(major, half);
    assert.ok(major.weight > minor.weight, 'Hours/half-hours must have heavier text');
    assert.notEqual(major.color, minor.color, 'Intermediate minutes must be muted');
  },
  async 'calendar-slot-equal-emphasis'(page) {
    const slot = page.locator('[data-slot-date][data-slot-time="11:00"]').first();
    await slot.click();
    const { source, popup } = await openPicker(page);
    assert.equal(await source.getAttribute('data-calendar-slot-time'), '');
    assert.equal(await popup.getAttribute('data-time-emphasis'), 'false');
    assert.equal(await popup.locator('[data-time-choice]').count(), 12);
    const values = await popup.locator('[data-time-choice]').allTextContents();
    assert.ok(values.every((value) => /^11:[0-5][05]$/.test(value)));
    const selected = await source.inputValue();
    const major = ['11:00', '11:30'].find((value) => value !== selected);
    const minor = ['11:05', '11:10', '11:15'].find((value) => value !== selected);
    assert.deepEqual(
      await choiceStyle(popup, major),
      await choiceStyle(popup, minor),
      'Calendar-cell creation must leave unselected minutes equally prominent',
    );
  },
  async 'native-time-min-step'(page) {
    await page.locator('[data-view=clients]').click();
    await page.locator('[data-patient=p]').click();
    await page.locator('#new-visit').click();
    const { source, trigger, popup, list } = await openPicker(page);
    assert.equal(await source.getAttribute('type'), 'time');
    assert.equal(await source.getAttribute('step'), '300');
    assert.equal(await popup.getAttribute('data-time-emphasis'), 'false');
    assert.equal(await popup.locator('[data-time-choice]').count(), 288);
    await list.press('Escape');
    // A synthetic constraint mutation verifies the adapter uses live native bounds/step.
    await source.evaluate((element) => {
      element.min = '09:05';
      element.max = '09:35';
      element.step = '600';
    });
    await trigger.click();
    assert.deepEqual(await popup.locator('[data-time-choice]').allTextContents(), [
      '09:05',
      '09:15',
      '09:25',
      '09:35',
    ]);
    assert.equal(await popup.locator('[data-time-choice="09:10"]').count(), 0);
    assert.equal(await source.inputValue(), '', 'Opening/navigation must not commit');
    await preview(list, '09:25');
    await list.press('Enter');
    assert.equal(await source.inputValue(), '09:25');
    assert.equal(await source.evaluate((element) => element.validity.valid), true);
    assert.equal((await formData(page)).find(([name]) => name === 'time')[1], '09:25');
  },
};

module.exports = { login, cases, caseNames: Object.keys(cases) };
