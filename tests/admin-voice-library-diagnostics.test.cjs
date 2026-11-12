const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, route, clone } = require('./helpers/voice-behavior-library.cjs');
function fixture(t, assessment) {
  return boot(t, async (url, _options, _data, catalog) => {
    if (!url.startsWith(route + '/library?')) return undefined;
    return clone({
      schemaVersion: 1,
      total: 1,
      offset: 0,
      limit: 20,
      categories: [],
      statuses: [],
      packs: [],
      coverage: {
        schemaVersion: 1,
        totalCases: 303,
        needsReview: 4,
        capabilities: [
          {
            id: 'prepareAppointment',
            title: 'Новая запись',
            caseCounts: { action: 12, clarification: 3, boundary: 2, archive: 1 },
          },
        ],
      },
      cases: [{ ...catalog[0], assessment }],
    });
  });
}
test('diagnostic view distinguishes expected missing data from a verified context defect without extra fetches', async (t) => {
  const f = fixture(t, {
    family: 'clarification',
    support: 'available',
    disposition: 'expected_clarification',
    gaps: [{ code: 'input_missing', label: 'Нужно уточнить данные команды' }],
    nextStep: 'Уточнить только время.',
  });
  await f.api.load();
  assert.equal(f.calls.length, 1);
  await f.open();
  assert.equal(f.calls.length, 2);
  const text = f.$('[data-library-cases]').textContent;
  assert.match(text, /Штатное уточнение недостающих данных/u);
  assert.match(text, /Уточнить только время/u);
  assert.doesNotMatch(text, /Расхождение подтверждено/u);
  assert.equal(f.$('[data-library-coverage] table').rows.length, 2);
  assert.match(f.$('[data-library-coverage]').textContent, /Сценариев: 303/u);
  assert.ok(f.calls.every((call) => !call.options.method));
});
test('archived, unsupported, unreviewed and continuation cases cannot enter working examples through the UI', async (t) => {
  for (const assessment of [
    { family: 'archive', support: 'available' },
    { family: 'boundary', support: 'not_implemented' },
    { family: 'action', support: 'needs_review' },
    { family: 'clarification', support: 'available', selectionRole: 'continuation' },
  ]) {
    await t.test(JSON.stringify(assessment), async (child) => {
      const f = fixture(child, assessment);
      await f.api.load();
      await f.open();
      assert.equal(f.$('[data-library-import]'), null);
      assert.ok(f.calls.every((call) => !call.url.endsWith('/approve')));
    });
  }
});
test('diagnostic labels and next steps render as escaped text', async (t) => {
  const f = fixture(t, {
    family: 'action',
    support: 'needs_review',
    disposition: 'review_required',
    gaps: [{ label: '<img src=x onerror=alert(1)>' }],
    nextStep: '<script>private()</script>',
  });
  await f.api.load();
  await f.open();
  assert.equal(f.$('[data-library-cases] img'), null);
  assert.equal(f.$('[data-library-cases] script'), null);
  assert.match(f.$('[data-library-cases]').textContent, /Причина пока не установлена/u);
});
