const http = require('node:http'),
  net = require('node:net');
const { createMultiServer } = require('./server.cjs');
const { configuration } = require('../config.cjs');
const { wifiAddress } = require('../http/local-network.cjs');
async function startWifi({ network = wifiAddress(), ...options } = {}) {
  const config = configuration(options);
  if (config.origin || config.production)
    throw Error('Wi-Fi HTTP нельзя смешивать с APP_ORIGIN/production.');
  const origin = `http://${network.address}:${config.port}`;
  const local = createMultiServer({ ...config, additionalOrigins: [origin] });
  const allowed = new net.BlockList();
  allowed.addSubnet(network.subnet, network.prefix, 'ipv4');
  const wifi = http.createServer((req, res) => {
    if (!allowed.check(req.socket.remoteAddress, 'ipv4')) {
      res.writeHead(403);
      res.end('Local subnet only');
      return;
    }
    local.emit('request', req, res);
  });
  const listen = (server, host) =>
    new Promise((resolve, reject) => {
      const failed = (error) => {
        server.off('listening', ready);
        reject(error);
      };
      const ready = () => {
        server.off('error', failed);
        resolve();
      };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(config.port, host);
    });
  try {
    await listen(local, '127.0.0.1');
    await listen(wifi, network.address);
  } catch (error) {
    if (local.listening) await new Promise((resolve) => local.close(resolve));
    else local.emit('close');
    throw error;
  }
  let closing;
  const close = () =>
    closing ||
    (closing = (async () => {
      await new Promise((resolve) => wifi.close(resolve));
      await new Promise((resolve) => local.close(resolve));
    })());
  console.log(
    `Компьютер: http://127.0.0.1:${config.port}/\nТелефон: ${origin}/\nАдаптер: ${network.name}; доступ только ${network.subnet}/${network.prefix}.\nHTTP без шифрования: только проверка в доверенной локальной сети.`,
  );
  return { local, wifi, origin, close };
}
module.exports = { startWifi };
