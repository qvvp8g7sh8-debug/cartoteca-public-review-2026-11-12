const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {organizationRestoreFixture}=require('./helpers/organization-restore-fixture.cjs');
const {createPlatformStore}=require('../platform-store.cjs');
const {prepareOrganizationRestore,verifyOrganizationRestore}=require('../src/server/infrastructure/backup/organization-restore.cjs');
const {applyOrganizationRestore,rollbackOrganizationRestore}=require('../src/server/infrastructure/backup/organization-switch.cjs');
const {dataInventory,inventoryFingerprint}=require('../src/server/infrastructure/backup/organization-inventory.cjs');
const {totp}=require('../src/server/modules/auth/admin-mfa-values.cjs');
const fingerprint=dir=>inventoryFingerprint(dataInventory(dir));
for(const version of [17,18,19,20])test('restore'+version+' pauses only selected push/schedule work and preserves current finances/MFA bytes',async t=>{
 const f=await organizationRestoreFixture(t,version),platformDir=path.join(f.source,'platform'),store=createPlatformStore(platformDir,{notificationSchema:version});
 const password='Synthetic-current-security-password';
 const admin=await store.bootstrapGlobalAdmin({email:'security@restore.test',password,displayName:'Synthetic operator'}),login=await store.login('security@restore.test',password);
 const preparedMfa=await store.adminMfa.prepare(login.token,{password,requestId:crypto.randomUUID()});store.adminMfa.enable(login.token,{setupId:preparedMfa.setupId,code:totp(preparedMfa.secret).generate()});
 if(version>=19){const command=values=>({requestId:crypto.randomUUID(),reason:'Synthetic financial preservation',...values});
  store.billing.packages.savePackage(admin.accountId,command({id:'voice',title:'Synthetic voice',priceKopecks:99000,taskLimit:10,enabled:true,expectedRevision:0}));
  store.billing.packages.grantTrial(admin.accountId,command({orgId:f.owners[0].organizationId,packageId:'voice'}));
  if(version>=20){store.billing.packages.savePackage(admin.accountId,command({id:'reports',serviceCode:'reports',serviceTitle:'Reports',periodMonths:12,quotaUnit:'access',title:'Synthetic reports',priceKopecks:250000,taskLimit:1,enabled:true,expectedRevision:0}));store.billing.packages.grantTrial(admin.accountId,command({orgId:f.owners[0].organizationId,packageId:'reports'}));}
 }
 store.close();const raw=f.openPlatform(),{db,seal}=raw;
 for(const [i,owner] of f.owners.slice(0,2).entries()){
  db.prepare('INSERT INTO staff_push_devices VALUES(?,?,?,?,?,?)').run('device-'+i,owner.organizationId,owner.accountId,'endpoint-'+i,seal({endpoint:'https://push.example.test/'+i}),1);
  db.prepare("INSERT INTO staff_push_jobs(id,organization_id,account_id,device_id,event_key,value,status,next_at,expires_at) VALUES(?,?,?,?,?,?,'pending',0,9999999999999)").run('push-'+i,owner.organizationId,owner.accountId,'device-'+i,'event-'+i,seal({synthetic:true}));
  if(version>=18){db.prepare('INSERT INTO notification_schedule VALUES(?,?,?,?,?,?,?,?)').run('client',owner.organizationId,'p','a',seal({synthetic:true}),1,9999999999999,'1');db.prepare('INSERT INTO notification_schedule_intents VALUES(?,?,?,?)').run('intent-'+i,owner.organizationId,9999999999999,seal({synthetic:true}));}
 }
 if(version>=19){
  const id=crypto.randomUUID(),org=f.owners[0].organizationId;db.prepare("INSERT INTO billing_payment_orders(id,organization_id,account_id,request_id,package_id,price_kopecks,state,config_revision,shop_id,test_mode,created_at,changed_at,paid_confirmed_at,fulfilled_at,value) VALUES(?,?,?,?,'voice',99000,'paid',1,'synthetic',1,1,1,1,1,?)").run(id,org,f.owners[0].accountId,crypto.randomUUID(),seal({order:{serviceCode:'voice-assistant'},refunds:[{id:'synthetic-refund',status:'succeeded',amountKopecks:10000}]}));
  if(version>=20){const grant=db.prepare('SELECT id FROM billing_package_grants WHERE organization_id=? ORDER BY id LIMIT 1').get(org);db.prepare('INSERT INTO billing_grant_revocations VALUES(?,?,?)').run(grant.id,'synthetic-reversal',2);db.prepare("INSERT INTO billing_financial_actions VALUES(?,?,?,?,?,'uncertain',1000,NULL,'fingerprint',0,1,1,?)").run(crypto.randomUUID(),admin.accountId,crypto.randomUUID(),id,'refund',seal({receiptEmail:'synthetic@example.test'}));}
 }
 const target=f.owners[0].organizationId,foreign=f.owners[1].organizationId;
 const runtime=db.prepare('INSERT OR REPLACE INTO telegram_runtime VALUES(?,?)');
 const hints=['push-interest-v1:all:'+target+':device-0','staff-interest-v1:telegram:delivery:'+JSON.stringify([target,'staff']),'staff-interest-v1:max:appointment:'+JSON.stringify([target,'staff'])];
 const retainedHints=['push-interest-v1:all:'+foreign+':device-1','push-interest-v1:all:'+target+'-extra:device','push-interest-v1:unknown:'+target+':device'];
 for(const key of [...hints,...retainedHints])runtime.run(key,seal({synthetic:true}));
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'billing_%' ORDER BY name").all().map(x=>x.name);
 const financial=new Map(tables.map(name=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]));
 const accounts=db.prepare('SELECT * FROM accounts ORDER BY id').all(),pushConfig=db.prepare('SELECT * FROM staff_push_config').all();raw.db.close();const before=fingerprint(f.source);
 const prepared=await prepareOrganizationRestore(f.options);await verifyOrganizationRestore(f);
 const candidate=new DatabaseSync(path.join(f.jobDirectory,'candidate/platform/platform.sqlite'),{readOnly:true});try{
  for(const[name,rows]of financial)assert.deepEqual(candidate.prepare('SELECT * FROM '+name+' ORDER BY rowid').all(),rows,name);
  for(const key of hints)assert.equal(candidate.prepare('SELECT 1 FROM telegram_runtime WHERE key=?').get(key),undefined,key);
  for(const key of retainedHints)assert(candidate.prepare('SELECT 1 FROM telegram_runtime WHERE key=?').get(key),key);
  assert.deepEqual(candidate.prepare('SELECT * FROM accounts ORDER BY id').all(),accounts);assert.deepEqual(candidate.prepare('SELECT * FROM staff_push_config').all(),pushConfig);
  assert.equal(candidate.prepare('SELECT count(*) n FROM staff_push_devices WHERE organization_id=?').get(f.owners[0].organizationId).n,0);
  assert.equal(candidate.prepare('SELECT count(*) n FROM staff_push_devices WHERE organization_id=?').get(f.owners[1].organizationId).n,1);
  assert.equal(candidate.prepare("SELECT status FROM staff_push_jobs WHERE id='push-1'").get().status,'pending');
  if(version>=18){assert.equal(candidate.prepare("SELECT count(*) n FROM notification_schedule_intents WHERE id='intent-0'").get().n,0);assert.equal(candidate.prepare("SELECT count(*) n FROM notification_schedule_intents WHERE id='intent-1'").get().n,1);}
  assert.deepEqual(candidate.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{candidate.close();}
 assert.equal(fingerprint(f.source),before);const options={...f,confirmation:prepared.id,stopped:true};await applyOrganizationRestore(options);rollbackOrganizationRestore(options);assert.equal(fingerprint(f.source),before);
});


test('full disaster restore retains enabled MFA but discards unfinished setup and old sessions',async t=>{
 const f=await organizationRestoreFixture(t,20),dir=path.join(f.source,'platform'),store=createPlatformStore(dir,{notificationSchema:20});
 const password='Synthetic-disaster-password',admin=await store.bootstrapGlobalAdmin({email:'mfa@disaster.test',password,displayName:'Synthetic operator'}),login=await store.login('mfa@disaster.test',password);
 const setup=await store.adminMfa.prepare(login.token,{password,requestId:crypto.randomUUID()}),enabled=store.adminMfa.enable(login.token,{setupId:setup.setupId,code:totp(setup.secret).generate()});store.close();
 const raw=f.openPlatform(),value=raw.open(raw.db.prepare('SELECT value FROM accounts WHERE id=?').get(admin.accountId).value);value.adminMfaPending={secret:'obsolete-pending',expiresAt:Date.now()+600000};raw.db.prepare('UPDATE accounts SET value=? WHERE id=?').run(raw.seal(value),admin.accountId);raw.db.close();
 const {createV2Backup,restoreV2Backup}=require('../src/server/infrastructure/backup/service.cjs');
 const backup=await createV2Backup({source:f.source,directory:path.join(f.directory,'mfa-archives'),keyFile:f.keyFile});
 const destination=path.join(f.directory,'mfa-recovered');await restoreV2Backup(backup.file,f.keyFile,destination);
 const recovered=createPlatformStore(path.join(destination,'platform'),{notificationSchema:20});try{assert.equal(recovered.session(login.token),null);await assert.rejects(recovered.login('mfa@disaster.test',password),e=>e.code==='MFA_REQUIRED');await assert.rejects(recovered.login('mfa@disaster.test',password,'','synthetic',enabled.recoveryCodes[0]),{status:401});const next=await recovered.login('mfa@disaster.test',password,'','synthetic',totp(setup.secret).generate({timestamp:Date.now()+30000}));assert(recovered.adminMfa.status(next.token).enabled);assert.equal(recovered.adminMfa.status(next.token).recoveryRemaining,0);const {createPlatformDatabase}=require('../src/server/infrastructure/platform-database.cjs');const checked=createPlatformDatabase(path.join(destination,'platform'),{notificationSchema:20});try{assert.equal(checked.open(checked.db.prepare('SELECT value FROM accounts WHERE id=?').get(admin.accountId).value).adminMfaPending,undefined);}finally{checked.db.close();}}finally{recovered.close();}
});

test('runtime ownership policy has exact organization boundaries for all derived hint formats',()=>{
 const {organizationInterestPolicy}=require('../src/server/infrastructure/backup/organization-runtime-policy.cjs');const db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE staff_notification_jobs(id TEXT,organization_id TEXT); CREATE TABLE staff_max_jobs(id TEXT,organization_id TEXT)');db.prepare('INSERT INTO staff_notification_jobs VALUES(?,?)').run('ours','a');db.prepare('INSERT INTO staff_notification_jobs VALUES(?,?)').run('theirs','ab');const matches=organizationInterestPolicy(db,'a');
 for(const key of ['client-interest-v1:all:a','push-interest-v1:all:a:device','staff-interest-v1:telegram:delivery:'+JSON.stringify(['a','account']),'staff-selftest-v1:telegram:ours'])assert(matches(key),key);
 for(const key of ['client-interest-v1:all:ab','push-interest-v1:all:ab:device','push-interest-v1:unknown:a:device','staff-interest-v1:telegram:delivery:'+JSON.stringify(['ab','account']),'staff-selftest-v1:telegram:theirs','staff-selftest-v1:max:ours'])assert.equal(matches(key),false,key);
 }finally{db.close();}
});
