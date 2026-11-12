const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {codec}=require('../src/server/infrastructure/postgres/backup-credentials.cjs');
const {createAssistantBackupValidator}=require('../src/server/infrastructure/postgres/backup-assistant.cjs');
const {initialState}=require('../src/server/modules/assistant/access/defaults.cjs');
const {settingsValue,historyValue}=require('../src/server/modules/assistant/access/row-state.cjs');
const {encode}=require('../src/server/modules/assistant/access/row-codec.cjs');
const {createSentinel}=require('../src/server/modules/assistant/access/row-sentinel.cjs');
function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-pg-backup-pure-')),context={directory,...codec(randomBytes(32))};
  t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('cartoteca-pg-backup-pure-'));fs.rmSync(directory,{recursive:true,force:true});});
  const registration={store_id:'00000000-0000-4000-8000-000000000122',import_sha256:'a'.repeat(64)};
  fs.writeFileSync(path.join(directory,'assistant-state.enc'),context.seal(createSentinel(registration)),{flag:'wx'});
  const table=row=>({columns:Object.keys(row).map(name=>({name,type:Buffer.isBuffer(row[name])?'BLOB':typeof row[name]==='bigint'||typeof row[name]==='number'?'INTEGER':'TEXT'}))});
  const sealed=(name,key,fields,value)=>({...fields,value:encode(context,registration,name,key,value)});
  function validator() {
    const current=createAssistantBackupValidator(context,registration),state=initialState();
    const settings=sealed('assistant_settings',[1],{id:1n,revision:0n,mode:'off',changed_at:0n},settingsValue(state));
    const history=sealed('assistant_admin_history',[1],{id:1n},historyValue(state));
    current.row('assistant_settings',settings,table(settings));current.row('assistant_admin_history',history,table(history));return current;
  }
  return {context,registration,table,sealed,validator};
}
test('PostgreSQL archive assistant validation preserves exact envelope binding, accounting and file fence',t=>{
  const f=fixture(t),v=f.validator();
  const reservation=f.sealed('assistant_reservations',['reservation'],{id:'reservation',scope_kind:'legacy',organization_id:null,account_id:null,membership_id:null,policy_revision:null,grant_version:null,kind:'llm',provider:'legacy',month:'2026-10',amount_microrub:10n,state:'legacy-unknown',created_at:1n,expires_at:2n},{imported:true,reservation:{month:'2026-10',amount:0.00001,kind:'llm',createdAt:1}});
  const month=f.sealed('assistant_usage_months',['2026-10'],{month:'2026-10',spent_microrub:0n,reserved_microrub:10n,calls:0n,uncertain_calls:0n},{original:null});
  v.row('assistant_reservations',reservation,f.table(reservation));v.row('assistant_usage_months',month,f.table(month));assert.equal(v.finish().reservations,1);
  const swapped=f.validator();assert.throws(()=>swapped.row('assistant_reservations',{...reservation,id:'other'},f.table(reservation)),/identity mismatch/);
  const invalid=f.validator();invalid.row('assistant_reservations',reservation,f.table(reservation));invalid.row('assistant_usage_months',{...month,reserved_microrub:0n},f.table(month));assert.throws(()=>invalid.finish(),/aggregate mismatch/);
  fs.writeFileSync(path.join(f.context.directory,'assistant-state.enc'),f.context.seal({...createSentinel(f.registration),storeId:'other'}));assert.throws(()=>f.validator().finish(),/fence mismatch/);
});
test('PostgreSQL archive assistant validation rejects scalar grant spoofing before restore',t=>{
  const f=fixture(t),v=f.validator(),grant={organizationId:'organization',accountId:'account',membershipId:'m'.repeat(43)};
  const row=f.sealed('assistant_grants',[grant.organizationId,grant.accountId],{organization_id:grant.organizationId,account_id:grant.accountId,membership_id:'different',enabled:1n,grant_version:1n,position:0n},{grant,enabled:true,version:1});
  assert.throws(()=>v.row('assistant_grants',row,f.table(row)),/scalar binding mismatch/);
});
