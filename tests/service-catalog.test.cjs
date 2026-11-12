const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createServiceCatalog, catalogProviders, assertRecordServices } =
  require('../src/server/modules/services/catalog.cjs');
const ownerId = 'owner';
const members = [
  { accountId: ownerId, role: 'owner', status: 'active', displayName: 'Owner' },
  { accountId: 'staff', role: 'cosmetologist', status: 'active', displayName: 'Staff' },
];
const services = [
  { id: 'legacy', name: 'Same name', duration: '30 минут', price: 100 },
  { id: 'personal', staffId: 'staff', name: 'Same name', duration: '60 минут', price: 200 },
];
const snapshot = (id) => ({ id, name: 'Saved name', price: 50, duration: 30 });
const patient = (record, kind = 'appointments') => ({ id: 'p', appointments: [], visits: [], [kind]: [record] });
const empty = () => ({ patients: [], services: [] });
function policy() {
  return createServiceCatalog({ workspaceIdentities: () => members });
}
const storage = { readSelected: (patients, ids) => ({ services: services.filter((service) => ids.includes(service.id)) }) };

test('legacy catalog belongs to owner, even when only the hired employee accepts online', () => {
  assert.deepEqual(policy().serviceCatalog('o'), { ownerId });
  assert.deepEqual(catalogProviders(members, services, ['legacy'], ownerId).map((member) => member.accountId), [ownerId]);
  assert.deepEqual(catalogProviders([members[1]], services, ['legacy'], ownerId), []);
  assert.deepEqual(catalogProviders([members[1]], services, ['personal'], ownerId).map((member) => member.accountId), ['staff']);
  assert.equal(services[0].staffId, undefined);
});
test('one booking cannot mix catalogs or refer to a missing service', () => {
  assert.deepEqual(catalogProviders(members, services, ['legacy', 'personal'], ownerId), []);
  assert.deepEqual(catalogProviders(members, services, ['missing'], ownerId), []);
});
test('service creation requires organization member and stored ownership cannot be reassigned', () => {
  const catalog = policy();
  catalog.assertServiceCatalog('o', empty(), { patients: [], services: [services[1]] }, storage);
  assert.throws(() => catalog.assertServiceCatalog('o', empty(), { patients: [], services: [{ ...services[1], staffId: 'foreign' }] }, storage), { status: 400 });
  assert.throws(() => catalog.assertServiceCatalog('o', { patients: [], services: [services[0]] }, { patients: [], services: [{ ...services[0], staffId: 'staff' }] }, storage), { status: 400 });
});
test('partial patient write resolves service ownership from storage and rejects foreign catalog', () => {
  const record = { id: 'a', staffId: 'staff', serviceItems: [snapshot('legacy')] };
  assert.throws(() => policy().assertServiceCatalog('o', empty(), { services: [], patients: [patient(record)] }, storage), { status: 400 });
  record.serviceItems = [snapshot('personal')];
  policy().assertServiceCatalog('o', empty(), { services: [], patients: [patient(record)] }, storage);
});
test('unchanged old snapshots survive edits, deleted services and completion into a linked visit', () => {
  const record = { id: 'a', staffId: 'staff', serviceItems: [snapshot('legacy')] };
  const before = { services: [], patients: [patient(record)] };
  const next = structuredClone(before);
  next.patients[0].appointments[0].notes = 'Unrelated change';
  assertRecordServices(before, next, [], ownerId);
  next.patients[0].visits.push({ id: 'v', appointmentId: 'a', staffId: 'staff', serviceItems: structuredClone(record.serviceItems) });
  assertRecordServices(before, next, [], ownerId);
  next.patients[0].appointments[0].staffId = ownerId;
  assert.throws(() => assertRecordServices(before, next, [], ownerId), { status: 400 });
});
test('changed historical snapshot must belong to chosen employee', () => {
  const before = { services: [], patients: [patient({ id: 'a', staffId: 'staff', serviceItems: [snapshot('legacy')] })] };
  const next = structuredClone(before);
  next.patients[0].appointments[0].serviceItems[0].price = 60;
  assert.throws(() => assertRecordServices(before, next, services, ownerId), { status: 400 });
});

function client() {
  const state = { multiUser: true, account: { id: ownerId, role: 'owner', organizationId: 'o', displayName: 'Owner' },
    serviceCatalogOwnerId: ownerId, teamAccess: { members: members.slice(0, 1) }, services: structuredClone(services), SERVICE_CATEGORIES: [{ id: 'other', title: 'Other' }] };
  const actions = { accountId: () => state.account.id, canManageTeam: () => state.account.role !== 'cosmetologist',
    canEditServices: () => true, $: () => null, esc: String };
  const context = vm.createContext({ structuredClone, Set, Object, JSON, Number, Intl, String });
  for (const [file, factory] of [['service-catalog', 'createServiceCatalog'], ['services', 'createServices']]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/client/modules/' + file + '.js'), 'utf8') + ';globalThis.factory=' + factory, context);
    Object.assign(actions, context.factory(state, actions));
  }
  return { state, actions };
}
test('selector hidden for sole owner activates after staff added; changing staff clears selected services', () => {
  const { state, actions } = client();
  assert.ok(!actions.serviceStaffHtml().includes('<select'));
  actions.toggleServiceSelection('legacy');
  assert.equal(actions.selectedServices().length, 1);
  state.teamAccess.members.push(members[1]);
  assert.ok(actions.serviceStaffHtml().includes('id="service-catalog-staff"'));
  actions.configureServiceView({ staffId: 'staff' });
  assert.equal(actions.selectedServices().length, 0);
  assert.equal(actions.servicesForStaff()[0].id, 'personal');
  actions.toggleServiceSelection('legacy');
  assert.equal(actions.selectedServices().length, 0);
  actions.toggleServiceSelection('personal');
  assert.equal(actions.selectedServices()[0].price, 200);
});
test('employee sees own catalog; organization change resets owner fallback and selection', () => {
  const { state, actions } = client();
  state.account.role = 'cosmetologist'; state.account.id = 'staff';
  assert.equal(actions.servicesForStaff()[0].id, 'personal');
  assert.ok(!actions.serviceStaffHtml().includes('<select'));
  actions.toggleServiceSelection('personal');
  state.account = { id: 'second-owner', role: 'owner', organizationId: 'second' };
  state.serviceCatalogOwnerId = 'second-owner';
  state.teamAccess = { members: [{ accountId: 'second-owner', role: 'owner', status: 'active' }] };
  assert.equal(actions.selectedServices().length, 0);
  assert.equal(actions.servicesForStaff()[0].id, 'legacy');
});

test('administrative access is not a service provider or a selectable personal catalog', () => {
  const admin = { accountId: 'admin', role: 'salon_admin', status: 'active', displayName: 'Administrative only' };
  const { state, actions } = client();
  state.teamAccess.members.push(admin);
  assert.ok(!actions.serviceStaffHtml().includes('<select'));
  state.teamAccess.members.push(members[1]);
  assert.ok(actions.serviceStaffHtml().includes('<select'));
  assert.ok(!actions.serviceStaffHtml().includes('Administrative only'));
  actions.selectServiceStaff(admin.accountId);
  assert.equal(actions.serviceStaffId(), ownerId);
  const catalog = createServiceCatalog({ workspaceIdentities: () => [...members, admin] });
  const old = { ...services[1], id: 'admin-old', staffId: admin.accountId };
  assert.throws(() => catalog.assertServiceCatalog('o', empty(), { patients: [], services: [old] }, storage), { status: 400 });
  catalog.assertServiceCatalog('o', { patients: [], services: [old] }, { patients: [], services: [old] }, storage);
});
