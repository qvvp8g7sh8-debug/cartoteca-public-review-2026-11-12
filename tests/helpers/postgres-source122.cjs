const fs=require('node:fs');
const path=require('node:path');
const {nativeIsolatedFixture}=require('./native-isolated-fixture.cjs');
const {assetHash}=require('../../src/server/infrastructure/postgres/migration-assets.cjs');
async function populatedPostgresSource(t) {
  const fixture=await nativeIsolatedFixture(t,{organizations:2});
  const directory=path.join(fixture.directory,'platform');
  const database=require('../../src/server/infrastructure/platform-database.cjs').createPlatformDatabase(directory);
  try {
    for(const [file,name] of [['012-max-connections','migrateMaxConnections'],['013-notification-queue','migrateNotificationQueue'],['014-notification-channels','migrateNotificationChannels'],['015-max-inbox','migrateMaxInbox'],['016-staff-max','migrateStaffMax'],['017-staff-push','migrateStaffPush'],['018-notification-schedule','migrateNotificationSchedule'],['019-paid-services','migratePaidServices']]) require('../../src/server/migrations/'+file+'.cjs')[name](database,directory,{offline:true});
    require('../../src/server/modules/assistant/access/store.cjs').createAssistantFileStore({directory,seal:database.seal,open:database.open}).update(state=>{state.policy.instructions='Synthetic migration policy';state.revision++;});
    database.db.prepare('INSERT INTO login_limits VALUES(?,?,?,?)').run('booking-budget:site-read:synthetic',2,0,3000);
  } finally {database.closeWriter();database.db.close();}
  const preparation=path.join(fixture.directory,'.restore-in-progress');
  fs.writeFileSync(preparation,'assistant-state-rows-preparation-v1',{flag:'wx',mode:0o600});
  try {require('../../src/server/migrations/001-assistant-state-rows.cjs').migrateAssistantStateRows(directory);}
  finally {fs.unlinkSync(preparation);}
  fs.writeFileSync(preparation,'booking-read-budget-preparation-v1',{flag:'wx',mode:0o600});
  try {require('../../src/server/migrations/001-booking-read-budget.cjs').migrateBookingReadBudget(directory);}
  finally {fs.unlinkSync(preparation);}
  const cabinetPath=path.join(fixture.directory,'tenants',fixture.actors[0].organizationId);
  const storage=require('../../src/server/infrastructure/cabinet-storage.cjs').createStorage(cabinetPath);
  const photoId='a'.repeat(32),photoCipher=storage.seal(Buffer.from('Synthetic immutable photo payload'));
  try {
    storage.db.prepare('INSERT INTO photos(id,mime,active) VALUES(?,?,1)').run(photoId,'image/jpeg');
    fs.writeFileSync(path.join(storage.photoDir,photoId+'.enc'),photoCipher,{flag:'wx',mode:0o600});
    require('../../src/server/migrations/002-cabinet-records.cjs').migrateCabinetRecords(storage);
  } finally {storage.close();}
  const assistantHash=assetHash(path.join(directory,'assistant-state.enc'));
  const close=fixture.platform.close;let closed=false;
  fixture.platform.close=()=>{if(!closed){closed=true;close();}};fixture.platform.close();
  return {fixture,directory,cabinetPath,photoId,photoCipher,assistantHash};
}
module.exports={populatedPostgresSource};
