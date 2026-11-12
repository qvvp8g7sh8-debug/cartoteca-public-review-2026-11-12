const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const { normalizePatientPhoneText } = require('../src/shared/patient-names.cjs');
const {invitationMessage}=require('../src/server/modules/notifications/telegram-messages.cjs');
const route=require('../src/server/modules/notifications/routes.cjs').routes.find(r=>r.path==='/api/telegram/link');
const root=path.resolve(__dirname,'..');
test('invitation identifies organization and nearest specialist without repetitions or private data',()=>{
 const identity={organization:{name:'Студия Пример',businessType:'salon',phone:'PRIVATE',city:'PRIVATE'},specialist:'Юлия Пример',patientName:'PRIVATE',notes:'PRIVATE'};
 const text=invitationMessage(identity);assert.match(text,/^Здравствуйте! Это Студия Пример\.\nВаш специалист — Юлия Пример\./);assert.doesNotMatch(text,/PRIVATE/);assert.match(text,/напоминания о приёме/);
 assert.doesNotMatch(invitationMessage({...identity,specialist:''}),/Ваш специалист/);
 for(const name of ['Юлия Пример','Студия Юлии']){const personal=invitationMessage({...identity,organization:{name,businessType:'individual'},specialist:name});assert.equal(personal.split(name).length,2);assert.doesNotMatch(personal,/Ваш специалист|косметолог/i);}
 assert.doesNotMatch(invitationMessage({...identity,specialist:'студия пример'}),/Ваш специалист/);
 assert.equal(invitationMessage({organization:{name:'',businessType:'individual'}}).split('\n')[0],'Здравствуйте!');
 assert.equal(invitationMessage({...identity,organization:{name:'Название\nновая строка',businessType:'clinic'}}).split('\n')[0],'Здравствуйте! Это Название новая строка.');
});
test('link route uses nearest future active accessible appointment and current server-side organization identity',async()=>{
 const patient={id:'p',createdBy:'owner',name:'PRIVATE',phone:'PRIVATE',designation:'PRIVATE',visits:[],appointments:[
  {id:'later',date:'2099-02-02',time:'12:00',staffId:'later'}, {id:'past',date:'2000-01-01',time:'12:00',staffId:'past'},
  ...['completed','cancelled','no_show'].map(status=>({id:status,date:'2099-02-01',time:'10:00',staffId:'closed',status})),
  {id:'nearest',date:'2099-02-01',time:'12:00',staffId:'nearest'}]};
 let businessType='salon',organizationName='Тестовая организация',chosen;
 const current={role:'owner',accountId:'owner',organizationId:'org'};
 const c={current,req:{},res:{},readBody:async()=>({patientId:'p'}),assertCurrent(){},tenantStore:org=>{assert.equal(org,'org');return {readSelected:ids=>{assert.deepEqual(ids,['p']);return {patients:[patient],services:[]};}};},telegram:{status:()=>({connected:true,username:'test_bot'})},platform:{telegram:{issueLink:()=> 'test_token',settings:()=>({timeZone:'Europe/Moscow'}),messageIdentity:(org,staff)=>{assert.equal(org,'org');chosen=staff;return {organization:{name:organizationName,businessType},specialist:staff?'Специалист '+staff:''};}}},json:(res,status,result)=>{assert.equal(status,200);return result;}};
 let result=await route.handle(c);assert.equal(chosen,'nearest');assert.match(result.invitationText,/Специалист nearest/);assert.doesNotMatch(result.invitationText,/PRIVATE|later|closed|past|owner/);assert.equal(result.expiresInHours,24);assert.match(result.qrDataUrl,/^data:image\/png;base64,/);
 current.role='cosmetologist';current.accountId='later';result=await route.handle(c);assert.equal(chosen,'later');assert.doesNotMatch(result.invitationText,/nearest/);
 current.role='owner';patient.appointments=[];organizationName='Новое название';result=await route.handle(c);assert.equal(chosen,'');assert.match(result.invitationText,/Новое название/);assert.doesNotMatch(result.invitationText,/Ваш специалист/);
 businessType='individual';organizationName='Юлия Пример';result=await route.handle(c);assert.match(result.invitationText,/Это Юлия Пример/);assert.doesNotMatch(result.invitationText,/Ваш специалист|косметолог/);
});
test('all sharing channels use personalized plain-text invitation, with one link and no patient metadata',async t=>{
 let shared;const w=new JSDOM('<button id="send">Отправить приглашение</button>',{url:'https://example.test',runScripts:'outside-only'}).window;t.after(()=>w.close());
 Object.defineProperty(w,'isSecureContext',{value:true});Object.defineProperty(w.navigator,'share',{value:async data=>{shared=data;}});Object.defineProperty(w.navigator,'canShare',{value:()=>true});
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
 const state={account:{id:'owner',organizationId:'org'},selectedId:'p',data:[{id:'p',name:'PRIVATE',phone:'+7 918 123-45-67',designation:'PRIVATE'}]};
 const actions={normalizePatientPhoneText,$:s=>w.document.querySelector(s),esc:x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),toast(){}};
 w.eval(fs.readFileSync(path.join(root,'src/client/modules/telegram-sharing.js'),'utf8'));Object.assign(actions,w.createTelegramSharing(state,actions));
 const url='https://t.me/test_bot?start=test_token',invitationText=invitationMessage({organization:{name:'Студия <Пример>',businessType:'salon'},specialist:'Юлия Пример'});
 actions.shareTelegramInvitation({url,invitationText,expiresAt:Date.now()+86400000,patientId:'p',accountKey:'owner:org'});
 const message=actions.$('textarea').value;assert.ok(message.startsWith(invitationText));assert.equal(message.split(url).length,2);assert.ok(message.endsWith('Ссылка действует 24 часа и предназначена только для вас.'));assert.doesNotMatch(message,/PRIVATE/);assert.equal(actions.$('textarea').children.length,0);
 for(const channel of ['telegram','whatsapp'])assert.equal(new URL(actions.$('[data-share-channel="'+channel+'"]').href).searchParams.get('text'),message);
 assert.equal(decodeURIComponent(actions.$('[data-share-channel="sms"]').href.split('body=')[1]),message);
 const chooser=new URL(actions.$('[data-share-channel="telegram-choice"]').href);assert.equal(chooser.searchParams.get('url'),url);assert.ok(chooser.searchParams.get('text').startsWith(invitationText));
 actions.$('[data-native-telegram-share]').click();await new Promise(r=>setImmediate(r));assert.equal(shared.text,message);assert.equal(shared.url,undefined);
 let copied;Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async value=>{copied=value;}}});actions.$('[data-copy-telegram-message]').click();await new Promise(r=>setImmediate(r));assert.equal(copied,message);
 actions.$('[data-copy-telegram-link]').click();await new Promise(r=>setImmediate(r));assert.equal(copied,url);
});
