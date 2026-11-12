const test=require('node:test'),assert=require('node:assert/strict');
const {configureSqlite}=require('../src/server/infrastructure/sqlite-configuration.cjs');
const busy=()=>Object.assign(Error('Synthetic locked database'),{code:'ERR_SQLITE_ERROR',errcode:5});
test('WAL initialization retries transient BUSY without retrying clinical writes',()=>{
  let attempts=0,time=0;const calls=[];
  const db={prepare:()=>({get:()=>({journal_mode:'delete'})}),exec:sql=>{calls.push(sql);if(sql==='PRAGMA journal_mode=WAL;'&&++attempts<3)throw busy();}};
  configureSqlite(db,{now:()=>time,pause:ms=>{time+=ms;}});
  assert.equal(attempts,3);assert.equal(time,50);
  assert.ok(calls.every(sql=>sql.startsWith('PRAGMA ')));
});
test('already-WAL connections avoid journal changes; permanent failures are not hidden',()=>{
  const calls=[];configureSqlite({prepare:()=>({get:()=>({journal_mode:'wal'})}),exec:sql=>calls.push(sql)});
  assert.ok(!calls.includes('PRAGMA journal_mode=WAL;'));
  const error=Object.assign(Error('Synthetic corruption'),{code:'ERR_SQLITE_ERROR',errcode:11});
  assert.throws(()=>configureSqlite({exec(){},prepare(){throw error;}}),e=>e===error);
});
test('persistent locks stop at deadline with retryable 503',()=>{
  let time=0;assert.throws(()=>configureSqlite({exec(){},prepare(){throw busy();}},{timeout:50,now:()=>time,pause:ms=>{time+=ms;}}),e=>e.status===503&&e.retryAfter===1);
  assert.equal(time,50);
});
