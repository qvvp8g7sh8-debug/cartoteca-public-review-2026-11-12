const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createServer}=require('../serve.cjs');const {jsonBodyBudget}=require('../src/server/http/json-body-budget.cjs');
test('legacy pre-buffering refusal preserves the explicit safe-to-retry code',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-legacy-capacity-')),server=createServer({dataDir:directory,sendMail:null});let release;
 t.after(async()=>{release?.();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^cartoteca-legacy-capacity-/);fs.rmSync(directory,{recursive:true,force:true});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const headers={Origin:base,'Content-Type':'application/json','X-Cartoteca-Request':'1'};
 const setup=await fetch(base+'/api/auth/setup',{method:'POST',headers,body:JSON.stringify({email:'synthetic@legacy.test',password:'Synthetic-legacy-capacity-password',displayName:'Synthetic owner'})});assert.equal(setup.status,200);const cookie=setup.headers.get('set-cookie').split(';')[0];await setup.arrayBuffer();
 release=jsonBodyBudget.acquire(64*1024*1024,'synthetic-other');
 const response=await fetch(base+'/api/cabinet',{method:'PUT',headers:{...headers,Cookie:cookie},body:'{}'});assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'2');const body=await response.json();assert.equal(body.code,'UPLOAD_CAPACITY');assert.equal(body.outcomeUnknown,false);
 release();release=null;assert.equal(jsonBodyBudget.stats().requests,0);
});
