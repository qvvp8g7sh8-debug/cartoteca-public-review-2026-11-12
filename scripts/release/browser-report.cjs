const assert = require('node:assert/strict');

// Minimum appearance checkpoints per business scenario. Conditional extra states are
// allowed, but silently dropping an entire state/category/width cannot qualify a release.
const coverage = {
  main: {
    'public-privacy-and-consent': 3,
    'registration-consent-and-draft': 2,
    login: 2,
    'calendar-multiple-services': 2,
    'clients-search-and-profile': 1,
    'appointment-actions-and-confirmation': 2,
    'complete-visit-with-photo': 2,
    'walk-in-visit': 1,
    'services-and-category': 2,
    settings: 1,
    'staff-push-device-controls': 2,
    'workday-editor': 1,
    'telegram-invitation-layout-mocked': 1,
    'max-copy-status-inside-dialog-mocked': 4,
    'public-booking-real-backend': 3,
    'booking-request-actions': 3,
    'classic-booking-settings-and-real-backend': 4,
    'browser-errors-and-network': 0,
  },
  admin: {
    overview: 1,
    'organizations-and-controls': 2,
    'accounts-paging': 1,
    'support-note-and-state': 2,
    history: 1,
    'service-state': 1,
    'explicit-email-confirmation': 2,
    'runtime-errors': 0,
  },
};

function validateBrowserReport(results, { suite, engine, functionalWidth, layoutWidths }) {
  assert.ok(Array.isArray(results) && results.length, 'Missing browser results');
  const expected = coverage[suite];
  assert.ok(expected, 'Unknown browser suite');
  for (const row of results) {
    assert.equal(row.passed, true, 'Browser report contains failures');
    assert.equal(row.engine, engine, 'Wrong browser engine');
    assert.equal(row.flowWidth, functionalWidth, 'Wrong functional viewport');
    assert.ok(['functional', 'appearance'].includes(row.category), 'Missing browser category');
  }
  const functional = results.filter((row) => row.category === 'functional');
  assert.deepEqual(
    functional.map((row) => row.name).sort(),
    Object.keys(expected).sort(),
    'Incomplete functional coverage',
  );
  for (const row of functional) assert.equal(row.width, functionalWidth);
  const checkpoints = new Map();
  for (const row of results.filter((item) => item.category === 'appearance')) {
    const scenario = row.name.split('/')[0];
    assert.ok(Object.hasOwn(expected, scenario), 'Unknown appearance scenario');
    if (!checkpoints.has(row.name)) checkpoints.set(row.name, []);
    checkpoints.get(row.name).push(row.width);
  }
  for (const [name, actual] of checkpoints)
    assert.deepEqual(
      actual.sort((a, b) => a - b),
      [...layoutWidths].sort((a, b) => a - b),
      'Incomplete appearance widths: ' + name,
    );
  for (const [name, minimum] of Object.entries(expected)) {
    const count = [...checkpoints.keys()].filter((key) => key.startsWith(name + '/')).length;
    const required = suite === 'main' && name === 'login' && functionalWidth < 700 ? 3 : minimum;
    assert.ok(count >= required, 'Missing appearance checkpoints: ' + name);
  }
}

module.exports = { coverage, validateBrowserReport };
