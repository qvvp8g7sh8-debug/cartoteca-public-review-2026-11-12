const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  { JSDOM } = require('jsdom');
function fixture(t, width) {
  const w = new JSDOM('<div id="detail"></div><div id="patient-print"></div>', {
    runScripts: 'outside-only',
    url: 'http://synthetic.test',
  }).window;
  t.after(() => w.close());
  const state = {
    account: { id: 'owner', organizationId: 'org' },
    currentView: 'card',
    activeTab: 'visits',
    mobileScreen: { matches: width < 700 },
    printGeneration: 0,
    workspace: { members: [] },
    SERVICE_CATEGORIES: [],
  };
  let p = {
    id: 'p',
    name: 'Synthetic',
    visits: Array.from({ length: 12 }, (_, i) => ({
      id: 'v' + i,
      date: '2026-10-01',
      time: String(i).padStart(2, '0') + ':00',
      procedure: 'Synthetic ' + i,
      photos: [{ data: '/api/photos/' + String(i).padStart(32, '0') }],
    })),
  };
  const actions = {
    $: (s) => w.document.querySelector(s),
    patient: () => p,
    esc: (v) =>
      String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    formatDate: (d) => d,
    formatMinutes: (n) => n + ' мин.',
    plural: () => 'записей',
    canEditPatient: () => true,
    canEditRecord: () => true,
    patientAppointmentsHtml: () => '',
    videoConsentHtml: () => '',
    roomName: () => '',
  };
  actions.viewPatient = actions.patient;
  actions.patientView = () => null;
  for (const [file, factory] of [
    ['photos', 'createPhotos'],
    ['printing', 'createPrinting'],
    ['patient-mark', 'createPatientMark'],
    ['card', 'createCard'],
  ]) {
    w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules/' + file + '.js'), 'utf8'));
    Object.assign(actions, w[factory](state, actions));
  }
  return {
    w,
    state,
    actions,
    $: actions.$,
    get p() {
      return p;
    },
    set p(value) {
      p = value;
    },
    rows: () => [...w.document.querySelectorAll('#visit-history-list .visit')],
  };
}
for (const width of [390, 1440])
  test(
    'latest five visits, incremental rendering, full print and scoped reset at ' + width,
    (t) => {
      const h = fixture(t, width);
      h.actions.renderDetail();
      assert.equal(h.rows().length, 5);
      assert.equal(h.$('#more-visits').textContent, 'Показать ещё 5');
      assert.deepEqual(
        h.rows().map((n) => n.querySelector('.visit-brief').textContent),
        ['Synthetic 11', 'Synthetic 10', 'Synthetic 9', 'Synthetic 8', 'Synthetic 7'],
      );
      assert.equal(h.$('#visit-history-list').querySelectorAll('img').length, 5);
      assert.equal(h.$('#patient-print').querySelectorAll('.print-visit').length, 12);
      const first = h.rows()[0];
      first.open = true;
      h.actions.showMoreVisits();
      assert.equal(h.rows().length, 10);
      assert.equal(h.rows()[0], first);
      assert.equal(first.open, true);
      assert.equal(h.$('#more-visits').textContent, 'Показать ещё 2');
      h.actions.showMoreVisits();
      assert.equal(h.rows().length, 12);
      assert.equal(h.$('#more-visits'), null);
      assert.equal(h.p.visits.length, 12);
      h.actions.renderDetail();
      assert.equal(h.rows().length, 12);
      h.state.activeTab = 'photos';
      h.actions.renderDetail();
      assert.equal(h.$('#tab-content').querySelectorAll('img').length, 12);
      h.state.activeTab = 'visits';
      h.actions.renderDetail();
      assert.equal(h.rows().length, 12);
      h.p = { ...h.p, id: 'other' };
      h.actions.renderDetail();
      assert.equal(h.rows().length, 5);
      h.actions.showMoreVisits();
      h.state.account = { id: 'another', organizationId: 'another-org' };
      h.actions.renderDetail();
      assert.equal(h.rows().length, 5);
      h.p = null;
      h.actions.renderDetail();
      h.actions.showMoreVisits();
      assert.equal(h.$('#more-visits'), null);
    },
  );
test('short history has no paging control; adding a recent visit preserves latest-first order', (t) => {
  const h = fixture(t, 390);
  h.p.visits = h.p.visits.slice(0, 5);
  h.actions.renderDetail();
  assert.equal(h.rows().length, 5);
  assert.equal(h.$('#more-visits'), null);
  h.p.visits.push({ id: 'new', date: '2026-10-02', procedure: 'New', photos: [] });
  h.actions.renderDetail();
  assert.equal(h.rows().length, 5);
  assert.equal(h.rows()[0].querySelector('.visit-brief').textContent, 'New');
  assert.equal(h.$('#more-visits').textContent, 'Показать ещё 1');
});
