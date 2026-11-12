const test=require('node:test'),assert=require('node:assert/strict');
const {Readable,PassThrough}=require('node:stream');
const {readBody}=require('../src/server/http/responses.cjs');
const {createJsonBodyBudget,createJsonBodyScope}=require('../src/server/http/json-body-budget.cjs');
function req(text,headers={}){const stream=Readable.from([Buffer.from(text)]);stream.headers={'content-type':'application/json',...headers};return stream;}
test('shared budget refuses a parallel large chunked body before its iterator runs, while small JSON remains available',async()=>{
 const budget=createJsonBodyBudget(),scope=createJsonBodyScope('one',budget);
 await readBody(req('{}'),50*1024*1024,undefined,scope.options);
 let iterated=false;const blocked={headers:{'content-type':'application/json'},[Symbol.asyncIterator](){iterated=true;throw Error('must not read');}};
 await assert.rejects(readBody(blocked,50*1024*1024,undefined,{budget,identity:'other'}),e=>e.status===503&&e.code==='UPLOAD_CAPACITY');assert.equal(iterated,false);
 assert.deepEqual(await readBody(req('{"ok":true}'),16384,undefined,{budget}),{ok:true});assert.equal(budget.stats().bytes,50*1024*1024);
 scope.close();scope.close();assert.equal(budget.stats().bytes,0);assert.equal(budget.stats().requests,0);
});
test('capacity is retained until BOTH handler and reader have finished, including cancellation races',async()=>{
 const budget=createJsonBodyBudget({maxBytes:100}),scope=createJsonBodyScope('one',budget),body=new PassThrough();body.headers={'content-type':'application/json'};
 const pending=readBody(body,100,undefined,scope.options);scope.close();assert.equal(budget.stats().bytes,100);
 body.end('{}');await pending;assert.equal(budget.stats().bytes,0);
});
test('per-identity large limits and global request limits recover without leaking identities',async()=>{
 const budget=createJsonBodyBudget({maxBytes:8*1024*1024,maxRequests:3});const a=budget.acquire(1024*1024,'one');
 assert.throws(()=>budget.acquire(1024*1024,'one'),{status:503});const b=budget.acquire(1024*1024,'two'),c=budget.acquire(1,'one');assert.throws(()=>budget.acquire(1,'three'),{status:503});a();b();c();assert.equal(budget.stats().identities,0);assert.equal(budget.stats().requests,0);
});
for(const [name,text,headers,status]of [['invalid JSON','{',{},400],['actual bytes over declared size','123456',{'content-length':'1'},413],['declared oversize','{}',{'content-length':'999'},413],['compression','{}',{'content-encoding':'gzip'},415],['wrong mime','{}',{'content-type':'application/jsonx'},415]])
 test('body failure releases capacity: '+name,async()=>{const budget=createJsonBodyBudget({maxBytes:10});await assert.rejects(readBody(req(text,headers),5,undefined,{budget}),{status});assert.equal(budget.stats().requests,0);});
test('MAX-compatible JSON reviver and content-type charset preserve normal behavior',async()=>{const value=await readBody(req('{"n":3}',{'content-type':'application/json; charset=utf-8'}),20,(key,v)=>key==='n'?v+1:v);assert.equal(value.n,4);});
test('timeout and aborted stream release reservations',async()=>{
 const budget=createJsonBodyBudget({maxBytes:100});const body=new PassThrough();body.headers={'content-type':'application/json'};
 const keep=setTimeout(()=>body.destroy(),1000);try{await assert.rejects(readBody(body,100,undefined,{budget,timeoutMs:10}),{status:408});assert.equal(budget.stats().requests,0);}finally{clearTimeout(keep);body.destroy();}
 const aborted=new PassThrough();aborted.headers={'content-type':'application/json'};const pending=readBody(aborted,100,undefined,{budget});aborted.destroy(Error('Synthetic abort'));await assert.rejects(pending);assert.equal(budget.stats().requests,0);
});

test('declared sizes permit concurrent ordinary saves but cannot understate retained bytes',async()=>{
 const budget=createJsonBodyBudget(),one=createJsonBodyScope('same',budget),two=createJsonBodyScope('same',budget);
 await Promise.all([readBody(req('{}',{'content-length':'2'}),50*1024*1024,undefined,one.options),readBody(req('{}',{'content-length':'2'}),50*1024*1024,undefined,two.options)]);assert.equal(budget.stats().bytes,4);one.close();two.close();
 await assert.rejects(readBody(req('{"secret":1}',{'content-length':'2'}),50*1024*1024,undefined,{budget}),{status:413});assert.equal(budget.stats().bytes,0);
 await assert.rejects(readBody(req('{}',{'content-length':'10'}),50*1024*1024,undefined,{budget}),{status:400});assert.equal(budget.stats().requests,0);
});
