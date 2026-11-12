const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {createServer}=require('./serve.cjs'),{createStore}=require('./auth-store.cjs'),{clientAddressResolver}=require('./client-address.cjs');
const caddyBin=require('./scripts/find-caddy.cjs').findCaddy();
test('forwarded headers are ignored unless the TCP peer is explicitly trusted',()=>{
 const req={socket:{remoteAddress:'::ffff:192.0.2.2'},headers:{'x-forwarded-for':'198.51.100.1','x-cartoteca-client-ip':'198.51.100.2'}};
 assert.equal(clientAddressResolver([])(req),'192.0.2.2');assert.equal(clientAddressResolver(['192.0.2.2'])(req),'198.51.100.2');
 req.headers['x-cartoteca-client-ip']='198.51.100.2, 203.0.113.4';assert.throws(()=>clientAddressResolver(['192.0.2.2'])(req),{status:403});
 assert.throws(()=>clientAddressResolver(['0.0.0.0/0']));
});
test('real Caddy overwrites spoofed IP headers and isolates two clients rate limits',{skip:!caddyBin},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-caddy-'));
 const credentials={email:'proxy@example.test',password:'Proxy-regression-password-2026!'};
 const seed=createStore(path.join(dir,'data'));await seed.setup(credentials.email,credentials.password,'seed');seed.close();
 const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const origin='http://127.0.0.1:'+port;
 const backend=createServer({dataDir:path.join(dir,'data'),origin,trustedProxies:['127.0.0.1'],sendMail:null});await new Promise(r=>backend.listen(0,'127.0.0.1',r));
 let forwarded=0;backend.on('request',()=>forwarded++);
 const config=path.join(dir,'Caddyfile');fs.writeFileSync(config,'{\n admin off\n auto_https off\n}\n'+fs.readFileSync(path.join(__dirname,'Caddyfile'),'utf8'));
 const child=spawn(caddyBin,['run','--config',config,'--adapter','caddyfile'],{windowsHide:true,stdio:'pipe',env:{...process.env,DOMAIN:origin,CARTOTECA_UPSTREAM:'127.0.0.1:'+backend.address().port}});
 let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
 const exited=once(child,'exit');
 t.after(async()=>{child.kill();await exited;await new Promise(r=>backend.close(r));if(path.dirname(dir)===path.resolve(os.tmpdir())&&path.basename(dir).startsWith('cartoteca-caddy-'))fs.rmSync(dir,{recursive:true,force:true});});
 const request=(localAddress,password,extra={})=>new Promise((resolve,reject)=>{
  const req=http.request(origin+'/api/auth/login',{localAddress,method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Cartoteca-Request':'1',...extra}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.end(JSON.stringify({...credentials,password}));
 });
 const until=Date.now()+10000;for(;;){try{await fetch(origin+'/api/auth/session');break}catch{if(Date.now()>until)throw Error('Caddy did not start: '+logs);await new Promise(r=>setTimeout(r,100))}}
 for(let i=0;i<10;i++)assert.equal(await request('127.0.0.2','wrong',{'X-Forwarded-For':'198.51.100.'+(i+1),'X-Cartoteca-Client-IP':'203.0.113.'+(i+1)}),401);
 assert.equal(await request('127.0.0.2',credentials.password,{'X-Cartoteca-Client-IP':'127.0.0.3'}),429);
 assert.equal(await request('127.0.0.3',credentials.password),200);
 assert.equal(await request('127.0.0.3',credentials.password,{Origin:'http://evil.test'}),403);
 const before=forwarded;await request('127.0.0.3',credentials.password,{Host:'evil.test'});assert.equal(forwarded,before,'Unknown Host must not reach the application');
});
