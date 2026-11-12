const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {setTimeout:delay}=require('node:timers/promises');
const {createBillingBrowserFixture}=require('./helpers/billing-browser-fixture.cjs');
const {authContextHeaders}=require('./helpers/account-context.cjs');
const {jsonBodyBudget}=require('../src/server/http/json-body-budget.cjs');
const {totp}=require('../src/server/modules/auth/admin-mfa-values.cjs');
async function login(f,email,code){const response=await fetch(f.base+'/api/auth/login',{method:'POST',headers:{Origin:f.base,'Content-Type':'application/json','X-Cartoteca-Request':'1'},body:JSON.stringify({email,password:f.password,...(code ? {oneTimeCode:code}: {})})});const data=await response.json();return{response,data,headers:response.ok ? {Cookie:response.headers.get('set-cookie').split(';')[0],...authContextHeaders(data)} : {}};}
async function waitFor(check){for(let i=0;i<100;i++){if(check())return;await delay(5);}assert(check());}

test('HTTP large-upload overload refuses before buffering, normal reads remain available and disconnect restores capacity',async t=>{
 const f=await createBillingBrowserFixture(t,{paymentNetworkEnabled:false}),owner=await login(f,'owner@billing.test');
 const headers={...owner.headers,Origin:f.base,'Content-Type':'application/json','X-Cartoteca-Request':'1','Content-Length':String(50*1024*1024)};
 const pending=http.request(f.base+'/api/cabinet',{method:'PUT',headers});pending.on('error',()=>{});pending.write('{');
 try{await waitFor(()=>jsonBodyBudget.stats().bytes===50*1024*1024);
  const read=await fetch(f.base+'/api/cabinet',{headers:owner.headers});assert.equal(read.status,200);await read.arrayBuffer();
  const small=await fetch(f.base+'/api/cabinet',{method:'PUT',headers:{...headers,'Content-Length':'2'},body:'{}'});assert.equal(small.status,400);await small.arrayBuffer();
  const chunkedHeaders={...headers,'Transfer-Encoding':'chunked'};delete chunkedHeaders['Content-Length'];
  const denied=await new Promise((resolve,reject)=>{const request=http.request(f.base+'/api/cabinet',{method:'PUT',headers:chunkedHeaders},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,retry:response.headers['retry-after'],data:JSON.parse(text)}));});request.on('error',reject);request.end('{}');});
  assert.equal(denied.status,503);assert.equal(denied.retry,'2');assert.equal(denied.data.code,'UPLOAD_CAPACITY');
 }finally{pending.destroy();}
 await waitFor(()=>jsonBodyBudget.stats().requests===0);
 const chunkedHeaders={...headers};delete chunkedHeaders['Content-Length'];
 const chunked=http.request(f.base+'/api/cabinet',{method:'PUT',headers:chunkedHeaders});chunked.on('error',()=>{});chunked.write('{');
 await waitFor(()=>jsonBodyBudget.stats().bytes===50*1024*1024);chunked.destroy();await waitFor(()=>jsonBodyBudget.stats().bytes===0);
 const bad=await fetch(f.base+'/api/cabinet',{method:'PUT',headers:{...headers,'Content-Length':'2'},body:'{}'});assert.equal(bad.status,400);await bad.arrayBuffer();assert.equal(jsonBodyBudget.stats().requests,0);
});

test('HTTP admin MFA settings are role/context protected and password-only login never issues a cookie after activation',async t=>{
 const f=await createBillingBrowserFixture(t,{paymentNetworkEnabled:false}),admin=await login(f,'root@billing.test'),other=await login(f,'root@billing.test'),owner=await login(f,'owner@billing.test');
 async function call(path,who,body){const response=await fetch(f.base+path,{method:body?'POST':'GET',headers:{...who.headers,Origin:f.base,'Content-Type':'application/json','X-Cartoteca-Request':'1'},...(body ? {body:JSON.stringify(body)} : {})});return{response,data:await response.json()};}
 assert.equal((await call('/api/admin/security/mfa',owner)).response.status,403);
 assert.equal((await call('/api/admin/security/mfa/prepare',owner,{password:f.password,requestId:crypto.randomUUID()})).response.status,403);
 const prepared=await call('/api/admin/security/mfa/prepare',admin,{password:f.password,requestId:crypto.randomUUID()});assert.equal(prepared.response.status,200);
 const enabled=await call('/api/admin/security/mfa/enable',admin,{setupId:prepared.data.setupId,code:totp(prepared.data.secret).generate()});assert.equal(enabled.response.status,200);assert.equal(enabled.data.recoveryCodes.length,10);
 assert.equal((await call('/api/admin/security/mfa',other)).response.status,401);assert.equal((await call('/api/admin/security/mfa',admin)).data.enabled,true);
 const refused=await login(f,'root@billing.test');assert.equal(refused.response.status,401);assert.equal(refused.data.code,'MFA_REQUIRED');assert.equal(refused.response.headers.get('set-cookie'),null);
 assert.equal((await login(f,'root@billing.test',enabled.data.recoveryCodes[0])).response.status,200);
 assert.equal((await login(f,'owner@billing.test')).response.status,200);assert.equal(f.providerCalls.length,0);
});
const crypto=require('node:crypto');
