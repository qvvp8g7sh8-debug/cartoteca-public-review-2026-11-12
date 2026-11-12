const http = require('node:http');
const { createHash } = require('node:crypto');
const { prepareStatic } = require('../../src/server/http/static-snapshot.cjs');
const { serveStatic } = require('../../src/server/http/static-files.cjs');

async function main() {
  const root = process.argv[2], previous = JSON.parse(process.argv[3]);
  const snapshot = prepareStatic(root);
  const server = http.createServer(async (req, res) => {
    try {
      await serveStatic(req, res, new URL(req.url, 'http://synthetic.test'),
        req.headers['x-synthetic-session'] ? {} : null, root);
    } catch (error) {
      res.writeHead(error.status || 500, { 'Cache-Control': 'no-store' });
      res.end('Synthetic resource error');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const read = async (url, authenticated = true) => {
      const response = await fetch(base + url, { headers: {
        'Accept-Encoding': 'identity', ...(authenticated ? { 'X-Synthetic-Session': '1' } : {}),
      } });
      const body = Buffer.from(await response.arrayBuffer());
      return { status: response.status, cache: response.headers.get('cache-control'),
        hash: createHash('sha256').update(body).digest('hex').slice(0, 16) };
    };
    const stale = await read('/app.js?v=' + previous.resources['app.js']);
    const current = await read('/app.js?v=' + snapshot.resources['app.js']);
    const denied = await read('/app.js?v=' + snapshot.resources['app.js'], false);
    const staleDeferred = await read('/app-settings.js?v=' + previous.resources['app-settings.js'] + '&build=' + previous.version);
    const currentDeferred = await read('/app-settings.js?v=' + snapshot.resources['app-settings.js'] + '&build=' + snapshot.version);
    process.stdout.write(JSON.stringify({ version: snapshot.version, resources: snapshot.resources,
      stale, current, denied, staleDeferred, currentDeferred }));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { process.stderr.write(error.stack); process.exitCode = 1; });
