const { readAsset } = require('./interface-assets.cjs');
// Supply only module transport in jsdom; execute the real generated modules.
// The assistant module is evaluated only when the granted host loads it.
function evaluateClient(window) {
  if (!window.document.querySelector('meta[name="cartoteca-build"]')) {
    const meta = window.document.createElement('meta');
    meta.name = 'cartoteca-build';
    meta.content = '1111111111111111';
    window.document.head.append(meta);
  }
  const source = (file) => readAsset(file)
    .replace('export const bundleId=', 'const bundleId=')
    .replace('export function install(', 'function install(');
  const marker = ',(module)=>module.install(state,actions,createModulePorts)';
  const assistantMarker = ',(assistantModule)=>assistantModule.install(state,actions,createModulePorts)';
  const initial = readAsset('app.js');
  if (!initial.includes(marker) || !initial.includes(assistantMarker))
    throw Error('Deferred composition fixture marker missing');
  const delivered = initial.replace(marker, marker + ',async()=>fixtureSettings')
    .replace(assistantMarker, assistantMarker + ',async()=>fixtureAssistant()');
  window.eval('(function(fixtureSettings,fixtureAssistant){\n' + delivered +
    '\n})((function(){\n' + source('app-settings.js') +
    '\nreturn {bundleId,install};})(),function(){\n' + source('app-assistant.js') +
    '\nreturn {bundleId,install};});');
}
module.exports = { evaluateClient };
