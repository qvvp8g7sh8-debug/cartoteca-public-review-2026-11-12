const { timingSafeEqual } = require('node:crypto');
const { isIP } = require('node:net');
// Only this process-local capability can override transport metadata. User
// headers never become a trusted peer unless the private listener authenticates.
const contexts = new WeakMap();
const transportHeader = 'x-cartoteca-native-transport';
const addressHeader = 'x-cartoteca-native-address';
const portHeader = 'x-cartoteca-native-port';
function internalContext(req) {
  return contexts.get(req);
}
function createInternalIngress(handler, secret) {
  if (secret === undefined) return handler;
  if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret))
    throw Error('Invalid private ingress capability.');
  const expected = Buffer.from(secret);
  return (req, res) => {
    const candidate = req.headers[transportHeader];
    const address = req.headers[addressHeader];
    const rawPort = req.headers[portHeader];
    const port = typeof rawPort === 'string' && /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : 0;
    if (
      typeof candidate !== 'string' ||
      !/^[a-f0-9]{64}$/.test(candidate) ||
      !timingSafeEqual(Buffer.from(candidate), expected) ||
      typeof address !== 'string' ||
      !isIP(address) ||
      port < 1 ||
      port > 65535
    ) {
      res.shouldKeepAlive = false;
      res.writeHead(403, {
        'Content-Type': 'application/json; charset=utf-8',
        Connection: 'close',
      });
      res.end('{"error":"Private ingress denied."}');
      return;
    }
    contexts.set(req, Object.freeze({ remoteAddress: address, localPort: port }));
    delete req.headers[transportHeader];
    delete req.headers[addressHeader];
    delete req.headers[portHeader];
    handler(req, res);
  };
}
module.exports = {
  createInternalIngress,
  internalContext,
  transportHeader,
  addressHeader,
  portHeader,
};
