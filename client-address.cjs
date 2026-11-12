const {isIP}=require('node:net');
const {internalContext}=require('./src/server/http/internal-ingress.cjs');
const normalize=v=>typeof v==='string'&&v.startsWith('::ffff:')?v.slice(7):v;
function clientAddressResolver(proxies=[]) {
 const trusted=new Set(proxies.map(x=>normalize(x.trim())).filter(Boolean));
 if([...trusted].some(x=>!isIP(x)))throw Error('TRUSTED_PROXIES must contain exact IP addresses.');
 return req=>{
  const peer=normalize(internalContext(req)?.remoteAddress || req.socket.remoteAddress);
  if(!trusted.has(peer))return peer;
  // Caddy overwrites this header from the TCP peer; X-Forwarded-For is never trusted.
  const client=normalize(req.headers['x-cartoteca-client-ip']);
  if(typeof client!=='string'||!isIP(client))throw Object.assign(Error('Не удалось определить адрес клиента.'),{status:403});
  return client;
 };
}
module.exports={clientAddressResolver};
