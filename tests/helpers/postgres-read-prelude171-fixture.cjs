const assert = require('node:assert/strict');
const {
  hotDirectoryFixture170,
  hotSQL169,
  bounded169,
} = require('./postgres-hot-directory170-fixture.cjs');
const authoritySQL171 = (text) =>
  text.includes('WITH auth_guard AS MATERIALIZED') && text.includes('platform_sessions');
const rrSQL171 = (text) => text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
function counts171(k) {
  return {
    metadata: k.trace.filter((r) => hotSQL169(r.text)).length,
    authority: k.trace.filter((r) => authoritySQL171(r.text)).length,
    rr: k.trace.filter((r) => rrSQL171(r.text)).length,
    commit: k.trace.filter((r) => r.text === 'COMMIT').length,
  };
}
function barrier171() {
  let signal, release;
  const entered = new Promise((resolve) => {
    signal = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    pause() {
      signal();
      return wait;
    },
  };
}
// Wrap only the public in-process owner composition. No product test hook, no
// individual BEGIN-query gate that could let pipelined GUC/guard overtake BEGIN.
function instrumentPrelude171(k, { onAccept, beforeRun, omitCallback = false } = {}) {
  const borrow = k.operations.borrow166,
    accepted = [],
    contexts = [];
  k.operations.borrow166 = () => {
    const owned = borrow();
    if (!owned) return owned;
    const slot = { ...owned };
    for (const name of ['prepareHotCalendar169', 'prepareHotDirectory170']) {
      if (typeof owned[name] !== 'function') continue;
      slot[name] = async (...args) => {
        const finish = await owned[name](...args);
        if (!finish) return finish;
        return (options) => {
          const copy = { ...options };
          if (omitCallback) delete copy.acceptColdAuthority171;
          else if (typeof options.acceptColdAuthority171 === 'function') {
            copy.acceptColdAuthority171 = (current) => {
              const result = options.acceptColdAuthority171(current);
              accepted.push({ ...current });
              onAccept?.(current);
              return result;
            };
          }
          return finish(copy);
        };
      };
    }
    slot.run = (context, execution) => {
      contexts.push({ ...context.current });
      return beforeRun
        ? Promise.resolve(beforeRun(context, execution)).then(() => owned.run(context, execution))
        : owned.run(context, execution);
    };
    return slot;
  };
  return {
    accepted,
    contexts,
    restore() {
      k.operations.borrow166 = borrow;
    },
  };
}
async function preludeFixture171(t, options = {}) {
  const f = await hotDirectoryFixture170(t, options);
  async function bumpPlatform() {
    await f.admin.query(
      'UPDATE cartoteca_platform.organizations SET slug=slug WHERE _store_id=$1 AND id=$2',
      [f.platform.storeId, f.organizations[0]],
    );
  }
  function bumpSummary(value = 171) {
    const source = f.a.c[0]
      .prepare("SELECT value FROM cabinet_summaries WHERE patient_id='patient' AND audience='*'")
      .get().value;
    f.a.c[0]
      .prepare("UPDATE cabinet_summaries SET value=? WHERE patient_id='patient' AND audience='*'")
      .run(f.storage.encode({ ...f.storage.decode(source), visitCount: value }));
  }
  async function candidate(k, kind, { actor = f.actors[0] } = {}) {
    if (kind === 'calendar') {
      const cold = await f.cold(k, actor);
      const url = cold.url.replace('projection=details', 'projection=occupancy');
      assert.notEqual(url, cold.url);
      k.clear();
      return { url, cold };
    }
    const cold = await f.warm(k, f.directoryUrl, actor);
    bumpSummary();
    k.clear();
    return { url: f.directoryUrl, cold };
  }
  return { ...f, bumpPlatform, bumpSummary, candidate };
}
module.exports = {
  preludeFixture171,
  instrumentPrelude171,
  barrier171,
  counts171,
  authoritySQL171,
  rrSQL171,
  hotSQL169,
  bounded169,
};
