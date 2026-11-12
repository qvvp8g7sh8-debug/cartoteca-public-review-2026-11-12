const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { JSDOM } = require('jsdom');
const { normalizePatientPhoneText } = require('../src/shared/patient-names.cjs');
function fixture(
  t,
  {
    userAgent = 'Desktop',
    platform = 'Win32',
    touch = 0,
    coarse = false,
    phone = '+7 (999) 000-00-00',
  } = {},
) {
  const w = new JSDOM('<main></main>', {
    runScripts: 'outside-only',
    url: 'https://synthetic.test',
  }).window;
  t.after(() => w.close());
  for (const [name, value] of Object.entries({ userAgent, platform, maxTouchPoints: touch }))
    Object.defineProperty(w.navigator, name, { value });
  w.matchMedia = () => ({ matches: coarse });
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new w.Event('close'));
  };
  const patient = { id: 'p', name: 'Synthetic client', phone };
  const state = { busy: false };
  const actions = {
    normalizePatientPhoneText,
    esc: (v) =>
      String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    clientRecords: () => [patient],
  };
  w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules/client-contact.js'), 'utf8'));
  const api = w.createClientContact(state, actions);
  w.document.querySelector('main').innerHTML = api.clientContactActionsHtml(patient);
  api.bindClientContactEvents();
  return { w, state, api, patient, $: (s) => w.document.querySelector(s) };
}
test('desktop has messaging but no telephone action', (t) => {
  const f = fixture(t);
  assert.ok(f.$('[data-client-message]'));
  assert.equal(f.$('a[href^="tel:"]'), null);
  f.$('[data-client-message]').click();
  assert.equal(f.$('dialog').open, true);
  const links = [...f.$('dialog').querySelectorAll('a')].map((a) => a.href);
  assert.deepEqual(links, ['https://t.me/+79990000000', 'https://wa.me/79990000000']);
  assert.ok(links.every((link) => !link.includes('start=') && !link.includes('text=')));
  assert.match(f.$('dialog').textContent, /не отправляется автоматически/);
  f.$('dialog').getBoundingClientRect = () => ({ left: 100, top: 100, right: 400, bottom: 300 });
  f.$('dialog').dispatchEvent(
    new f.w.MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }),
  );
  assert.equal(f.$('dialog').open, true);
  f.$('[data-close-client-contact]').click();
  assert.equal(f.$('dialog').textContent, '');
});
for (const device of [
  { userAgent: 'Android' },
  { userAgent: 'iPhone' },
  { userAgent: 'Desktop', platform: 'MacIntel', touch: 5 },
  { touch: 5, coarse: true },
])
  test(
    'phone and tablet show call without treating narrow desktop as mobile: ' +
      JSON.stringify(device),
    (t) => {
      const f = fixture(t, device);
      assert.equal(f.$('a[href^="tel:"]').href, 'tel:+79990000000');
    },
  );
test('a copied phone with bidi controls and nonbreaking hyphens enables call and chat', (t) => {
  const f = fixture(t, { phone: '\u202A+7 999 123\u201145\u201167\u202C', userAgent: 'Android' });
  assert.equal(f.$('a[href^="tel:"]').href, 'tel:+79991234567');
  f.$('[data-client-message]').click();
  const links = [...f.$('dialog').querySelectorAll('a')].map((a) => a.href);
  assert.deepEqual(links, ['https://t.me/+79991234567', 'https://wa.me/79991234567']);
});
for (const phone of [
  '',
  '555',
  'javascript:alert(1)',
  '+7 999 000-00-00 ext.12',
  '\u202A++7 999 123\u201145\u201167\u202C',
  '\u202A+7 999/123\u201145\u201167\u202C',
])
  test('invalid phone cannot open chat or inject a link: ' + phone, (t) => {
    const f = fixture(t, { phone, userAgent: 'Android' });
    assert.equal(f.$('[data-client-message]').disabled, true);
    assert.equal(f.$('a'), null);
    assert.equal(f.$('dialog'), null);
  });
test('busy client operation cannot open contact dialog', (t) => {
  const f = fixture(t);
  f.state.busy = true;
  f.$('[data-client-message]').click();
  assert.equal(f.$('dialog'), null);
});
test('page exit clears contact links and changed account cannot follow a stale link', (t) => {
  const f = fixture(t);
  f.$('[data-client-message]').click();
  f.w.dispatchEvent(new f.w.Event('pagehide'));
  assert.equal(f.$('dialog').textContent, '');
  assert.equal(f.$('dialog').open, false);
  f.$('[data-client-message]').click();
  f.state.account = { id: 'another-account' };
  const link = f.$('dialog a'),
    event = new f.w.MouseEvent('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.$('dialog').textContent, '');
});
