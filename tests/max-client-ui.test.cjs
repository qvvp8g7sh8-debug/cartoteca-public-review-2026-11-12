const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, width = 390) {
  const w = new JSDOM('<div id="patient-max-connection" data-patient-id="p"></div>', {
    url: 'https://synthetic.test',
    runScripts: 'outside-only',
  }).window;
  Object.defineProperty(w, 'innerWidth', { value: width });
  t.after(() => w.close());
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new w.Event('close'));
  };
  const state = {
    account: { id: 'owner', organizationId: 'org' },
    currentView: 'card',
    selectedId: 'p',
    multiUser: true,
    busy: false,
    data: [{ id: 'p', name: 'Synthetic client' }],
  };
  const messages = [],
    calls = [],
    actions = {
      $: (selector) => w.document.querySelector(selector),
      esc: (value) =>
        String(value).replace(
          /[&<>"']/g,
          (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
        ),
      toast: (value) => messages.push(value),
      confirmAction: async () => w.confirm(),
      patientView: () => null,
    };
  const invitation = {
    url: 'https://max.ru/id000000000000_1_bot?start=' + 'a'.repeat(43),
    qrDataUrl: 'data:image/png;base64,c3ludGhldGlj',
    invitationText: 'Synthetic invitation',
    expiresAt: Date.now() + 86400000,
  };
  let result = {
    patientId: 'p',
    linked: false,
    canConnect: true,
    canDisconnect: false,
    compatible: false,
    canChooseDelivery: false,
    preference: { preference: 'auto', revision: 0 },
  };
  actions.request = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/max/link') return invitation;
    if (url === '/api/max/unlink') {
      result = { ...result, linked: false, canDisconnect: false };
      return result;
    }
    return result;
  };
  for (const [file, factory] of [
    ['client-service-summary.js', 'createClientServiceSummary'],
    ['max-invitation.js', 'createMaxInvitation'],
    ['max-client.js', 'createMaxClient'],
  ]) {
    w.eval(fs.readFileSync(path.join(root, 'src/client/modules', file), 'utf8'));
    Object.assign(actions, w[factory](state, actions));
  }
  actions.bindMaxInvitationEvents();
  actions.bindMaxClientEvents();
  return {
    w,
    state,
    actions,
    calls,
    messages,
    invitation,
    status: (next) => {
      result = { ...result, ...next };
    },
  };
}

test('display-only card requests bounded MAX status without fetching full patient history', async (t) => {
  const f = fixture(t);
  f.actions.patientView = () => ({ patient: { id: 'p' } });
  f.actions.ensurePatient = () => assert.fail('Full history must not be requested');
  await f.actions.loadPatientMax();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/api/max/patient?patientId=p&view=card');
});
for (const width of [320, 390, 1440])
  test(`MAX preparation, invitation, linked state and confirmation to disconnect: DOM ${width}`, async (t) => {
    const f = fixture(t, width),
      $ = f.actions.$;
    f.status({ canConnect: false });
    await f.actions.loadPatientMax();
    assert.equal($('[data-max-link]').disabled, true);
    assert.match($('#patient-max-connection').textContent, /Недоступно/);
    assert.equal($('#patient-delivery-choice'), null);
    assert.equal($('[data-delivery-preference]'), null);
    f.status({ canConnect: true });
    await f.actions.loadPatientMax();
    $('[data-max-link]').click();
    $('[data-max-link]').click();
    await settle();
    assert.equal(f.calls.filter((c) => c.url === '/api/max/link').length, 1);
    assert.equal($('#max-invitation-dialog').open, true);
    assert.equal($('#max-invitation-dialog input').value, f.invitation.url);
    assert.equal($('[data-max-unlink]'), null);
    assert.match($('#patient-max-connection').textContent, /Приглашение/);
    let copied;
    Object.defineProperty(f.w.navigator, 'clipboard', {
      value: {
        writeText: async (value) => {
          copied = value;
        },
      },
    });
    $('[data-copy-max-invitation="link"]').click();
    await settle();
    assert.equal(copied, f.invitation.url);
    const copyStatus = $('#max-invitation-dialog [data-max-invitation-status]');
    assert.equal(copyStatus.textContent, 'Ссылка скопирована');
    assert.equal(copyStatus.getAttribute('role'), 'status');
    assert.equal(copyStatus.dataset.kind, 'success');
    assert.equal(f.messages.includes('Ссылка скопирована'), false);
    $('[data-copy-max-invitation="message"]').click();
    await settle();
    assert.equal(copied, f.invitation.invitationText + '\n\n' + f.invitation.url);
    assert.equal(copyStatus.textContent, 'Сообщение скопировано — отправьте клиенту');
    f.status({
      linked: true,
      compatible: true,
      canDisconnect: true,
      bindingId: 'synthetic-binding',
      canChooseDelivery: true, // Even a stale response must not restore the retired selector.
    });
    await f.actions.loadPatientMax();
    assert.match($('#patient-max-connection').textContent, /✓ Подключён/);
    assert.equal($('[data-delivery-preference]'), null);
    assert.equal(
      f.calls.some((c) => c.url.includes('/notifications/preference')),
      false,
    );
    assert.equal($('#max-invitation-dialog').open, false);
    f.w.confirm = () => false;
    $('[data-max-unlink]').click();
    await settle();
    assert.equal(f.calls.filter((c) => c.url === '/api/max/unlink').length, 0);
    f.w.confirm = () => true;
    $('[data-max-unlink]').click();
    await settle();
    const sent = f.calls.find((c) => c.url === '/api/max/unlink');
    assert.deepEqual(JSON.parse(sent.options.body), {
      patientId: 'p',
      bindingId: 'synthetic-binding',
    });
    assert.equal(
      f.calls.some((c) => c.url.startsWith('/api/telegram/')),
      false,
    );
  });

test('late MAX response after account change cannot overwrite current client', async (t) => {
  const f = fixture(t);
  let answer;
  f.actions.request = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  const pending = f.actions.loadPatientMax();
  f.state.account.organizationId = 'other-org';
  answer({ linked: true, canDisconnect: true, preference: {} });
  await pending;
  assert.equal(f.actions.$('#patient-max-connection').textContent, '');
});

test('MAX invitation refuses a foreign host or stale client and clipboard fallback remains manual', async (t) => {
  const f = fixture(t),
    invitation = { ...f.invitation, patientId: 'p', accountKey: 'owner:org' };
  f.actions.showMaxInvitation({
    ...invitation,
    url: 'https://foreign.test/?start=' + 'a'.repeat(43),
  });
  assert.equal(f.actions.$('#max-invitation-dialog'), null);
  f.actions.showMaxInvitation(invitation);
  Object.defineProperty(f.w.navigator, 'clipboard', {
    value: {
      writeText: async () => {
        throw Error('synthetic clipboard unavailable');
      },
    },
  });
  f.actions.$('[data-copy-max-invitation="link"]').click();
  await settle();
  assert.equal(f.actions.$('#max-invitation-dialog input').closest('details').open, true);
  const copyStatus = f.actions.$('#max-invitation-dialog [data-max-invitation-status]');
  assert.match(copyStatus.textContent, /скопируйте его вручную/);
  assert.equal(copyStatus.dataset.kind, 'manual');
  assert.equal(
    f.messages.some((message) => /Текст выделен/.test(message)),
    false,
  );
  f.actions.$('[data-copy-max-invitation="message"]').click();
  await settle();
  assert.equal(f.actions.$('#max-invitation-dialog textarea').closest('details').open, true);
  assert.equal(f.w.document.activeElement.tagName, 'TEXTAREA');
  f.state.selectedId = 'other-p';
  f.actions.$('[data-copy-max-invitation="message"]').click();
  await settle();
  assert.equal(f.actions.$('#max-invitation-dialog').open, false);
});

test('late clipboard result cannot recreate status in a closed MAX invitation', async (t) => {
  const f = fixture(t);
  f.actions.showMaxInvitation({ ...f.invitation, patientId: 'p', accountKey: 'owner:org' });
  let copied;
  Object.defineProperty(f.w.navigator, 'clipboard', {
    value: {
      writeText: () =>
        new Promise((resolve) => {
          copied = resolve;
        }),
    },
  });
  f.actions.$('[data-copy-max-invitation="link"]').click();
  f.actions.dismissMaxInvitation();
  copied();
  await settle();
  assert.equal(f.actions.$('#max-invitation-dialog').open, false);
  assert.equal(f.actions.$('[data-max-invitation-status]'), null);
  assert.equal(f.messages.length, 0);
});
