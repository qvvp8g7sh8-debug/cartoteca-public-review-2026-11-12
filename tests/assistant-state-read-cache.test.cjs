const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { initialState, validateState } = require('../src/server/modules/assistant/access/defaults.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { createAssistantPolicy } = require('../src/server/modules/assistant/access/policy.cjs');
const STORE_PATH = path.join(__dirname,'../src/server/modules/assistant/access/store.cjs');
const MAX_BYTES = 2*1024*1024;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const actor = { organizationId:'synthetic-org',accountId:'synthetic-account',role:'owner' };
function selectedState() {
  const state=initialState(); state.revision=7; state.policy.mode='selected';
  state.grants=[{ organizationId:actor.organizationId,accountId:actor.accountId,
    membershipId:crypto.createHash('sha256').update(JSON.stringify([actor.organizationId,actor.accountId,123])).digest('base64url'),
    limits:{ dailyRequests:7 } }];
  return state;
}
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-assistant-state-cache-'));
  fs.chmodSync(root,0o700);
  fs.writeFileSync(path.join(root,'owner.json'),JSON.stringify({ kind:'assistant-state-read-cache-test',pid:process.pid,syntheticOnly:true })+'\n',{flag:'wx',mode:0o600});
  const directory=path.join(root,'assistant'); fs.mkdirSync(directory,{mode:0o700});
  const database=createPlatformDatabase(path.join(root,'platform'),{notificationSchema:11,sharedCabinetWrites:false,isolatedReadBudgets:false});
  t.after(()=>{database.closeWriter();database.db.close();}); // Preserve only this fresh fixture; never recursively remove paths.
  const filename=path.join(directory,'assistant-state.enc');
  const counts={stat:0,bytes:0,opens:0,validations:0};
  const fault={read:null,rename:false};
  const injectedFs={...fs,
    statSync(file,...args) { if(file===filename)counts.stat++; return fs.statSync(file,...args); },
    readFileSync(file,...args) {
      if(file===filename) {
        counts.bytes++;
        if(fault.read) { const code=fault.read;fault.read=null;throw Object.assign(new Error('Synthetic state read error'),{code}); }
      }
      return fs.readFileSync(file,...args);
    },
    renameSync(from,to) {
      if(to===filename && fault.rename) { fault.rename=false;throw Object.assign(new Error('Synthetic atomic publish failure'),{code:'EACCES'}); }
      return fs.renameSync(from,to);
    },
  };
  // Execute the unchanged source with isolated dependency counters, not global monkeypatches.
  const loaded=new Module(STORE_PATH,module), realRequire=Module.createRequire(STORE_PATH);
  loaded.filename=STORE_PATH;
  loaded.require=specifier=>specifier==='node:fs'?injectedFs:specifier==='./defaults.cjs'
    ? {...realRequire(specifier),validateState(value){counts.validations++;return validateState(value);}}
    :realRequire(specifier);
  loaded._compile(fs.readFileSync(STORE_PATH,'utf8'),STORE_PATH);
  const open=bytes=>{counts.opens++;return database.open(bytes);};
  const settings={directory,seal:database.seal,open};
  const store=loaded.exports.createAssistantStore(settings);
  const reset=()=>{for(const key of Object.keys(counts))counts[key]=0;};
  const replaceRaw=bytes=>{
    const temporary=path.join(directory,'.external-'+crypto.randomUUID()+'.tmp');
    const fd=fs.openSync(temporary,'wx',0o600);
    try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temporary,filename);
  };
  return {root,directory,filename,database,counts,fault,store,reset,replaceRaw,
    seed(state=selectedState()) {
      store.update(current=>{for(const key of Object.keys(current))delete current[key];Object.assign(current,structuredClone(state));});reset();
    },
    publish(state) { validateState(state);replaceRaw(database.seal(state)); },
    independent:()=>loaded.exports.createAssistantStore(settings),
    legacyReset:()=>loaded.exports.resetRestoredAssistant(settings),
  };
}
function expectReadCounts(f,reads,opens,validations=opens) {
  assert.deepEqual(f.counts,{stat:reads,bytes:reads,opens,validations});
}

test('constructing a private state store performs no file read or decode',t=>{
  const f=fixture(t);assert.deepEqual(f.counts,{stat:0,bytes:0,opens:0,validations:0});
});

test('first read decrypts once, equal-byte hits still stat and read every time',t=>{
  const f=fixture(t);f.seed();
  const first=f.store.read(),second=f.store.read(),third=f.store.read();
  assert.deepEqual(first,second);assert.deepEqual(second,third);
  assert.notEqual(first,second);assert.notEqual(first.policy,second.policy);
  expectReadCounts(f,3,1);
});

test('each store owns its own single validated snapshot',t=>{
  const f=fixture(t);f.seed();const other=f.independent();
  assert.equal(f.store.read().revision,7);assert.equal(other.read().revision,7);
  expectReadCounts(f,2,2);
  assert.equal(f.store.read().revision,7);assert.equal(other.read().revision,7);
  expectReadCounts(f,4,2);
});

test('A to B to A byte publications re-decode rather than retain a map of old states',t=>{
  const f=fixture(t);f.seed();const bytesA=fs.readFileSync(f.filename);
  assert.equal(f.store.read().revision,7);
  const changed=selectedState();changed.revision=8;f.publish(changed);
  assert.equal(f.store.read().revision,8);
  f.replaceRaw(bytesA);assert.equal(f.store.read().revision,7);
  expectReadCounts(f,3,3);
});

test('an independent atomic writer revokes access without any in-process invalidation callback',t=>{
  const f=fixture(t);f.seed();assert.equal(f.store.read().policy.mode,'selected');
  const changed=selectedState();changed.policy.mode='off';changed.grants=[];f.publish(changed);
  const current=f.store.read();assert.equal(current.policy.mode,'off');assert.deepEqual(current.grants,[]);
  expectReadCounts(f,2,2);
});

test('same-size in-place changes remain visible when mtime is restored exactly',t=>{
  const f=fixture(t);f.seed();const fixed=new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(f.filename,fixed,fixed);
  const previous=fs.statSync(f.filename),current=f.store.read();
  current.revision=8;const replacement=f.database.seal(current);
  assert.equal(replacement.length,previous.size);
  fs.writeFileSync(f.filename,replacement,{flag:'r+'});fs.utimesSync(f.filename,fixed,fixed);
  const next=fs.statSync(f.filename);
  assert.equal(next.size,previous.size);assert.equal(next.mtimeMs,previous.mtimeMs);assert.equal(next.ino,previous.ino);
  assert.equal(f.store.read().revision,8);expectReadCounts(f,2,2);
});

test('deeply mutated returned values never alter a later hit or encrypted bytes',t=>{
  const f=fixture(t),state=selectedState();
  state.policy.examples=[{id:crypto.randomUUID(),text:'Synthetic behavior',referenceDate:'2099-01-05',referenceTime:'08:00',enabled:false,expected:{intent:'help'}}];
  state.history=[{revision:6,time:0,policy:structuredClone(state.policy),providers:structuredClone(state.providers),rates:{...state.rates}}];
  state.behavior={version:1,current:{time:1,actorId:'synthetic-operator',reason:'Synthetic revision'},history:[{version:0,time:0,actorId:'synthetic-operator',reason:'Synthetic prior revision',rules:{instructions:'',dictionary:'',exampleSelection:'manual',examples:structuredClone(state.policy.examples)}}]};
  state.usage={'2099-01':{spentRub:0,calls:0,uncertainCalls:0}};state.daily={synthetic:1};
  state.reservations={synthetic:{amount:0,createdAt:0,month:'2099-01',kind:'tts'}};
  state.audit=[{detail:{synthetic:true}}];state.operations=[{detail:{synthetic:true}}];
  f.seed(state);const fileHash=digest(fs.readFileSync(f.filename));
  const first=f.store.read(),expected=structuredClone(first);
  first.policy.commands.calendar=false;first.policy.limits.dailyRequests=999;
  first.policy.examples[0].text='mutated';first.policy.examples[0].expected.intent='calendar';
  first.history[0].policy.examples[0].text='mutated history';
  first.behavior.history[0].rules.examples[0].text='mutated behavior';
  first.grants[0].limits.dailyRequests=999;first.usage['2099-01'].spentRub=999;
  first.reservations.synthetic.amount=999;first.daily.synthetic=999;
  first.audit[0].detail.synthetic=false;first.operations[0].detail.synthetic=false;
  assert.deepEqual(f.store.read(),expected);expectReadCounts(f,2,1);
  assert.equal(digest(fs.readFileSync(f.filename)),fileHash);
});

test('successful atomic write invalidates even a warmed private snapshot',t=>{
  const f=fixture(t);f.seed();f.store.read();
  f.store.update(state=>{state.revision++;state.policy.instructions='synthetic updated policy';});f.reset();
  assert.equal(f.store.read().revision,8);expectReadCounts(f,1,1);
  assert.equal(f.store.read().policy.instructions,'synthetic updated policy');expectReadCounts(f,2,1);
});

test('a throwing update callback cannot mutate the private validated snapshot',t=>{
  const f=fixture(t);f.seed();const expected=f.store.read(),before=digest(fs.readFileSync(f.filename));
  assert.throws(()=>f.store.update(state=>{state.policy.mode='off';state.grants=[];throw Error('Synthetic callback failure');}),/Synthetic callback failure/u);
  assert.equal(digest(fs.readFileSync(f.filename)),before);assert.deepEqual(f.store.read(),expected);
});

test('invalid update schema leaves the authoritative bytes and next read valid',t=>{
  const f=fixture(t);f.seed();const expected=f.store.read(),before=digest(fs.readFileSync(f.filename));
  assert.throws(()=>f.store.update(state=>{state.schema=99;state.policy.mode='off';}));
  assert.equal(digest(fs.readFileSync(f.filename)),before);assert.deepEqual(f.store.read(),expected);
});

test('failed atomic rename never publishes a proposed state into the cache',t=>{
  const f=fixture(t);f.seed();const expected=f.store.read(),before=digest(fs.readFileSync(f.filename));
  f.fault.rename=true;
  assert.throws(()=>f.store.update(state=>{state.revision++;state.policy.mode='off';}),error=>error.code==='EACCES');
  assert.equal(digest(fs.readFileSync(f.filename)),before);assert.deepEqual(f.store.read(),expected);
  assert.equal(fs.existsSync(path.join(f.directory,'assistant-state.lock')),false);
});

test('invalid ciphertext fails closed and discards the previously valid cache entry',t=>{
  const f=fixture(t);f.seed();f.store.read();const valid=fs.readFileSync(f.filename),broken=Buffer.from(valid);
  broken[broken.length-1]^=1;f.replaceRaw(broken);f.reset();
  assert.throws(()=>f.store.read());expectReadCounts(f,1,1,0);
  f.replaceRaw(valid);assert.equal(f.store.read().revision,7);expectReadCounts(f,2,2,1);
});

test('authenticated invalid schema is not a cache fallback and restoration revalidates',t=>{
  const f=fixture(t);f.seed();f.store.read();const valid=fs.readFileSync(f.filename),invalid=selectedState();invalid.schema=99;
  f.replaceRaw(f.database.seal(invalid));f.reset();
  assert.throws(()=>f.store.read());expectReadCounts(f,1,1,1);
  f.replaceRaw(valid);assert.equal(f.store.read().schema,1);expectReadCounts(f,2,2,2);
});

test('oversized file is rejected before decoding and clears the one-entry cache',t=>{
  const f=fixture(t);f.seed();f.store.read();const valid=fs.readFileSync(f.filename);
  f.replaceRaw(Buffer.alloc(MAX_BYTES+1));f.reset();assert.throws(()=>f.store.read());
  assert.deepEqual(f.counts,{stat:1,bytes:0,opens:0,validations:0});
  f.replaceRaw(valid);assert.equal(f.store.read().revision,7);
  assert.deepEqual(f.counts,{stat:2,bytes:1,opens:1,validations:1});
});

test('read error clears cached data; an ENOENT race returns independent default state',async t=>{
  for(const code of ['EIO','ENOENT'])await t.test(code,t=>{
    const f=fixture(t);f.seed();f.store.read();f.reset();f.fault.read=code;
    if(code==='EIO')assert.throws(()=>f.store.read(),error=>error.code==='EIO');
    else {const missing=f.store.read();assert.equal(missing.policy.mode,'off');assert.deepEqual(missing.grants,[]);missing.policy.commands.clients=false;}
    expectReadCounts(f,1,0);
    assert.equal(f.store.read().policy.mode,'selected');expectReadCounts(f,2,1);
  });
});

test('missing file clears the cache and reappearance is decoded independently',t=>{
  const f=fixture(t);f.seed();f.store.read();const valid=fs.readFileSync(f.filename);
  fs.unlinkSync(f.filename);f.reset();const first=f.store.read();first.policy.commands.clients=false;
  assert.equal(f.store.read().policy.commands.clients,true);
  assert.deepEqual(f.counts,{stat:2,bytes:0,opens:0,validations:0});
  f.replaceRaw(valid);assert.equal(f.store.read().revision,7);
  assert.deepEqual(f.counts,{stat:3,bytes:1,opens:1,validations:1});
});

test('legacy restored assistant reset is immediately visible to an already warm store',t=>{
  const f=fixture(t);f.seed();const before=f.store.read();f.legacyReset();f.reset();
  const next=f.store.read();assert.equal(next.revision,before.revision+1);
  assert.equal(next.policy.mode,'off');assert.deepEqual(next.grants,[]);assert.deepEqual(next.credentials,{});
  assert.deepEqual(next.reservations,{});assert.deepEqual(next.operations,[]);assert.deepEqual(next.audit,[]);
  assert.deepEqual(next.history,[]);assert.equal(next.behavior.current,null);expectReadCounts(f,1,1);
});

test('an equal-byte state hit never caches membership authorization between scope checks',t=>{
  const f=fixture(t);f.seed();let joins=0;
  const row={role:'owner',status:'active',created_at:123,account_status:'active',organization_status:'active',global_admin:0};
  const db={prepare(sql){assert.match(sql,/FROM memberships m/u);return{get(org,account){joins++;assert.equal(org,actor.organizationId);assert.equal(account,actor.accountId);return{...row};}};}};
  const policy=createAssistantPolicy({db},f.store);
  assert.equal(policy.requireScope(actor,7).scope.enabled,true);row.status='suspended';
  assert.throws(()=>policy.requireScope(actor,7),error=>error.status===403);
  row.status='active';assert.equal(policy.requireScope(actor,7).scope.enabled,true);
  assert.equal(joins,3);expectReadCounts(f,3,1);
});

function projectedPolicy(f, { paid = false, connected = false } = {}) {
  const row = { role:'owner', status:'active', created_at:123, account_status:'active',
    organization_status:'active', global_admin:0 };
  let joins = 0;
  const db = { prepare(sql) {
    assert.match(sql, /FROM memberships m/u);
    return { get(org, account) {
      joins++;
      return org === actor.organizationId && account === actor.accountId ? { ...row } : null;
    } };
  } };
  const billing = { hasServiceConnection:()=>connected, isServiceEnabled:()=>paid };
  return { row, joins:()=>joins, policy:createAssistantPolicy({ db, billing }, f.store) };
}

test('narrow public access preserves roles, grants, limits, billing and provider readiness', async t=>{
  for (const variant of ['owner','salon_admin','cosmetologist','no-grant','paid','unpaid',
    'timeweb','timeweb-no-key','codex','local','off','global','anonymous','other-account']) {
    await t.test(variant,t=>{
      const f=fixture(t),state=selectedState();
      if (['no-grant','paid','unpaid'].includes(variant)) state.grants=[];
      if (variant==='off') state.policy.mode='off';
      if (variant.startsWith('timeweb')) {
        state.providers.llm.provider='timeweb';
        if (variant==='timeweb') state.credentials.timeweb='synthetic-provider-key';
      }
      if (variant==='codex') state.providers.llm.provider='codex';
      if (variant==='local') { state.providers.stt.provider='local';state.providers.stt.model='whisper-base'; }
      f.seed(state);
      const p=projectedPolicy(f,{paid:variant==='paid',connected:['paid','unpaid'].includes(variant)});
      if (['salon_admin','cosmetologist'].includes(variant)) p.row.role=variant;
      const current=variant==='anonymous'?null:{...actor,role:p.row.role,
        ...(variant==='global'?{globalAdmin:true}:{}),
        ...(variant==='other-account'?{accountId:'foreign-account'}:{})};
      const expected=p.policy.inspect(current).scope;
      assert.deepEqual(p.policy.inspectAccess(current).scope,expected);
      assert.deepEqual(p.policy.access(current),expected);
      expectReadCounts(f,3,1);
      assert.equal(p.joins(),['off','global','anonymous'].includes(variant)?0:3);
    });
  }
});

test('public access observes membership incarnation and equal-size policy changes without cached authority',t=>{
  const f=fixture(t);f.seed();const p=projectedPolicy(f);
  assert.equal(p.policy.access(actor).enabled,true);
  p.row.created_at++;
  assert.equal(p.policy.access(actor).enabled,false);
  p.row.created_at--;
  p.row.account_status='suspended';
  assert.equal(p.policy.access(actor).enabled,false);
  p.row.account_status='active';
  assert.equal(p.policy.access(actor).enabled,true);
  const fixed=new Date('2026-01-01T00:00:00Z');fs.utimesSync(f.filename,fixed,fixed);
  const before=fs.statSync(f.filename),state=selectedState();
  state.grants[0].accountId='synthetic-accounX';state.revision=8;
  const replacement=f.database.seal(state);assert.equal(replacement.length,before.size);
  fs.writeFileSync(f.filename,replacement,{flag:'r+'});fs.utimesSync(f.filename,fixed,fixed);
  assert.equal(fs.statSync(f.filename).mtimeMs,before.mtimeMs);
  assert.deepEqual(p.policy.access(actor),{enabled:false,organizationId:actor.organizationId,policyVersion:8});
  assert.equal(p.joins(),5);expectReadCounts(f,5,2);
});

test('access projection copies only one exact grant and excludes private history and credentials',t=>{
  const f=fixture(t),state=selectedState();state.credentials.timeweb='synthetic-provider-key';
  state.audit=Array.from({length:100},()=>({detail:'synthetic'.repeat(1000)}));
  const original=structuredClone(state.grants[0]);
  state.grants.unshift({...original,organizationId:'foreign-org',limits:{dailyRequests:999}});
  state.grants.push({...original,limits:{dailyRequests:999}});
  f.seed(state);const p=projectedPolicy(f),projected=p.policy.inspectAccess(actor);
  assert.equal(projected.scope.limits.dailyRequests,7);
  assert.equal(projected.state.grants.length,1);
  assert.equal(projected.state.credentials.timeweb,true);
  assert.equal(projected.state.audit,undefined);
  assert.equal(projected.state.policy.instructions,undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(projected.state))<2048);
  projected.state.grants[0].limits.dailyRequests=999;
  projected.state.policy.commands.calendar=false;
  assert.equal(p.policy.access(actor).limits.dailyRequests,7);
  assert.equal(p.policy.access(actor).commands.calendar,true);
  // Commands/admin/budget keep the full validated state, independently cloned.
  const full=p.policy.requireScope(actor,7).state;
  assert.equal(full.audit.length,100);assert.equal(full.credentials.timeweb,'synthetic-provider-key');
  assert.equal(full.grants.length,3);assert.equal(full.policy.commands.calendar,true);
  const bytes=fs.readFileSync(f.filename);bytes[bytes.length-1]^=1;f.replaceRaw(bytes);
  assert.throws(()=>p.policy.access(actor));
});
