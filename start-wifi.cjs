const {execFile,spawn}=require('node:child_process');
const {promisify}=require('node:util');
const {wifiAddress}=require('./wifi.cjs');
const run=promisify(execFile);
const port=Number(process.env.PORT)||4173;
const local=`http://127.0.0.1:${port}/`;
async function available(url){
  try{const response=await fetch(url+'api/auth/session',{signal:AbortSignal.timeout(1200)});const result=await response.json();return response.ok&&typeof result.configured==='boolean';}catch{return false;}
}
async function main(){
  const network=wifiAddress(),phone=`http://${network.address}:${port}/`;
  if(!await available(local)){
    try{await run('schtasks.exe',['/Run','/TN','Cartoteca-WiFi'],{windowsHide:true});}
    catch{
      console.log('Фоновая задача Windows не установлена. Оставьте это окно открытым во время просмотра.');
      const child=spawn(process.execPath,['--env-file-if-exists=.env.local','wifi.cjs'],{cwd:__dirname,stdio:'inherit'});
      child.on('error',()=>{console.error('Не удалось запустить сервер.');process.exitCode=1;});
      child.on('exit',code=>{process.exitCode=code||0;});
    }
  }
  const deadline=Date.now()+12000;
  while(!await available(local)){if(Date.now()>deadline)throw Error('Сервер не запустился. Повторите запуск или проверьте задачу Cartoteca-WiFi в планировщике Windows.');await new Promise(resolve=>setTimeout(resolve,300));}
  if(!await available(phone))throw Error('Сервер работает, но адрес Wi-Fi изменился. Остановите картотеку и запустите её снова.');
  console.log(`Компьютер: ${local}\nТелефон: ${phone}\nКомпьютер должен оставаться включённым и подключённым к Wi-Fi.`);
  if(process.argv.includes('--open'))await run('rundll32.exe',['url.dll,FileProtocolHandler',local],{windowsHide:true});
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
