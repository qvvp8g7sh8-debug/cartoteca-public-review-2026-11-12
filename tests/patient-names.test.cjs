const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {patientNameParts,patientFullName}=require('../src/shared/patient-names.cjs');
const {directoryPage}=require('../src/server/modules/cabinet/directory.cjs');
const {validateState}=require('../src/server/modules/cabinet/validation.cjs');
const {authorizeCabinetChange}=require('../src/server/modules/access/cabinet-policy.cjs');
const {createStorage}=require('../storage.cjs');
const {JSDOM}=require('jsdom');
const patient=(id,firstName,lastName,middleName='')=>({id,firstName,lastName,middleName,name:patientFullName({firstName,lastName,middleName}),createdBy:'staff',phone:'555'+id,visits:[],appointments:[]});
test('structured names preserve patronymics, surname-first display and ambiguous legacy text',()=>{
  const p=patient('1','  Анна ','Морозова','Ивановна');
  assert.equal(p.name,'Анна Ивановна Морозова');assert.equal(patientNameParts(p).lastFirst,'Морозова Анна Ивановна');
  assert.deepEqual(patientNameParts({name:'Анна Морозова'}),{first:'Анна',last:'Морозова',middle:'',full:'Анна Морозова',lastFirst:'Морозова Анна',structured:false});
  const old=patientNameParts({name:'Морозова Анна Ивановна'});assert.equal(old.first,old.full);assert.equal(old.last,'');assert.equal(old.middle,'');
});
test('encrypted directory summaries retain names; sort and search do not confuse patronymics with surnames',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'patient-names-')),storage=createStorage(dir);t.after(()=>{storage.close();fs.rmSync(dir,{recursive:true,force:true});});
  const data=[patient('1','Анна','Яковлева','Александровна'),patient('2','Юлия','Андреева','Яковлевна'),patient('3','Алла','')];
  storage.write({revision:0,patients:data,services:[]});const current={organizationId:'org',accountId:'owner',role:'owner'};
  const page=params=>directoryPage(storage,current,new URL('http://test/?'+new URLSearchParams(params)));
  assert.deepEqual(page({sort:'first'}).directory.map(p=>p.id),['3','1','2']);assert.deepEqual(page({sort:'last'}).directory.map(p=>p.id),['2','1','3']);
  assert.equal(page({q:'Яковлева Анна'}).directory[0].id,'1');assert.equal(page({q:'Юлия Яковлевна Андреева'}).matched,1);
  assert.equal(page({}).directory.find(p=>p.id==='2').middleName,'Яковлевна');
});
test('calendar index displays structured names surname first without rewriting the patient card',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'patient-calendar-name-')),storage=createStorage(dir);t.after(()=>{storage.close();fs.rmSync(dir,{recursive:true,force:true});});
  const p=patient('1','Анна','Морозова','Ивановна');p.appointments=[{id:'a',date:'2030-01-01',time:'10:00',duration:30,staffId:'staff'}];storage.write({revision:0,patients:[p],services:[]});
  assert.equal(storage.read().patients[0].name,'Анна Ивановна Морозова');assert.equal(storage.indexes.appointments('2030-01-01','2030-01-01')[0].patientName,'Морозова Анна Ивановна');
});
test('server rejects inconsistent names and employee cannot bypass name protection with separate fields',()=>{
  const p=patient('1','Анна','Морозова','Ивановна'),before={revision:0,patients:[p],services:[]};
  assert.doesNotThrow(()=>validateState(before));assert.doesNotThrow(()=>validateState({...before,patients:[{id:'old',name:'Старая карточка',visits:[],appointments:[]}]}));
  for(const change of [{name:'Подмена'},{firstName:''},{lastName:10},{middleName:'x'.repeat(501)}])assert.throws(()=>validateState({...before,patients:[{...p,...change}]}),e=>e.status===400);
  const swapped={...p,firstName:'Анна Ивановна',middleName:''};assert.equal(patientFullName(swapped),p.name);
  assert.throws(()=>authorizeCabinetChange({role:'cosmetologist',accountId:'staff'},before,{...before,patients:[swapped]}),e=>e.status===403);
  assert.doesNotThrow(()=>authorizeCabinetChange({role:'owner'},before,{...before,patients:[swapped]}));
});
test('same name fields and optional designation serve normal and appointment forms; legacy text is not lost and values are escaped',t=>{
  const w=new JSDOM('<main></main>',{runScripts:'outside-only'}).window;t.after(()=>w.close());
  w.eval(fs.readFileSync(path.join(__dirname,'../src/client/modules/patient-fields.js'),'utf8'));
  const actions={patientNameParts,patientFullName,esc:v=>String(v).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')},fields=w.createPatientFields({},actions),main=w.document.querySelector('main');
  main.innerHTML=fields.patientFieldsHtml({...patient('1','Анна','Морозова','Ивановна'),nameNeedsReview:true});
  assert.deepEqual([...main.querySelectorAll('input')].map(i=>i.name),['lastName','firstName','middleName','designation']);assert.equal(main.querySelector('[name=firstName]').required,false);assert.equal(main.querySelector('[name=lastName]').required,false);assert.equal(main.querySelector('[name=designation]').required,false);assert.equal(main.querySelector('[name=designation]').maxLength,200);assert.ok(main.querySelector('.form-hint'));
  main.innerHTML=fields.patientFieldsHtml({name:'Исходное полное ФИО'});assert.equal(main.querySelector('[name=firstName]').value,'Исходное полное ФИО');
  main.innerHTML=fields.patientFieldsHtml({firstName:'<img src=x onerror=x>',lastName:'"',middleName:''});assert.equal(main.querySelector('img'),null);
  main.innerHTML=fields.patientFieldsHtml(null,{appointment:true});assert.equal(main.querySelectorAll('.appointment-new-field[hidden]').length,4);assert.equal(main.querySelector('input[required]'),null);
  const values=fields.patientFormValues({newFirstName:' Анна ',newLastName:' Морозова ',newMiddleName:' Ивановна ',newDesignation:' тренер по фитнесу '},{appointment:true});
  assert.equal(values.name,'Анна Ивановна Морозова');assert.equal(values.nameNeedsReview,false);assert.equal(values.designation,'тренер по фитнесу');
});
