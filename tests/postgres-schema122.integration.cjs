const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {Client}=require('pg');
const {nativeIsolatedFixture}=require('./helpers/native-isolated-fixture.cjs');
const {startPostgresTestRuntime}=require('../scripts/postgres-test-runtime.cjs');
const {canonicalSqliteSchema,canonicalCabinetTemplateHashes}=require('../src/server/infrastructure/postgres/catalog-canonical.cjs');
const {registerCanonicalTemplate}=require('../src/server/infrastructure/postgres/schema-prepare.cjs');
const {createPostgresCoordinator}=require('../src/server/infrastructure/postgres/coordinator.cjs');
const {openRuntimeStore}=require('../src/server/infrastructure/postgres/runtime.cjs');
const {nativeSchemaPlan}=require('../src/server/infrastructure/postgres/schema-plan.cjs');
const {digest}=require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const {migratePostgresData,sourceStores}=require('../src/server/infrastructure/postgres/migration.cjs');
const {assetHash}=require('../src/server/infrastructure/postgres/migration-assets.cjs');
const {validatePostgresSchema,verifyAssetProfile}=require('../src/server/infrastructure/postgres/catalog-postgres.cjs');

test('canonical PostgreSQL plans retain source versions, native tenant keys, RLS and immutable finance triggers',()=>{
  for(const version of [0,1,2]) {
    const catalog=canonicalSqliteSchema({kind:'cabinet',version});assert.equal(catalog.version,version);
    const plan=nativeSchemaPlan('cabinet',catalog);
    assert.ok(plan.objects.some(object=>object.sql.includes('FORCE ROW LEVEL SECURITY')));
    assert.ok(plan.objects.filter(object=>object.type==='table').every(object=>object.sql.includes('_store_id')));
  }
  const billing=canonicalSqliteSchema({kind:'platform',version:20,components:{assistantRows:true,notificationMaintenance:true,bookingPublicLinks:true}});
  const plan=nativeSchemaPlan('platform',billing);
  assert.ok(plan.objects.some(object=>object.type==='trigger'&&object.name==='billing_financial_frozen'));
  assert.ok(plan.objects.some(object=>object.type==='trigger'&&object.name==='billing_entries_immutable_delete'));
  assert.ok(plan.objects.some(object=>object.type==='index'&&object.name==='billing_payment_open_service'&&object.sql.includes('WHERE')));
  assert.match(plan.objects.find(object=>object.type==='table'&&object.name==='billing_package_definitions').sql,/CHECK\(cartoteca_catalog\.json_valid\("receipt_json"\)<>0\)/,'integer JSON validity is coerced only in native CHECK');
  assert.equal(digest({a:1,b:2}),digest({b:2,a:1}),'JSONB key order cannot change a manifest hash');
  const unknown=structuredClone(billing);unknown.objects.push({type:'trigger',name:'unknown',tbl_name:'accounts',sql:'CREATE TRIGGER unknown AFTER INSERT ON accounts BEGIN DELETE FROM accounts; END'});
  assert.throws(()=>nativeSchemaPlan('platform',unknown),/Unsupported mutating/);
});

test('offline PostgreSQL import verifies every typed row and rollback, assets, RLS, revisions and scoped provisioning',{timeout:120000},async(t)=>{
  const fixture=await nativeIsolatedFixture(t,{organizations:2});
  const directory=path.join(fixture.directory,'platform');
  const database=require('../src/server/infrastructure/platform-database.cjs').createPlatformDatabase(directory);
  try {
    for(const [file,name] of [['012-max-connections','migrateMaxConnections'],['013-notification-queue','migrateNotificationQueue'],['014-notification-channels','migrateNotificationChannels'],['015-max-inbox','migrateMaxInbox'],['016-staff-max','migrateStaffMax'],['017-staff-push','migrateStaffPush'],['018-notification-schedule','migrateNotificationSchedule'],['019-paid-services','migratePaidServices']]) require('../src/server/migrations/'+file+'.cjs')[name](database,directory,{offline:true});
    require('../src/server/modules/assistant/access/store.cjs').createAssistantFileStore({directory,seal:database.seal,open:database.open}).update(state=>{state.policy.instructions='Synthetic migration policy';state.revision++;});
    database.db.prepare('INSERT INTO login_limits VALUES(?,?,?,?)').run('booking-budget:site-read:synthetic',2,0,3000);
  } finally {database.closeWriter();database.db.close();}
  const preparation=path.join(fixture.directory,'.restore-in-progress');
  fs.writeFileSync(preparation,'assistant-state-rows-preparation-v1',{flag:'wx',mode:0o600});
  try {require('../src/server/migrations/001-assistant-state-rows.cjs').migrateAssistantStateRows(directory);}
  finally {fs.unlinkSync(preparation);}
  fs.writeFileSync(preparation,'booking-read-budget-preparation-v1',{flag:'wx',mode:0o600});
  try {require('../src/server/migrations/001-booking-read-budget.cjs').migrateBookingReadBudget(directory);}
  finally {fs.unlinkSync(preparation);}
  const cabinetPath=path.join(fixture.directory,'tenants',fixture.actors[0].organizationId);
  const storage=require('../src/server/infrastructure/cabinet-storage.cjs').createStorage(cabinetPath);
  const photoId='a'.repeat(32),photoCipher=storage.seal(Buffer.from('Synthetic immutable photo payload'));
  try {
    storage.db.prepare('INSERT INTO photos(id,mime,active) VALUES(?,?,1)').run(photoId,'image/jpeg');
    fs.writeFileSync(path.join(storage.photoDir,photoId+'.enc'),photoCipher,{flag:'wx',mode:0o600});
    require('../src/server/migrations/002-cabinet-records.cjs').migrateCabinetRecords(storage);
  } finally {storage.close();}
  const assistantHash=assetHash(path.join(directory,'assistant-state.enc'));
  const runtime=await startPostgresTestRuntime();
  const admin=new Client(runtime.admin),app=new Client(runtime.application);
  const destination=path.join(os.tmpdir(),'cartoteca-pg-assets-'+randomUUID());
  t.after(async()=>{await app.end();await admin.end();await runtime.close();
    if(fs.existsSync(destination)) {assert.equal(path.dirname(destination),path.resolve(os.tmpdir()));assert.ok(path.basename(destination).startsWith('cartoteca-pg-assets-'));fs.rmSync(destination,{recursive:true,force:true});}
  });
  await admin.connect();await app.connect();
  const sourceKey=assetHash(path.join(fixture.directory,'platform','platform.key'));
  const dry=await migratePostgresData({source:fixture.directory,client:admin,offline:true});
  assert.equal(dry.rolledBack,true);assert.equal(fs.existsSync(destination),false);
  assert.equal((await admin.query("SELECT 1 FROM pg_namespace WHERE nspname='cartoteca_platform'")).rows.length,0);
  const result=await migratePostgresData({source:fixture.directory,destination,client:admin,offline:true,dryRun:false});
  assert.equal(result.cutover,false);assert.ok(result.reports.every(store=>store.tables.every(table=>/^[a-f0-9]{64}$/.test(table.sha256))));
  const profile=JSON.parse(fs.readFileSync(path.join(destination,'postgresql-runtime.json'),'utf8'));
  assert.equal(assetHash(path.join(destination,'platform','platform.key')),sourceKey);
  assert.equal(assetHash(path.join(fixture.directory,'platform','platform.key')),sourceKey);
  assert.equal(fs.existsSync(path.join(destination,'platform','platform.sqlite')),false);
  assert.equal(fs.readFileSync(path.join(destination,'encryption.key')).length,32,'new empty root owns a new key only');
  assert.deepEqual(profile.cabinetTemplates,canonicalCabinetTemplateHashes());
  assert.equal((await verifyAssetProfile(app,profile)).verified,true);
  const wrongLineage={...profile,migrationId:randomUUID()};
  await assert.rejects(verifyAssetProfile(app,wrongLineage),error=>error.code==='POSTGRES_ASSET_PROFILE_MISMATCH');
  const binding=(await admin.query("SELECT c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cartoteca_catalog' AND c.relname='asset_profiles'")).rows[0];
  assert.equal(binding.relrowsecurity,true);assert.equal(binding.relforcerowsecurity,true);
  await assert.rejects(app.query("UPDATE cartoteca_catalog.asset_profiles SET marker_hash=$1",['a'.repeat(64)]),error=>error.code==='42501');
  await app.query("SELECT set_config('cartoteca.kind','cabinet',false)");assert.equal((await app.query('SELECT 1 FROM cartoteca_catalog.asset_profiles')).rows.length,0);

  assert.equal(profile.notificationSchema,19);
  assert.ok(profile.budgetStoreId);
  assert.equal(assetHash(path.join(destination,'platform','assistant-state.enc')),assistantHash);
  assert.equal(assetHash(path.join(directory,'assistant-state.enc')),assistantHash);
  assert.deepEqual(fs.readFileSync(path.join(destination,'tenants',fixture.actors[0].organizationId,'photos',photoId+'.enc')),photoCipher);
  assert.ok(result.reports.some(store=>store.kind==='budget'&&store.tables.some(table=>table.table==='login_limits'&&table.rows===1)));
  assert.ok(result.reports.some(store=>store.kind==='platform'&&store.tables.some(table=>table.table==='assistant_settings'&&table.rows===1)));
  assert.ok(profile.stores.some(store=>store.kind==='cabinet'&&store.schemaVersion===2));
  const first=profile.stores.find(store=>store.organizationId===fixture.actors[0].organizationId);
  await app.query("SELECT set_config('cartoteca.kind','cabinet',false),set_config('cartoteca.store_id',$1,false)",[first.storeId]);
  assert.equal((await app.query('SELECT id FROM cartoteca_cabinet.patients')).rows.length,1);
  assert.equal((await app.query('SELECT id FROM cartoteca_cabinet.patients WHERE _store_id<>$1',[first.storeId])).rows.length,0);
  await assert.rejects(app.query('ALTER TABLE cartoteca_cabinet.patients DISABLE ROW LEVEL SECURITY'),error=>error.code==='42501');
  const revision=async()=>BigInt((await app.query("SELECT revision FROM cartoteca_catalog.stores WHERE kind='cabinet' AND store_id=$1",[first.storeId])).rows[0].revision);
  const before=await revision();await app.query('BEGIN');
  await app.query('INSERT INTO cartoteca_cabinet.meta(key,value) VALUES($1,$2)',['synthetic-postgres-revision',Buffer.from([1,2,3])]);
  assert.ok(await revision()>before);await app.query('ROLLBACK');assert.equal(await revision(),before);
  await app.query('INSERT INTO cartoteca_cabinet.meta(key,value) VALUES($1,$2)',['synthetic-postgres-revision',Buffer.from([1,2,3])]);
  assert.ok(await revision()>before);
  const canonical=canonicalSqliteSchema({kind:'cabinet',version:1}),variant=structuredClone(canonical);
  variant.tables.meta.sql+=' ';variant.objects.find(object=>object.type==='table'&&object.name==='meta').sql+=' ';
  const variantHash=await registerCanonicalTemplate(admin,{kind:'cabinet',source:variant});
  const template=profile.cabinetTemplates['1'];assert.notEqual(template,variantHash);
  assert.ok(Number((await admin.query("SELECT count(*) n FROM cartoteca_catalog.templates WHERE kind='cabinet' AND version=1")).rows[0].n)>1,'historical source catalogs do not uniquely identify a fresh-store template');
  const newOrg=randomUUID();
  await assert.rejects(app.query('SELECT cartoteca_catalog.provision_store($1,$2,$3,$4,$5)',['cabinet',newOrg,1,template,profile.platformStoreId]),error=>error.code==='42501');
  await admin.query("SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",[profile.platformStoreId]);
  await admin.query("INSERT INTO cartoteca_platform.organizations(id,value,slug,status,created_at) VALUES($1,$2,$3,'active',0)",[newOrg,Buffer.from('synthetic'),'synthetic-'+newOrg]);
  assert.equal((await app.query('SELECT cartoteca_catalog.provision_store($1,$2,$3,$4,$5) AS created',['cabinet',newOrg,1,template,profile.platformStoreId])).rows[0].created,true);
  assert.equal((await app.query('SELECT cartoteca_catalog.provision_store($1,$2,$3,$4,$5) AS created',['cabinet',newOrg,1,template,profile.platformStoreId])).rows[0].created,false);
  const anotherOrg=randomUUID();
  await admin.query("INSERT INTO cartoteca_platform.organizations(id,value,slug,status,created_at) VALUES($1,$2,$3,'active',0)",[anotherOrg,Buffer.from('synthetic'),'synthetic-'+anotherOrg]);
  const owner=createPostgresCoordinator({connection:runtime.application,allowBlocking:true});
  try {
    await owner.ready();
    assert.throws(()=>owner.verifyProfile({platformStoreId:profile.platformStoreId,migrationId:wrongLineage.migrationId,markerHash:digest(wrongLineage)}),error=>error.code==='POSTGRES_ASSET_LINEAGE_MISMATCH');
    assert.equal(owner.stats().stores,0,'a mismatched clone marker is rejected before any clinical store opens');
    assert.equal(owner.verifyProfile({platformStoreId:profile.platformStoreId,migrationId:profile.migrationId,markerHash:digest(profile)}),true);
    const created=openRuntimeStore(owner,destination,path.join(destination,'tenants',anotherOrg),'cabinet',{organizationId:anotherOrg,schemaVersion:0});
    try {assert.equal(created.newStore,true);assert.equal(digest(created.catalog),template,'runtime selects the canonical lineage hash among several source version1 templates');}
    finally {created.close();}
  } finally {await owner.close();}
  // Actual PG constraints/triggers, not a SQLite catalog pretending protection.
  await admin.query("INSERT INTO cartoteca_platform.billing_package_definitions(id,title,price_kopecks,task_limit,enabled,revision,changed_at) VALUES('synthetic-package','Synthetic',100,1,1,1,0)");
  const actor=fixture.actors[0],order=randomUUID();
  const insertOrder="INSERT INTO cartoteca_platform.billing_payment_orders(id,organization_id,account_id,request_id,package_id,price_kopecks,state,config_revision,shop_id,test_mode,created_at,changed_at,value) VALUES($1,$2,$3,$4,'synthetic-package',100,'creating',1,'synthetic',1,0,0,$5)";
  await admin.query(insertOrder,[order,actor.organizationId,actor.accountId,randomUUID(),Buffer.from([1])]);
  await assert.rejects(admin.query(insertOrder,[randomUUID(),actor.organizationId,actor.accountId,randomUUID(),Buffer.from([1])]),error=>error.code==='23505');
  await assert.rejects(admin.query('UPDATE cartoteca_platform.billing_payment_orders SET price_kopecks=101 WHERE id=$1',[order]),error=>error.code==='23514');
  await assert.rejects(admin.query('DELETE FROM cartoteca_platform.billing_payment_orders WHERE id=$1',[order]),error=>error.code==='23514');
  await validatePostgresSchema(admin,{kind:'cabinet',applicationRole:'cartoteca_app'});
  await admin.query('BEGIN');await admin.query('ALTER TABLE cartoteca_cabinet.patients DISABLE ROW LEVEL SECURITY');
  await assert.rejects(validatePostgresSchema(admin,{kind:'cabinet'}),/RLS|differs/);await admin.query('ROLLBACK');
});


test('legacy cabinet0 prepares only missing derived indexes in memory and retains original ciphertext and rowids',async(t)=>{
  const fixture=await nativeIsolatedFixture(t),{DatabaseSync}=require('node:sqlite');
  const file=path.join(fixture.directory,'tenants',fixture.actors[0].organizationId,'cabinet.sqlite');
  const db=new DatabaseSync(file);
  db.exec('DROP TABLE cabinet_summaries;DROP TABLE cabinet_patient_counts;DROP TABLE cabinet_record_ids;DROP TABLE cabinet_appointments;DROP TABLE cabinet_days;DROP TABLE cabinet_photo_refs;PRAGMA user_version=0');
  const before=db.prepare('SELECT rowid,value FROM patients').get();db.close();
  const sourceHash=assetHash(file),inventory=sourceStores(fixture.directory);
  try {
    const store=inventory.stores.find(row=>row.organizationId===fixture.actors[0].organizationId);
    assert.equal(store.sourceSchemaVersion,0);assert.equal(store.schemaVersion,1);assert.equal(store.derivedIndexesPrepared,true);
    const actual=store.sqlite.prepare('SELECT rowid,value FROM patients').get();
    assert.equal(actual.rowid,before.rowid);assert.deepEqual(Buffer.from(actual.value),Buffer.from(before.value));
    assert.equal(store.derivedDatabase.prepare('SELECT count(*) n FROM cabinet_summaries').get().n,2);
    assert.equal(assetHash(file),sourceHash);
  } finally {for(const store of inventory.stores){store.derivedDatabase?.close();store.sqlite?.close();}}
});
