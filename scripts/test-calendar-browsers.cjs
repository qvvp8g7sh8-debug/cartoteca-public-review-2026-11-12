const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');
const { createFixture } = require('../tests/browser/fixture.cjs');
const { chooseCalendarMode, runScenarios } = require('../tests/browser/scenarios.cjs');

async function checkWeekScroll(page, context) {
  const grid = page.locator('.time-scroll');
  const cdp = await context.newCDPSession(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const position = () => grid.evaluate(({ scrollLeft, scrollTop }) => ({ scrollLeft, scrollTop }));
  await grid.evaluate((node) => {
    node.scrollLeft = 0;
    node.scrollTop = 200;
  });
  const bounds = await grid.boundingBox();
  const origin = {
    x: Math.round(bounds.x + bounds.width * 0.76),
    y: Math.round(bounds.y + bounds.height * 0.68),
  };
  const dayWidth = (await grid.locator('.time-day-heading').first().boundingBox()).width;
  const shortSwipe = 42;
  assert.ok(shortSwipe * 2 < dayWidth, 'Swipe must travel less than half a day');
  async function swipe(start, dx, dy) {
    const send = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    await send('touchStart', [start]);
    for (let step = 1; step <= 8; step++)
      await send('touchMove', [{ x: start.x + (dx * step) / 8, y: start.y + (dy * step) / 8 }]);
    await send('touchEnd', []);
  }
  const start = await position();
  const returnOrigin = { ...origin, x: Math.round(bounds.x + bounds.width * 0.4) };
  const gestures = [
    [origin, -shortSwipe, 1],
    [origin, -shortSwipe, 2],
    [returnOrigin, shortSwipe, 1],
    [returnOrigin, shortSwipe, 0],
  ];
  for (const [index, [point, dx, day]] of gestures.entries()) {
    if (index === 0)
      await grid.evaluate((node) => {
        node.addEventListener(
          'pointerup',
          () => {
            const positions = [node.scrollLeft];
            const record = () => positions.push(node.scrollLeft);
            node.addEventListener('scroll', record);
            node.testWeekMotion = {
              positions,
              stop: () => node.removeEventListener('scroll', record),
            };
          },
          { capture: true, once: true },
        );
      });
    await swipe(point, dx, -6);
    try {
      await page.waitForFunction(
        (left) => Math.abs(document.querySelector('.time-scroll').scrollLeft - left) <= 1,
        day * dayWidth,
        { timeout: 3000 },
      );
    } catch (error) {
      const actual = await position();
      throw new Error(
        `Short touch swipe ${dx}px must land on day ${day}, scrollLeft was ${actual.scrollLeft}px`,
        { cause: error },
      );
    }
    assert.equal(
      (await position()).scrollTop,
      start.scrollTop,
      'Horizontal touch keeps the current hour',
    );
    if (index === 0) {
      const positions = await grid.evaluate((node) => {
        const motion = node.testWeekMotion;
        motion.stop();
        delete node.testWeekMotion;
        return motion.positions;
      });
      assert.ok(
        positions.some((left) => left > Math.max(45, positions[0] + 8) && left < dayWidth - 8),
        'Smooth snap must display intermediate offsets after release: ' + positions.join(', '),
      );
      assert.ok(
        positions.every((left, step) => step === 0 || left >= positions[step - 1]),
        'Smooth snap must advance toward the target without reversing: ' + positions.join(', '),
      );
      console.log('Smooth short swipe offsets: ' + positions.join(' → '));
      await page.emulateMedia({ reducedMotion: 'reduce' });
    }
  }
  assert.equal(
    await page.locator('#editor').isVisible(),
    false,
    'A swipe cannot open an appointment',
  );

  await page.mouse.move(origin.x, origin.y);
  const beforeWheel = await position();
  await page.mouse.wheel(1, 0);
  // Allow the wheel gesture to finish before checking the absence of a day change.
  await page.waitForTimeout(220);
  assert.ok(
    Math.abs((await position()).scrollLeft - beforeWheel.scrollLeft) <= 2,
    'An accidental 1px wheel movement stays on the current day',
  );
  await page.mouse.wheel(shortSwipe, 6);
  await page.waitForFunction(
    (day) => Math.abs(document.querySelector('.time-scroll').scrollLeft - day) <= 2,
    dayWidth,
    { timeout: 3000 },
  );
  const horizontalWheel = await position();
  assert.equal(
    horizontalWheel.scrollTop,
    beforeWheel.scrollTop,
    'Diagonal wheel locks horizontally',
  );
  await page.mouse.wheel(18, 110);
  await page.waitForFunction(
    (top) => document.querySelector('.time-scroll').scrollTop > top + 30,
    horizontalWheel.scrollTop,
  );
  assert.equal(
    (await position()).scrollLeft,
    horizontalWheel.scrollLeft,
    'Vertical wheel stays on the day',
  );

  await grid.evaluate((node) => node.scrollTo({ left: 0, top: 0, behavior: 'instant' }));
  const openSlot = grid.locator('.time-slot[data-slot-time="08:00"]').first();
  await openSlot.tap({ position: { x: 18, y: 8 } });
  await page.locator('#editor[open]').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#editor[open]').waitFor({ state: 'hidden' });

  // Native vertical momentum must not overlap the independent wheel checks.
  await grid.evaluate(
    (node, left) => node.scrollTo({ left, top: 200, behavior: 'instant' }),
    dayWidth,
  );
  const beforeVertical = await position();
  await swipe(origin, -24, -100);
  await page.waitForFunction(
    (top) => document.querySelector('.time-scroll').scrollTop > top + 30,
    beforeVertical.scrollTop,
  );
  assert.equal(
    (await position()).scrollLeft,
    beforeVertical.scrollLeft,
    'Vertical touch stays on the same day',
  );
  await cdp.detach();
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    channel:
      process.env.CARTOTECA_CHROMIUM_CHANNEL ||
      (process.platform === 'win32' ? 'msedge' : undefined),
  });
  const viewports = [
    [320, 568],
    [375, 667],
    [390, 664],
    [412, 740],
    [700, 480],
  ];
  let passed = 0;
  try {
    for (const [width, height] of viewports) {
      const fixture = await createFixture();
      let context;
      try {
        context = await browser.newContext({
          viewport: { width, height },
          locale: 'ru-RU',
          timezoneId: 'Asia/Yerevan',
          isMobile: true,
          hasTouch: true,
          userAgent: devices['Pixel 7'].userAgent,
          serviceWorkers: 'block',
        });
        const page = await context.newPage(),
          errors = [];
        page.setDefaultTimeout(12000);
        page.on('pageerror', (error) => errors.push(error.message));
        await context.route('**/*', (route) => {
          const url = route.request().url();
          return url.startsWith(fixture.base + '/') || /^(data|blob):/.test(url)
            ? route.continue()
            : route.abort('blockedbyclient');
        });
        await runScenarios(page, fixture, async (name, run) => {
          if (name !== 'login') return;
          await run();
          passed++;
        });
        for (const mode of ['day', 'week']) {
          await chooseCalendarMode(page, mode);
          const toggle = page.locator('.early-hours-control [data-toggle-early-hours]');
          assert.equal(await toggle.isVisible(), true);
          assert.match(await toggle.textContent(), /Показать время до 07:00/);
          const bounds = await toggle.boundingBox();
          assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
          assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height - 72 + 1);
          assert.ok(bounds.height >= 44 && bounds.width < width - 24);
          assert.equal(await page.locator('.calendar-work-key,.mobile-hours').count(), 0);
          const grid = page.locator('.time-scroll');
          assert.ok((await grid.boundingBox()).height >= 48);
          await grid.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          assert.equal(await toggle.isVisible(), true);
          await toggle.click();
          assert.equal(await page.locator('.time-grid').getAttribute('data-first-minute'), '0');
          assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
          await toggle.click();
          assert.equal(await page.locator('.time-grid').getAttribute('data-first-minute'), '420');
          assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
          if (width === 390 && mode === 'week') await checkWeekScroll(page, context);
          if (width === 390 && process.env.CARTOTECA_BROWSER_REPORT) {
            const output = path.resolve(process.env.CARTOTECA_BROWSER_REPORT);
            fs.mkdirSync(output, { recursive: true });
            await page.screenshot({
              path: path.join(output, `calendar-${width}-${height}-${mode}.png`),
            });
          }
          passed++;
          console.log(`calendar ${width}x${height} ${mode}: PASS`);
        }
        assert.deepEqual(errors, []);
      } finally {
        await context?.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
  assert.equal(passed, 15);
  console.log(`Calendar browser checks: ${passed}/${passed}`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
