// Local Wi-Fi launch: one store/session handler, listeners only on loopback and Wi-Fi.
const http = require('node:http');
const os = require('node:os');
const net = require('node:net');
const { createServer } = require('./serve.cjs');

function wifiAddress(interfaces = os.networkInterfaces(), name = process.env.WIFI_INTERFACE || 'Wi-Fi') {
  const address = interfaces[name]?.find(a => a.family === 'IPv4' && !a.internal);
  if (!address) throw Error(`Нет IPv4 у адаптера «${name}». Подключите Wi-Fi и запустите снова.`);
  const privateRanges = new net.BlockList();
  privateRanges.addSubnet('10.0.0.0', 8); privateRanges.addSubnet('172.16.0.0', 12); privateRanges.addSubnet('192.168.0.0', 16);
  if (!privateRanges.check(address.address)) throw Error('Для просмотра нужен частный IPv4 Wi-Fi.');
  const bits = address.netmask.split('.').map(n => Number(n).toString(2).padStart(8,'0')).join('');
  if (!/^1{8,30}0+$/.test(bits)) throw Error('Не удалось безопасно определить локальную подсеть.');
  const prefix = bits.indexOf('0');
  const subnet = address.address.split('.').map((n,i) => Number(n) & Number(address.netmask.split('.')[i])).join('.');
  return { name, address: address.address, subnet, prefix };
}

async function startWifi({ port = Number(process.env.PORT) || 4173, network = wifiAddress(), dataDir, backups = true } = {}) {
  if (process.env.APP_ORIGIN || process.env.NODE_ENV === 'production') throw Error('Wi-Fi HTTP нельзя смешивать с APP_ORIGIN/production. Используйте отдельный локальный запуск.');
  const origin = `http://${network.address}:${port}`;
  const local = createServer({ dataDir, origin: '', additionalOrigins: [origin], backups, production: false });
  const allowed = new net.BlockList(); allowed.addSubnet(network.subnet, network.prefix, 'ipv4');
  const wifi = http.createServer((req,res) => {
    if (!allowed.check(req.socket.remoteAddress, 'ipv4')) { res.writeHead(403); res.end('Local subnet only'); return; }
    local.emit('request', req, res);
  });
  const listen = (server,host) => new Promise((resolve,reject) => {
    const failed = error => { server.off('listening',ready);reject(error); };
    const ready = () => { server.off('error',failed);resolve(); };
    server.once('error',failed);server.once('listening',ready);server.listen(port,host);
  });
  try { await listen(local,'127.0.0.1'); await listen(wifi,network.address); }
  catch(error) { if(local.listening)await new Promise(resolve=>local.close(resolve));else local.emit('close'); throw error; }
  const close = async () => { await new Promise(resolve=>wifi.close(resolve));await new Promise(resolve=>local.close(resolve)); };
  console.log(`Компьютер: http://127.0.0.1:${port}/\nТелефон: ${origin}/\nАдаптер: ${network.name}; доступ только ${network.subnet}/${network.prefix}.\nHTTP без шифрования. Только для просмотра в доверенной локальной сети.`);
  return { local, wifi, close, origin };
}
if(require.main===module)startWifi().then(({close})=>{
  let closing=false;
  const stop=()=>{if(closing)return;closing=true;close().then(()=>process.exit(0));};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={wifiAddress,startWifi};
