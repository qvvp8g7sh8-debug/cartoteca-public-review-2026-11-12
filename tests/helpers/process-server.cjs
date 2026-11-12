// Synthetic workers report infrastructure failures over IPC, never HTTP.
const storageModule=require('../../src/server/infrastructure/cabinet-storage.cjs');
const originalCreateStorage=storageModule.createStorage;
const report=error=>process.send?.({diagnostic:{code:error.code, message:error.message,stack:error.stack}});
storageModule.createStorage=(...args)=>{
  try{
    const storage=originalCreateStorage(...args), originalTransaction=storage.transaction;
    storage.transaction=(...values)=>{try{return originalTransaction(...values);}catch(error){report(error);throw error;}};
    return storage;
  }catch(error){report(error);throw error;}
};
const {createMultiServer}=require('../../multi-server.cjs');
const server=createMultiServer({dataDir:process.argv[2],sendMail:null,telegramBot:null,telegramAutostart:false});
server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
process.on('message',message=>{if(message==='stop')server.close(()=>process.exit(0));});
