const test=require('node:test'),assert=require('node:assert/strict');
const {createBillingBrowserFixture}=require('./helpers/billing-browser-fixture.cjs');
const {authContextHeaders}=require('./helpers/account-context.cjs');
test('schema20 HTTP finance remains owner/global scoped and the network gate blocks every money action',async t=>{
 const f=await createBillingBrowserFixture(t,{paymentNetworkEnabled:false,notificationSchema:20});
 async function actor(email){const response=await fetch(f.base+'/api/auth/login',{method:'POST',headers:{Origin:f.base,'Content-Type':'application/json','X-Cartoteca-Request':'1'},body:JSON.stringify({email,password:f.password})});assert.equal(response.status,200);return{Cookie:response.headers.get('set-cookie').split(';')[0],...authContextHeaders(await response.json())};}
 const admin=await actor('root@billing.test'),owner=await actor('owner@billing.test'),staff=await actor('cosmetologist@billing.test');
 async function call(route,headers,body={}){const response=await fetch(f.base+route,{method:'POST',headers:{...headers,Origin:f.base,'Content-Type':'application/json','X-Cartoteca-Request':'1'},body:JSON.stringify(body)});return response.status;}
 for(const route of ['/api/admin/billing/financial-action','/api/admin/billing/financial-action-check']){
  assert.equal(await call(route,owner),403);assert.equal(await call(route,staff),403);assert.equal(await call(route,admin),503);
 }
 assert.equal(await call('/api/billing/services/connection',staff),403);
 assert.equal(f.database.db.prepare('SELECT count(*) n FROM billing_financial_actions').get().n,0);assert.equal(f.providerCalls.length,0);
});
