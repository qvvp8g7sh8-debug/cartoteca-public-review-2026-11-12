const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('service view is private, snapshots cannot alter its selection or the shared catalogue',()=>{
  const state={services:[{id:'s',name:'Synthetic',price:10}],SERVICE_CATEGORIES:[{id:'care'}]},actions={canEditServices:()=>true,serviceStaffId:()=> 'owner',servicesForStaff:()=>state.services};
  const context=vm.createContext({structuredClone,Set,Object,JSON,Number,Intl,String});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/client/modules/services.js'),'utf8')+';globalThis.factory=createServices;',context);
  Object.assign(actions,context.factory(state,actions));
  actions.configureServiceView({category:'care',query:'Test',editing:true});const view=actions.serviceView();assert.equal(Object.isFrozen(view),true);
  actions.toggleServiceSelection('s');const selected=actions.selectedServices();selected[0].name='Changed externally';selected.length=0;
  assert.equal(actions.selectedServices()[0].name,'Synthetic');assert.equal(state.services[0].name,'Synthetic');
  assert.equal(state.selectedServiceIds,undefined);assert.equal(state.activeServiceCategoryId,undefined);
  actions.configureServiceView({category:'unknown'});assert.equal(actions.serviceView().category,'all');
  actions.removeServiceSelection('s');assert.equal(actions.selectedServices().length,0);
  actions.toggleServiceSelection('unknown');assert.equal(actions.selectedServices().length,0);
});
