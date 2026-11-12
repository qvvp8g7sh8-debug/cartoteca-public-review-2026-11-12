const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  intentNames,
  commandFields,
} = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
const { commandCategory } = require('../src/server/modules/assistant/interpretation/intent-schema.cjs');
const {
  capabilityRegistry,
  capabilityDefinition,
  unsupportedBranches,
} = require('../src/server/modules/assistant/interpretation/capability-registry.cjs');
test('registry describes exactly the current9 intents and real callable bindings without adding permissions or actions', () => {
  const registry = capabilityRegistry();
  assert.deepEqual(
    registry.map((item) => item.id),
    intentNames,
  );
  for (const item of registry) {
    assert.deepEqual(item.modelFields, commandFields[item.id]);
    assert.equal(item.policyCategory, commandCategory(item.id));
    assert.deepEqual(item.roles, ['owner', 'salon_admin', 'cosmetologist']);
    assert.equal(item.authorization, 'server_policy_and_current_scope');
    for (const binding of item.bindings) {
      assert.equal(
        typeof require(path.join(__dirname, '../src/server/modules/assistant', binding.module))[
          binding.exported
        ],
        'function',
        item.id + '/' + binding.module + '/' + binding.exported,
      );
    }
  }
  assert.deepEqual(
    registry
      .filter((item) => item.execution === 'conditional_server_execution')
      .map((item) => item.id),
    ['prepareAppointment', 'moveAppointment', 'cancelAppointment'],
  );
  assert.equal(capabilityDefinition('cancelAppointment').gates.cancellationConsent, true);
  assert.deepEqual(capabilityDefinition('moveAppointment').gates.outsideHoursConsentRoles, [
    'owner',
    'salon_admin',
  ]);
  assert.equal(capabilityDefinition('editAppointment').execution, 'manual_form');
  assert.equal(capabilityDefinition('create_client'), null);
  assert.ok(unsupportedBranches.includes('create_client'));
});
test('registry results cannot mutate contract fields, role gates or subsequent callers', () => {
  const item = capabilityDefinition('prepareAppointment');
  item.modelFields.push('patientId');
  item.roles.push('global_admin');
  item.gates.savingEnabled = false;
  const fresh = capabilityDefinition('prepareAppointment');
  assert.equal(fresh.modelFields.includes('patientId'), false);
  assert.equal(fresh.roles.includes('global_admin'), false);
  assert.equal(fresh.gates.savingEnabled, true);
});
