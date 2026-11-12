// Synthetic-only worker, launched by backup-v2.test.cjs against its mkdtemp fixture.
const path=require('node:path');
const {createPlatformDatabase}=require('../../src/server/infrastructure/platform-database.cjs');
const {createStorage}=require('../../storage.cjs');
const [source,organizationId]=process.argv.slice(2);
const platform=createPlatformDatabase(path.join(source,'platform')),storage=createStorage(path.join(source,'tenants',organizationId));
let tick=0,timer,stopped=false;
function write(){
  try{
    platform.transaction(()=>storage.transaction(()=>{
      const row=platform.db.prepare('SELECT value FROM organizations WHERE id=?').get(organizationId),organization=platform.open(row.value),patient=storage.readSelected(['p']).patients[0];
      const stamp='Synthetic coherent '+(++tick);organization.name=stamp;patient.notes=stamp;
      platform.db.prepare('UPDATE organizations SET value=? WHERE id=?').run(platform.seal(organization),organizationId);
      storage.write({revision:storage.get('revision',0),patients:[patient],services:[]},{insideTransaction:true,changedIds:{patients:['p'],services:[]}});
    }));
    if(tick===1)process.stdout.write('ready\n');if(!stopped)timer=setTimeout(write,5);
  }catch(error){process.stderr.write('Synthetic backup writer failed: '+error.message+'\n');process.exitCode=1;stop();}
}
function stop(){if(stopped)return;stopped=true;clearTimeout(timer);storage.close();platform.db.close();}
process.stdin.resume();process.stdin.on('end',stop);write();
