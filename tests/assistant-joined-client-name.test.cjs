const test = require('node:test');
const assert = require('node:assert/strict');
const { nameSuggestionPlan, rankNameSuggestions, rawJoinedName, SUGGESTION_LIMITS } = require('../src/server/modules/assistant/language/names/name-suggestions.cjs');
const { resolveClient, suggestClientMatches } = require('../src/server/modules/assistant/language/names/name-directory.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const patient = (id, firstName, lastName, middleName='') => ({id,firstName,lastName,middleName,name:[firstName,middleName,lastName].filter(Boolean).join(' '),phone:'',appointments:[],visits:[],createdBy:'owner'});
const rows = [patient('anna','Анна','Семёнова'),patient('sim','Анна','Симёнова'),patient('zhanna','Жанна','Семёнова'),patient('olga','Ольга','Семёнова')];
const ranked = (text, candidates=rows) => rankNameSuggestions(candidates,nameSuggestionPlan(text)).map(row=>row.id);
const noSave = f => assert.ok(f.patients.every(row=>row.appointments.length===0));
const fields = result => Object.fromEntries((result.dialogue?.fields||[]).map(row=>[row.key,row.value]));
function fixture(count=1,role='owner',query='анюсименову') {
  const f=dialogueFixture({role}); if(role==='cosmetologist')f.members[0].role=role;
  f.patients.splice(0,f.patients.length,...Array.from({length:count},(_,i)=>patient('anna-'+i,'Анна',i?'Симёнова':'Семёнова')));
  f.changed();f.start({query,serviceQuery:'Чистка',date:day,time:'10:00',duration:30});return f;
}
const entry = f => f.flow.get(f.c,f.member,f.state,f.result.dialogue.id);
const proposal = client => ({operation:'patch',fields:{client,staff:null,service:null,date:null,time:null,duration:null},choice:null,field:null});
function model(f,raw,client) {
  const body={policyVersion:f.state.revision,dialogueId:f.result.dialogue.id,dialogueVersion:f.result.dialogue.version,text:raw};
  const snapshot=f.flow.prepareModelTurn(f.c,body,f.state,f.member,f.clock);
  assert.ok(snapshot);
  return f.flow.applyModelTurn(f.c,body,f.state,f.member,f.clock,proposal(client),snapshot);
}

test('joined short or declined given names retrieve complete surname hypotheses in either FIO order',()=>{
  for(const text of ['анюсименову','Анюсемёнову.','АннуСемёнову','СименовуАню','СемёновуАнну']) {
    assert.ok(ranked(text).includes('anna'),text);
    assert.ok(!ranked(text).includes('zhanna'),text);
    assert.ok(!ranked(text).includes('olga'),text);
    const plan=nameSuggestionPlan(text);assert.ok(plan.queries.length<=SUGGESTION_LIMITS.queries);
  }
  assert.deepEqual(ranked('юлюневолину',[patient('julia','Юлия','Неволина')]),['julia']);
  assert.equal(nameSuggestionPlan('наташысеменову').variants.some(parts=>parts.length===2),false);
  assert.deepEqual(ranked('наташысеменову',[patient('n','Наталья','Семёнова')]),[]);
});

test('a split never turns commands negation fragments or unrelated names into a client',()=>{
  for(const text of ['не анюсименову','не анюсименову завтра','запишиверу','пожалуйстааню','анюсохрани','аннаеве','жаннеСемёновой']) {
    assert.ok(!ranked(text,[patient('anna','Анна','Семёнова'),patient('command','Вера','Запиши'),patient('polite','Анна','Пожалуйста'),patient('save','Анна','Сохрани')]).includes('anna'),text);
  }
  for(const text of ['запишиверу','пожалуйстааню','анюсохрани'])
    assert.equal(nameSuggestionPlan(text).variants.some(words=>words.some(word=>['запиши','пожалуйста','сохрани'].includes(word))),false,text);
});

test('model space repair returns only the identical raw token and cannot alter letters boundaries or negation',()=>{
  assert.equal(rawJoinedName('Запиши анюсименову на консультацию.','Аню Сименову'),'анюсименову');
  assert.equal(rawJoinedName('Запиши АннуСемёнову.','Анну Семенову'),'АннуСемёнову');
  assert.equal(rawJoinedName('АннуСемёнову, нет, лучше Анну Семёнову','Анну Семёнову'),'');
  for(const [raw,value] of [['анюсименову','Аню Семенову'],['не Полина','Неполина'],['Анна Марина','Аннамарина'],['не-анюсименову','Аню Сименову'],['xанюсименову','Аню Сименову'],['анюсименову42','Аню Сименову']])
    assert.equal(rawJoinedName(raw,value),'',raw);
});

test('strict lookup keeps priority and approximate lookup stays bounded on joined input',()=>{
  const f=fixture();assert.equal(resolveClient(f.c,'анюсименову').matches.length,0);
  const result=suggestClientMatches(f.c,'анюсименову');assert.equal(result.approximate,true);assert.equal(result.matches[0].id,f.patients[0].id);
  f.patients.push(patient('literal','Анна','Анюсименову'));f.changed();
  assert.deepEqual(resolveClient(f.c,'анюсименову').matches.map(row=>row.id),['literal']);
  const many=fixture(8);assert.equal(suggestClientMatches(many.c,'анюсименову').matches.length,5);assert.equal(suggestClientMatches(many.c,'анюсименову').overflow,true);
});

test('each role must confirm even one joined-name hypothesis and the existing draft is retained without Save',()=>{
  for(const role of ['owner','salon_admin','cosmetologist']) {
    const f=fixture(1,role);assert.equal(f.result.dialogue.step,'client');assert.equal(f.result.action,null);assert.equal(fields(f.result).client,undefined);assert.equal(fields(f.result).time,'10:00');
    assert.equal(entry(f).options.values().next().value.approximate,true);
    const selected=f.answer({text:'да'}).result;assert.equal(selected.dialogue.step,'review');assert.equal(entry(f).data.patient.confirmedSuggestion,true);
    const ready=f.answer({text:'открой форму'}).result;assert.equal(ready.action.patientId,f.patients[0].id);assert.equal(ready.action.time,'10:00');noSave(f);
  }
});

test('several similar joined-name candidates stay unanswered on yes and a current explicit choice controls identity',()=>{
  const f=fixture(2);assert.equal(f.result.dialogue.options.length,2);f.answer({text:'да'});assert.equal(f.result.dialogue.step,'client');assert.equal(fields(f.result).client,undefined);
  const choice=f.result.dialogue.options[1].id,target=entry(f).options.get(choice).value;f.answer({choice});const ready=f.answer({text:'открой форму'}).result;assert.equal(ready.action.patientId,target);noSave(f);
});

test('a model inserted space keeps raw joined provenance and still asks for client confirmation',()=>{
  const f=fixture(1,'owner','');const reply=model(f,'Это анюсименову','Аню Сименову');
  assert.equal(reply.dialogue.step,'client');assert.equal(reply.dialogue.options.length,1);assert.equal(entry(f).data.clientQuery,'анюсименову');assert.equal(entry(f).data.patient,null);assert.equal(reply.action,null);noSave(f);
});

test('model spelling only locates raw joined candidates while a negated joined client keeps the draft',()=>{
  const f=fixture(1,'owner','');const reply=model(f,'анюсименову','Аню Семенову');assert.equal(reply.action,null);assert.equal(reply.dialogue.step,'client');assert.equal(entry(f).data.clientQuery,'анюсименову');assert.equal(entry(f).data.patient,null);assert.equal(reply.dialogue.options.length,1);noSave(f);
  const negative=fixture(1,'owner',''),before=structuredClone(entry(negative).data);const rejected=model(negative,'не анюсименову','Аню Сименову');assert.equal(rejected.action,null);assert.deepEqual(entry(negative).data,before);noSave(negative);
});

test('employee ACL is applied before suggestions and again when an earlier joined-name choice is confirmed',()=>{
  const f=fixture(1,'cosmetologist'),choice=f.result.dialogue.options[0].id;f.patients[0].createdBy='foreign';f.changed();assert.deepEqual(suggestClientMatches(f.c,'анюсименову').matches,[]);
  assert.throws(()=>f.answer({choice}),{status:409});assert.equal(entry(f).data.patient,null);noSave(f);
});