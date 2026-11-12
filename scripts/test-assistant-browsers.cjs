const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, webkit } = require('playwright');
const { createAssistantBrowserFixture } = require('../tests/helpers/assistant-browser-fixture.cjs');
const label = process.env.ASSISTANT_BROWSER_LABEL || 'initial';
if (!/^[a-z0-9-]+$/.test(label)) throw Error('Invalid report label');
const output = path.resolve('work/assistant-validation-20261015');
fs.mkdirSync(output, { recursive: true });
const report = { label, synthetic: true, realApi: true, demoOnly: true, results: [], engines: [] };
const write = () =>
  fs.writeFileSync(
    path.join(output, 'frontend-browser-' + label + '.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
const targets = new Set((process.env.ASSISTANT_BROWSER_TARGETS || '').split(',').filter(Boolean));
const turnPath = '/api/assistant/turn';
const panel = (page) => page.locator('.voice-assistant-dialog[open]');
async function turn(page, action) {
  const pending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === turnPath && response.request().method() === 'POST',
  );
  await action();
  const response = await pending;
  const body = await response.json();
  assert.equal(response.ok(), true, JSON.stringify(body));
  return body;
}
async function send(page, text, answer = false) {
  await page.locator(answer ? '[data-assistant-input]' : '[data-assistant-text]').fill(text);
  return turn(page, () => page.locator('[data-assistant-send]').click());
}
async function choose(page, text) {
  return turn(page, () =>
    page.locator('[data-assistant-choice]').filter({ hasText: text }).first().click(),
  );
}
async function recover(page) {
  if (await panel(page).count()) await page.locator('[data-assistant-close]').click();
  if (await page.locator('#editor[open]').count()) {
    await page.locator('#cancel-editor').click();
    const confirmation = page.locator('#action-confirmation[open] [data-confirm-accept]');
    if (await confirmation.count()) await confirmation.click();
  }
  await page.locator('[data-view=calendar]').first().click();
  await page.locator('#calendar-new.assistant-trigger').waitFor();
}
async function openAssistant(page) {
  await recover(page);
  await page.locator('#calendar-new').press('Shift+Enter');
  await panel(page).waitFor();
  await page.locator('[data-assistant-send]').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[data-assistant-send]').disabled);
}
async function main() {
  for (const engine of (process.env.ASSISTANT_BROWSER_ENGINES || 'chromium,webkit').split(',')) {
    let browser;
    try {
      browser = await { chromium, webkit }[engine].launch({
        headless: true,
        ...(engine === 'chromium'
          ? {
              channel:
                process.env.CARTOTECA_CHROMIUM_CHANNEL ||
                (process.platform === 'win32' ? 'msedge' : undefined),
            }
          : {}),
      });
      report.engines.push({ engine, version: browser.version(), available: true });
    } catch (error) {
      report.engines.push({ engine, available: false, error: error.message });
      if (engine === 'chromium')
        report.results.push({
          engine,
          scenario: 'engine-launch',
          passed: false,
          error: error.message,
        });
      write();
      continue;
    }
    try {
      for (const width of [1366, 390]) {
        let fixture, context, page;
        const pageErrors = [],
          consoleErrors = [],
          external = [],
          clinicalWrites = [],
          badResponses = [];
        const check = async (scenario, run) => {
          if (
            targets.size &&
            !['login', 'manual-save-integrity', 'console-and-network'].includes(scenario) &&
            !targets.has(width + ':' + scenario)
          )
            return;
          const result = { engine, width, scenario, passed: false };
          const started = Date.now();
          try {
            result.details = await run();
            result.passed = true;
          } catch (error) {
            result.error = error.stack || error.message;
            if (page && !page.isClosed()) {
              const file =
                'frontend-browser-' +
                label +
                '-' +
                engine +
                '-' +
                width +
                '-' +
                scenario +
                '-failed.png';
              try {
                await page.screenshot({ path: path.join(output, file), fullPage: true });
                result.screenshot = file;
              } catch {}
            }
          }
          result.durationMs = Date.now() - started;
          report.results.push(result);
          write();
          console.log(JSON.stringify(result));
        };
        try {
          fixture = await createAssistantBrowserFixture();
          context = await browser.newContext({
            viewport: { width, height: 900 },
            hasTouch: width < 700,
            isMobile: width < 700 && !(engine === 'webkit' && process.platform === 'win32'),
            locale: 'ru-RU',
            timezoneId: 'Asia/Yerevan',
            serviceWorkers: 'block',
          });
          await context.route('**/*', (route) => {
            const url = route.request().url();
            if (url.startsWith(fixture.base + '/') || /^(data|blob):/.test(url))
              return route.continue();
            external.push(url);
            return route.abort('blockedbyclient');
          });
          page = await context.newPage();
          page.setDefaultTimeout(12000);
          page.on('pageerror', (error) => pageErrors.push(error.message));
          page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text());
          });
          page.on('request', (request) => {
            const pathname = new URL(request.url()).pathname;
            if (
              /^\/api\/cabinet(?:\/|$)/.test(pathname) &&
              !['GET', 'HEAD'].includes(request.method())
            )
              clinicalWrites.push({ method: request.method(), path: pathname });
          });
          page.on('response', (response) => {
            if (response.status() >= 500)
              badResponses.push({
                status: response.status(),
                path: new URL(response.url()).pathname,
              });
          });
          if (engine === 'webkit' && process.platform === 'win32') {
            await page.setContent(
              '<meta name="viewport" content="width=device-width,initial-scale=1">',
            );
            const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
            await page.setViewportSize({
              width: Math.round((width * width) / actual.width),
              height: Math.round((900 * 900) / actual.height),
            });
          }
          await check('login', async () => {
            await page.goto(fixture.base + '/login.html');
            await page.locator('#auth-email').fill(fixture.email);
            await page.locator('#auth-password').fill(fixture.password);
            await page.locator('#auth-submit').click();
            await page.locator('#calendar-new.assistant-trigger').waitFor();
            const install = page.locator('.install-app-close');
            if (await install.isVisible()) await install.click();
            return { url: new URL(page.url()).pathname, clients: fixture.assistantClients.length };
          });
          await check('week', async () => {
            await openAssistant(page);
            const reply = await send(page, 'Покажи расписание на эту неделю');
            assert.equal(reply.action?.mode, 'week');
            await page.locator('[data-assistant-action]').click();
            await page.locator('[data-calendar-mode=week][aria-pressed=true]').waitFor();
            const dates = (await page.locator('.time-grid').getAttribute('data-dates')).split(',');
            assert.equal(dates.length, 7);
            return { dates };
          });
          await check('month', async () => {
            await openAssistant(page);
            const reply = await send(page, 'Покажи расписание на этот месяц');
            assert.equal(reply.action?.mode, 'month');
            await page.locator('[data-assistant-action]').click();
            await page
              .locator('[data-calendar-mode=month][aria-pressed=true]')
              .waitFor({ state: 'attached' });
            await page.locator('.month-overview .overview-grid').waitFor();
            const days = await page.locator('.month-overview .overview-grid > *').count();
            assert.ok(days >= 28);
            return { days };
          });
          await check('availability', async () => {
            await openAssistant(page);
            const reply = await send(
              page,
              'Найди свободные окна завтра с 13:00 до 16:00 на 30 минут',
            );
            assert.equal(reply.dialogue?.step, 'availability');
            assert.ok(reply.dialogue.options.length > 0);
            for (const item of reply.dialogue.options) {
              const times = item.label.match(/(\d\d):(\d\d)–(\d\d):(\d\d)/);
              assert.ok(times);
              const from = +times[1] * 60 + +times[2],
                to = +times[3] * 60 + +times[4];
              assert.ok(
                to <= 840 || from >= 870,
                item.label + ' overlaps the existing 14:00–14:30 appointment',
              );
            }
            const selected = await choose(page, reply.dialogue.options[0].label);
            assert.equal(selected.dialogue?.step, 'client');
            assert.ok(
              selected.dialogue.fields.some(
                (field) => field.key === 'date' && field.value === fixture.dates[1],
              ),
            );
            const cancelled = await turn(page, () => page.locator('[data-assistant-new]').click());
            assert.equal(cancelled.dialogue, null);
            return { options: reply.dialogue.options.map((item) => item.label) };
          });
          await check('unique-card', async () => {
            await openAssistant(page);
            const reply = await send(page, 'Открой карточку Анны Семёновой');
            assert.equal(reply.action?.type, 'clientCard');
            assert.equal(reply.action.patientId, fixture.assistantClients[0].id);
            await page.locator('[data-assistant-action]').click();
            await page.locator('#detail h2').filter({ hasText: 'Анна Семёнова' }).waitFor();
            return { name: await page.locator('#detail h2').textContent() };
          });
          await check('ambiguous-clients', async () => {
            await openAssistant(page);
            const reply = await send(page, 'Открой карточку Семёновой');
            assert.equal(reply.action?.type, 'clients');
            await page.locator('[data-assistant-action]').click();
            await page.locator('[data-patient="' + fixture.assistantClients[0].id + '"]').waitFor();
            await page.locator('[data-patient="' + fixture.assistantClients[1].id + '"]').waitFor();
            return {
              query: await page.locator('#search').inputValue(),
              matches: await page.locator('[data-patient]').count(),
            };
          });
          await check('booking-edit-manual-form', async () => {
            await openAssistant(page);
            let reply = await send(page, 'Запиши Семёнову');
            assert.equal(reply.dialogue?.step, 'client');
            const initialClientPrompt = reply.dialogue.prompt;
            reply = await send(page, 'Семёнова', true);
            assert.equal(reply.dialogue?.step, 'client');
            assert.equal(reply.dialogue.options.length, 2);
            reply = await choose(page, 'Анна Семёнова');
            assert.equal(reply.dialogue?.step, 'service');
            reply = await choose(page, 'Первичная консультация');
            assert.equal(reply.dialogue?.step, 'date');
            reply = await send(page, fixture.dates[1], true);
            assert.equal(reply.dialogue?.step, 'time');
            reply = await send(page, '15:00', true);
            assert.equal(reply.dialogue?.step, 'review');
            reply = await turn(page, () => page.locator('[data-assistant-edit=time]').click());
            assert.equal(reply.dialogue?.step, 'time');
            reply = await send(page, '15:30', true);
            assert.equal(reply.dialogue?.step, 'review');
            reply = await turn(page, () => page.locator('[data-assistant-edit=duration]').click());
            assert.equal(reply.dialogue?.step, 'duration');
            reply = await send(page, '45', true);
            assert.equal(reply.dialogue?.step, 'review');
            reply = await choose(page, 'Подготовить форму записи');
            assert.equal(reply.action?.type, 'prepareAppointment');
            assert.equal(
              await page.locator('#editor[open]').count(),
              0,
              'Form opening remains explicit',
            );
            await page.locator('[data-assistant-action]').click();
            await page.locator('#editor[open]').waitFor();
            assert.equal(await page.locator('#editor [name=date]').inputValue(), fixture.dates[1]);
            assert.equal(await page.locator('#editor [name=time]').inputValue(), '15:30');
            assert.equal(await page.locator('#editor [name=duration]').inputValue(), '45');
            assert.equal(
              await page.locator('#appointment-patient').inputValue(),
              fixture.assistantClients[0].id,
            );
            assert.equal(clinicalWrites.length, 0);
            const screenshot =
              'frontend-browser-' + label + '-' + engine + '-' + width + '-manual-form.png';
            await page.screenshot({ path: path.join(output, screenshot), fullPage: true });
            return {
              date: fixture.dates[1],
              time: '15:30',
              duration: 45,
              clinicalWrites: 0,
              screenshot,
            };
          });
          await check('booking-cancel', async () => {
            await openAssistant(page);
            const reply = await send(page, 'Запиши Анну Семёнову на завтра в 16:00');
            assert.ok(reply.dialogue);
            const cancelled = await turn(page, () => page.locator('[data-assistant-new]').click());
            assert.equal(cancelled.dialogue, null);
            assert.equal(cancelled.action, null);
            assert.equal(await page.locator('[data-assistant-command-label]').isVisible(), true);
            assert.equal(await page.locator('#editor[open]').count(), 0);
          });
          await check('manual-save-integrity', async () => {
            const response = await page.request.get(fixture.base + '/api/cabinet');
            assert.equal(response.ok(), true);
            const cabinet = await response.json();
            const appointments = cabinet.patients.flatMap((patient) => patient.appointments || []);
            assert.equal(appointments.length, 1);
            assert.equal(appointments[0].id, 'plan');
            assert.deepEqual(clinicalWrites, []);
            return { appointments: appointments.length, clinicalWrites: 0 };
          });
          await check('console-and-network', async () => {
            assert.deepEqual(pageErrors, []);
            assert.deepEqual(consoleErrors, []);
            assert.deepEqual(external, []);
            assert.deepEqual(badResponses, []);
            return { pageErrors, consoleErrors, external, badResponses };
          });
        } catch (error) {
          report.results.push({
            engine,
            width,
            scenario: 'fixture-or-context',
            passed: false,
            error: error.stack || error.message,
          });
          write();
        } finally {
          await context?.close();
          await fixture?.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  report.passed = report.results.filter((item) => item.passed).length;
  report.failed = report.results.filter((item) => !item.passed).length;
  write();
  console.log(
    JSON.stringify({
      passed: report.passed,
      failed: report.failed,
      checks: report.results.length,
      engines: report.engines,
    }),
  );
  if (report.failed) process.exitCode = 1;
}
main().catch((error) => {
  report.fatal = error.stack || error.message;
  write();
  console.error(error.stack);
  process.exitCode = 1;
});
