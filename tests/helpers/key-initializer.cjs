const path=require('node:path'),crypto=require('node:crypto');
const {encryptionKey}=require('../../src/server/infrastructure/encryption-key.cjs');
process.send({ready:true});
process.on('message',message=>{
  if(message!=='start')return;
  const dir=process.argv[2],key=encryptionKey(dir,path.join(dir,'cabinet.sqlite'),path.join(dir,'encryption.key'),'Missing key');
  process.send({digest:crypto.createHash('sha256').update(key).digest('hex')},()=>process.exit(0));
});
