const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { JSDOM } = require('jsdom');
const { validateState } = require('../src/server/modules/cabinet/validation.cjs');
const {
  authorizeCabinetChange,
  cabinetForUser,
} = require('../src/server/modules/access/cabinet-policy.cjs');
const { createStorage } = require('../storage.cjs');
const patient = (extra = {}) => ({
  id: 'synthetic-client',
  name: 'Пример клиента',
  createdBy: 'staff',
  visits: [],
  appointments: [],
  ...extra,
});
const cabinet = (p) => ({ revision: 0, patients: [p], services: [] });

test('client marks are optional and bounded, with no orphaned explanations', () => {
  assert.doesNotThrow(() => validateState(cabinet(patient())));
  for (const clientMark of ['none', 'star', 'attention', 'flag'])
    assert.doesNotThrow(() =>
      validateState(
        cabinet(
          patient({ clientMark, clientMarkNote: clientMark === 'none' ? '' : 'x'.repeat(200) }),
        ),
      ),
    );
  for (const extra of [
    { clientMark: 'vip' },
    { clientMark: null },
    { clientMark: [] },
    { clientMark: 'star', clientMarkNote: 'x'.repeat(201) },
    { clientMarkNote: 'Без значка' },
    { clientMark: 'none', clientMarkNote: 'Скрытое пояснение' },
    { clientMark: 'flag', clientMarkNote: 3 },
  ])
    assert.throws(
      () => validateState(cabinet(patient(extra))),
      (error) => error.status === 400,
    );
});

test('mark permissions match card editing and do not expose inaccessible clients', () => {
  const before = cabinet(patient()),
    next = cabinet(patient({ clientMark: 'flag', clientMarkNote: 'Связаться сообщением' }));
  for (const role of ['owner', 'salon_admin'])
    assert.doesNotThrow(() => authorizeCabinetChange({ role, accountId: 'staff' }, before, next));
  for (const role of ['cosmetologist', 'global_admin'])
    assert.throws(
      () => authorizeCabinetChange({ role, accountId: 'staff' }, before, next),
      (error) => error.status === 403,
    );
  assert.throws(
    () =>
      authorizeCabinetChange(
        { role: 'cosmetologist', accountId: 'staff' },
        { revision: 0, patients: [], services: [] },
        next,
      ),
    (error) => error.status === 403,
  );
  const current = { role: 'cosmetologist', accountId: 'staff' };
  assert.equal(
    cabinetForUser(current, cabinet(patient({ createdBy: 'other', clientMark: 'star' }))).patients
      .length,
    0,
  );
  assert.equal(cabinetForUser(current, next).patients[0].clientMark, 'flag');
});

test('encrypted card persistence retains marks without migrating existing records', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-patient-mark-'));
  let storage = createStorage(dir);
  t.after(() => {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const value = cabinet(patient({ clientMark: 'star', clientMarkNote: 'Только сообщения' }));
  storage.write(value);
  storage.close();
  storage = createStorage(dir);
  assert.deepEqual(storage.read().patients[0], value.patients[0]);
});

function fixture(t, editable = true) {
  const w = new JSDOM(
    '<main id="detail"></main><dialog id="editor"><h2 id="dialog-title"></h2><form id="editor-form"><div id="form-content"></div><p id="form-error"></p><button id="save-editor" type="submit">Сохранить</button></form></dialog>',
    { runScripts: 'outside-only' },
  ).window;
  t.after(() => w.close());
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  for (const file of ['src/client/core/editor.js', 'src/client/modules/patient-mark.js'])
    w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
  const state = {
    account: { id: 'owner', organizationId: 'org-a' },
    selectedId: 'synthetic-client',
    data: [patient()],
    uploadItems: [],
    editorMode: null,
    busy: false,
    multiUser: true,
  };
  let failSave = false,
    saves = 0,
    baseline = structuredClone(state.data);
  const actions = {
    $: (selector) => w.document.querySelector(selector),
    patient: () => state.data.find((p) => p.id === state.selectedId),
    canEditPatient: () => editable,
    esc: (text) =>
      String(text).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      ),
    toast() {},
    cancelPhotoProcessing() {},
    mountServiceGroupControl() {},
    renderSaveRecovery() {},
    photosPending: () => false,
    cabinetSaveStatus: () => null,
    confirmAction: async () => true,
    updatePhotoSaveButton: () => {
      actions.$('#save-editor').disabled = state.busy;
    },
    rollback: () => {
      state.data = structuredClone(baseline);
    },
    save: async () => {
      if (failSave) throw Error('Синтетическая ошибка сохранения');
      saves++;
      baseline = structuredClone(state.data);
    },
    renderDetail: () => {
      actions.$('#detail').innerHTML =
        '<header class="patient-header"><h2>Пример клиента' +
        actions.patientMarkHtml(actions.patient()) +
        '</h2></header>';
    },
  };
  Object.assign(
    actions,
    w.eval('createEditor')(state, actions),
    w.eval('createPatientMark')(state, actions),
  );
  actions.bindPatientMarkEvents();
  actions.renderDetail();
  return {
    w,
    state,
    actions,
    fail: () => {
      failSave = true;
    },
    saves: () => saves,
    submit: () => actions.submit({ preventDefault() {}, target: actions.$('#editor-form') }),
  };
}

test('circle has no visible caption; choose/save/clear are explicit and note is escaped', async (t) => {
  const f = fixture(t),
    $ = f.actions.$;
  assert.equal($('[data-patient-mark]').textContent, '');
  assert.equal($('.patient-header h2').textContent, 'Пример клиента');
  $('[data-patient-mark]').click();
  assert.equal($('[name="clientMarkNote"]').disabled, true);
  $('[name="clientMark"][value="flag"]').click();
  $('[name="clientMarkNote"]').value = '<img src=x onerror=alert(1)> Только сообщения';
  assert.equal(f.saves(), 0);
  await f.submit();
  assert.equal(f.actions.patient().clientMark, 'flag');
  assert.equal(f.saves(), 1);
  assert.equal($('.patient-header img'), null);
  $('[data-patient-mark]').click();
  assert.equal($('#form-content img'), null);
  $('[name="clientMark"][value="none"]').click();
  await f.submit();
  assert.equal(f.actions.patient().clientMark, 'none');
  assert.equal(f.actions.patient().clientMarkNote, '');
});

test('employee sees explanation read-only; failure rolls back and preserves editable draft', async (t) => {
  const view = fixture(t, false);
  view.actions.$('[data-patient-mark]').click();
  assert.equal(view.state.editorMode.kind, 'patientMarkView');
  assert.equal(view.actions.$('#save-editor').hidden, true);
  assert.equal(view.actions.$('#form-content input'), null);
  await view.submit();
  assert.equal(view.saves(), 0);
  const f = fixture(t),
    $ = f.actions.$;
  $('[data-patient-mark]').click();
  $('[name="clientMark"][value="attention"]').click();
  $('[name="clientMarkNote"]').value = 'Сохранить черновик';
  f.fail();
  await f.submit();
  assert.equal(f.actions.patient().clientMark, undefined);
  assert.equal($('[name="clientMarkNote"]').value, 'Сохранить черновик');
  assert.equal($('#editor').open, true);
  assert.match($('#form-error').textContent, /ошибка сохранения/);
});

test('changing account or client cannot apply the mark to another card', async (t) => {
  const f = fixture(t),
    $ = f.actions.$;
  $('[data-patient-mark]').click();
  $('[name="clientMark"][value="star"]').click();
  f.state.account = { id: 'other', organizationId: 'org-b' };
  await f.submit();
  assert.equal(f.saves(), 0);
  assert.match($('#form-error').textContent, /доступ изменились/);
});
