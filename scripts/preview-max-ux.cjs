// Isolated visual review, not an app server: no API, accounts, database or sending.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { publicAssetRoot } = require('../src/shared/web-assets.cjs');
const qr = require('qrcode').toDataURL(
  'https://max.ru/id000000000000_1_bot?start=' + 'x'.repeat(43),
  { width: 220, margin: 2 },
);
const modules = [
  ['settings-help', 'createSettingsHelp'],
  ['video-consent', 'createVideoConsent'],
  ['manual-confirmation', 'createManualConfirmation'],
  ['appointment-outcomes', 'createAppointmentOutcomes'],
  ['appointment-panel', 'createAppointmentPanel'],
  ['max-invitation', 'createMaxInvitation'],
  ['max-client', 'createMaxClient'],
  ['telegram', 'createTelegram'],
  ['card', 'createCard'],
];
const sources = modules
  .map(([name]) => fs.readFileSync(path.join(root, 'src/client/modules', name + '.js'), 'utf8'))
  .join('\n');
const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MAX — изолированный просмотр кнопок</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/ui-extra.css"></head><body>
<header style="padding:10px 16px;background:#eef3f6;font-size:12px">Макет на вымышленных данных · ничего не сохраняет и не отправляет</header>
<main class="workspace card-mode" id="workspace"><section class="detail" id="detail"></section></main>
<footer style="padding:12px 16px"><button type="button" id="review-invitation">Посмотреть приглашение MAX</button></footer>
<script>${sources}
const a={id:'review-a',date:'2030-04-08',time:'14:00',duration:90,service:'Консультация и уход',staffId:'review-owner',confirmationKey:'a'.repeat(64),deliveryReady:true,deliveryPreference:'auto',deliveryRevision:0,deliveryChannel:'max',deliveryStatus:null,canRemind:true,upcoming:true};
const p={id:'review-p',name:'Демонстрационная карточка',phone:'Телефон не указан',appointments:[a],visits:[],videoConsent:'unknown'};
const state={multiUser:true,currentView:'card',selectedId:p.id,activeTab:'visits',account:{id:'review-owner',organizationId:'review-org',role:'owner'},data:[p],busy:false};
const actions={$:s=>document.querySelector(s),esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),patient:()=>p,
 canEditPatient:()=>true,canEditRecord:()=>true,canManageTeam:()=>true,isActiveAppointment:a=>!['cancelled','no_show','completed'].includes(a.status),isClosedAppointment:a=>['cancelled','no_show','completed'].includes(a.status),appointmentStatusLabel:()=>'',
 cabinetToday:()=> '2026-10-07',cabinetClock:()=>({date:'2026-10-07',hour:12,minute:0}),timeLabel:m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0'),
 formatDate:d=>d.split('-').reverse().join('.'),formatMinutes:m=>m+' минут',invalidatePrint:()=>{},renderTab:()=>{},printablePatient:()=>false,toast:()=>{},
 request:async url=>{
  if(url.startsWith('/api/max/patient'))return {linked:true,compatible:true,canConnect:false,canDisconnect:true,bindingId:'review-binding',linkedAt:1,canChooseDelivery:true,deliveryReady:true,preference:{preference:'max',revision:1},bot:{connected:true}};
  if(url.startsWith('/api/telegram/patient'))return {patientId:p.id,linked:true,bot:{connected:true},notificationsEnabled:true,confirmations:[{appointmentId:a.id,confirmationKey:a.confirmationKey}],appointments:[{...a,deliveryReady:true}]};
  throw new Error('В макете сохранения и отправки отключены.');
 }};
${modules.map(([, factory]) => `Object.assign(actions,${factory}(state,actions));`).join('\n')}
actions.renderTab=()=>{document.querySelector('#tab-content').innerHTML='<p class="form-hint">История посещений — демонстрационный экран</p>';};
actions.renderDetail();
document.querySelector('#review-invitation').addEventListener('click',()=>actions.showMaxInvitation({patientId:p.id,accountKey:'review-owner:review-org',expiresAt:Date.now()+86400000,qrDataUrl:'data-review-qr',url:'https://max.ru/id000000000000_1_bot?start='+ 'x'.repeat(43),invitationText:'Здравствуйте! Подключите связь с нами в MAX. Персональная ссылка действует 24 часа.'}));
</script></body></html>`;
const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }
  if (req.url === '/') {
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(html.replace('data-review-qr', await qr));
    return;
  }
  const file = new Map([
    ['/style.css', 'style.css'],
    ['/ui-extra.css', 'ui-extra.css'],
  ]).get(req.url);
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  res
    .writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(fs.readFileSync(path.join(publicAssetRoot(root), file)));
});
server.listen(0, '127.0.0.1', () =>
  console.log('Isolated UI preview: http://127.0.0.1:' + server.address().port + '/'),
);
process.once('SIGINT', () => server.close());
