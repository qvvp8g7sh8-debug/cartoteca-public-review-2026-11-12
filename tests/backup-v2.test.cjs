const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite'),sharp=require('sharp'),tar=require('tar-stream');
const {createPlatformStore}=require('../platform-store.cjs'),{createPlatformDatabase}=require('../src/server/infrastructure/platform-database.cjs');
const {createStorage}=require('../storage.cjs'),{createMultiServer}=require('../multi-server.cjs');
const {createV2Backup,verifyV2Backup,restoreV2Backup,createBackupKey}=require('../src/server/infrastructure/backup/service.cjs');
const {extractArchive,writeArchive,digest}=require('../src/server/infrastructure/backup/archive.cjs');
const {spawn}=require('node:child_process');
const password='Synthetic-backup-password-2026';
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-v2-backup-test-')),source=path.join(dir,'source'),directory=path.join(dir,'archives'),keyFile=path.join(dir,'keys','backup.key');
  t.after(()=>{if(path.dirname(dir)===path.resolve(os.tmpdir())&&path.basename(dir).startsWith('cartoteca-v2-backup-test-'))fs.rmSync(dir,{recursive:true,force:true});});
  const platform=createPlatformStore(path.join(source,'platform'));
  const owner=await platform.registerOwner({email:'owner@example.test',password,displayName:'Synthetic owner',organizationName:'Synthetic organization'});platform.verifyEmail(owner.verificationToken);
  const other=await platform.registerOwner({email:'other@example.test',password,displayName:'Synthetic other',organizationName:'Other organization'});platform.verifyEmail(other.verificationToken);
  const unused=await platform.registerOwner({email:'unused@example.test',password,displayName:'Synthetic unused',organizationName:'Unopened organization'});platform.verifyEmail(unused.verificationToken);
  const admin=await platform.bootstrapGlobalAdmin({email:'admin@example.test',password,displayName:'Synthetic global admin'});
  const invitation=platform.createInvitation({organizationId:owner.organizationId,invitedBy:owner.accountId,role:'cosmetologist'});
  const staff=await platform.acceptInvitation({token:invitation.token,email:'staff@example.test',password,displayName:'Synthetic employee'});
  const session=await platform.login('owner@example.test',password);
  const image=await sharp({create:{width:4,height:4,channels:3,background:'#204060'}}).png().toBuffer();
  const cabinets=[];
  for(const [root,user]of [['',owner],['tenants/'+owner.organizationId,staff],['tenants/'+other.organizationId,other]]){
    const storage=createStorage(path.join(source,root));
    storage.write({revision:0,services:[{id:'service',name:'Synthetic service',duration:'30',price:100,type:'Уход'}],patients:[{id:'p',name:'Synthetic patient',createdBy:user.accountId,notes:'PRIVATE NOTE',visits:[{id:'v',date:'2020-01-01',procedure:'Synthetic',staffId:user.accountId,photos:[{data:'data:image/png;base64,'+image.toString('base64')}]}],appointments:[{id:'a',date:'2030-01-01',time:'12:00',duration:30,service:'Synthetic',staffId:user.accountId}]}]});
    const state=storage.read(),id=state.patients[0].visits[0].photos[0].data.split('/').pop();cabinets.push({root,state,id,image:storage.photo(id).buffer});storage.close();
  }
  const token=platform.telegram.issueLink(owner.organizationId,'p',owner.accountId);
  platform.telegram.consumeLink(token,'synthetic-chat',()=>true);platform.telegram.saveSettings(owner.organizationId,owner.accountId,{enabled:true,leadMinutes:120,timeZone:'Europe/Moscow',showServices:true});
  platform.telegram.enqueue(owner.organizationId,'p',cabinets[1].state.patients[0].appointments[0],'synthetic-stamp',platform.telegram.link(owner.organizationId,'p'),Date.now()+86400000);
  const job=platform.telegram.claim();platform.telegram.confirm(job,'synthetic-chat');const confirmedAt=platform.telegram.confirmed(owner.organizationId,'p','synthetic-stamp');
  platform.withWriteLock(()=>platform.appointmentConfirmations.set(owner.organizationId,'p',cabinets[1].state.patients[0].appointments[0],'Europe/Moscow',owner.accountId,true,123456789));
  const supportReceipt=platform.support.create({accountId:owner.accountId,organizationId:owner.organizationId},{requestId:crypto.randomUUID(),description:'SUPPORT PRIVATE',diagnostics:null});
  const scheduleStorage=createStorage(path.join(source,'tenants',owner.organizationId));
  try { platform.workSchedules.save(session.token,{staffId:staff.accountId,dates:['2035-01-01'],status:'working',intervals:[['09:00','13:00'],['14:00','19:00']],revision:0,expectedTimeZone:'Europe/Moscow'},scheduleStorage); }
  finally { scheduleStorage.close(); }
  platform.workSchedules.permission(session.token,{staffId:staff.accountId,revision:1,allowSelfEdit:false});
  const emailed=platform.prepareEmailInvitation({organizationId:owner.organizationId,actorId:owner.accountId,email:'backup-invite@example.test',role:'cosmetologist'});
  platform.finishEmailInvitation({organizationId:owner.organizationId,actorId:owner.accountId,invitationId:emailed.id,token:emailed.token},true);
  const personal=platform.staffNotifications.issue(session.token);
  platform.staffNotifications.consume(personal.token,'10000001');
  platform.withWriteLock(()=>platform.bookingRequests.create(owner.organizationId,'synthetic-backup-staff-notification',{kind:'other-time',staffId:owner.accountId,date:'2035-01-01',time:'10:00',duration:30,services:[{name:'Synthetic service'}]},30));
  platform.close();createBackupKey(keyFile);
  return {dir,source,directory,keyFile,cabinets,owner,other,unused,admin,staff,session,job,confirmedAt,supportReceipt,emailed,personal,options:{source,directory,keyFile}};
}
test('complete encrypted v2 backup preserves accounts/passwords/roles/all cabinets/photos and revokes restored sessions and calendar links',async t=>{
  const f=await fixture(t),live=createPlatformStore(path.join(f.source,'platform'));
  let result, calendarCredentials, accountBefore, organizationAdmin, adminSession, adminCalendarCredentials;
  try {
    calendarCredentials = Object.fromEntries(
      ['apple', 'google'].map(provider => [
        provider, live.calendarSubscription.connect(f.session.token, () => {}, provider).credential,
      ]),
    );
    const adminInvitation = live.createInvitation({
      organizationId: f.owner.organizationId, invitedBy: f.owner.accountId, role: 'salon_admin',
    });
    organizationAdmin = await live.acceptInvitation({
      token: adminInvitation.token, email: 'calendar-admin@example.test', password,
      displayName: 'Synthetic calendar administrator',
    });
    adminSession = await live.login('calendar-admin@example.test', password);
    adminCalendarCredentials = Object.fromEntries(['apple', 'google'].map(provider => [
      provider, live.calendarSubscription.connect(adminSession.token, () => {}, provider).credential,
    ]));
    const sourceAccounts = createPlatformDatabase(path.join(f.source, 'platform'));
    try {
      accountBefore = sourceAccounts.open(sourceAccounts.db.prepare('SELECT value FROM accounts WHERE id=?').get(f.owner.accountId).value);
      delete accountBefore.calendarSubscriptions;
    } finally { sourceAccounts.db.close(); }
    result = await createV2Backup(f.options);
    assert.equal(live.session(f.session.token).accountId, f.owner.accountId);
    for (const credential of Object.values(calendarCredentials))
      assert.equal(live.calendarSubscription.resolve(credential).accountId, f.owner.accountId);
    assert.equal(live.session(adminSession.token).role, 'salon_admin');
    for (const credential of Object.values(adminCalendarCredentials)) {
      const resolved = live.calendarSubscription.resolve(credential);
      assert.equal(resolved.accountId, organizationAdmin.accountId);
      assert.equal(resolved.role, 'salon_admin');
    }
    // The archive predates revocation; disaster recovery must not resurrect any link.
    for (const provider of ['apple', 'google'])
      live.calendarSubscription.disconnect(f.session.token, () => {}, provider);
    for (const provider of ['apple', 'google'])
      live.calendarSubscription.disconnect(adminSession.token, () => {}, provider);
    for (const credential of Object.values(adminCalendarCredentials))
      assert.throws(() => live.calendarSubscription.resolve(credential), { status: 404 });
    for (const credential of Object.values(calendarCredentials))
      assert.throws(() => live.calendarSubscription.resolve(credential), { status: 404 });
  } finally { live.close(); }
  assert.equal(result.verified,true);assert.equal(result.accounts,6);assert.equal(result.organizations,3);assert.equal(result.cabinets,3);assert.equal(result.patients,3);assert.equal(result.photos,3);
  const verified=await verifyV2Backup(result.file,f.keyFile);assert.equal(verified.photos,3);
  const destination=path.join(f.dir,'recovered'),restored=await restoreV2Backup(result.file,f.keyFile,destination);assert.equal(restored.sessionsRevoked,true);assert.equal(restored.notificationsPaused,true);
  assert.equal(fs.existsSync(path.join(destination,'.restore-in-progress')),false);
  const recoveredAccounts = createPlatformDatabase(path.join(destination, 'platform'));
  try {
    assert.deepEqual(
      recoveredAccounts.open(recoveredAccounts.db.prepare('SELECT value FROM accounts WHERE id=?').get(f.owner.accountId).value),
      accountBefore,
    );
  } finally { recoveredAccounts.db.close(); }
  const platform=createPlatformStore(path.join(destination,'platform'));
  try{
    assert.equal(platform.session(f.session.token),null);
    assert.equal(platform.session(adminSession.token),null);
    const recoveredAdminLogin = await platform.login('calendar-admin@example.test', password);
    assert.equal(platform.session(recoveredAdminLogin.token).role, 'salon_admin');
    for (const provider of ['apple', 'google']) {
      const status = platform.calendarSubscription.status(recoveredAdminLogin.token, provider);
      assert.equal(status.connected, false);
      assert.equal(status.credential, null);
      assert.throws(() => platform.calendarSubscription.resolve(adminCalendarCredentials[provider]), { status: 404 });
      const renewed = platform.calendarSubscription.connect(recoveredAdminLogin.token, () => {}, provider);
      assert.notEqual(renewed.credential, adminCalendarCredentials[provider]);
      assert.equal(platform.calendarSubscription.resolve(renewed.credential).accountId, organizationAdmin.accountId);
      assert.equal(platform.calendarSubscription.resolve(renewed.credential).role, 'salon_admin');
    }
    assert.deepEqual(platform.emailInvitations(f.owner.organizationId,f.owner.accountId),[]);
    assert.throws(()=>platform.emailInvitationInfo(f.emailed.token),{status:400});
    const scheduleLogin=await platform.login('owner@example.test',password);
    for (const provider of ['apple', 'google']) {
      assert.deepEqual(platform.calendarSubscription.status(scheduleLogin.token, provider), { connected: false, credential: null });
      assert.throws(() => platform.calendarSubscription.resolve(calendarCredentials[provider]), { status: 404 });
      const renewed = platform.calendarSubscription.connect(scheduleLogin.token, () => {}, provider);
      assert.notEqual(renewed.credential, calendarCredentials[provider]);
      assert.equal(platform.calendarSubscription.resolve(renewed.credential).accountId, f.owner.accountId);
    }
    const schedule=platform.workSchedules.view(scheduleLogin.token,f.staff.accountId,'2035-01-01','2035-01-01');
    assert.deepEqual(schedule.days['2035-01-01'].intervals,[['09:00','13:00'],['14:00','19:00']]);
    assert.equal(schedule.allowSelfEdit,false);assert.equal(schedule.revision,2);
    for(const [email,user,role]of [['owner@example.test',f.owner,'owner'],['other@example.test',f.other,'owner'],['staff@example.test',f.staff,'cosmetologist'],['admin@example.test',f.admin,null]]){
      const login=await platform.login(email,password);assert.equal(login.account.id,user.accountId);const current=platform.session(login.token);if(role)assert.equal(current.role,role);else assert.equal(current.globalAdmin,true);
    }
    assert.equal(platform.telegram.settings(f.owner.organizationId).enabled,false);assert.equal(platform.telegram.link(f.owner.organizationId,'p').chatId,'synthetic-chat');
    assert.ok(f.confirmedAt);assert.equal(platform.telegram.confirmed(f.owner.organizationId,'p','synthetic-stamp'),f.confirmedAt);
    assert.equal(platform.appointmentConfirmations.read(f.owner.organizationId,'p',f.cabinets[1].state.patients[0].appointments[0],'Europe/Moscow').manualConfirmedAt,123456789);
    assert.equal(platform.telegram.callback(f.job.decoded.callback),null);assert.equal(platform.telegram.claim(),null);
    const relogin=await platform.login('owner@example.test',password);
    assert.equal(platform.staffNotifications.status(relogin.token).linked,true);
    assert.equal(platform.staffNotifications.status(relogin.token).enabled,false);
    assert.equal(platform.staffNotifications.claim(),null);
    assert.throws(()=>platform.staffNotifications.consume(f.personal.token,'10000001'),{status:400});
    assert.equal(platform.support.receipt(f.owner.accountId,f.supportReceipt.id).deliveries.telegram,'failed');assert.equal(platform.support.claim('telegram'),null);
    assert.throws(()=>platform.telegram.consumeLink('not-a-token','synthetic-chat',()=>true));
  }finally{platform.close();}
  for(const c of f.cabinets){const storage=createStorage(path.join(destination,c.root));try{assert.deepEqual(storage.read(),c.state);assert.deepEqual(storage.photo(c.id).buffer,c.image);}finally{storage.close();}}
  assert.equal(fs.existsSync(path.join(destination,'tenants',f.unused.organizationId)),false);
  const checked=createPlatformDatabase(path.join(destination,'platform'));
  assert.deepEqual(checked.db.prepare('PRAGMA foreign_key_check').all(),[]);checked.db.close();
  await assert.rejects(restoreV2Backup(result.file,f.keyFile,destination),/must not exist/);
  assert.doesNotMatch(fs.readFileSync(result.file).toString('utf8'),/PRIVATE NOTE|SUPPORT PRIVATE|Synthetic patient|example\.test/);
  assert.deepEqual(fs.readdirSync(f.directory),[path.basename(result.file)]);
});
test('schema 11 backup preserves support history and audit but cancels pending recovery and mail on restore',async t=>{
  const f=await fixture(t), platform=createPlatformStore(path.join(f.source,'platform'));
  const raw=createPlatformDatabase(path.join(f.source,'platform'));
  const command=(kind,id,changes={})=>({requestId:crypto.randomUUID(),expectedRevision:raw.db.prepare(
    'SELECT revision FROM admin_resource_versions WHERE kind=? AND resource_id=?').get(kind,id)?.revision||0,
    reason:'Synthetic backup verification',...changes});
  let token,requestId;
  try {
    const profile=command('organization',f.owner.organizationId,{changes:{city:'Synthetic admin city'}});
    requestId=profile.requestId;
    platform.admin.updateProfile(f.admin.accountId,f.owner.organizationId,profile);
    platform.admin.support.message(f.admin.accountId,f.supportReceipt.id,
      command('support',f.supportReceipt.id,{kind:'internal',text:'PRIVATE ADMIN NOTE'}));
    platform.admin.support.message(f.admin.accountId,f.supportReceipt.id,
      command('support',f.supportReceipt.id,{kind:'reply',text:'Synthetic public support reply'}));
    const recovery=platform.admin.prepareEmailRecovery(f.admin.accountId,f.owner.accountId,
      command('account',f.owner.accountId,{email:'recovered@example.test',identityConfirmed:true}),'https://synthetic.test');
    const payload=raw.open(raw.db.prepare('SELECT value FROM admin_email_jobs WHERE operation_id=?').get(recovery.recoveryId).value);
    token=new URL(payload.link).hash.split('=')[1];
    assert.ok(platform.admin.emailQueue.claim());
  } finally {raw.db.close();platform.close();}
  const backup=await createV2Backup(f.options),destination=path.join(f.dir,'admin-recovered');
  await restoreV2Backup(backup.file,f.keyFile,destination);
  const restored=createPlatformStore(path.join(destination,'platform')),checked=createPlatformDatabase(path.join(destination,'platform'));
  try {
    assert.equal(restored.organization(f.owner.organizationId).city,'Synthetic admin city');
    assert.equal(restored.admin.support.detail(f.admin.accountId,f.supportReceipt.id).messages.length,2);
    const receipt=restored.support.receipt(f.owner.accountId,f.supportReceipt.id);
    assert.equal(receipt.messages.length,1);assert.doesNotMatch(JSON.stringify(receipt),/PRIVATE ADMIN NOTE/);
    assert.equal(restored.admin.audit(f.admin.accountId,{event:'organization_profile_admin_updated'}).items.length,1);
    assert.equal(restored.admin.operation(f.admin.accountId,requestId).result,null);
    assert.equal(restored.admin.emailQueue.claim(),null);
    assert.deepEqual(checked.db.prepare('SELECT DISTINCT status FROM admin_email_jobs').all().map(x=>x.status),['cancelled']);
    assert.throws(()=>restored.admin.confirmEmailRecovery(token),{status:400});
    assert.equal((await restored.login('owner@example.test',password)).account.id,f.owner.accountId);
    assert.doesNotMatch(fs.readFileSync(backup.file).toString('utf8'),/PRIVATE ADMIN NOTE|recovered@example/);
  } finally {checked.db.close();restored.close();}
});

test('schema 3 backups remain verifiable and restore through the schema 4 migration',async t=>{
  const f=await fixture(t),old=createPlatformDatabase(path.join(f.source,'platform'));
  require('./helpers/platform-inspection.cjs').dropAdminSchema(old.db);old.db.exec('DROP TABLE staff_notification_jobs; DROP TABLE staff_telegram_tokens; DROP TABLE staff_telegram_links; DROP TABLE booking_requests; DROP TABLE email_invitations; DROP TABLE appointment_manual_confirmations; PRAGMA user_version=3;');old.db.close();
  const result=await createV2Backup(f.options);assert.equal((await verifyV2Backup(result.file,f.keyFile)).accounts,5);
  const destination=path.join(f.dir,'old-recovered');await restoreV2Backup(result.file,f.keyFile,destination);
  const restored=createPlatformStore(path.join(destination,'platform'));try{assert.ok(await restored.login('owner@example.test',password));assert.equal(restored.appointmentConfirmations.read(f.owner.organizationId,'p',f.cabinets[1].state.patients[0].appointments[0],'Europe/Moscow'),null);}finally{restored.close();}
});
test('missing key/photo never publishes success or changes source data or previous backups',async t=>{
  const f=await fixture(t),first=await createV2Backup(f.options),db=path.join(f.source,'tenants',f.owner.organizationId,'cabinet.sqlite'),before=await digest(db);
  const photo=path.join(f.source,'tenants',f.owner.organizationId,'photos',f.cabinets[1].id+'.enc'),removed=photo+'.saved';fs.renameSync(photo,removed);
  await assert.rejects(createV2Backup(f.options),/ENOENT/);fs.renameSync(removed,photo);
  const key=path.join(f.source,'tenants',f.owner.organizationId,'encryption.key'),saved=key+'.saved';fs.renameSync(key,saved);
  await assert.rejects(createV2Backup(f.options),/ENOENT/);assert.equal(fs.existsSync(key),false);fs.renameSync(saved,key);
  assert.equal(await digest(db),before);assert.deepEqual(fs.readdirSync(f.directory),[path.basename(first.file)]);assert.equal((await verifyV2Backup(first.file,f.keyFile)).photos,3);
  await assert.rejects(createV2Backup({...f.options,keyFile:path.join(f.directory,'backup.key')}),/separately/);
  await assert.rejects(createV2Backup({...f.options,directory:path.join(f.source,'archives')}),/independent/);
  assert.throws(()=>createBackupKey(f.keyFile),{code:'EEXIST'});
});
test('authentication, checksum and clinical-photo validation fail closed before destination publication',async t=>{
  const f=await fixture(t),first=await createV2Backup(f.options),corrupt=path.join(f.dir,'corrupt.enc'),bytes=fs.readFileSync(first.file);bytes[50]^=1;fs.writeFileSync(corrupt,bytes);
  const destination=path.join(f.dir,'must-not-exist');await assert.rejects(restoreV2Backup(corrupt,f.keyFile,destination));assert.equal(fs.existsSync(destination),false);
  const wrong=path.join(f.dir,'wrong.key');createBackupKey(wrong);await assert.rejects(verifyV2Backup(first.file,wrong));
  const stage=path.join(f.dir,'forge');fs.mkdirSync(stage);const key=fs.readFileSync(f.keyFile),{recovered}=await extractArchive(first.file,key,stage);
  const manifest=JSON.parse(fs.readFileSync(path.join(recovered,'manifest.json'),'utf8')),file=manifest.files.find(x=>x.name.endsWith('.enc'));const photo=path.join(recovered,file.name),bad=fs.readFileSync(photo);bad[30]^=1;fs.writeFileSync(photo,bad);
  file.sha256=await digest(photo);fs.writeFileSync(path.join(recovered,'manifest.json'),JSON.stringify(manifest));const forged=path.join(f.dir,'forged.enc');await writeArchive(recovered,['manifest.json',...manifest.files.map(x=>x.name)],forged,key);
  await assert.rejects(restoreV2Backup(forged,f.keyFile,destination));assert.equal(fs.existsSync(destination),false);
  const remainder=fs.readdirSync(f.dir).filter(n=>n.startsWith('.cartoteca-v2-'));assert.deepEqual(remainder,[]);
});
async function maliciousArchive(file,key,entries){
  const pack=tar.pack(),chunks=[],complete=(async()=>{for await(const chunk of pack)chunks.push(chunk);})();
  for(const entry of entries)await new Promise((resolve,reject)=>pack.entry(entry.header,entry.body||'',error=>error?reject(error):resolve()));pack.finalize();await complete;
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([cipher.update(Buffer.concat(chunks)),cipher.final()]);fs.writeFileSync(file,Buffer.concat([Buffer.from('CARTOBK2'),iv,data,cipher.getAuthTag()]));
}
test('authenticated archives reject traversal, duplicate entries and links, and incomplete restore cannot start',async t=>{
  const f=await fixture(t),key=fs.readFileSync(f.keyFile),destination=path.join(f.dir,'unsafe');
  for(const [i,entries]of [
    [{header:{name:'../escaped',type:'file'},body:'unsafe'}],
    [{header:{name:'manifest.json',type:'file'},body:'{}'},{header:{name:'manifest.json',type:'file'},body:'{}'}],
    [{header:{name:'platform/platform.key',type:'symlink',linkname:'../../escaped'}}],
  ].entries()){
    const file=path.join(f.dir,'unsafe-'+i+'.enc');await maliciousArchive(file,key,entries);await assert.rejects(restoreV2Backup(file,f.keyFile,destination),/Unsafe/);assert.equal(fs.existsSync(destination),false);assert.equal(fs.existsSync(path.join(f.dir,'escaped')),false);
  }
  const unfinished=path.join(f.dir,'unfinished');fs.mkdirSync(unfinished);fs.writeFileSync(path.join(unfinished,'.restore-in-progress'),'2');
  assert.throws(()=>createMultiServer({dataDir:unfinished,sendMail:null,telegramBot:null}),/incomplete/);assert.equal(fs.existsSync(path.join(unfinished,'platform')),false);
});
test('online snapshots remain coherent with another process committing platform and cabinet changes',async t=>{
  const f=await fixture(t),worker=spawn(process.execPath,[path.join(__dirname,'fixtures','backup-writer.cjs'),f.source,f.owner.organizationId],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  let errors='';worker.stderr.on('data',chunk=>{errors+=chunk;});
  const ended=new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('close',code=>code===0?resolve():reject(Error('Synthetic writer stopped unexpectedly: '+errors)));});ended.catch(()=>{});
  try{
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('Synthetic writer startup timeout.')),5000);
      worker.stdout.once('data',()=>{clearTimeout(timeout);resolve();});worker.once('error',error=>{clearTimeout(timeout);reject(error);});
    });
    for(let i=0;i<3;i++){
      const result=await createV2Backup(f.options),destination=path.join(f.dir,'coherent-'+i);await restoreV2Backup(result.file,f.keyFile,destination);
      const platform=createPlatformStore(path.join(destination,'platform')),cabinet=createStorage(path.join(destination,'tenants',f.owner.organizationId));
      try{const name=platform.organization(f.owner.organizationId).name,notes=cabinet.readSelected(['p']).patients[0].notes;assert.match(name,/^Synthetic coherent /);assert.equal(notes,name);}finally{platform.close();cabinet.close();}
    }
  }finally{worker.stdin.end();await ended;}
});
