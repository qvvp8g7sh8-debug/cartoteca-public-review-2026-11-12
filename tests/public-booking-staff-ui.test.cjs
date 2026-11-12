const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { PRIVACY_VERSION } = require('../src/shared/privacy-consent.cjs');

const day = '2030-01-02';
const rules = (bookingMode, mode = 'any') => ({
  bookingMode,
  mode,
  reservationMinutes: 30,
  minimumLeadMinutes: 60,
});
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('Synthetic staff booking UI timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(
  t,
  { url = 'https://booking.example/booking.html?organization=org', customize } = {},
) {
  const window = new JSDOM('<main id="public-booking"></main>', { url, runScripts: 'outside-only', pretendToBeVisual: true })
    .window;
  t.after(() => window.close());
  for (const name of ['phone', 'flow', 'receipt', 'view', 'page'])
    window.eval(
      fs.readFileSync(path.join(__dirname, '../src/client/public', name + '.js'), 'utf8'),
    );
  const info = {
    organization: {
      organizationId: 'org',
      name: 'Synthetic organization',
      timeZone: 'Europe/Moscow',
    },
    mode: 'any',
    bookingMode: 'approval',
    reservationMinutes: 30,
    challenge: 'original-synthetic-challenge',
    privacyConsentVersion: PRIVACY_VERSION,
    members: [
      { id: 'a', name: 'First synthetic', rules: rules('classic', 'sequential') },
      { id: 'b', name: 'Second synthetic', rules: rules('approval') },
    ],
    services: [
      { id: 'a-service', name: 'First service', duration: 30, staffIds: ['a'] },
      { id: 'b-service', name: 'Second service', duration: 30, staffIds: ['b'] },
    ],
  };
  const posts = [],
    calls = [];
  const availability = (
    staffId,
    applied = info.members.find((member) => member.id === staffId).rules,
  ) => ({
    rules: applied,
    mode: applied.mode,
    members: info.members.filter((member) => member.id === staffId),
    slots: (applied.mode === 'sequential' ? ['09:50'] : ['09:00', '09:15']).map((time) => ({
      date: day,
      time,
      duration: 30,
      staffId,
    })),
    requestedTimes: applied.bookingMode === 'classic' ? [] : ['10:00', '10:15'],
  });
  const defaultRequest = async (url, options = {}) => {
    calls.push(url);
    if (url.includes('/info')) return structuredClone(info);
    if (url.includes('/dates')) return { dates: [day] };
    if (url.includes('/availability')) return availability(JSON.parse(options.body).staffId);
    if (url.includes('/requests')) {
      const input = JSON.parse(options.body);
      posts.push(input);
      return {
        status: input.bookingMode === 'classic' ? 'booked' : 'pending',
        date: day,
        time: input.time,
        duration: 30,
      };
    }
    throw Error('Unexpected synthetic request');
  };
  const request = (url, options = {}) =>
    customize
      ? customize({ url, options, info, posts, availability, defaultRequest })
      : defaultRequest(url, options);
  const root = window.document.querySelector('main');
  const page = window.eval('createPublicBookingPage')(
    root,
    window.eval('createPublicBookingView'),
    request,
  );
  const $ = (selector) => root.querySelector(selector);
  const change = (element) => element.dispatchEvent(new window.Event('change', { bubbles: true }));
  await page.initialize();
  $('#booking-month').value = '2030-01';
  async function chooseService(id) {
    const control = $('[data-booking-service="' + id + '"]');
    assert.ok(control);
    control.checked = true;
    change(control);
    await until(() => $('[data-booking-date="' + day + '"]'));
  }
  async function chooseDate() {
    $('[data-booking-next="2"]').click();
    $('[data-booking-date="' + day + '"]').click();
    await until(
      () =>
        $('[data-booking-time]') && $('#booking-time-area').getAttribute('aria-busy') === 'false',
    );
  }
  async function chooseSlot(id = 'a-service') {
    await chooseService(id);
    await chooseDate();
    $('[data-booking-time]').click();
    $('[data-booking-next="3"]').click();
  }
  function contact() {
    $('[name="firstName"]').value = 'Synthetic contact';
    $('[name="phone"]').value = '+79990000101';
    $('[name="consent"]').checked = true;
  }
  function submit() {
    $('#booking-contact-form').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    );
  }
  return {
    window,
    $,
    change,
    info,
    posts,
    calls,
    page,
    chooseService,
    chooseDate,
    chooseSlot,
    contact,
    submit,
  };
}

test('common booking page promises no completion mode before a specialist is known', async (t) => {
  const f = await fixture(t);
  assert.match(f.$('.booking-submit-hint').textContent, /после выбора специалиста/);
  assert.equal(f.$('#booking-contact-form [type="submit"]').textContent, 'Продолжить');
  assert.equal(f.$('#booking-selected-staff').hidden, true);
  await f.chooseService('a-service');
  assert.match(f.$('.booking-submit-hint').textContent, /После сохранения.*сразу.*подтверждение/);
  assert.match(f.$('#booking-selected-staff').textContent, /First synthetic/);
  assert.equal(f.$('#booking-contact-form [type="submit"]').textContent, 'Записаться');
});

for (const url of [
  'https://booking.example/booking.html?organization=org&staff=a',
  'https://booking.example/b/abcd1234',
])
  test(
    'personal entry keeps the selected specialist until an explicit change: ' +
      new URL(url).pathname,
    async (t) => {
      const f = await fixture(t, {
        url,
        customize: ({ url, info, defaultRequest, options }) => {
          if (url.includes('/info')) info.selectedStaffId = 'a';
          return defaultRequest(url, options);
        },
      });
      assert.equal(f.$('#booking-staff').value, 'a');
      assert.equal(f.$('[data-booking-service="b-service"]'), null);
      f.$('#booking-staff').value = 'b';
      f.change(f.$('#booking-staff'));
      assert.ok(f.$('[data-booking-service="b-service"]'));
      assert.equal(f.$('[data-booking-service="a-service"]'), null);
      assert.equal(f.$('#booking-contact-form [type="submit"]').textContent, 'Отправить заявку');
      assert.equal(f.posts.length, 0);
    },
  );

test('changing staff clears incompatible services and times but retains contact fields', async (t) => {
  const f = await fixture(t);
  await f.chooseSlot();
  f.contact();
  f.$('#booking-staff').value = 'b';
  f.change(f.$('#booking-staff'));
  assert.equal(f.$('[name="firstName"]').value, 'Synthetic contact');
  assert.equal(f.$('[name="phone"]').value, '+79990000101');
  assert.equal(f.$('[data-booking-service="b-service"]').checked, false);
  assert.equal(f.$('[data-booking-time]'), null);
  assert.equal(f.posts.length, 0);
  await f.chooseSlot('b-service');
  f.submit();
  await until(() => f.posts.length === 1);
  assert.equal(f.posts[0].staffId, 'b');
  assert.equal(f.posts[0].bookingMode, 'approval');
});

test('fresh availability changes the button and payload before any booking is submitted', async (t) => {
  const f = await fixture(t, {
    customize: ({ url, options, availability, defaultRequest }) =>
      url.includes('/availability')
        ? availability('a', rules('approval', 'sequential'))
        : defaultRequest(url, options),
  });
  await f.chooseSlot();
  f.contact();
  assert.equal(f.$('#booking-contact-form [type="submit"]').textContent, 'Отправить заявку');
  f.submit();
  await until(() => f.posts.length === 1);
  assert.equal(f.posts[0].bookingMode, 'approval');
});

test('rules conflict refreshes selection without a new key or losing contact and consent', async (t) => {
  let failed = false;
  const f = await fixture(t, {
    customize: ({ url, options, info, defaultRequest }) => {
      if (url.includes('/requests') && !failed) {
        failed = true;
        info.challenge = 'replacement-challenge-must-not-retry-write';
        info.members[0].rules.bookingMode = 'approval';
        throw Object.assign(Error('Режим онлайн-записи изменился.'), { status: 409, code: 'BOOKING_CONDITIONS_CHANGED' });
      }
      return defaultRequest(url, options);
    },
  });
  await f.chooseSlot();
  f.contact();
  f.submit();
  await until(
    () =>
      failed && f.$('#booking-page-status').textContent.includes('Режим онлайн-записи изменился.'),
  );
  assert.equal(f.$('[name="firstName"]').value, 'Synthetic contact');
  assert.equal(f.$('[name="consent"]').checked, true);
  assert.equal(f.posts.length, 0);
  await f.chooseDate();
  f.$('[data-booking-time]').click();
  f.$('[data-booking-next="3"]').click();
  f.submit();
  await until(() => f.posts.length === 1);
  assert.equal(f.posts[0].key, 'original-synthetic-challenge');
  assert.equal(f.posts[0].bookingMode, 'approval');
});

test('unknown write result retries the exact frozen staff rules and original key', async (t) => {
  const attempts = [];
  let fail = true;
  const f = await fixture(t, {
    customize: ({ url, options, defaultRequest }) => {
      if (url.includes('/requests')) {
        attempts.push(JSON.parse(options.body));
        if (fail) throw Error('Synthetic network timeout');
      }
      return defaultRequest(url, options);
    },
  });
  await f.chooseSlot();
  f.contact();
  f.submit();
  await until(
    () => f.$('#booking-contact-form [type="submit"]').textContent === 'Повторить отправку',
  );
  f.$('#booking-staff').value = 'b';
  f.change(f.$('#booking-staff'));
  fail = false;
  f.submit();
  await until(() => attempts.length === 2);
  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal(attempts[1].staffId, 'a');
  assert.equal(attempts[1].bookingMode, 'classic');
});

test('a late availability response cannot restore the previous specialist or booking mode', async (t) => {
  let release;
  const f = await fixture(t, {
    customize: ({ url, options, availability, defaultRequest }) => {
      if (url.includes('/availability') && JSON.parse(options.body).staffId === 'a')
        return new Promise((resolve) => {
          release = () => resolve(availability('a'));
        });
      return defaultRequest(url, options);
    },
  });
  await f.chooseService('a-service');
  f.$('[data-booking-next="2"]').click();
  f.$('[data-booking-date="' + day + '"]').click();
  await until(() => release);
  f.$('#booking-staff').value = 'b';
  f.change(f.$('#booking-staff'));
  await f.chooseService('b-service');
  await f.chooseDate();
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.$('#booking-staff').value, 'b');
  assert.equal(f.$('#booking-contact-form [type="submit"]').textContent, 'Отправить заявку');
  assert.equal(f.$('[data-booking-time="09:50"]'), null);
});
