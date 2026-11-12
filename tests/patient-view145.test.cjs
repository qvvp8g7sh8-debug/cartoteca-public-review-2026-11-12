const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../src/client/core/patient-view.js'), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function page(revision = 7) {
  return {
    patient: { id: 'patient', name: 'Synthetic', notes: 'Profile only' },
    revision,
    history: {
      entries: [{ kind: 'visit', record: { id: 'visit-1', date: '2030-01-01' } }],
      total: 2,
      nextCursor: 'opaque-history',
      photoCount: 9,
    },
    upcoming: {
      entries: [{ id: 'appointment', date: '2031-01-01', status: 'scheduled' }],
      total: 1,
      nextCursor: null,
    },
  };
}
function fixture(t) {
  const w = new JSDOM(
    '<section id="detail"><button id="edit-patient">Edit</button><button id="more-visits">More</button><button data-tab="photos">Photos</button></section>',
    { runScripts: 'outside-only' },
  ).window;
  t.after(() => w.close());
  const state = {
    lazyReads: true,
    account: { id: 'owner', organizationId: 'org', role: 'owner' },
    selectedId: 'patient',
    revision: 1,
    data: [],
    currentView: 'card',
  };
  const calls = [],
    messages = [];
  let fullReads = 0,
    renders = 0;
  const actions = {
    patient: () => state.data.find((p) => p.id === state.selectedId),
    request(url) {
      const d = deferred();
      calls.push({ url, ...d });
      return d.promise;
    },
    async ensurePatient(id) {
      fullReads++;
      const result = await actions.request('/full/' + id);
      state.data = [result];
      state.revision = 8;
      return result;
    },
    renderDetail: () => renders++,
    toast: (message) => messages.push(message),
  };
  const view = w.eval(source + '\ncreatePatientView')(state, actions);
  return {
    w,
    state,
    actions,
    calls,
    messages,
    view,
    fullReads: () => fullReads,
    renders: () => renders,
  };
}
async function open(f) {
  const read = f.view.ensurePatientView('patient');
  f.calls[0].resolve(page());
  await read;
}
test('display pages never enter editable data; paging keeps total/photo count and coalesces a cursor', async (t) => {
  const f = fixture(t);
  await open(f);
  assert.equal(f.calls[0].url, '/api/cabinet/patient?id=patient&view=card');
  assert.deepEqual(f.state.data, []);
  assert.equal(f.view.viewPatient().visits.length, 1);
  assert.equal(f.state.revision, 1);
  const one = f.view.loadPatientViewPage('history'),
    two = f.view.loadPatientViewPage('history');
  assert.equal(f.calls.length, 2);
  f.calls[1].resolve({
    revision: 7,
    entries: [{ kind: 'appointment', record: { id: 'cancelled', status: 'cancelled' } }],
    total: 2,
    nextCursor: null,
  });
  await Promise.all([one, two]);
  assert.equal(f.view.patientView().history.entries.length, 2);
  assert.equal(f.view.patientView().history.photoCount, 9);
  assert.equal(f.view.viewPatient().appointments.length, 2);
  assert.deepEqual(f.state.data, []);
  assert.equal(f.fullReads(), 0);
});
test('account object, organization, role, selected card and local revision invalidate late reads', async (t) => {
  for (const change of [
    (s) => {
      s.account = { ...s.account };
    },
    (s) => {
      s.account.organizationId = 'other-org';
    },
    (s) => {
      s.account.role = 'cosmetologist';
    },
    (s) => {
      s.selectedId = 'other-patient';
    },
    (s) => {
      s.revision++;
    },
  ]) {
    const f = fixture(t),
      reading = f.view.ensurePatientView('patient');
    change(f.state);
    f.calls[0].resolve(page());
    await reading;
    assert.equal(f.view.patientView(), null);
    assert.equal(f.view.viewPatient(), undefined);
    assert.equal(f.fullReads(), 0);
  }
});
test('only an explicit unsupported store requests the full compatibility route; ACL errors never do', async (t) => {
  const f = fixture(t),
    read = f.view.ensurePatientView('patient');
  f.calls[0].resolve({ viewUnsupported: true });
  await new Promise(setImmediate);
  assert.equal(f.fullReads(), 1);
  f.calls[1].resolve({ id: 'patient', visits: [{ id: 'entire-history' }] });
  await read;
  assert.equal(f.view.patientView(), null);
  assert.equal(f.view.viewPatient().visits[0].id, 'entire-history');
  const g = fixture(t),
    denied = g.view.ensurePatientView('patient');
  g.calls[0].reject(Object.assign(Error('denied'), { status: 403 }));
  await assert.rejects(denied, /denied/);
  assert.equal(g.fullReads(), 0);
});
test('editing waits for full patient before original handler; readonly pagination does not', async (t) => {
  const f = fixture(t);
  await open(f);
  f.view.bindPatientViewEvents();
  let editEvents = 0,
    moreEvents = 0;
  f.w.document.addEventListener('click', (event) => {
    if (event.target.id === 'edit-patient') {
      editEvents++;
      assert.equal(f.actions.patient().visits.length, 99);
    }
    if (event.target.id === 'more-visits') moreEvents++;
  });
  f.w.document.querySelector('#more-visits').click();
  assert.equal(moreEvents, 1);
  assert.equal(f.fullReads(), 0);
  f.w.document.querySelector('#edit-patient').click();
  assert.equal(editEvents, 0);
  assert.equal(f.fullReads(), 1);
  f.calls[1].resolve({ id: 'patient', visits: Array.from({ length: 99 }, (_, id) => ({ id })) });
  await new Promise(setImmediate);
  assert.equal(editEvents, 1);
  assert.equal(f.view.patientView(), null);
});
test('checkbox consent cannot silently toggle or save from a display-only card', async (t) => {
  const f = fixture(t);
  await open(f);
  f.w.document
    .querySelector('#detail')
    .insertAdjacentHTML('beforeend', '<input id="patient-video-consent" type="checkbox">');
  f.view.bindPatientViewEvents();
  const checkbox = f.w.document.querySelector('#patient-video-consent');
  let changes = 0;
  checkbox.addEventListener('change', () => {
    changes++;
    assert.ok(f.actions.patient());
  });
  checkbox.click();
  assert.equal(checkbox.checked, false);
  assert.equal(changes, 0);
  f.calls[1].resolve({ id: 'patient', visits: [], appointments: [] });
  await new Promise(setImmediate);
  assert.equal(checkbox.checked, true);
  assert.equal(changes, 1);
});
test('full read completion cannot replay a click after account or selected card changes', async (t) => {
  const f = fixture(t);
  await open(f);
  f.view.bindPatientViewEvents();
  let edits = 0;
  f.w.document.addEventListener('click', () => edits++);
  f.w.document.querySelector('#edit-patient').click();
  f.state.account = { ...f.state.account };
  f.calls[1].resolve({ id: 'patient', visits: [] });
  await new Promise(setImmediate);
  assert.equal(edits, 0);
});

test('whole-card action gives immediate progress, suppresses duplicate taps and cleans up', async (t) => {
  const f = fixture(t);
  await open(f);
  f.view.bindPatientViewEvents();
  const button = f.w.document.querySelector('#edit-patient');
  let edits = 0;
  f.w.document.addEventListener('click', () => edits++);
  button.click();
  button.click();
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.match(button.nextElementSibling.textContent, /Загружаем карточку/);
  assert.equal(f.fullReads(), 1);
  f.calls[1].resolve({ id: 'patient', appointments: [], visits: [] });
  await new Promise(setImmediate);
  assert.equal(edits, 1);
  assert.equal(button.disabled, false);
  assert.equal(button.hasAttribute('aria-busy'), false);
  assert.equal(f.w.document.querySelector('[role="status"]'), null);
});
test('departure during whole-card hydration prevents the original action from replaying', async (t) => {
  const f = fixture(t);
  await open(f);
  f.view.bindPatientViewEvents();
  let edits = 0;
  f.w.document.addEventListener('click', () => edits++);
  f.w.document.querySelector('#edit-patient').click();
  f.w.dispatchEvent(new f.w.Event('pagehide'));
  f.calls[1].resolve({ id: 'patient', appointments: [], visits: [] });
  await new Promise(setImmediate);
  assert.equal(edits, 0);
  assert.equal(f.w.document.querySelector('[aria-busy]'), null);
});

test('failed whole-card action restores its control and leaves the display out of editable data', async (t) => {
  const f = fixture(t);
  await open(f);
  f.view.bindPatientViewEvents();
  const button = f.w.document.querySelector('#edit-patient');
  button.click();
  f.calls[1].reject(Error('Нет связи'));
  await new Promise(setImmediate);
  assert.equal(button.disabled, false);
  assert.equal(button.hasAttribute('aria-busy'), false);
  assert.equal(f.w.document.querySelector('[role="status"]'), null);
  assert.deepEqual(f.state.data, []);
  assert.equal(f.messages[0], 'Нет связи');
  assert.ok(f.view.patientView());
});
test('revision conflict discards mixed pages, reloads only first view and does not edit', async (t) => {
  const f = fixture(t);
  await open(f);
  const next = f.view.loadPatientViewPage('history');
  const observed = assert.rejects(next, /changed/);
  f.calls[1].reject(Object.assign(Error('changed'), { status: 409 }));
  await new Promise(setImmediate);
  assert.equal(f.calls[2].url, '/api/cabinet/patient?id=patient&view=card');
  f.calls[2].resolve(page(8));
  await observed;
  assert.equal(f.view.patientView().revision, 8);
  assert.equal(f.view.patientView().history.entries.length, 1);
  assert.equal(f.fullReads(), 0);
  assert.equal(f.renders(), 1);
});
test('notification status reads use at most 50 loaded appointment IDs and never hydrate history', async (t) => {
  const f = fixture(t),
    reading = f.view.ensurePatientView('patient'),
    result = page();
  result.upcoming.entries = Array.from({ length: 97 }, (_, id) => ({ id: 'a' + id }));
  f.calls[0].resolve(result);
  await reading;
  const statuses = f.view.readPatientTelegramStatus('patient');
  const first = new URL(f.calls[1].url, 'https://synthetic.test');
  assert.equal(first.searchParams.get('revision'), '7');
  const firstIds = JSON.parse(first.searchParams.get('appointmentIds'));
  assert.equal(firstIds.length, 50);
  f.calls[1].resolve({
    revision: 7,
    linked: true,
    appointments: firstIds.map((id) => ({ appointmentId: id })),
    confirmations: [],
  });
  await new Promise(setImmediate);
  const secondIds = JSON.parse(
    new URL(f.calls[2].url, 'https://synthetic.test').searchParams.get('appointmentIds'),
  );
  assert.equal(secondIds.length, 47);
  f.calls[2].resolve({
    revision: 7,
    linked: true,
    appointments: secondIds.map((id) => ({ appointmentId: id })),
    confirmations: [],
  });
  assert.equal((await statuses).appointments.length, 97);
  assert.equal(f.fullReads(), 0);
  assert.deepEqual(f.state.data, []);
});
