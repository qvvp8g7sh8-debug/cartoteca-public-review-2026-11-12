const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createPlatformStore } = require('../../platform-store.cjs');
const { createStorage } = require('../../storage.cjs');
const { createMultiServer } = require('../../multi-server.cjs');

const password = 'Synthetic-parallel-browser-password-2026';
const sameName = 'Same synthetic browser account';
const day = '2099-01-06';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function parallelBrowserFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-parallel-browser-'));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  const platform = createPlatformStore(path.join(directory, 'platform'));
  const stores = [],
    contexts = [];
  let server;
  t.after(async () => {
    const errors = [];
    for (const context of contexts.reverse()) {
      try {
        await context.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    for (const storage of stores) storage.close();
    platform.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('cartoteca-parallel-browser-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
    if (errors.length) throw new AggregateError(errors, 'Synthetic browser cleanup failed');
  });
  async function owner(label, sharedPhotoId) {
    const email = label.toLowerCase() + '@parallel-browser.test';
    const account = await platform.registerOwner({
      email,
      password,
      displayName: sameName,
      organizationName: 'PRIVATE_ORGANIZATION_' + label,
      city: 'Synthetic ' + label,
    });
    platform.verifyEmail(account.verificationToken);
    const token = (await platform.login(email, password)).token;
    const storage = createStorage(path.join(directory, 'tenants', account.organizationId));
    stores.push(storage);
    const png = await require('sharp')({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: label === 'A' ? '#dd2211' : '#1133dd',
      },
    })
      .png()
      .toBuffer();
    storage.write({
      revision: 0,
      services: [],
      patients: [
        {
          id: 'same-patient-id',
          name: 'PRIVATE_CLIENT_' + label,
          createdBy: account.accountId,
          notes: 'PRIVATE_NOTES_' + label,
          visits: [
            {
              id: 'same-visit-id',
              date: '2020-01-01',
              procedure: 'PRIVATE_VISIT_' + label,
              staffId: account.accountId,
              photos: [{ data: 'data:image/png;base64,' + png.toString('base64') }],
            },
          ],
          appointments: [
            {
              id: 'same-appointment-id',
              date: day,
              time: '10:00',
              duration: 30,
              service: 'PRIVATE_CALENDAR_' + label,
              staffId: account.accountId,
            },
          ],
        },
      ],
    });
    let saved = storage.read(),
      photoPath = saved.patients[0].visits[0].photos[0].data;
    let photoId = photoPath.split('/').pop();
    if (sharedPhotoId && photoId !== sharedPhotoId) {
      // Deliberate identifier collision in these two temporary cabinets only.
      // Both endpoints must find valid but different image bytes under this ID.
      assert.match(photoId, /^[a-f0-9]{32}$/);
      assert.match(sharedPhotoId, /^[a-f0-9]{32}$/);
      const from = path.resolve(storage.photoDir, photoId + '.enc');
      const to = path.resolve(storage.photoDir, sharedPhotoId + '.enc');
      assert.equal(path.dirname(from), path.resolve(storage.photoDir));
      assert.equal(path.dirname(to), path.resolve(storage.photoDir));
      fs.renameSync(from, to);
      storage.db.prepare('UPDATE photos SET id=? WHERE id=?').run(sharedPhotoId, photoId);
      saved.patients[0].visits[0].photos[0].data = '/api/photos/' + sharedPhotoId;
      storage.write(saved);
      photoId = sharedPhotoId;
      photoPath = '/api/photos/' + photoId;
    }
    return {
      ...account,
      label,
      email,
      token,
      storage,
      photoId,
      photoPath,
      photoHash: hash(storage.photo(photoId).buffer),
    };
  }
  const first = await owner('A'),
    second = await owner('B', first.photoId);
  assert.equal(first.photoPath, second.photoPath);
  assert.equal(
    first.photoHash !== second.photoHash,
    true,
    'The collision must contain distinct pixels',
  );
  server = createMultiServer({
    dataDir: directory,
    production: false,
    origin: '',
    sendMail: null,
    telegramBot: null,
    supportBot: null,
    telegramAutostart: false,
    supportAutostart: false,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const { chromium } = require('playwright');
  const shared = await chromium.launchPersistentContext(path.join(directory, 'browser-profile'), {
    headless: true,
    viewport: { width: 1280, height: 850 },
    serviceWorkers: 'block',
    channel:
      process.env.CARTOTECA_CHROMIUM_CHANNEL ||
      (process.platform === 'win32' ? 'msedge' : undefined),
    args: ['--mute-audio', '--no-first-run', '--disable-background-networking'],
  });
  contexts.push(shared);
  t.diagnostic('Temporary real browser: ' + shared.browser().version());
  async function guard(context) {
    await context.route('**/*', (route) => {
      const url = route.request().url();
      return url.startsWith(base + '/') || /^(?:data:|blob:)/.test(url)
        ? route.continue()
        : route.abort('blockedbyclient');
    });
    return context;
  }
  await guard(shared);
  async function isolated() {
    const context = await shared
      .browser()
      .newContext({ viewport: { width: 1280, height: 850 }, serviceWorkers: 'block' });
    contexts.push(context);
    return guard(context);
  }
  const profile = (account) => platform.accountProfile(account.token);
  const clinical = (account) => JSON.stringify(account.storage.read());
  const snapshot = (account) =>
    JSON.stringify({
      profile: profile(account),
      memberships: platform.memberships(account.accountId),
      clinical: clinical(account),
      photoHash: hash(account.storage.photo(account.photoId).buffer),
    });
  return {
    directory,
    base,
    platform,
    first,
    second,
    shared,
    isolated,
    profile,
    clinical,
    snapshot,
  };
}

async function login(page, f, account) {
  await page.goto(f.base + '/login.html?switch-account=1');
  await page.locator('#auth-email').fill(account.email);
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-submit').click();
  await page.locator('#calendar-new').waitFor({ timeout: 20000 });
}
async function profileForm(page) {
  await page.locator('[data-view="settings"]').click();
  const section = page.locator('#profile-settings');
  await section.waitFor({ state: 'attached' });
  const tile = section.locator('xpath=ancestor::details[1]');
  if (!(await tile.evaluate((element) => element.open)))
    await tile.locator(':scope > summary').click();
  await page.locator('#account-profile-form').waitFor({ state: 'visible', timeout: 12000 });
  return page.locator('#account-profile-form');
}
async function request(page, route, account, body) {
  return page.evaluate(
    async ({ route, account, body }) => {
      const response = await fetch(route, {
        method: body ? 'POST' : 'GET',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-Cartoteca-Request': '1',
          'X-Cartoteca-Account-Id': account.accountId,
          'X-Cartoteca-Organization-Id': account.organizationId,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const type = response.headers.get('content-type') || '';
      if (type.includes('application/json'))
        return { status: response.status, data: await response.json() };
      const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
      return {
        status: response.status,
        photoHash: [...new Uint8Array(digest)]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join(''),
      };
    },
    {
      route,
      account: { accountId: account.accountId, organizationId: account.organizationId },
      body,
    },
  );
}
const photoUrl = (account) =>
  account.photoPath +
  '?accountContext=' +
  account.accountId +
  '&organizationContext=' +
  account.organizationId;
const calendarUrl = '/api/cabinet/calendar?from=' + day + '&to=' + day;
module.exports = {
  parallelBrowserFixture,
  login,
  profileForm,
  request,
  photoUrl,
  calendarUrl,
  sameName,
};
