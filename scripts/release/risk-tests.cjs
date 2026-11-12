// These cross-layer guarantees cannot be inferred reliably from static imports.
// The preliminary time budget must not defer them when shared save code changes.
const saveSources = [
  /^src\/server\/infrastructure\/(?:async-write-lock|platform-write-fence|mutation-receipts|cabinet-prepared-write|platform-database)\.cjs$/,
  /^src\/server\/modules\/cabinet\/(?:mutations|shared-mutation|mutation-write|mutation-policy|appointment-commands)\.cjs$/,
  /^src\/server\/modules\/access\/cabinet-policy\.cjs$/,
  /^src\/client\/core\/(?:cabinet-store|editor)\.js$/,
  /^src\/client\/modules\/(?:save-recovery|appointment-save|patient-save|visit-save|service-save)\.js$/,
];
const saveTests = [
  'async-write-lock',
  'platform-write-fence',
  'shared-mutation-effects',
  'cabinet-preparation-policy',
  'mutation-receipts',
  'cabinet-store',
  'async-workflows',
  'appointment-outcomes',
];

function timePickerChanged(changed) {
  return changed.some((name) =>
    /^(?:src\/client\/modules\/(?:time-picker(?:-[\w-]+)?|appointments)\.js|src\/client\/styles\/time-picker\.css)$/.test(
      name,
    ),
  );
}

function riskTests(changed, available) {
  const selected = new Map();
  const add = (name, sources, reason = 'required-save-risk') => {
    const file = 'tests/' + name + '.test.cjs';
    if (available.includes(file))
      selected.set(file, [reason, ...sources.map((source) => 'risk-source:' + source)]);
  };
  const save = changed.filter((name) => saveSources.some((pattern) => pattern.test(name)));
  if (save.length) for (const name of saveTests) add(name, save);
  const classic = changed.filter((name) =>
    /^src\/server\/modules\/booking\/(?:classic|classic-receipts|public-service|request-input)\.cjs$/.test(
      name,
    ),
  );
  // Public classic booking also uses the common mutation and receipt boundary.
  if (classic.length || save.some((name) => name.startsWith('src/server/')))
    add('classic-booking-recovery', [
      ...save.filter((name) => name.startsWith('src/server/')),
      ...classic,
    ]);
  // These fixtures load factory names dynamically, so literal-path discovery is insufficient.
  if (timePickerChanged(changed))
    for (const name of ['appointment-time-picker', 'time-picker-controls'])
      add(
        name,
        changed.filter((source) => timePickerChanged([source])),
        'required-time-picker',
      );
  return selected;
}

module.exports = { riskTests, timePickerChanged };
