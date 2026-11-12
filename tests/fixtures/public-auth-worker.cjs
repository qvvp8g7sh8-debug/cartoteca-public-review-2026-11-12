const path=require('node:path');
const sourceRoot=path.resolve(__dirname,'../..')+path.sep;
let store,stage='require',index=null;
const result={allowed:0,blocked:0};
function details(error,at){
  const locations=[];
  for(const line of String(error?.stack||'').split(/\r?\n/).slice(1)){
    const offset=line.lastIndexOf(sourceRoot);if(offset<0)continue;
    const match=line.slice(offset+sourceRoot.length).match(/^([A-Za-z0-9_./\\-]+):(\d+):(\d+)/);
    if(!match)continue;const file=match[1].replaceAll('\\','/');
    if(file.startsWith('src/')||file==='platform-store.cjs'||file==='tests/fixtures/public-auth-worker.cjs')locations.push({file,line:Number(match[2]),column:Number(match[3])});
    if(locations.length===6)break;
  }
  return {stage:at,index,name:/^[A-Za-z_]{1,40}$/.test(error?.name)?error.name:null,code:/^[A-Z0-9_]{1,64}$/.test(error?.code)?error.code:null,errcode:Number.isSafeInteger(error?.errcode)?error.errcode:null,status:Number.isSafeInteger(error?.status)?error.status:null,locations};
}
function close(){const current=store;store=null;current?.close();}
function send(packet){
  if(!process.connected){process.exitCode=1;return;}
  try{process.send(packet,error=>{if(error)process.exitCode=1;if(process.connected)process.disconnect();});}
  catch{process.exitCode=1;if(process.connected)process.disconnect();}
}
try{
  const {createPlatformStore}=require('../../platform-store.cjs');
  stage='open';store=createPlatformStore(process.argv[2]);
  stage='consume';
  for(index=0;index<Number(process.argv[3]);index++){try{store.consumePublicAuthRequest('register',process.argv[4]+'-'+index+'@example.test','shared-synthetic-ip');result.allowed++;}catch(error){if(error.status!==429)throw error;result.blocked++;}}
  index=null;stage='close';close();stage='send';send(result);
}catch(error){
  const failures=[details(error,stage)];process.exitCode=1;
  try{close();}catch(closeError){failures.push(details(closeError,'close'));}
  send({kind:'diagnostic',failures});
}
