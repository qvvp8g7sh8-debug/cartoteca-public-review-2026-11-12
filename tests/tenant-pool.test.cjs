const test=require('node:test'),assert=require('node:assert/strict');
const {createTenantPool}=require('../src/server/infrastructure/tenant-pool.cjs');
test('tenant pool evicts only idle least-recently-used connections and pins async requests',()=>{
  const opened=[],closed=[];
  const pool=createTenantPool({limit:2,open:id=>{const store={id,close(){closed.push(store);}};opened.push(store);return store;}});
  const first=pool.lease();const a=first.get('a');const b=pool.get('b');assert.equal(first.get('a'),a);
  const c=pool.get('c');assert.ok(closed.includes(b));assert.ok(!closed.includes(a));
  const second=pool.lease();assert.equal(second.get('c'),c);const d=pool.get('d');assert.ok(!closed.includes(c));
  // Temporary overflow is allowed only while all older stores are pinned.
  assert.equal(opened.length,4);first.release();assert.ok(closed.includes(a));second.release();
  first.release();assert.throws(()=>first.get('a'),/released/);
  pool.close();assert.ok(closed.includes(c));assert.ok(closed.includes(d));assert.equal(new Set(closed).size,opened.length);
});
