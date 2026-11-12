const assert = require('node:assert/strict');

const settle = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const sameBox = (before, after, label) => {
  for (const key of ['x', 'y', 'width', 'height'])
    assert.ok(
      Math.abs(before[key] - after[key]) <= 2,
      `${label}: ${key} changed; ${JSON.stringify({ before, after })}`,
    );
};
async function pageBounds(page) {
  const geometry = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  assert.ok(
    geometry.documentWidth <= geometry.width + 1 && geometry.bodyWidth <= geometry.width + 1,
    `Horizontal page overflow: ${JSON.stringify(geometry)}`,
  );
  return geometry;
}

async function loginAndSeed(page, fixture) {
  const base = new URL(fixture.base);
  assert.equal(base.hostname, '127.0.0.1', 'Only the temporary fixture may receive writes');
  assert.equal(base.protocol, 'http:');
  assert.equal(fixture.email, 'owner@browser.test');
  await page.goto(fixture.base + '/login.html');
  await page.locator('#auth-email').fill(fixture.email);
  await page.locator('#auth-password').fill(fixture.password);
  await page.locator('#auth-submit').click();
  await page.locator('#calendar-new').waitFor();
  await settle(page);
  const install = page.locator('.install-app');
  if ((await page.evaluate(() => innerWidth)) < 700)
    await install.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  if (await install.isVisible()) await install.locator('.install-app-close').click();
  const response = await page.request.get(fixture.base + '/api/cabinet');
  assert.equal(response.status(), 200);
  const cabinet = await response.json(),
    patient = cabinet.patients.find((entry) => entry.id === 'p');
  assert.ok(patient, 'Synthetic fixture client exists');
  const template = patient.appointments.find((entry) => entry.id === 'plan');
  assert.ok(template, 'Synthetic planned appointment exists');
  const changes = Array.from({ length: 9 }, (_, index) => {
    const id = `composition-${index + 1}`,
      minutes = 480 + index * 30;
    return {
      id,
      before: null,
      after: {
        id,
        date: fixture.dates[1],
        time: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
        duration: 30,
        service: template.service,
        serviceItems: template.serviceItems,
        staffId: template.staffId,
        status: 'scheduled',
      },
    };
  });
  const seeded = await page.request.post(fixture.base + '/api/cabinet/appointments', {
    headers: { Origin: fixture.base, 'X-Cartoteca-Request': '1' },
    data: { revision: cabinet.revision, patientId: patient.id, changes },
  });
  assert.equal(seeded.status(), 200, `Synthetic appointment seed: ${await seeded.text()}`);
  await page.reload();
  await page.locator('#calendar-new').waitFor();
  await settle(page);
  if (await install.isVisible()) await install.locator('.install-app-close').click();
  return { appointments: 10, isolatedFixture: true };
}

async function shellGeometry(page, desktop) {
  await page.locator('[data-view=settings]').click();
  await page.locator('#account-profile-form').waitFor({ state: 'attached' });
  await settle(page);
  const geometry = await page.evaluate(() => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const header = document.querySelector('.topbar'),
      nav = header.querySelector('.app-nav');
    const panel = document.querySelector('.settings-panel');
    return {
      header: box(header),
      nav: box(nav),
      panel: box(panel),
      headerBackground: getComputedStyle(header).backgroundColor,
      panelBackground: getComputedStyle(panel).backgroundColor,
      items: [...nav.querySelectorAll('[data-view]')].map((el) => el.dataset.view),
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  assert.deepEqual(geometry.items, ['calendar', 'clients', 'card', 'services', 'settings']);
  if (desktop) {
    assert.ok(
      Math.abs(
        geometry.nav.x + geometry.nav.width / 2 - geometry.header.x - geometry.header.width / 2,
      ) <= 2,
      `Main navigation is not centered: ${JSON.stringify(geometry)}`,
    );
    assert.equal(geometry.headerBackground, 'rgb(255, 255, 255)', 'White top surface');
    assert.equal(geometry.panelBackground, 'rgb(255, 255, 255)', 'White work surface');
    assert.ok(
      geometry.panel.y + geometry.panel.height <= geometry.viewport.height + 1,
      `Settings panel exceeds viewport: ${JSON.stringify(geometry)}`,
    );
  }
  await pageBounds(page);
  return geometry;
}

async function settingsGeometry(page, desktop, short) {
  const summaries = page.locator('.settings-tiles > details > summary');
  assert.equal(await summaries.count(), 7);
  const visited = [];
  for (let index = 0; index < 7; index++) {
    const summary = summaries.nth(index),
      detail = summary.locator('..');
    if (!(await detail.evaluate((el) => el.open))) await summary.click();
    await detail.locator('.settings-page-surface').waitFor({ state: 'visible' });
    await settle(page);
    visited.push(await detail.locator('.settings-page-title').textContent());
    assert.equal(await page.locator('.settings-tiles > details[open]').count(), 1);
    await pageBounds(page);
    if (!desktop) await detail.locator('[data-settings-back]').click();
  }
  assert.equal(new Set(visited).size, 7, 'Every settings category was opened');
  if (!desktop) return { visited, mobileBack: true };
  const surface = page.locator('.settings-tiles > details[open] .settings-page-surface');
  const rail = page.locator('.settings-tiles');
  await rail.evaluate((el) => {
    el.scrollTop = 0;
  });
  await settle(page);
  const before = await surface.boundingBox();
  const scroll = await rail.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return {
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      overflowY: getComputedStyle(el).overflowY,
    };
  });
  await settle(page);
  sameBox(before, await surface.boundingBox(), 'Menu scrolling moved the settings form');
  assert.ok(
    ['auto', 'scroll'].includes(scroll.overflowY),
    `Menu is not scrollable: ${JSON.stringify(scroll)}`,
  );
  if (scroll.scrollHeight > scroll.clientHeight + 2) assert.ok(scroll.scrollTop > 0);
  if (short)
    assert.ok(
      scroll.scrollHeight > scroll.clientHeight + 10 && scroll.scrollTop > 0,
      `Short desktop did not exercise menu scrolling: ${JSON.stringify(scroll)}`,
    );
  const last = await summaries.last().boundingBox(),
    menu = await rail.boundingBox();
  assert.ok(
    last.y >= menu.y - 1 && last.y + last.height <= menu.y + menu.height + 1,
    `Last settings item is clipped: ${JSON.stringify({ last, menu })}`,
  );
  const content = page.locator('.settings-tiles > details[open] .settings-accordion-content');
  const contentBounds = await content.boundingBox(),
    surfaceBounds = await surface.boundingBox();
  assert.ok(
    contentBounds.height > 80 &&
      contentBounds.y + contentBounds.height <= surfaceBounds.y + surfaceBounds.height + 1,
    `Settings content escaped its surface: ${JSON.stringify({ contentBounds, surfaceBounds })}`,
  );
  const hit = await surface.evaluate((el) => {
    const rect = el.getBoundingClientRect(),
      x = rect.x + 40,
      y = rect.y + 80;
    return {
      exposed: el.contains(document.elementFromPoint(x, y)),
      x,
      y,
      bottom: rect.bottom,
      viewportHeight: innerHeight,
    };
  });
  assert.ok(
    hit.exposed && hit.bottom <= hit.viewportHeight + 1,
    `Settings form is clipped or outside viewport: ${JSON.stringify(hit)}`,
  );
  await content.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await settle(page);
  assert.equal(
    await rail.evaluate((el) => el.scrollTop),
    scroll.scrollTop,
    'Form scrolling moved menu',
  );
  return { visited, scroll, surface: surfaceBounds, last, menu, hit };
}

async function clientsGeometry(page, desktop) {
  await page.locator('[data-view=clients]').click();
  await page.locator('.client-open-patient[data-patient=p]').waitFor();
  await settle(page);
  const geometry = await page.evaluate(() => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const row = document.querySelector('.patient-row.client-list-row'),
      avatar = row.querySelector('.avatar');
    return {
      row: box(row),
      avatar: box(avatar),
      initials: avatar.textContent.trim(),
      header: [...document.querySelectorAll('.patient-list-head > span')].map(box),
      cells: [
        '.person-cell',
        '.client-list-phone',
        '.client-list-last',
        '.client-list-next',
        '.client-contact-actions',
      ].map((selector) => ({ selector, ...box(row.querySelector(selector)) })),
    };
  });
  if (desktop) {
    assert.equal(geometry.header.length, 5);
    for (let i = 0; i < 5; i++) {
      assert.ok(
        Math.abs(geometry.header[i].x - geometry.cells[i].x) <= 2,
        `Client column ${i + 1} is misaligned: ${JSON.stringify(geometry)}`,
      );
      if (i)
        assert.ok(
          geometry.cells[i - 1].x + geometry.cells[i - 1].width <= geometry.cells[i].x + 2,
          `Client columns overlap: ${JSON.stringify(geometry)}`,
        );
    }
    assert.ok(
      geometry.avatar.width >= 20 && geometry.avatar.width <= 32,
      'Compact client initials',
    );
    assert.ok(geometry.avatar.height >= 20 && geometry.avatar.height <= 32);
    assert.ok(geometry.row.height <= 100, `Client row too tall: ${JSON.stringify(geometry.row)}`);
    assert.ok(geometry.initials.length > 0);
  }
  await pageBounds(page);
  return geometry;
}

async function cardGeometry(page, desktop) {
  await page.locator('.client-open-patient[data-patient=p]').click();
  const list = page.locator('.patient-appointments-list');
  await list.waitFor();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.patient-appointments-list .unified-appointment-row').length >= 10,
  );
  await settle(page);
  const geometry = await list.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: getComputedStyle(el).overflowY,
    count: el.querySelectorAll('.unified-appointment-row').length,
  }));
  assert.ok(
    geometry.height <= (desktop ? 234 : 302),
    `Unbounded card list: ${JSON.stringify(geometry)}`,
  );
  assert.ok(
    geometry.scrollHeight > geometry.clientHeight + 10,
    'Saturated synthetic list must scroll',
  );
  assert.ok(['auto', 'scroll'].includes(geometry.overflowY));
  const tabs = page.locator('.card-mode .tabs'),
    before = await tabs.boundingBox();
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await settle(page);
  sameBox(before, await tabs.boundingBox(), 'Appointment scrolling moved card tabs');
  assert.ok(await list.evaluate((el) => el.scrollTop > 0));
  assert.equal(await tabs.locator('button').count(), 3);
  await pageBounds(page);
  return geometry;
}

async function managementGeometry(page, desktop) {
  await page.locator('[data-view=services]').click();
  await page.locator('.management-panel').waitFor();
  await settle(page);
  const geometry = await page.evaluate(() => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const panel = document.querySelector('.management-panel');
    return { panel: box(panel), tabs: box(panel.querySelector('.management-tabs')) };
  });
  if (desktop)
    assert.ok(
      Math.abs(
        geometry.tabs.x + geometry.tabs.width / 2 - geometry.panel.x - geometry.panel.width / 2,
      ) <= 2,
      `Management navigation is not centered: ${JSON.stringify(geometry)}`,
    );
  await pageBounds(page);
  return geometry;
}

async function runDesktopComposition(page, fixture, viewport, check) {
  await check('login-and-synthetic-seed', () => loginAndSeed(page, fixture), { fatal: true });
  const desktop = viewport.width >= 981;
  await check('shell-navigation-and-surfaces', () => shellGeometry(page, desktop));
  await check('seven-settings-and-independent-scroll', () =>
    settingsGeometry(page, desktop, viewport.height === 500),
  );
  await check('client-columns-and-initials', () => clientsGeometry(page, desktop));
  await check('bounded-card-appointments', () => cardGeometry(page, desktop));
  await check('management-navigation', () => managementGeometry(page, desktop));
}

module.exports = { runDesktopComposition };
