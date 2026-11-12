const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { once } = require('node:events');
const { bookingFixture } = require('../tests/helpers/booking-fixture.cjs');
const { matchingContacts } = require('../src/server/modules/booking/contacts.cjs');
const { startsAt } = require('../src/server/modules/notifications/appointments.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');

const round = n => Math.round(n * 100) / 100;
function distribution(values) {
  const rows = [...values].sort((a,b) => a-b);
  return { medianMs: round(rows[Math.floor(rows.length*.5)]),
    p95Ms: round(rows[Math.min(rows.length-1, Math.ceil(rows.length*.95)-1)]), maxMs: round(rows.at(-1)) };
}
async function pool(count, concurrency, task) {
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < count) { const index = cursor++; await task(index); }
  }));
}
async function main() {
  const label = process.argv[2] || 'measurement';
  if (!/^[a-z0-9-]+$/i.test(label)) throw Error('Invalid measurement label');
  const occupied = process.argv.includes('--occupied');
  const p95Flag = process.argv.find(value => value.startsWith('--max-p95-ms='));
  const maxP95Ms = p95Flag ? Number(p95Flag.split('=')[1]) : Infinity;
  if (!(maxP95Ms > 0)) throw Error('Invalid latency ceiling');
  const f = await bookingFixture({ patients: 1000, history: 30, appointments: occupied ? 10 : 0 });
  let child, database;
  const results = [];
  try {
    f.setMode('classic');
    const measure = (name, count, fn) => {
      const times=[];for(let i=0;i<count;i++){ const start=performance.now();fn(i);times.push(performance.now()-start); }
      results.push({ name, count, ...distribution(times) });
    };
    measure('phone-match-1000-cards', 25, () => matchingContacts(f.storage, '+79000000000'));
    measure('time-conversion-1000', 25, () => { for(let n=0;n<1000;n++) startsAt({ date:f.date,time:'09:00' },'Europe/Moscow'); });
    if (occupied) measure('occupancy-100-reads', 25, () => {
      for (let n=0;n<100;n++) f.storage.indexes.appointments(f.date,f.date,{includeNames:false});
    });
    database = createPlatformDatabase(path.join(f.dir,'platform'));
    // Restore the same empty counter baseline BETWEEN profiles, only in this
    // known temporary fixture. Rate limits remain enabled during every request.
    const resetBudgets = () => database.db.prepare("DELETE FROM login_limits WHERE key LIKE 'booking-budget:%'").run();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ['path','systemroot','windir','temp','tmp','comspec','pathext'].includes(key.toLowerCase())));
    child = fork(path.join(__dirname,'../tests/fixtures/booking-load-server.cjs'), [f.dir],
      { env, stdio:['ignore','ignore','pipe','ipc'] });
    child.stderr.on('data', chunk => { if(!String(chunk).includes('ExperimentalWarning')) process.stderr.write(chunk); });
    const ready = await Promise.race([once(child,'message').then(([value])=>value),
      once(child,'exit').then(()=>{throw Error('Synthetic load server exited before readiness');})]);
    const base = 'http://127.0.0.1:'+ready.port;
    const metrics = async () => { const reply=once(child,'message');child.send({type:'metrics'});return (await reply)[0].metrics; };
    const headers = {'Content-Type':'application/json','X-Cartoteca-Request':'1',Origin:base};
    let stoppedAt = null;
    profiles: for (const concurrency of [1,10,50,100,200])
      for (const route of ['info','dates','availability','directory','calendar']) {
        resetBudgets();await metrics();
        const endpoint = route==='directory'?'/api/cabinet/directory?filter=all&limit=20&sort=first&today=2030-01-01':
          route==='calendar'?'/api/cabinet/calendar?from=2030-01-01&to=2030-01-03':
          '/api/public-booking/'+route+'?organization='+f.org+(route==='dates'?'&month=2030-01&staffId='+f.owner.accountId:'');
        const timings=[],statuses={};const started=performance.now();
        await pool(200,concurrency,async()=>{
          const start=performance.now();const response=await fetch(base+endpoint,{
            headers:{...headers,...(['directory','calendar'].includes(route)?{Cookie:'cartoteca_v2_session='+f.token}:{})},
            ...(route==='availability'?{method:'POST',body:JSON.stringify({date:f.date,serviceIds:['s'],staffId:f.owner.accountId})}:{}),
            signal:AbortSignal.timeout(30000)});
          await response.arrayBuffer();statuses[response.status]=(statuses[response.status]||0)+1;timings.push(performance.now()-start);
        });
        const elapsed=performance.now()-started;
        const row={name:'http-'+route,concurrency,count:200,statuses,requestsPerSecond:round(200000/elapsed),
          ...distribution(timings),server:await metrics()};results.push(row);
        console.log(JSON.stringify({label,...row}));
        if(Object.keys(statuses).some(status=>status!=='200'))throw Error('Unexpected HTTP status in load profile '+route);
        if (row.p95Ms > maxP95Ms) {
          stoppedAt = { route, concurrency, p95Ms: row.p95Ms, maxP95Ms };
          break profiles;
        }
      }
    if (stoppedAt) {
      const output = path.join(__dirname, '../work/booking-load-' + label + '.json');
      fs.writeFileSync(output, JSON.stringify({ label, stoppedAt, results }, null, 2));
      console.log('Latency ceiling reached; no further load or writes. Report: ' + output);
      return;
    }
    resetBudgets();
    const info = await (await fetch(base+'/api/public-booking/info?organization='+f.org)).json();
    const values = f.input({ key:info.challenge });
    const collision = async (sameKey) => {
      const forms = sameKey ? Array(12).fill(values) : await Promise.all(Array.from({length:12},async(_,i)=>{
        const next=await(await fetch(base+'/api/public-booking/info?organization='+f.org)).json();
        return {...values,key:next.challenge,time:'10:00',phone:'+7'+String(9999900000+i)};
      }));
      const states=await Promise.all(forms.map(async form=>{
        const response=await fetch(base+'/api/public-booking/requests?organization='+f.org,
          {method:'POST',headers,body:JSON.stringify(form)});return {http:response.status,status:(await response.json()).status};
      }));results.push({name:sameKey?'same-key-retries':'same-slot-race',states});
      const accepted=states.filter(s=>s.http===200&&s.status==='booked').length;
      if(accepted!==(sameKey?12:1)||states.some(s=>![200,409].includes(s.http)))throw Error('Collision invariant failed');
    };
    await collision(true);resetBudgets();await collision(false);
    resetBudgets();
    const writes = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
      const next = await (await fetch(base+'/api/public-booking/info?organization='+f.org)).json();
      return { ...values, key: next.challenge, date: '2030-01-02',
        time: `${String(13+Math.floor(i/2)).padStart(2,'0')}:${i%2?'30':'00'}`,
        phone: '+7'+String(9999800000+i) };
    }));
    const writeTimes = [], writeStatuses = {}; const writeStart = performance.now();
    await pool(writes.length, 10, async i => {
      const start = performance.now();
      const response = await fetch(base+'/api/public-booking/requests?organization='+f.org,
        {method:'POST',headers,body:JSON.stringify(writes[i]),signal:AbortSignal.timeout(30000)});
      const result = await response.json();
      writeTimes.push(performance.now()-start);writeStatuses[response.status]=(writeStatuses[response.status]||0)+1;
      if(response.status!==200 || result.status!=='booked')throw Error('Independent write failed');
    });
    results.push({ name:'independent-booking-writes', count:10, concurrency:10, statuses:writeStatuses,
      requestsPerSecond:round(10000/(performance.now()-writeStart)),...distribution(writeTimes) });
    if(f.storage.read().patients.flatMap(p=>p.appointments).length!==(occupied?22:12))
      throw Error('Unexpected durable appointment count');
    resetBudgets();const statuses={};
    await pool(400,100,async()=>{const response=await fetch(base+'/api/public-booking/dates?organization='+f.org+'&month=2030-01');
      await response.arrayBuffer();statuses[response.status]=(statuses[response.status]||0)+1;});
    results.push({name:'rate-limit-burst',count:400,statuses});
    if(statuses[200]!==240||statuses[429]!==160)throw Error('Read budget regression');
    const report={label,node:process.version,platform:process.platform,cpu:os.cpus()[0].model,
      logicalCpus:os.availableParallelism(),synthetic:{patients:1000,visits:30000,appointments:occupied?10:0,botNetwork:false},results};
    const output=path.join(__dirname,'../work/booking-load-'+label+'.json');
    fs.writeFileSync(output,JSON.stringify(report,null,2));console.log('Report: '+output);
  } finally {
    if(child?.connected){const ended=once(child,'exit');child.send({type:'stop'});await ended;}
    database?.db.close();f.close();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
