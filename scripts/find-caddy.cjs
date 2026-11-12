const fs=require('node:fs'),path=require('node:path');
function findCaddy(env=process.env){
  const name=process.platform==='win32'?'caddy.exe':'caddy';
  if(env.CADDY_BIN)return env.CADDY_BIN;
  const candidates=[path.join(__dirname,'..','tools','caddy',name),...(env.PATH||'').split(path.delimiter).filter(Boolean).map(dir=>path.join(dir,name))];
  return candidates.find(file=>fs.existsSync(file)&&fs.statSync(file).isFile())||'';
}
module.exports={findCaddy};
