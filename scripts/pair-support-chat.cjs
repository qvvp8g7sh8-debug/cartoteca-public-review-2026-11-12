// Local operator-only pairing. Does not send messages or expose provider errors.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {configuredTelegram}=require('../src/server/modules/notifications/telegram-adapter.cjs');
const root=path.resolve(__dirname,'..');
const pairingPath=path.join(root,'.env.support-pairing.json');
function matchedChat(updates,pairing,now=Date.now()){
  if(!pairing||!/^support_[a-f0-9]{48}$/.test(pairing.code)||!Number.isFinite(pairing.expires)||pairing.expires<=now)throw Error('Ссылка привязки истекла. Подготовьте новую.');
  const matches=new Set();
  for(const item of updates){
    const message=item.message;
    if(message?.text!==`/start ${pairing.code}`||message.chat?.type!=='private'||message.from?.is_bot)continue;
    if(!Number.isSafeInteger(message.chat.id)||message.chat.id<=0||message.chat.id!==message.from?.id)continue;
    if(!Number.isFinite(message.date)||message.date*1000<pairing.created-2000||message.date*1000>pairing.expires)continue;
    matches.add(String(message.chat.id));
  }
  if(matches.size>1)throw Error('Ссылку использовали несколько чатов. Подготовьте новую и откройте только со своего аккаунта.');
  return [...matches][0]||null;
}
function chatConfiguration(existing,id){
  if(!/^[1-9]\d{0,15}$/.test(id))throw Error('Неверный получатель.');
  const line='CARTOTECA_SUPPORT_CHAT_ID='+id;
  const pattern=/^[ \t]*CARTOTECA_SUPPORT_CHAT_ID[ \t]*=[^\r\n]*/gm;
  if(pattern.test(existing))return existing.replace(pattern,()=>line);
  const newline=existing.includes('\r\n')?'\r\n':'\n';
  return existing+(existing&&!existing.endsWith('\n')?newline:'')+line+newline;
}
async function main(mode){
  if(mode==='--begin'){
    const pairing={code:'support_'+crypto.randomBytes(24).toString('hex'),created:Date.now(),expires:Date.now()+15*60000};
    fs.writeFileSync(pairingPath,JSON.stringify(pairing),{mode:0o600});
    console.log(JSON.stringify({link:'https://t.me/CartotecaExampleBot?start='+pairing.code,validMinutes:15}));
    return;
  }
  if(mode!=='--finish')throw Error('Используйте --begin или --finish.');
  const pairing=JSON.parse(fs.readFileSync(pairingPath,'utf8'));
  matchedChat([],pairing);
  const token=process.env.CARTOTECA_SUPPORT_BOT_TOKEN||'';
  if(!token||token===process.env.TELEGRAM_BOT_TOKEN)throw Error('Требуется отдельный токен бота поддержки.');
  const bot=configuredTelegram({token});
  const info=await bot.initialize();
  if(info.username.toLowerCase()!=='cartotecahelp_bot')throw Error('Токен относится к другому боту.');
  let response,data;
  try{
    response=await fetch(`https://api.telegram.org/bot${token}/getUpdates`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({timeout:0,limit:100,allowed_updates:['message']}),signal:AbortSignal.timeout(10000)});
    data=await response.json();
  }catch{throw Error('Не удалось проверить запуск бота. Проверьте интернет.');}
  if(!response.ok||!data.ok||!Array.isArray(data.result))throw Error('Telegram не подтвердил запуск бота.');
  const id=matchedChat(data.result,pairing);
  if(!id){console.log(JSON.stringify({paired:false,message:'Откройте персональную ссылку и нажмите Запустить.'}));return;}
  const target=path.join(root,'.env.local');
  const existing=fs.readFileSync(target,'utf8');
  fs.writeFileSync(target,chatConfiguration(existing,id));
  fs.unlinkSync(pairingPath);
  console.log(JSON.stringify({paired:true,username:info.username,message:'Получатель сохранён. Доставка обращений ещё не включена.'}));
}
if(require.main===module)main(process.argv[2]).catch(()=>{console.error('Не удалось завершить привязку. Настройки не изменены; проверьте ключ, запуск бота и срок ссылки.');process.exitCode=1;});
module.exports={matchedChat,chatConfiguration};
