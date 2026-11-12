const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parallelBrowserFixture,
  login,
  profileForm,
  request,
  photoUrl,
  calendarUrl,
  sameName,
} = require('./helpers/account-parallel-browser-fixture.cjs');

test(
  'real browser shared-cookie tabs stop stale account work while isolated contexts retain separate identities',
  {
    skip: process.env.CARTOTECA_ACCOUNT_PARALLEL_BROWSER !== '1',
    timeout: 120000,
  },
  async (t) => {
    const f = await parallelBrowserFixture(t),
      { first, second } = f;
    await t.test(
      'two ordinary tabs share the cookie but never apply it to the old account form or images',
      async () => {
        const pageA = await f.shared.newPage(),
          pageB = await f.shared.newPage();
        await login(pageA, f, first);
        const formA = await profileForm(pageA);
        assert.equal(await formA.locator('[name="displayName"]').inputValue(), sameName);
        await formA.locator('[name="displayName"]').fill('STALE_FORM_A_MUST_NOT_WRITE_B');
        const beforeA = f.snapshot(first),
          beforeB = f.snapshot(second);
        let releaseBackground;
        const background = new Promise((resolve) => {
          releaseBackground = resolve;
        });
        let armed = true,
          writes = 0,
          terminalDocuments = 0;
        pageA.on('request', (req) => {
          if (new URL(req.url()).pathname === '/api/account/profile' && req.method() === 'POST')
            writes++;
        });
        // Preserve the old form until the deliberate submit. No API response is
        // mocked: unrelated background reads wait and are aborted at terminal exit.
        await pageA.route('**/api/**', async (route) => {
          const req = route.request(),
            url = new URL(req.url());
          if (armed && req.method() === 'GET' && !url.searchParams.has('parallelProbe')) {
            await background;
            try {
              await route.abort('aborted');
            } catch {}
          } else await route.continue();
        });
        await pageA.route(f.base + '/', async (route) => {
          if (!armed || !route.request().isNavigationRequest()) return route.continue();
          terminalDocuments++;
          armed = false;
          releaseBackground();
          // Record the real client's terminal reload without bootstrapping a new B
          // document; the old form must not consume any B response before disposal.
          await route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><p id="parallel-terminal">Old account document ended</p>',
          });
        });
        try {
          await login(pageB, f, second);
          for (const route of [
            '/api/account/profile?parallelProbe=1',
            calendarUrl + '&parallelProbe=1',
            photoUrl(first) + '&parallelProbe=1',
          ]) {
            const result = await request(pageA, route, first);
            assert.equal(result.status, 428);
            assert.equal(result.data.code, 'AUTH_CONTEXT_CHANGED');
            assert.doesNotMatch(
              JSON.stringify(result),
              /PRIVATE_ORGANIZATION_B|PRIVATE_CLIENT_B|PRIVATE_CALENDAR_B|PRIVATE_NOTES_B/,
            );
            assert.equal(Object.hasOwn(result, 'photoHash'), false);
          }
          const rejected = pageA.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === '/api/account/profile' &&
              response.request().method() === 'POST',
          );
          await formA.locator('button[type="submit"]').click();
          const response = await rejected;
          assert.equal(response.status(), 428);
          assert.equal((await response.json()).code, 'AUTH_CONTEXT_CHANGED');
          await pageA.locator('#parallel-terminal').waitFor({ timeout: 12000 });
          assert.equal(writes, 1, 'The stale write must never be automatically replayed');
          assert.equal(terminalDocuments, 1);
          assert.equal(await pageA.locator('#account-profile-form').count(), 0);
          assert.equal(f.snapshot(first), beforeA);
          assert.equal(f.snapshot(second), beforeB);
          const ownProfile = await request(pageB, '/api/account/profile', second);
          assert.equal(ownProfile.status, 200);
          assert.equal(ownProfile.data.account.email, second.email);
          const ownCalendar = await request(pageB, calendarUrl, second);
          assert.equal(ownCalendar.status, 200);
          assert.match(JSON.stringify(ownCalendar), /PRIVATE_CALENDAR_B/);
          assert.doesNotMatch(JSON.stringify(ownCalendar), /PRIVATE_CALENDAR_A|PRIVATE_CLIENT_A/);
          const ownPhoto = await request(pageB, photoUrl(second), second);
          assert.equal(ownPhoto.status, 200);
          assert.equal(ownPhoto.photoHash, second.photoHash);
          const saved = await request(pageB, '/api/account/profile', second, {
            displayName: sameName,
            specialty: 'B own browser specialty',
            expectedSpecialty: '',
          });
          assert.equal(saved.status, 200);
          assert.equal(f.profile(second).specialty, 'B own browser specialty');
          assert.equal(f.snapshot(first), beforeA);
        } finally {
          armed = false;
          releaseBackground();
          await pageA.close();
          await pageB.close();
        }
      },
    );

    await t.test(
      'separate browser contexts concurrently retain their own same-name account and colliding photo IDs',
      async () => {
        const contextA = await f.isolated(),
          contextB = await f.isolated();
        const pageA = await contextA.newPage(),
          pageB = await contextB.newPage();
        await Promise.all([login(pageA, f, first), login(pageB, f, second)]);
        const [cookiesA, cookiesB] = await Promise.all([
          contextA.cookies(f.base),
          contextB.cookies(f.base),
        ]);
        const cookieA = cookiesA.find((cookie) => cookie.name === 'cartoteca_v2_session');
        const cookieB = cookiesB.find((cookie) => cookie.name === 'cartoteca_v2_session');
        assert.equal(Boolean(cookieA && cookieB && cookieA.value !== cookieB.value), true);
        const clinicalA = f.clinical(first),
          clinicalB = f.clinical(second);
        const profiles = await Promise.all([
          request(pageA, '/api/account/profile', first),
          request(pageB, '/api/account/profile', second),
        ]);
        assert.equal(profiles[0].status, 200);
        assert.equal(profiles[1].status, 200);
        assert.equal(profiles[0].data.account.email, first.email);
        assert.equal(profiles[1].data.account.email, second.email);
        for (const profile of profiles) assert.equal(profile.data.account.displayName, sameName);
        const calendars = await Promise.all([
          request(pageA, calendarUrl, first),
          request(pageB, calendarUrl, second),
        ]);
        for (const [index, result] of calendars.entries()) {
          const own = index ? 'B' : 'A',
            other = index ? 'A' : 'B';
          assert.equal(result.status, 200);
          assert.match(JSON.stringify(result), new RegExp('PRIVATE_CALENDAR_' + own));
          assert.doesNotMatch(
            JSON.stringify(result),
            new RegExp('PRIVATE_CALENDAR_' + other + '|PRIVATE_CLIENT_' + other),
          );
        }
        const images = await Promise.all([
          request(pageA, photoUrl(first), first),
          request(pageB, photoUrl(second), second),
        ]);
        assert.equal(images[0].status, 200);
        assert.equal(images[0].photoHash, first.photoHash);
        assert.equal(images[1].status, 200);
        assert.equal(images[1].photoHash, second.photoHash);
        const [formA, formB] = await Promise.all([profileForm(pageA), profileForm(pageB)]);
        const beforeB = f.snapshot(second);
        await formA.locator('[name="displayName"]').fill('Updated only browser A');
        const saveA = pageA.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/account/profile' &&
            response.request().method() === 'POST',
        );
        await formA.locator('button[type="submit"]').click();
        assert.equal((await saveA).status(), 200);
        assert.equal(f.profile(first).account.displayName, 'Updated only browser A');
        assert.equal(f.snapshot(second), beforeB);
        const afterA = f.snapshot(first);
        await formB.locator('[name="displayName"]').fill('Updated only browser B');
        const saveB = pageB.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/account/profile' &&
            response.request().method() === 'POST',
        );
        await formB.locator('button[type="submit"]').click();
        assert.equal((await saveB).status(), 200);
        assert.equal(f.profile(second).account.displayName, 'Updated only browser B');
        assert.equal(f.snapshot(first), afterA);
        assert.equal(f.clinical(first), clinicalA);
        assert.equal(f.clinical(second), clinicalB);
        await pageA.close();
        await pageB.close();
      },
    );
  },
);
