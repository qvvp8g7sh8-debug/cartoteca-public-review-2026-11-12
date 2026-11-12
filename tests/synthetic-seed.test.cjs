const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createSyntheticSeed, createFixtureTimer } = require('./helpers/synthetic-seed.cjs');

test('closed SQLite seed gives independent data, metadata and later clones', async t => {
  let preparations = 0;
  const seed = createSyntheticSeed({ name: 'seed-isolation', async prepare(dir) {
    preparations++;
    const db = new DatabaseSync(path.join(dir, 'fixture.sqlite'));
    try {
      db.exec('PRAGMA journal_mode=WAL; CREATE TABLE state(value TEXT); INSERT INTO state VALUES(\'original\')');
    } finally { db.close(); }
    return { nested: { values: ['original'] } };
  }});
  t.after(() => seed.close());
  const [first, second] = await Promise.all([seed.clone(), seed.clone()]);
  t.after(() => first.close());t.after(() => second.close());
  assert.notEqual(first.dir, second.dir);assert.equal(preparations, 1);
  const left = new DatabaseSync(path.join(first.dir, 'fixture.sqlite'));
  const right = new DatabaseSync(path.join(second.dir, 'fixture.sqlite'));
  try {
    left.exec('UPDATE state SET value=\'changed\'');
    first.data.nested.values.push('changed');
    fs.writeFileSync(path.join(first.dir, 'case-only.txt'), 'synthetic');
    assert.equal(right.prepare('SELECT value FROM state').get().value, 'original');
    assert.deepEqual(second.data.nested.values, ['original']);
    assert.equal(fs.existsSync(path.join(second.dir, 'case-only.txt')), false);
  } finally { left.close();right.close(); }
  first.close();first.close();assert.equal(fs.existsSync(first.dir), false);
  const third = await seed.clone();t.after(() => third.close());
  const fresh = new DatabaseSync(path.join(third.dir, 'fixture.sqlite'));
  try { assert.equal(fresh.prepare('SELECT value FROM state').get().value, 'original'); }
  finally { fresh.close(); }
  assert.deepEqual(third.data.nested.values, ['original']);assert.equal(preparations, 1);
});

test('synthetic seed rejects SQLite transient files rather than copying an active database', async t => {
  let directory;
  const seed = createSyntheticSeed({ name: 'seed-open', async prepare(dir) {
    directory = dir;fs.writeFileSync(path.join(dir, 'fixture.sqlite-wal'), 'not closed');
  }});
  t.after(() => seed.close());
  await assert.rejects(seed.clone(), /Close SQLite handles/);
  assert.equal(fs.existsSync(directory), false);
});

test('failure while building a seed removes its own directory and is never retried silently', async t => {
  let directory, calls = 0;
  const seed = createSyntheticSeed({ name: 'seed-failure', async prepare(dir) {
    calls++;directory=dir;fs.writeFileSync(path.join(dir, 'synthetic.txt'), 'temporary');
    throw Error('Synthetic initialization failure');
  }});
  t.after(() => seed.close());
  await assert.rejects(seed.clone(), /Synthetic initialization failure/);
  await assert.rejects(seed.clone(), /Synthetic initialization failure/);
  assert.equal(calls, 1);assert.equal(fs.existsSync(directory), false);
});

test('seed mutation after preparation is refused and cannot leak into another scenario', async t => {
  let directory;
  const seed = createSyntheticSeed({ name: 'seed-integrity', async prepare(dir) {
    directory=dir;fs.writeFileSync(path.join(dir, 'synthetic.txt'), 'original');
  }});
  t.after(() => seed.close());
  const copy = await seed.clone();t.after(() => copy.close());
  fs.writeFileSync(path.join(directory, 'synthetic.txt'), 'mutated');
  await assert.rejects(seed.clone(), /changed after preparation/);
  assert.equal(fs.readFileSync(path.join(copy.dir, 'synthetic.txt'), 'utf8'), 'original');
});

test('close is idempotent, forbids new clones and does not delete an existing independent copy', async () => {
  const seed = createSyntheticSeed({ name: 'seed-close', async prepare(dir) {
    fs.writeFileSync(path.join(dir, 'synthetic.txt'), 'original');
  }});
  let copy;
  try {
    copy = await seed.clone();await seed.close();await seed.close();
    await assert.rejects(seed.clone(), /closed/);
    assert.equal(fs.readFileSync(path.join(copy.dir, 'synthetic.txt'), 'utf8'), 'original');
  } finally { copy?.close();await seed.close(); }
});

test('close during preparation waits for cleanup and never hands out a clone', async () => {
  let finish, started, directory;
  const began = new Promise(resolve => { started=resolve; });
  const pause = new Promise(resolve => { finish=resolve; });
  const seed = createSyntheticSeed({ name: 'seed-race', async prepare(dir) {
    directory=dir;started();await pause;return {};
  }});
  const cloning = seed.clone();const rejected = assert.rejects(cloning, /closed/);
  await began;const closing = seed.close();finish();
  await Promise.all([rejected, closing]);assert.equal(fs.existsSync(directory), false);
});

test('seed names cannot escape the explicitly generated temporary directory', () => {
  for (const name of ['', '../escape', 'C:\\outside', 'bad/name', '.'])
    assert.throws(() => createSyntheticSeed({ name, prepare() {} }), /Invalid synthetic/);
});

test('fixture timing is silent by default and reports only setup/body/cleanup durations when enabled', async () => {
  const prior=process.env.CARTOTECA_FIXTURE_TIMINGS, messages=[];
  try {
    delete process.env.CARTOTECA_FIXTURE_TIMINGS;
    const quiet=createFixtureTimer({diagnostic:message=>messages.push(message)}, 'synthetic');
    quiet.ready();await quiet.cleanup(()=>{});assert.deepEqual(messages, []);
    process.env.CARTOTECA_FIXTURE_TIMINGS='1';
    const timed=createFixtureTimer({diagnostic:message=>messages.push(message)}, 'synthetic');
    timed.ready();await assert.rejects(timed.cleanup(()=>{throw Error('cleanup failed');}), /cleanup failed/);
    const report=JSON.parse(messages[0]);assert.equal(report.setupCompleted, true);
    for (const key of ['setupMs','bodyMs','cleanupMs']) assert.ok(report[key]>=0);
    assert.deepEqual(Object.keys(report).sort(), ['bodyMs','cleanupMs','fixture','setupCompleted','setupMs']);
  } finally {
    if(prior===undefined)delete process.env.CARTOTECA_FIXTURE_TIMINGS;else process.env.CARTOTECA_FIXTURE_TIMINGS=prior;
  }
});

test('real authenticated sessions remain role-bound and revocation is isolated to one cloned database', async t => {
  const { createPlatformStore }=require('../platform-store.cjs');
  const password='Synthetic-seed-auth-password-2026';
  const seed=createSyntheticSeed({name:'seed-auth',async prepare(dir){
    const platform=createPlatformStore(path.join(dir,'platform'));
    try {
      const owner=await platform.registerOwner({email:'owner@seed.test',password,displayName:'Synthetic owner',organizationName:'Synthetic'});
      platform.verifyEmail(owner.verificationToken);
      const invite=platform.createInvitation({organizationId:owner.organizationId,invitedBy:owner.accountId,role:'cosmetologist'});
      const staff=await platform.acceptInvitation({token:invite.token,email:'staff@seed.test',password,displayName:'Synthetic staff'});
      const login=await platform.login('staff@seed.test',password);
      return {owner,staff,token:login.token};
    } finally { platform.close(); }
  }});
  t.after(()=>seed.close());
  const first=await seed.clone(),second=await seed.clone();
  t.after(()=>first.close());t.after(()=>second.close());
  const left=createPlatformStore(path.join(first.dir,'platform')),right=createPlatformStore(path.join(second.dir,'platform'));
  try {
    const {owner,staff,token}=first.data;
    assert.equal(left.session(token).accountId,staff.accountId);
    assert.equal(right.session(token).accountId,staff.accountId);
    left.updateMembership({organizationId:owner.organizationId,actorId:owner.accountId,accountId:staff.accountId,status:'suspended',role:'cosmetologist'});
    assert.equal(left.session(token),null);
    assert.equal(right.session(token).accountId,staff.accountId);
    assert.throws(()=>right.workSchedules.view(token,owner.accountId,'2030-01-01','2030-01-01'),{status:403});
  } finally { left.close();right.close(); }
});
