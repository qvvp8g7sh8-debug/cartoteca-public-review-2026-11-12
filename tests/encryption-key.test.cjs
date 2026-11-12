const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {fork}=require('node:child_process');
test('concurrent initializers publish one complete key without overwrite or temporary-file remnants',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-key-race-')),children=[];
  t.after(()=>{children.forEach(child=>{if(child.exitCode===null)child.kill();});fs.rmSync(dir,{recursive:true,force:true});});
  await Promise.all(Array.from({length:4},()=>new Promise((resolve,reject)=>{
    const child=fork(path.join(__dirname,'helpers/key-initializer.cjs'),[dir],{stdio:['ignore','ignore','ignore','ipc']});children.push(child);child.once('message',resolve);child.once('error',reject);
  })));
  const results=children.map(child=>new Promise((resolve,reject)=>{child.once('message',message=>resolve(message.digest));child.once('error',reject);child.send('start');}));
  const hashes=await Promise.all(results);assert.equal(new Set(hashes).size,1);
  const key=fs.readFileSync(path.join(dir,'encryption.key'));assert.equal(key.length,32);assert.equal(crypto.createHash('sha256').update(key).digest('hex'),hashes[0]);
  await Promise.all(children.map(child=>child.exitCode!==null?Promise.resolve():new Promise(resolve=>child.once('exit',resolve))));
  assert.deepEqual(fs.readdirSync(dir),['encryption.key']);
});
