const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const photo = '/api/photos/' + 'a'.repeat(32);
const dataPreview = 'data:image/png;base64,c3ludGhldGlj';
const blobPreview = 'blob:http://photo-context.test/synthetic-preview';
function fixture(t) {
  const w = new JSDOM(
    '<div id="upload-list"></div><div id="tab-content"></div>' +
      '<section id="patient-print"></section><img id="large-photo">' +
      '<p id="photo-caption"></p><dialog id="photo-view"></dialog>',
    { url: 'http://photo-context.test/', runScripts: 'outside-only' },
  ).window;
  t.after(() => w.close());
  const state = {
    multiUser: true,
    account: { id: 'account-A', organizationId: 'organization-A' },
    busy: false,
    editorMode: { kind: 'visit', patientId: 'patient-A' },
    uploadItems: [{ data: photo, caption: 'Before' }],
    activeTab: 'photos',
    currentView: 'card',
    workspace: { members: [] },
    SERVICE_CATEGORIES: [],
  };
  const patient = {
    id: 'patient-A',
    name: 'Synthetic person',
    appointments: [],
    visits: [
      {
        id: 'visit-A',
        date: '2099-01-06',
        procedure: 'Synthetic visit',
        photos: [{ data: photo, caption: 'Before' }],
      },
    ],
  };
  const actions = {
    $: (selector) => w.document.querySelector(selector),
    esc: (value) =>
      String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    patient: () => patient,
    viewPatient: () => patient,
    patientView: () => null,
    formatDate: (value) => value,
    formatMinutes: (value) => value + ' min',
    plural: () => 'photos',
    canDelete: () => true,
    canEditRecord: () => true,
    roomName: () => '',
  };
  for (const [module, factory] of [
    ['photos', 'createPhotos'],
    ['printing', 'createPrinting'],
    ['card', 'createCard'],
  ]) {
    w.eval(
      fs.readFileSync(path.join(__dirname, '../src/client/modules/' + module + '.js'), 'utf8'),
    );
    Object.assign(actions, w[factory](state, actions));
  }
  let shown = 0;
  actions.$('#photo-view').showModal = () => {
    shown++;
  };
  return { w, state, patient, actions, $: actions.$, shown: () => shown };
}

test('protected photo rendering fixes the account and organization in its URL without changing saved data', (t) => {
  const h = fixture(t),
    { actions, state } = h;
  const before = JSON.stringify({ patient: h.patient, uploads: state.uploadItems });
  const expected = photo + '?accountContext=account-A&organizationContext=organization-A';
  actions.renderUploads();
  actions.renderTab(h.patient, h.patient.visits);
  actions.buildPrintCard(h.patient);
  const upload = h.$('#upload-list [data-photo]');
  const card = h.$('#tab-content [data-photo]');
  const printed = h.$('#patient-print img');
  for (const button of [upload, card]) {
    assert.equal(button.dataset.photo, expected);
    assert.equal(button.querySelector('img').getAttribute('src'), expected);
  }
  assert.equal(printed.getAttribute('src'), expected);
  const visit = h.w.document.createElement('div');
  visit.innerHTML = actions.visitHtml(h.patient.visits[0]);
  assert.equal(visit.querySelector('[data-photo]').dataset.photo, expected);
  assert.equal(visit.querySelector('img').getAttribute('src'), expected);

  state.account = { id: 'account-B', organizationId: 'organization-B' };
  actions.showPhoto(upload);
  assert.equal(h.$('#large-photo').getAttribute('src'), expected);
  actions.showPhoto(card);
  assert.equal(h.$('#large-photo').getAttribute('src'), expected);
  assert.equal(printed.getAttribute('src'), expected);
  assert.equal(actions.photoSource(expected), expected);
  assert.equal(
    actions.photoSource(photo),
    photo + '?accountContext=account-B&organizationContext=organization-B',
  );
  assert.equal(JSON.stringify({ patient: h.patient, uploads: state.uploadItems }), before);
});

test('render-only photo context is encoded and a missing multi-user scope cannot load protected bytes', (t) => {
  const h = fixture(t),
    { actions, state } = h;
  state.account = { id: 'account & A', organizationId: 'organization/A?' };
  const scoped = new URL(actions.photoSource(photo), h.w.location.href);
  assert.equal(scoped.searchParams.get('accountContext'), 'account & A');
  assert.equal(scoped.searchParams.get('organizationContext'), 'organization/A?');
  assert.equal([...scoped.searchParams].length, 2);
  for (const account of [
    null,
    {},
    { id: 'account-A', organizationId: null },
    { id: '', organizationId: 'organization-A' },
  ]) {
    state.account = account;
    assert.equal(actions.photoSource(photo), '');
    actions.renderUploads();
    actions.renderTab(h.patient, h.patient.visits);
    actions.buildPrintCard(h.patient);
    for (const root of ['#upload-list', '#tab-content', '#patient-print'])
      assert.equal(h.$(root).querySelector('img').getAttribute('src'), null);
    const before = h.shown();
    actions.showPhoto(h.$('#upload-list [data-photo]'));
    assert.equal(h.shown(), before);
    assert.equal(h.patient.visits[0].photos[0].data, photo);
    assert.equal(state.uploadItems[0].data, photo);
  }
});

test('legacy protected paths and local data or blob previews keep their original representation', (t) => {
  const h = fixture(t),
    { actions, state } = h;
  state.multiUser = false;
  state.account = null;
  assert.equal(actions.photoSource(photo), photo);
  actions.renderUploads();
  actions.renderTab(h.patient, h.patient.visits);
  actions.buildPrintCard(h.patient);
  for (const root of ['#upload-list', '#tab-content', '#patient-print'])
    assert.equal(h.$(root).querySelector('img').getAttribute('src'), photo);
  state.multiUser = true;
  state.uploadItems = [{ data: dataPreview }, { data: blobPreview }];
  actions.renderUploads();
  assert.deepEqual(
    [...h.$('#upload-list').querySelectorAll('[data-photo]')].map((button) => [
      button.dataset.photo,
      button.querySelector('img').getAttribute('src'),
    ]),
    [
      [dataPreview, dataPreview],
      [blobPreview, blobPreview],
    ],
  );
  assert.equal(actions.photoSource(dataPreview), dataPreview);
  assert.equal(actions.photoSource(blobPreview), blobPreview);
  assert.deepEqual(state.uploadItems, [{ data: dataPreview }, { data: blobPreview }]);
  h.patient.visits[0].photos = [{ data: 'https://external.test/track' }];
  actions.buildPrintCard(h.patient);
  assert.equal(h.$('#patient-print img').getAttribute('src'), null);
});
