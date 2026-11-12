const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assessmentForCase,
  libraryCoverage,
} = require('../src/server/modules/assistant/behavior/behavior-library-coverage.cjs');
const {
  loadCatalog,
  libraryView,
  createBehaviorLibrary,
} = require('../src/server/modules/assistant/behavior/behavior-library.cjs');
function row(intent = { intent: 'prepareAppointment' }, status = 'supported', extra = {}) {
  return {
    id: 'synthetic-case',
    category: 'appointment-fields',
    title: 'SYNTHETIC_PERSON',
    text: 'SYNTHETIC_PERSON PHONE_SENTINEL',
    referenceDate: '2026-10-18',
    referenceTime: '09:00',
    current: { intent, status, outcome: 'synthetic outcome' },
    ...extra,
  };
}
test('existing code capability, manual editing, unsupported boundaries and stale example contracts are different assessments', () => {
  assert.equal(assessmentForCase(row()).support, 'available');
  const manual = assessmentForCase(row({ intent: 'editAppointment' }, 'manual'));
  assert.equal(manual.support, 'manual_only');
  assert.equal(manual.gaps.length, 0);
  const conditional = assessmentForCase(row({ intent: 'prepareAppointment' }, 'manual'));
  assert.equal(
    conditional.support,
    'available',
    'historical default-off manual outcome does not remove a current implemented action',
  );
  assert.equal(conditional.execution, 'conditional_server_execution');
  assert.equal(conditional.requiresSavingFlag, true);
  assert.equal(conditional.gaps.length, 0);
  const boundary = assessmentForCase(row({ intent: 'help' }, 'unsupported'));
  assert.equal(boundary.support, 'needs_review');
  assert.equal(boundary.disposition, 'review_required');
  assert.equal(
    boundary.gaps[0].code,
    'evidence_missing',
    'unknown unsupported/help is not assumed to be an ACL boundary',
  );
  const stale = assessmentForCase(row({ intent: 'calendar', query: 'SYNTHETIC_PERSON' }));
  assert.equal(stale.family, 'archive');
  assert.equal(stale.gaps[0].code, 'example_contract_stale');
});
test('dialogue examples are marked as continuation while incomplete initial commands remain initial', () => {
  assert.equal(
    assessmentForCase(row({ intent: 'prepareAppointment' }, 'needs_clarification')).selectionRole,
    'initial',
  );
  assert.equal(
    assessmentForCase(
      row({ intent: 'prepareAppointment' }, 'needs_clarification', {
        preconditions: { activeDialogue: true },
      }),
    ).selectionRole,
    'continuation',
  );
  const missing = assessmentForCase(
    row({ intent: 'prepareAppointment' }, 'needs_clarification', {
      diagnostics: { capabilityId: 'prepareAppointment', fields: { missing: ['time'] } },
    }),
  );
  assert.equal(missing.disposition, 'expected_clarification');
  assert.equal(missing.support, 'available');
  const lost = assessmentForCase(
    row({ intent: 'prepareAppointment' }, 'needs_clarification', {
      diagnostics: {
        capabilityId: 'prepareAppointment',
        fields: { before: ['client', 'time'], after: ['client'] },
      },
    }),
  );
  assert.equal(lost.disposition, 'defect');
  assert.equal(lost.gaps[0].code, 'context_lost');
});

test('audited consent, archive, creation, payments and ACL cases keep distinct content-bound reasons', () => {
  const catalog = loadCatalog();
  const find = (id) => catalog.cases.find((item) => item.id === id);
  for (const id of [
    'card-create-new',
    'card-archive',
    'card-restore',
    'card-delete-consent',
    'card-payments',
  ]) {
    const result = assessmentForCase(find(id));
    assert.equal(result.support, 'not_implemented', id);
    assert.equal(result.capabilityId, null, id);
    assert.equal(result.gaps[0].code, 'function_absent', id);
  }
  for (const id of ['card-photo', 'card-history']) {
    const result = assessmentForCase(find(id));
    assert.equal(result.support, 'manual_only', id);
    assert.equal(result.capabilityId, 'clientCard', id);
    assert.equal(result.gaps[0].code, 'manual_interface_step', id);
  }
  for (const id of ['card-consents', 'card-merge-read']) {
    const result = assessmentForCase(find(id));
    assert.equal(result.family, 'archive', id);
    assert.equal(result.support, 'needs_review', id);
    assert.equal(result.gaps[0].code, 'example_contract_stale', id);
  }
  for (const id of [
    'safety-foreign-organization',
    'safety-admin-clinical',
    'safety-ignore-acl',
    'constraint-staff-acl',
  ]) {
    const result = assessmentForCase(find(id));
    assert.equal(result.support, 'policy_boundary', id);
    assert.equal(result.disposition, 'expected_boundary', id);
    assert.equal(result.gaps.length, 0, id);
  }
  const changed = { ...find('card-create-new'), text: 'A different unsupported request' };
  assert.equal(
    assessmentForCase(changed).support,
    'needs_review',
    'a retained ID never approves an unaudited changed phrase',
  );
  assert.equal(assessmentForCase(row({ intent: 'help' }, 'unsupported')).support, 'needs_review');
});
test('missing data does not invent a missing function; absent evidence or conflicting diagnostics require review', () => {
  const missingData = assessmentForCase(
    row({ intent: 'prepareAppointment' }, 'supported', {
      diagnostics: { capabilityId: 'prepareAppointment', data: { catalog: 'empty' } },
    }),
  );
  assert.equal(missingData.gaps[0].code, 'catalog_unavailable');
  assert.equal(missingData.support, 'needs_review');
  const missingFunction = assessmentForCase(
    row({ intent: 'help' }, 'unsupported', {
      diagnostics: { capabilityId: 'help', unsupportedBranch: 'create_client' },
    }),
  );
  assert.equal(missingFunction.support, 'not_implemented');
  assert.equal(missingFunction.gaps[0].kind, 'function');
  const unknown = assessmentForCase(
    row({ intent: 'calendar' }, 'supported', { diagnostics: { capabilityId: 'calendar' } }),
  );
  assert.equal(unknown.support, 'needs_review');
  const mismatch = assessmentForCase(
    row({ intent: 'calendar' }, 'supported', { diagnostics: { capabilityId: 'moveAppointment' } }),
  );
  assert.equal(mismatch.gaps[0].code, 'diagnostic_invalid');
});
test('library coverage is counts/enums/IDs only and annotates the real catalog without changing paging or phrases', () => {
  const catalog = loadCatalog(),
    view = libraryView(catalog, new URLSearchParams('limit=3'));
  assert.equal(view.cases.length, 3);
  assert.equal(view.coverage.totalCases, catalog.cases.length);
  assert.equal(view.coverage.capabilities.length, 9);
  assert.deepEqual(
    view.cases.map((item) => item.text),
    catalog.cases.slice(0, 3).map((item) => item.text),
  );
  view.cases.forEach((item) => assert.ok(item.assessment.selectionRole));
  const data = [
    row(),
    row({ intent: 'help' }, 'unsupported'),
    row({ intent: 'calendar', query: 'SYNTHETIC_PERSON' }),
  ];
  const summary = libraryCoverage(data);
  assert.equal(summary.totalCases, 3);
  assert.equal(summary.unassignedCases, 1);
  assert.equal(summary.gapCounts.example_contract_stale, 1);
  assert.doesNotMatch(
    JSON.stringify({ summary, assessment: assessmentForCase(data[0]) }),
    /SYNTHETIC_PERSON|PHONE_SENTINEL|synthetic outcome|rawText|apiKey/u,
  );
});
test('coverage remains behind the existing administrator gate and has no writes or provider calls', () => {
  let checks = 0;
  const locked = createBehaviorLibrary({
    assertAdmin() {
      checks++;
      throw Object.assign(new Error('denied'), { status: 403 });
    },
  });
  assert.throws(() => locked('not-admin', new URLSearchParams()), { status: 403 });
  assert.equal(checks, 1);
  const open = createBehaviorLibrary({
    assertAdmin(id) {
      assert.equal(id, 'synthetic-admin');
    },
  });
  assert.equal(
    open('synthetic-admin', new URLSearchParams('limit=1')).coverage.capabilities.length,
    9,
  );
});
