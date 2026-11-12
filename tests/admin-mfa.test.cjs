const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createPlatformStore}=require('../platform-store.cjs');
const {createPlatformDatabase}=require('../src/server/infrastructure/platform-database.cjs');
const {totp,consume}=require('../src/server/modules/auth/admin-mfa-values.cjs');
const password='Synthetic-admin-mfa-password';
async function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-admin-mfa-')),store=createPlatformStore(directory),raw=createPlatformDatabase(directory);
 t.after(()=>{store.close();raw.db.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^cartoteca-admin-mfa-/);fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 const admin=await store.bootstrapGlobalAdmin({email:'admin@mfa.test',password,displayName:'Synthetic admin'});const login=await store.login('admin@mfa.test',password);
 const f={store,raw,admin,token:login.token};f.value=()=>raw.open(raw.db.prepare('SELECT value FROM accounts WHERE id=?').get(admin.accountId).value);f.login=code=>store.login('admin@mfa.test',password,'','synthetic',code);
 f.prepare=()=>store.adminMfa.prepare(f.token,{password,requestId:crypto.randomUUID()});
 f.enable=async()=>{const prepared=await f.prepare();return store.adminMfa.enable(f.token,{setupId:prepared.setupId,code:totp(prepared.secret).generate()});};return f;}

test('MFA is opt-in for existing global administrators and remains absent from public account data',async t=>{const f=await fixture(t);assert.equal(f.store.adminMfa.status(f.token).enabled,false);assert(f.store.session(f.token).globalAdmin);assert.equal(JSON.stringify((await f.login()).account).includes('secret'),false);});
test('setup requires current password and is tied to the initiating session and unexpired setup ID',async t=>{
 const f=await fixture(t);await assert.rejects(f.store.adminMfa.prepare(f.token,{password:'wrong',requestId:crypto.randomUUID()}),{status:401});
 const prepared=await f.prepare(),other=await f.login();assert.throws(()=>f.store.adminMfa.enable(other.token,{setupId:prepared.setupId,code:totp(prepared.secret).generate()}),{status:409});
 const value=f.value();value.adminMfaPending.expiresAt=1;f.raw.db.prepare('UPDATE accounts SET value=? WHERE id=?').run(f.raw.seal(value),f.admin.accountId);
 assert.throws(()=>f.store.adminMfa.enable(f.token,{setupId:prepared.setupId,code:totp(prepared.secret).generate()}),{status:409});assert.equal(f.store.adminMfa.status(f.token).enabled,false);
});
test('activation verifies code, invalidates old sessions, keeps the current session and stores recovery hashes only',async t=>{
 const f=await fixture(t),other=await f.login(),prepared=await f.prepare();
 assert.throws(()=>f.store.adminMfa.enable(f.token,{setupId:prepared.setupId,code:'abcdef'}),{status:401});
 const result=f.store.adminMfa.enable(f.token,{setupId:prepared.setupId,code:totp(prepared.secret).generate()});
 assert.equal(result.recoveryCodes.length,10);assert.equal(f.store.session(other.token),null);assert(f.store.session(f.token));assert.equal(f.store.adminMfa.status(f.token).recoveryRemaining,10);
 assert.equal(JSON.stringify(f.value()).includes(result.recoveryCodes[0].replace(/-/g,'')),false);
 assert.equal(f.store.adminMfa.enable(f.token,{setupId:prepared.setupId,code:'000000'}).recoveryCodes,null);
});
test('password alone never creates a session after activation; recovery codes work only once across concurrent logins',async t=>{
 const f=await fixture(t),enabled=await f.enable();const before=f.raw.db.prepare('SELECT count(*) n FROM platform_sessions').get().n;
 await assert.rejects(f.login(),e=>e.code==='MFA_REQUIRED');assert.equal(f.raw.db.prepare('SELECT count(*) n FROM platform_sessions').get().n,before);
 const outcomes=await Promise.allSettled([f.login(enabled.recoveryCodes[0]),f.login(enabled.recoveryCodes[0])]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
});
test('TOTP is rejected after use and outside the narrow clock window',()=>{
 const secret='US3WHSG7X5KAPV27VANWKQHF3SH3HULL',now=1800000000000,code=totp(secret).generate({timestamp:now});
 const first=consume({secret,lastCounter:-1},code,'admin',now);assert(first);assert.equal(consume(first,code,'admin',now),null);assert.equal(consume({secret,lastCounter:-1},code,'admin',now+90000),null);
});
test('wrong MFA attempts persist rate limiting even when the password is correct',async t=>{
 const f=await fixture(t);await f.enable();for(let i=0;i<4;i++)await assert.rejects(f.login('not-a-code'),{status:401});await assert.rejects(f.login('not-a-code'),{status:429});await assert.rejects(f.login(),{status:429});
});
test('rotating recovery codes and disabling protection require password plus second factor and invalidate other sessions',async t=>{
 const f=await fixture(t),enabled=await f.enable(),other=await f.login(enabled.recoveryCodes[0]);
 const rotated=await f.store.adminMfa.recovery(f.token,{password,code:enabled.recoveryCodes[1]});assert.equal(rotated.recoveryCodes.length,10);assert.equal(f.store.session(other.token),null);
 await assert.rejects(f.login(enabled.recoveryCodes[2]),{status:401});await assert.rejects(f.store.adminMfa.disable(f.token,{password:'wrong',code:rotated.recoveryCodes[0]}),{status:401});
 await f.store.adminMfa.disable(f.token,{password,code:rotated.recoveryCodes[0]});assert.equal(f.store.adminMfa.status(f.token).enabled,false);assert((await f.login()).token);
});
test('password reset revokes sessions but does not bypass enabled MFA or discard the recovery codes',async t=>{
 const f=await fixture(t),enabled=await f.enable(),token=f.store.requestPasswordReset('admin@mfa.test'),next='Synthetic-next-admin-password';await f.store.resetPassword(token,next);
 assert.equal(f.store.session(f.token),null);await assert.rejects(f.store.login('admin@mfa.test',next),e=>e.code==='MFA_REQUIRED');assert((await f.store.login('admin@mfa.test',next,'','synthetic',enabled.recoveryCodes[0])).token);
});
