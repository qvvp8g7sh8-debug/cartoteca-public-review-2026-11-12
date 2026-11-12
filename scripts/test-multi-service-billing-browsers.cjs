const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {createBillingBrowserFixture}=require('../tests/helpers/billing-browser-fixture.cjs');
async function main(){
 const output=path.resolve('work/multi-service-billing-20261019/browser');fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({channel:'msedge',headless:true}),results=[];
 try {for(const width of [1440,390]){
  const f=await createBillingBrowserFixture(null,{paymentNetworkEnabled:false,notificationSchema:20});
  const contexts=[],errors=[],outbound=[];const result={width,passed:false};
  async function session(email){const context=await browser.newContext({viewport:{width,height:900},locale:'ru-RU',isMobile:width<700,hasTouch:width<700,serviceWorkers:'block'});contexts.push(context);
   await context.route('**/*',route=>{if(new URL(route.request().url()).origin===f.base)return route.continue();outbound.push(route.request().url());return route.abort();});
   const response=await context.request.post(f.base+'/api/auth/login',{headers:{Origin:f.base,'X-Cartoteca-Request':'1'},data:{email,password:f.password}});assert.equal(response.status(),200);
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());page.setDefaultTimeout(10000);return page;}
  try {
   f.platform.billing.admin.package(f.admin.accountId,f.command({id:'voice',title:'Помощник на месяц',priceRub:'990',taskLimit:100,enabled:true,expectedRevision:0}));
   const admin=await session('root@billing.test');await admin.goto(f.base+'/admin.html');await admin.locator('[data-admin-view="billing"]').click();
   await admin.locator('[data-admin-billing-tab="packages"]').click();const form=admin.locator('[data-admin-package-form][data-package-id=""]');
   await form.locator('..').locator(':scope > summary').click();await form.locator('[name="serviceCode"]').selectOption('new');
   await form.locator('[name="serviceTitle"]').fill('Отчёты');await form.locator('[name="periodMonths"]').fill('12');await form.locator('[name="quotaUnit"]').selectOption('access');
   assert.equal(await form.locator('[name="taskLimit"]').isVisible(),false);
   await form.locator('[name="title"]').fill('Отчёты на год');await form.locator('[name="priceRub"]').fill('2490');await form.locator('[name="enabled"]').check();await form.locator('[name="reason"]').fill('Синтетическая проверка независимой услуги');
   await form.locator('[type="submit"]').click();await admin.waitForFunction(()=>document.querySelectorAll('[data-admin-package-form]').length===3);
   const reports=f.platform.billing.packages.adminCatalog(f.admin.accountId).find(x=>x.title==='Отчёты на год');assert(reports);assert.equal(reports.periodMonths,12);assert.equal(reports.quotaUnit,'access');
   for(const packageId of ['voice',reports.id])f.platform.billing.admin.trial(f.admin.accountId,f.command({organizationId:f.owner.organizationId,packageId}));
   await admin.locator('[data-admin-billing-tab="payments"]').click();assert.equal(await admin.locator('[data-billing-orders-filter] [name="serviceCode"] option').count(),3);
   await admin.screenshot({path:path.join(output,width+'-admin-payments.png')});
   const owner=await session('owner@billing.test');await owner.goto(f.base+'/');await owner.locator('[data-view="settings"]').click();await owner.locator('details.settings-tile:has(#paid-services-settings) > summary').click();
   await owner.waitForFunction(()=>document.querySelectorAll('[data-paid-service]').length===2 && !document.querySelector('#paid-services-settings').hasAttribute('aria-busy'));
   assert.equal(await owner.locator('[data-paid-toggle]').count(),2);assert.equal(await owner.locator('[data-paid-checkout] [type="submit"]:enabled').count(),0);
   const reportsGroup=owner.locator('[data-paid-service="'+reports.serviceCode+'"]');await reportsGroup.locator('[data-paid-toggle]').click();
   await owner.waitForFunction(code=>document.querySelector('[data-paid-toggle="'+code+'"]')?.dataset.enabled==='false',reports.serviceCode);
   assert(f.platform.billing.isServiceEnabled(f.owner.organizationId,'voice-assistant'));assert.equal(f.platform.billing.isServiceEnabled(f.owner.organizationId,reports.serviceCode),false);
   await reportsGroup.locator('[data-paid-toggle]').click();await owner.waitForFunction(code=>document.querySelector('[data-paid-toggle="'+code+'"]')?.dataset.enabled==='true',reports.serviceCode);
   await owner.locator('#paid-services-settings').scrollIntoViewIfNeeded();
   assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
   await owner.screenshot({path:path.join(output,width+'-owner-services.png'),fullPage:true});
   assert.equal(f.providerCalls.length,0);assert.deepEqual(errors,[]);assert.deepEqual(outbound,[]);result.passed=true;
  }catch(error){result.error=error.stack;result.browserErrors=errors;for(const [i,c]of contexts.entries()){const page=c.pages()[0];if(page){await page.screenshot({path:path.join(output,width+'-failure-'+i+'.png')});fs.writeFileSync(path.join(output,width+'-failure-'+i+'.txt'),await page.locator('body').innerText());}}}finally{await Promise.all(contexts.map(c=>c.close()));await f.close();results.push(result);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({results},null,2));console.log(width+': '+(result.passed ? 'PASS' : result.error));}
 }}finally{await browser.close();}if(results.some(x=>!x.passed))process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
