const {test}=require('node:test');
const assert=require('node:assert/strict');
const {matchedChat,chatConfiguration}=require('../scripts/pair-support-chat.cjs');
const pairing={code:'support_'+'a'.repeat(48),created:100000,expires:1000000};
function update(id,overrides={}){return {message:{text:'/start '+pairing.code,chat:{type:'private',id},from:{id,is_bot:false},date:110,...overrides}};}
test('support recipient requires a fresh secret link in a private human chat',()=>{
  assert.equal(matchedChat([update(123)],pairing,120000),'123');
  assert.equal(matchedChat([update(123),update(123)],pairing,120000),'123');
  for(const overrides of [{text:'/start'},{text:'/start wrong'},{chat:{id:123,type:'group'}},{from:{id:456}},{from:{id:123,is_bot:true}},{date:10},{date:1001}])assert.equal(matchedChat([update(123,overrides)],pairing,120000),null);
  assert.throws(()=>matchedChat([update(123),update(456)],pairing,120000));
  assert.throws(()=>matchedChat([],pairing,1000001));
  assert.throws(()=>matchedChat([],{...pairing,code:'invalid'},120000));
});
test('support chat setup preserves clinical bot and all unrelated configuration',()=>{
  const source='TELEGRAM_BOT_TOKEN=synthetic-clinical\r\nCARTOTECA_SUPPORT_BOT_TOKEN=synthetic-support\r\n';
  const output=chatConfiguration(source,'123');
  assert.equal(output,source+'CARTOTECA_SUPPORT_CHAT_ID=123\r\n');
  assert.equal(chatConfiguration(output,'123'),output);
  assert.equal(chatConfiguration(output,'456'),source+'CARTOTECA_SUPPORT_CHAT_ID=456\r\n');
  assert.throws(()=>chatConfiguration(source,'123\nOTHER=bad'));
});
