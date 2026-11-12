const {startWifi}=require('../src/server/application/wifi.cjs');
startWifi().then(({local,close})=>{
  const stop=()=>{close().then(()=>process.exit(0));};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  setTimeout(()=>console.log('Telegram: '+JSON.stringify(local.telegramRuntime.status())),5000);
}).catch(error=>{console.error(error.message);process.exitCode=1;});
