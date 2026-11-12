const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {createServer}=require('./serve.cjs');
const {wifiAddress}=require('./wifi.cjs');

test('Wi-Fi detection selects only named private adapter and derives subnet',()=>{
 const interfaces={'Wi-Fi':[{family:'IPv4',internal:false,address:'192.168.123.2',netmask:'255.255.255.0'}],VPN:[{family:'IPv4',internal:false,address:'10.8.0.1',netmask:'255.255.0.0'}]};
 assert.deepEqual(wifiAddress(interfaces,'Wi-Fi'),{name:'Wi-Fi',address:'192.168.123.2',subnet:'192.168.123.0',prefix:24});
 assert.throws(()=>wifiAddress(interfaces,'missing'));
 assert.throws(()=>wifiAddress({'Wi-Fi':[{family:'IPv4',address:'8.8.8.8',netmask:'255.255.255.0'}]}));
});
test('exact LAN and localhost hosts retain auth and reject cross-origin/host mutations',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-lan-'));
 const lan='http://192.168.123.2:4173';
 const server=createServer({dataDir:dir,additionalOrigins:[lan],sendMail:null});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port,local=`http://127.0.0.1:${port}`;
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));const resolved=path.resolve(dir);if(path.dirname(resolved)===path.resolve(os.tmpdir())&&path.basename(resolved).startsWith('cartoteca-lan-'))fs.rmSync(resolved,{recursive:true,force:true});});
 const request=(route,host,origin,method='GET',cookie='')=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path:route,method,headers:{Host:host,Origin:origin,'X-Cartoteca-Request':'1','Content-Type':'application/json',Cookie:cookie}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});
  req.on('error',reject);req.end(method==='POST'?JSON.stringify({email:'lan@example.test',password:'Test-wifi-password-2026!'}):undefined);
 });
 assert.equal((await request('/',new URL(lan).host,lan)).status,200);
 assert.equal((await request('/',`localhost:${port}`,local)).status,200);
 assert.equal((await request('/','evil.test',lan)).status,403);
 assert.equal((await request('/','192.168.123.3:4173',lan)).status,403);
 assert.equal((await request('/api/auth/setup',new URL(lan).host,local,'POST')).status,403);
 assert.equal((await request('/api/auth/setup',new URL(lan).host,'http://evil.test','POST')).status,403);
 const login=await request('/api/auth/setup',new URL(lan).host,lan,'POST');assert.equal(login.status,200);
 const cookie=login.headers['set-cookie'][0].split(';')[0];
 assert.match(login.headers['set-cookie'][0],/HttpOnly; SameSite=Strict/);
 assert.equal((await request('/api/cabinet',new URL(lan).host,lan)).status,401);
 assert.equal((await request('/api/photos/unknown',new URL(lan).host,lan)).status,401);
 assert.equal((await request('/api/cabinet',new URL(lan).host,lan,'GET',cookie)).status,200);
 assert.throws(()=>createServer({dataDir:dir,origin:'https://cabinet.test',additionalOrigins:[lan]}),/HTTPS/);
});
