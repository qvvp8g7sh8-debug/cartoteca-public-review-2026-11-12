const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function memory() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
function fixture(
  storage = memory(),
  account = { id: 'owner', organizationId: 'org', role: 'owner' },
) {
  const state = {
      account,
      data: [{ id: 'p', name: 'PRIVATE SYNTHETIC NAME', visits: [], appointments: [] }],
      services: [],
      revision: 1,
    },
    actions = { request: () => assert.fail('unexpected request') },
    context = vm.createContext({ structuredClone, sessionStorage: storage });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../src/client/core/cabinet-store.js'), 'utf8') +
      ';globalThis.factory=createCabinetStore;',
    context,
  );
  Object.assign(actions, context.factory(state, actions));
  actions.rememberCabinet({
    patients: state.data,
    services: [],
    partialWrites: true,
    idempotentWrites: true,
  });
  return { state, actions, storage };
}
async function lost(f) {
  let sent;
  f.state.data[0].notes = 'PRIVATE SYNTHETIC DRAFT';
  f.actions.request = async (url, options) => {
    sent = { url, options };
    assert.equal(f.storage.values.size, 1, 'the operation ID is retained before sending');
    throw Object.assign(Error('lost acknowledgement'), { outcomeUnknown: true });
  };
  await assert.rejects(f.actions.save());
  return sent;
}

test('reload retains only the same scoped ID and confirms a late commit without replaying a draft', async () => {
  const original = fixture(),
    sent = await lost(original),
    id = sent.options.headers['X-Cartoteca-Operation'],
    raw = [...original.storage.values.values()][0];
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['expires', 'operationId']);
  assert.doesNotMatch(raw, /PRIVATE|patients|notes|body/);
  const reloaded = fixture(original.storage),
    calls = [];
  assert.equal(reloaded.actions.cabinetSaveStatus(), 'check');
  reloaded.actions.request = async (url, options) => {
    calls.push(url);
    assert.equal(options, undefined);
    assert.equal(url, '/api/cabinet/operation?id=' + id + '&statusOnly=1');
    return { status: 'committed', revision: 2 };
  };
  const result = await reloaded.actions.recoverCabinetSave({ retry: true });
  assert.equal(result.status, 'saved');
  assert.equal(result.reload, true, 'the initialization read might precede this late commit');
  assert.equal(calls.length, 1);
  assert.equal(reloaded.actions.cabinetSaveStatus(), null);
  assert.equal(original.storage.values.size, 0);
});

test('an unknown restored ID stays for review and never manufactures a retry payload or a new ID', async () => {
  const original = fixture();
  await lost(original);
  const reloaded = fixture(original.storage);
  let reads = 0;
  reloaded.actions.request = async (url, options) => {
    assert.equal(options, undefined);
    assert.match(url, /statusOnly=1$/);
    reads++;
    return { status: 'unknown' };
  };
  assert.equal((await reloaded.actions.recoverCabinetSave({ retry: true })).status, 'review');
  assert.equal(reloaded.actions.cabinetSaveStatus(), 'review');
  await assert.rejects(reloaded.actions.save(), /Сначала/);
  assert.equal(reads, 1);
  const accepted = await reloaded.actions.recoverCabinetSave({ acceptCurrent: true });
  assert.equal(accepted.status, 'review');
  assert.equal(accepted.reload, true);
  assert.equal(original.storage.values.size, 0);
});

test('account, organization, role and late-response fences keep operation recovery isolated', async () => {
  const original = fixture();
  await lost(original);
  for (const account of [
    { ...original.state.account, id: 'other' },
    { ...original.state.account, organizationId: 'other' },
    { ...original.state.account, role: 'salon_admin' },
  ])
    assert.equal(fixture(original.storage, account).actions.cabinetSaveStatus(), null);
  const otherTab = fixture(memory());
  assert.equal(otherTab.actions.cabinetSaveStatus(), null);
  const reloaded = fixture(original.storage);
  let resolve;
  reloaded.actions.request = () => new Promise((done) => (resolve = done));
  const pending = reloaded.actions.recoverCabinetSave();
  reloaded.state.account = { id: 'other', organizationId: 'org', role: 'owner' };
  resolve({ status: 'committed', revision: 2 });
  assert.equal((await pending).status, 'none');
  assert.equal(original.storage.values.size, 1);
  assert.equal(reloaded.state.revision, 1);
});

test('a known commit stays sticky when replay is superseded and later data equals the old baseline', async () => {
  const f = fixture(),
    original = structuredClone(f.state.data[0]);
  await lost(f);
  f.actions.rollback();
  let statusReads = 0,
    writes = 0;
  f.actions.request = async (url, options) => {
    if (options) writes++;
    assert.equal(options, undefined);
    if (url.endsWith('&statusOnly=1'))
      return { status: ++statusReads === 1 ? 'committed' : 'unknown', revision: 2 };
    if (url.startsWith('/api/cabinet/operation'))
      throw Object.assign(Error('superseded replay'), { status: 409 });
    assert.equal(url, '/api/cabinet/patient?id=p');
    return { revision: 3, patients: [original] };
  };
  assert.equal((await f.actions.recoverCabinetSave()).status, 'review');
  assert.equal((await f.actions.recoverCabinetSave({ retry: true })).status, 'review');
  assert.equal(writes, 0);
  assert.equal(f.actions.cabinetSaveStatus(), 'review');
});

test('a late status conflict after an account switch cannot send the old retry in the new account', async () => {
  const f = fixture(),
    original = structuredClone(f.state.data[0]);
  await lost(f);
  f.actions.rollback();
  f.actions.request = async (url, options) => {
    assert.equal(options, undefined);
    return url.startsWith('/api/cabinet/operation')
      ? { status: 'unknown' }
      : { revision: 1, patients: [original] };
  };
  assert.equal((await f.actions.recoverCabinetSave()).status, 'retry');
  let reject;
  f.actions.request = (url, options) => {
    assert.equal(options, undefined, 'an old command must not be sent after scope changed');
    return new Promise((resolve, fail) => (reject = fail));
  };
  const pending = f.actions.recoverCabinetSave({ retry: true });
  f.state.account = { id: 'other', organizationId: 'other', role: 'owner' };
  reject(Object.assign(Error('late conflict'), { status: 409 }));
  assert.equal((await pending).status, 'none');
});

test('a definite rejection clears only its own pending ID and a damaged marker cannot replay', async () => {
  const f = fixture();
  f.state.data[0].notes = 'Draft';
  f.actions.request = async () => {
    throw Object.assign(Error('rejected'), { status: 400 });
  };
  await assert.rejects(f.actions.save(), { status: 400 });
  assert.equal(f.storage.values.size, 0);
  const key = 'cartoteca-cabinet-operation:' + JSON.stringify(['owner', 'org', 'owner']);
  f.storage.setItem(key, 'x'.repeat(513));
  const damaged = fixture(f.storage);
  assert.equal(damaged.actions.cabinetSaveStatus(), 'review');
  assert.equal((await damaged.actions.recoverCabinetSave({ retry: true })).status, 'review');
  const accepted = await damaged.actions.recoverCabinetSave({ acceptCurrent: true });
  assert.equal(accepted.reload, true);
  assert.equal(f.storage.values.size, 0);
});
