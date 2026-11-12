const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const { createContinuationRuntime } = require('../src/server/modules/assistant/dialogue/continuation/continuation-runtime.cjs');
const { modelOutputContract } = require('../src/server/modules/assistant/interpretation/model-output-contract.cjs');
const { continuationSchema } = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
const { createOutputParser } = require('../src/server/modules/assistant/providers/codex/codex-output.cjs');
const base = operation => ({ operation, fields: { client:null,staff:null,service:null,date:null,time:null,duration:null }, choice:null,field:null });
function fixture(handler) {
  const f = dialogueFixture(), defaults = initialState(), calls = [];
  f.state.policy = { ...defaults.policy, ...f.state.policy, limits: defaults.policy.limits };
  f.state.providers = { ...defaults.providers, llm: { provider:'codex',model:'codex-default' } };
  f.state.rates = defaults.rates;
  let revoked = false;
  const scope = () => { if(revoked)throw Object.assign(Error('Synthetic scope revoked'),{status:403}); return {state:f.state,member:f.member}; };
  const runtime = createContinuationRuntime({dialogues:f.flow,scope,timeZone:()=> 'Europe/Moscow',
    invoke: async (...args) => {
      calls.push(args[4]);
      if(handler) return handler({args,payload:args[4],calls});
      args[7]();
      return { text: JSON.stringify({...base('patch'), fields:{...base('patch').fields,service:'Чистка'}}),usage:{kind:'llm',estimatedRub:0} };
    }});
  f.start({query:'Анна Семёнова'});
  const body = text => ({policyVersion:f.state.revision,dialogueId:f.result.dialogue.id,dialogueVersion:f.result.dialogue.version,text});
  return {...f, f, runtime,calls,body,revoke(){revoked=true}};
}
const turn = (f,body) => f.runtime.run(f.c,body,f.state,f.member);
const noSave = f => assert.ok(f.patients.every(p=>p.appointments.length===0));
const entry = f => f.flow.get(f.c,f.member,f.state,f.f.result.dialogue.id);
const gate = () => {let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};

test('free follow-up uses the registered model contract, preserves other fields, and frozen replay performs no second model call',async()=>{
  const f=fixture(),body=f.body('Мне нужна услуга Чистка');
  const reply=await turn(f,body);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].response_format.json_schema.name,'cartoteca_continuation');
  assert.equal(reply.dialogue.step,'date');
  assert.equal(entry(f).data.service.id,'clean');
  assert.equal(entry(f).data.patient.id,f.patients[0].id);
  assert.doesNotMatch(JSON.stringify(f.calls),new RegExp(f.patients[0].id));
  assert.equal(reply.action,null);
  const repeated=await turn(f,body);
  assert.deepEqual(repeated.dialogue,reply.dialogue);
  assert.equal(f.calls.length,1);
  noSave(f);
});

test('simultaneous identical follow-ups coalesce while a conflicting pending answer is refused',async()=>{
  const wait=gate(),started=gate();const f=fixture(async({args})=>{await args[7]();started.resolve();await wait.promise;return {text:JSON.stringify({...base('patch'),fields:{...base('patch').fields,service:'Чистка'}})};});
  const body=f.body('Мне нужна услуга Чистка');
  const first=turn(f,body),second=turn(f,structuredClone(body));
  await started.promise;
  assert.equal(f.calls.length,1);
  await assert.rejects(turn(f,{...body,text:'Мне нужна другая услуга'}),{status:429});
  wait.resolve();
  const [a,b]=await Promise.all([first,second]);
  assert.deepEqual(a.dialogue,b.dialogue);
  assert.equal(f.calls.length,1);
  noSave(f);
});

test('cancelling a pending model reply invalidates its result and cannot open a form',async()=>{
  const wait=gate();const f=fixture(async({args})=>{args[7]();await wait.promise;return {text:JSON.stringify({...base('patch'),fields:{...base('patch').fields,service:'Чистка'}})};});
  const body=f.body('Мне нужна услуга Чистка');const pending=turn(f,body);
  await Promise.resolve();await Promise.resolve();
  const cancelled=await turn(f,{policyVersion:body.policyVersion,dialogueId:body.dialogueId,cancel:true});
  assert.equal(cancelled.dialogue,null);assert.equal(cancelled.action,null);
  wait.resolve();await assert.rejects(pending,{status:409});noSave(f);
});

test('revoked scope after provider await rejects the proposal and leaves appointment data unchanged',async()=>{
  const wait=gate();const f=fixture(async({args})=>{args[7]();await wait.promise;return {text:JSON.stringify(base('ready'))};});
  const before=structuredClone(entry(f).data),pending=turn(f,f.body('Всё готово можно открыть форму'));
  await Promise.resolve();await Promise.resolve();f.revoke();wait.resolve();
  await assert.rejects(pending,{status:403});assert.deepEqual(entry(f).data,before);noSave(f);
});

test('a malformed reply repeats the owned clarification with fresh version and frozen replay costs no model call',async()=>{
  const f=fixture(async({args,calls})=>{args[7]();return {text:calls.length===1?'not-json':JSON.stringify({...base('patch'),fields:{...base('patch').fields,service:'Чистка'}}),usage:{kind:'llm',estimatedRub:0}};});
  const before=structuredClone(entry(f).data),oldResponse=structuredClone(entry(f).response),body=f.body('Мне нужна услуга Чистка');
  const reply=await turn(f,body);
  assert.equal(reply.action,null);
  assert.equal(reply.dialogue.version,body.dialogueVersion+1);
  assert.equal(reply.dialogue.prompt,oldResponse.dialogue.prompt);
  assert.deepEqual(reply.dialogue.fields,oldResponse.dialogue.fields);
  assert.deepEqual(reply.dialogue.options,oldResponse.dialogue.options);
  assert.match(reply.text,/^Повторите, пожалуйста\. /u);
  assert.equal(entry(f).turns,1);
  assert.deepEqual(entry(f).data,before);
  await assert.rejects(turn(f,{...body,cancel:true}),{status:400});
  await assert.rejects(turn(f,{...body,choice:'1'}),{status:400});
  await assert.rejects(turn(f,{...body,dialogueVersion:body.dialogueVersion+2,text:'Другая услуга'}),{status:409});
  const repeated=await turn(f,body);
  assert.equal(repeated.text,reply.text);
  assert.deepEqual(repeated.dialogue,reply.dialogue);
  assert.equal(f.calls.length,1);
  assert.equal(entry(f).turns,1);
  const next=await turn(f,{...body,dialogueVersion:reply.dialogue.version,text:'Мне нужна услуга Чистка'});
  assert.equal(next.dialogue.step,'date');
  assert.equal(entry(f).data.service.id,'clean');
  assert.equal(f.calls.length,2);
  noSave(f);
});

test('an unsent busy error can be retried while an outbound provider 502 remains a cached failure',async()=>{
  let attempt=0;const retry=fixture(async({args})=>{if(++attempt===1)throw Object.assign(Error('busy before outbound'),{status:429});args[7]();return {text:JSON.stringify({...base('patch'),fields:{...base('patch').fields,service:'Чистка'}})};});
  const retryBody=retry.body('Мне нужна услуга Чистка');await assert.rejects(turn(retry,retryBody),{status:429});
  assert.equal((await turn(retry,retryBody)).dialogue.step,'date');assert.equal(retry.calls.length,2);noSave(retry);
  const failed=fixture(async({args})=>{args[7]();throw Object.assign(Error('provider HTTP failed'),{status:502});});
  const before=structuredClone(entry(failed).data),body=failed.body('Мне нужна услуга Чистка');
  await assert.rejects(turn(failed,body),{status:502,message:'provider HTTP failed'});
  await assert.rejects(turn(failed,body),{status:502,message:'provider HTTP failed'});
  assert.equal(failed.calls.length,1);
  assert.equal(entry(failed).version,body.dialogueVersion);
  assert.deepEqual(entry(failed).data,before);noSave(failed);
});

test('a malformed patch cannot change known fields or opaque choices and its current manual choice remains usable',async()=>{
  const bad={...base('patch'),fields:{...base('patch').fields,client:'Другой клиент',service:'Другая услуга',date:'2099-02-30'}};
  const f=fixture(async({args})=>{args[7]();return {text:JSON.stringify(bad)};});
  f.f.start({query:'Анна Семёнова',serviceQuery:'чстка',date:day,time:'12:00'});
  const before=structuredClone(entry(f).data),oldResponse=structuredClone(entry(f).response),options=[...entry(f).options];
  assert.ok(options.length>0,'The regression needs an actual current service choice');
  const body=f.body('Расскажу подробнее о нужной услуге');
  const reply=await turn(f,body);
  assert.equal(reply.action,null);
  assert.deepEqual(entry(f).data,before);
  assert.deepEqual([...entry(f).options],options);
  assert.deepEqual(reply.dialogue.options,oldResponse.dialogue.options);
  const selected=f.flow.continueDialogue(f.c,{...body,dialogueVersion:reply.dialogue.version,text:undefined,choice:oldResponse.dialogue.options[0].id},f.state,f.member,f.clock);
  assert.equal(selected.dialogue.step,'review');
  assert.equal(entry(f).data.service.id,'clean');
  assert.equal(f.calls.length,1);noSave(f);
});

test('malformed output after a revoked scope or a changed fresh catalog is not recovered',async()=>{
  for(const mode of ['scope','catalog']){
    const wait=gate(),started=gate(),f=fixture(async({args})=>{await args[7]();started.resolve();await wait.promise;return {text:'not-json'};});
    f.f.start({query:'Анна Семёнова',serviceQuery:'Чистка',date:day});
    const before=structuredClone(entry(f).data),body=f.body('Расскажу пожелания по времени'),pending=turn(f,body);
    await started.promise;
    if(mode==='scope')f.revoke();else{f.services[0].duration=60;f.changed();}
    wait.resolve();
    await assert.rejects(pending,{status:mode==='scope'?403:409});
    assert.deepEqual(entry(f).data,before);
    assert.equal(entry(f).version,body.dialogueVersion);
    assert.equal(f.calls.length,1);noSave(f);
  }
});

test('malformed late output cannot overwrite a newer dialogue version',async()=>{
  const wait=gate(),f=fixture(async({args})=>{args[7]();await wait.promise;return {text:'not-json'};});
  const body=f.body('Мне нужна услуга Чистка'),pending=turn(f,body);
  await Promise.resolve();await Promise.resolve();
  f.flow.continueDialogue(f.c,{...body,text:'Чистка'},f.state,f.member,f.clock);
  const latest=structuredClone(entry(f).data),version=entry(f).version;
  wait.resolve();await assert.rejects(pending,{status:409});
  assert.deepEqual(entry(f).data,latest);assert.equal(entry(f).version,version);noSave(f);
});

test('transport abort after outbound is not turned into a clarification when malformed output arrives late',async()=>{
  const wait=gate(),f=fixture(async({args})=>{args[7]();await wait.promise;return {text:'not-json'};});
  const controller=new AbortController();f.c.transportAbortSignal=controller.signal;
  const body=f.body('Мне нужна услуга Чистка'),before=structuredClone(entry(f).data),pending=turn(f,body);
  await Promise.resolve();await Promise.resolve();controller.abort();
  await assert.rejects(pending,{status:502,code:'ASSISTANT_REQUEST_ABORTED'});
  wait.resolve();await Promise.resolve();await Promise.resolve();
  assert.deepEqual(entry(f).data,before);assert.equal(entry(f).version,body.dialogueVersion);
  assert.equal(f.calls.length,1);noSave(f);
});

test('wire recovery consumes one bounded clarification turn and does not bypass the turn limit',async()=>{
  const f=fixture(async({args})=>{args[7]();return {text:'not-json'};});
  entry(f).turns=39;
  const body=f.body('Мне нужна услуга Чистка'),reply=await turn(f,body);
  assert.equal(entry(f).turns,40);
  assert.equal(reply.dialogue.version,body.dialogueVersion+1);
  await assert.rejects(turn(f,{...body,dialogueVersion:reply.dialogue.version,text:'Ещё одно уточнение'}),{status:429});
  assert.equal(f.calls.length,1);noSave(f);
});

test('Codex output parser accepts only the registered continuation schema and still rejects tool events',()=>{
  const payload={response_format:{type:'json_schema',json_schema:{name:'cartoteca_continuation',strict:true,schema:continuationSchema}}};
  const contract=modelOutputContract(payload),proposal=base('clarify');proposal.field='date';
  assert.equal(contract.schema,continuationSchema);
  const parser=createOutputParser({parseResponse:contract.parseResponse});
  parser.push(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(proposal)}})+'\n');
  parser.push(JSON.stringify({type:'turn.completed'})+'\n');assert.deepEqual(JSON.parse(parser.finish().text),proposal);
  for(const change of [{name:'invented'},{strict:false},{schema:{type:'object'}}])
    assert.throws(()=>modelOutputContract({response_format:{type:'json_schema',json_schema:{...payload.response_format.json_schema,...change}}}),{status:400});
  const tools=createOutputParser({parseResponse:contract.parseResponse});
  assert.throws(()=>tools.push(JSON.stringify({type:'item.completed',item:{type:'command_execution'}})+'\n'),{status:502});
});
