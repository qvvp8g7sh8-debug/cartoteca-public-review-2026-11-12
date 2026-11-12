// PREPARED WORK-ONLY. All requests are in-memory synthetic transport.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const helper = fs.existsSync(path.join(__dirname, 'helpers/passive-view-fixture.cjs'))
  ? './helpers/passive-view-fixture.cjs'
  : './passive-view-fixture.cjs';
const { fixture, deferred, response, patient } = require(helper);
const directoryRoute = '/api/cabinet/directory?';
function page(items, nextCursor = null) {
  return {
    directory: items,
    total: items.length,
    matched: items.length,
    counts: { all: items.length },
    nextCursor,
  };
}
function search(f, value) {
  f.$('#search').value = value;
  f.actions.renderList();
}
const queryOf = (call) => new URL(call.route, 'https://synthetic.test/').searchParams;

test('an already queued 160ms automatic search waits hidden and resumes the same key once without perpetual loading', async (t) => {
  const f = fixture(t, { view: 'clients', paged: true });
  f.seedDirectory([patient('old', 'Initial Client')]);
  f.catalog.directory = [patient('alpha', 'Alpha Client')];
  search(f, 'alpha');
  f.hidden(true);
  const paints = f.stats.listPaints;
  await f.advance(160);
  assert.equal(f.readCalls(directoryRoute).length, 0);
  assert.equal(f.stats.listPaints, paints);
  await f.resume();
  await f.advance(160);
  assert.equal(f.readCalls(directoryRoute).length, 1);
  assert.equal(queryOf(f.readCalls(directoryRoute)[0]).get('q'), 'alpha');
  assert.ok(f.$('[data-patient="alpha"]'));
  assert.doesNotMatch(f.$('#patient-list').textContent, /Загрузка клиентов/);
  f.focus();
  await f.flush();
  await f.advance(600);
  assert.equal(f.readCalls(directoryRoute).length, 1);
  f.assertNoMutation();
});

test('a passive 409 while hidden defers its sole retry; a second 409 remains a current error and does not auto-loop on resume', async (t) => {
  const f = fixture(t, { view: 'clients', paged: true });
  f.seedDirectory([patient('old', 'Initial Client')]);
  const first = deferred();
  let attempts = 0;
  f.handle(directoryRoute, () => {
    attempts++;
    return attempts === 1
      ? first.promise
      : response({ error: 'Synthetic second cursor conflict' }, 409);
  });
  search(f, 'alpha');
  await f.advance(160);
  assert.equal(attempts, 1);
  f.hidden(true);
  first.resolve(response({ error: 'Synthetic first cursor conflict' }, 409));
  await f.flush();
  assert.equal(attempts, 1, 'no automatic retry may start from a hidden passive completion');
  await f.resume();
  await f.advance(160);
  assert.equal(
    attempts,
    2,
    'the deferred retry resumes once even when key is unchanged and meta is empty',
  );
  assert.match(f.$('#patient-list').textContent, /Synthetic second cursor conflict/);
  assert.doesNotMatch(f.$('#patient-list').textContent, /Загрузка клиентов/);
  await f.advance(600);
  await f.resume();
  await f.advance(160);
  assert.equal(
    attempts,
    2,
    'terminal error retains explicit retry, not a resume-triggered retry loop',
  );
  f.assertNoMutation();
});

test('late successful list data is cached but not painted hidden; resume paints it without an extra directory request', async (t) => {
  const f = fixture(t, { view: 'clients', paged: true });
  f.seedDirectory([patient('old', 'Initial Client')]);
  const gate = deferred();
  f.handle(directoryRoute, () => gate.promise);
  search(f, 'new');
  await f.advance(160);
  assert.equal(f.readCalls(directoryRoute).length, 1);
  f.hidden(true);
  const paints = f.stats.listPaints;
  gate.resolve(page([patient('new', 'New Client')]));
  await f.flush();
  assert.equal(f.stats.listPaints, paints);
  await f.resume();
  await f.advance(160);
  assert.ok(f.$('[data-patient="new"]'));
  assert.equal(f.readCalls(directoryRoute).length, 1);
  f.assertNoMutation();
});

test('deferred automatic reads are replaced by current query/scope, including same account ID in a different organization', async (t) => {
  for (const change of ['query', 'account', 'organization']) {
    await t.test(change, async (t) => {
      const f = fixture(t, { view: 'clients', paged: true });
      f.seedDirectory([patient('old', 'Initial Client')]);
      search(f, 'oldquery');
      f.hidden(true);
      await f.advance(160);
      assert.equal(f.readCalls(directoryRoute).length, 0);
      if (change === 'account') f.state.account = { ...f.state.account, id: 'other-owner' };
      if (change === 'organization')
        f.state.account = { ...f.state.account, organizationId: 'other-org' };
      const currentQuery = change === 'query' ? 'newquery' : 'oldquery';
      if (change === 'query') search(f, currentQuery);
      f.catalog.directory = [patient('current', 'Current Client')];
      await f.resume();
      await f.advance(160);
      const reads = f.readCalls(directoryRoute);
      assert.equal(reads.length, 1);
      assert.equal(queryOf(reads[0]).get('q'), currentQuery);
      assert.equal(reads[0].scope, f.state.account.id + '|' + f.state.account.organizationId);
      assert.ok(f.$('[data-patient="current"]'));
      assert.doesNotMatch(f.$('#patient-list').textContent, /Загрузка клиентов/);
      f.assertNoMutation();
    });
  }
});

test('pagehide invalidates the departed automatic read while the restored current list still receives a fresh load', async (t) => {
  const f = fixture(t, { view: 'clients', paged: true });
  f.seedDirectory([patient('old', 'Initial Client')]);
  search(f, 'restored');
  f.hidden(true);
  await f.advance(160);
  assert.equal(f.readCalls(directoryRoute).length, 0);
  f.pagehide();
  search(f, 'afterrestore');
  f.catalog.directory = [patient('restored', 'Restored Client')];
  f.pageshow();
  await f.resume();
  await f.advance(160);
  assert.equal(f.readCalls(directoryRoute).length, 1);
  assert.equal(queryOf(f.readCalls(directoryRoute)[0]).get('q'), 'afterrestore');
  assert.ok(f.$('[data-patient="restored"]'));
  f.assertNoMutation();
});

test('explicit load-more retains its awaited hidden completion and an explicit picker read remains immediate', async (t) => {
  const f = fixture(t, { view: 'clients', paged: true });
  f.seedDirectory([patient('first', 'First Client')], 'next-cursor');
  const gate = deferred();
  f.handle(directoryRoute, () => gate.promise);
  const loading = f.actions.loadDirectoryMore();
  await f.flush();
  assert.equal(f.readCalls(directoryRoute).length, 1);
  assert.equal(queryOf(f.readCalls(directoryRoute)[0]).get('cursor'), 'next-cursor');
  f.hidden(true);
  gate.resolve(page([patient('second', 'Second Client')]));
  await loading;
  await f.flush();
  assert.equal(f.readCalls(directoryRoute).length, 1);
  f.handle(directoryRoute, () => page([patient('picker', 'Picker Client')]));
  const selected = await f.actions.loadAppointmentDirectory('picker');
  assert.equal(selected.patients[0].id, 'picker');
  assert.equal(f.readCalls(directoryRoute).length, 2);
  assert.equal(
    f.readCalls(directoryRoute)[1].visibility,
    'hidden',
    'explicit user read is not a passive leak',
  );
  await f.resume();
  await f.advance(160);
  assert.ok(f.$('[data-patient="first"]'));
  assert.ok(f.$('[data-patient="second"]'));
  assert.equal(f.readCalls(directoryRoute).length, 2);
  f.assertNoMutation();
});

test('a current explicit load-more error retains rows and explicit retry semantics across hidden/visible transitions', async (t) => {
  const f = fixture(t, { view: 'clients', paged: true });
  f.seedDirectory([patient('first', 'First Client')], 'next-cursor');
  const gate = deferred();
  f.handle(directoryRoute, () => gate.promise);
  const loading = f.actions.loadDirectoryMore();
  await f.flush();
  f.hidden(true);
  gate.resolve(response({ error: 'Synthetic current manual failure' }, 403));
  await loading;
  await f.flush();
  await f.resume();
  await f.advance(160);
  assert.ok(f.$('[data-patient="first"]'));
  assert.match(f.$('#patient-list').textContent, /Synthetic current manual failure/);
  assert.ok(f.$('#directory-retry'));
  assert.equal(f.readCalls(directoryRoute).length, 1);
  f.handle(directoryRoute, () => page([patient('second', 'Second Client')]));
  await f.actions.loadDirectoryMore();
  assert.equal(f.readCalls(directoryRoute).length, 2);
  assert.equal(queryOf(f.readCalls(directoryRoute)[1]).get('cursor'), 'next-cursor');
  f.assertNoMutation();
});

test('an empty-search card cancels obsolete list work without loading an invisible directory', async (t) => {
  for (const started of [false, true]) {
    await t.test(started ? 'in-flight search' : 'queued search', async (t) => {
      const f = fixture(t, { view: 'clients', paged: true });
      f.seedDirectory([patient('initial', 'Initial Client')]);
      const gate = deferred();
      f.handle(directoryRoute, () => gate.promise);
      search(f, 'alpha');
      if (started) await f.advance(160);
      const before = f.readCalls(directoryRoute).length;
      assert.equal(before, Number(started));

      f.state.currentView = 'card';
      f.state.selectedId = 'initial';
      search(f, '');
      if (started) assert.equal(f.readCalls(directoryRoute)[0].signal.aborted, true);
      await f.advance(160);
      gate.resolve(page([patient('late', 'Late Client')]));
      await f.flush();
      await f.resume();
      await f.advance(600);
      assert.equal(f.readCalls(directoryRoute).length, before);
      assert.equal(f.$('#patient-list').innerHTML, '');
      assert.equal(
        f.state.directory.some((p) => p.id === 'late'),
        false,
      );

      f.handle(directoryRoute, () => page([patient('picker', 'Picker Client')]));
      const selected = await f.actions.loadAppointmentDirectory('picker');
      assert.equal(selected.patients[0].id, 'picker');
      assert.equal(f.readCalls(directoryRoute).length, before + 1);
      assert.equal(queryOf(f.readCalls(directoryRoute).at(-1)).get('q'), 'picker');

      f.handle(directoryRoute, () => page([patient('current', 'Current Client')]));
      search(f, 'current');
      await f.advance(160);
      assert.equal(f.readCalls(directoryRoute).length, before + 2);
      assert.ok(f.$('[data-patient="current"]'));
      f.assertNoMutation();
    });
  }
});
