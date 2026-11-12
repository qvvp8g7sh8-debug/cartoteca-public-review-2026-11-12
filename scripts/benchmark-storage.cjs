// Synthetic records only. This measures storage operations, not future-server user capacity.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {performance}=require('node:perf_hooks');
const {createStorage}=require('../storage.cjs');
const count=Number(process.argv[2]||1000),visits=30;
if(!Number.isSafeInteger(count)||count<10||count>5000)throw Error('Choose 10–5000 synthetic patients');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cartoteca-benchmark-'));let store;
function measure(fn,n){const values=[];for(let i=0;i<n;i++){const start=performance.now();fn(i);values.push(performance.now()-start);}values.sort((a,b)=>a-b);return {medianMs:+values[Math.floor(n/2)].toFixed(2),p95Ms:+values[Math.ceil(n*0.95)-1].toFixed(2)};}
try{
  store=createStorage(dir);
  for(let offset=0;offset<count;offset+=100){
    const patients=Array.from({length:Math.min(100,count-offset)},(_,i)=>{
      const id='synthetic-'+(i+offset);
      return {id,name:'Synthetic '+(i+offset),phone:'Synthetic phone',createdBy:'staff',visits:Array.from({length:visits},(_,j)=>({id:id+'-visit-'+j,date:'2020-01-01',procedure:'Synthetic procedure',staffId:'staff',notes:'Synthetic '.repeat(52),photos:[]})),appointments:[{id:id+'-appointment',date:'2030-01-01',time:'10:00',duration:60,service:'Synthetic procedure',staffId:'staff'}]};
    });
    store.write({revision:store.get('revision',0),patients,services:[]},{changedIds:{patients:patients.map(p=>p.id),services:[]}});
  }
  const owner={role:'owner'},bootstrap=store.overview(owner),full=store.read();
  const result={patients:count,visits:count*visits,photos:0,node:process.version,
    fullResponseBytes:Buffer.byteLength(JSON.stringify(full)),bootstrapResponseBytes:Buffer.byteLength(JSON.stringify(bootstrap))};
  result.fullRead=measure(()=>store.read(),9);
  result.bootstrapRead=measure(()=>store.overview(owner),9);
  result.selectedCardRead=measure(()=>store.readSelected(['synthetic-0']),25);
  result.emptyCalendarRead=measure(()=>store.calendarSnapshot('2026-10-01','2026-11-11'),25);
  result.fullSave=measure(i=>{const snapshot=store.read();snapshot.patients[0].notes='Synthetic full '+i;store.write(snapshot);},5);
  result.selectedCardSave=measure(i=>{const snapshot=store.readSelected(['synthetic-0']);snapshot.patients[0].notes='Synthetic partial '+i;store.write(snapshot,{changedIds:{patients:['synthetic-0'],services:[]}});},25);
  console.log(JSON.stringify(result,null,2));
}finally{
  store?.close();
  if(path.dirname(dir)!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('cartoteca-benchmark-'))throw Error('Unsafe benchmark cleanup path');
  fs.rmSync(dir,{recursive:true,force:true});
}
