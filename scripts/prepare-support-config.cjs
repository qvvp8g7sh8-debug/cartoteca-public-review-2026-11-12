// Explicit local configuration only: never log file contents or secrets.
const fs=require('node:fs');
const path=require('node:path');
function prepareSupportConfig(existing){
  const newline=existing.includes('\r\n')?'\r\n':'\n';
  let result=existing;
  const defaults={CARTOTECA_SUPPORT_BOT_TOKEN:'',CARTOTECA_SUPPORT_BOT_USERNAME:'CartotecaExampleBot',CARTOTECA_SUPPORT_EMAIL:'support@example.invalid'};
  for(const [key,value] of Object.entries(defaults)){
    if(new RegExp('^[ \\t]*'+key+'[ \\t]*=','m').test(result))continue;
    if(result&&!result.endsWith('\n'))result+=newline;
    result+=key+'='+value+newline;
  }
  return {text:result,line:result.split(/\r?\n/).findIndex(line=>/^[ \t]*CARTOTECA_SUPPORT_BOT_TOKEN[ \t]*=/.test(line))+1};
}
if(require.main===module){
  try{
    const target=path.resolve(__dirname,'../.env.local');
    const existing=fs.existsSync(target)?fs.readFileSync(target,'utf8'):'';
    const prepared=prepareSupportConfig(existing);
    if(existing!==prepared.text)fs.writeFileSync(target,prepared.text,{mode:0o600});
    console.log(JSON.stringify({path:target,line:prepared.line}));
  }catch{console.error('Не удалось подготовить локальную настройку поддержки.');process.exitCode=1;}
}
module.exports={prepareSupportConfig};
