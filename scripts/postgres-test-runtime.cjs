const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');

function execute(filename, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(filename, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0;
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        bytes += chunk.length;
      });
    child.once('error', () => reject(Error('Portable PostgreSQL binary could not start.')));
    child.once('exit', (code) =>
      code === 0
        ? resolve({ code, outputBytes: bytes })
        : reject(Object.assign(Error('Portable PostgreSQL command failed.'), { exitCode: code })),
    );
  });
}
async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
function safeRetire(directory, expectedParent) {
  const resolved = fs.realpathSync(directory);
  if (
    path.dirname(resolved) !== fs.realpathSync(expectedParent) ||
    !path.basename(resolved).startsWith('cartoteca-postgres122-')
  )
    throw Error('Unsafe PostgreSQL fixture retirement.');
  function noLinks(file) {
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink()) throw Error('PostgreSQL fixture link refused.');
    if (info.isDirectory())
      for (const entry of fs.readdirSync(file)) noLinks(path.join(file, entry));
  }
  noLinks(resolved);
  fs.rmSync(resolved, { recursive: true, force: true });
}
// One explicitly owned synthetic cluster. No installer, Windows service, PATH,
// public listener, production data, or user account is changed by this helper.
async function startPostgresTestRuntime({
  binaryDirectory = process.env.CARTOTECA_POSTGRES_BIN || 'C:/Cartoteca/tools/postgresql-18.6/bin',
  parent = os.tmpdir(),
} = {}) {
  if (process.env.CARTOTECA_TEST_PG) {
    const shared = JSON.parse(process.env.CARTOTECA_TEST_PG);
    if (
      shared.synthetic !== true ||
      shared.admin?.host !== '127.0.0.1' ||
      shared.application?.host !== '127.0.0.1' ||
      shared.admin.user !== 'cartoteca_owner' ||
      shared.application.user !== 'cartoteca_app'
    )
      throw Error('Invalid shared PostgreSQL test runtime.');
    const database = 'fixture122_' + randomBytes(12).toString('hex');
    const client = new Client({ ...shared.admin, database: 'postgres' });
    await client.connect();
    try {
      const observed = await client.query('SHOW data_directory');
      if (path.resolve(observed.rows[0].data_directory) !== path.resolve(shared.data))
        throw Error('Shared PostgreSQL fixture ownership mismatch.');
      await client.query('CREATE DATABASE ' + database + ' OWNER cartoteca_owner');
      await client.query('REVOKE ALL ON DATABASE ' + database + ' FROM PUBLIC');
      await client.query('GRANT CONNECT,TEMPORARY ON DATABASE ' + database + ' TO cartoteca_app');
    } finally {
      await client.end();
    }
    const root = fs.mkdtempSync(path.join(parent, 'cartoteca-postgres122-'));
    let retired = false;
    return {
      admin: { ...shared.admin, database },
      application: { ...shared.application, database },
      root,
      data: shared.data,
      status: () => ({ engine: 'postgresql', synthetic: true, shared: true }),
      async close() {
        if (retired) return;
        const cleanup = new Client({ ...shared.admin, database: 'postgres' });
        await cleanup.connect();
        try {
          await cleanup.query('DROP DATABASE ' + database + ' WITH (FORCE)');
        } finally {
          await cleanup.end();
        }
        safeRetire(root, parent);
        retired = true;
      },
    };
  }
  const executable = (name) =>
    path.join(binaryDirectory, name + (process.platform === 'win32' ? '.exe' : ''));
  for (const name of ['postgres', 'initdb', 'pg_ctl']) {
    const file = executable(name);
    if (!fs.statSync(file).isFile()) throw Error('Portable PostgreSQL runtime is unavailable.');
  }
  const root = fs.mkdtempSync(path.join(parent, 'cartoteca-postgres122-'));
  const data = path.join(root, 'cluster'),
    passwordFile = path.join(root, 'init-password');
  const port = await unusedPort(),
    adminPassword = randomBytes(32).toString('hex');
  const appPassword = randomBytes(32).toString('hex');
  let started = false,
    closePromise;
  const admin = {
    host: '127.0.0.1',
    port,
    user: 'cartoteca_owner',
    password: adminPassword,
    database: 'cartoteca_test',
    connectionTimeoutMillis: 5000,
  };
  const application = { ...admin, user: 'cartoteca_app', password: appPassword };
  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (started)
        await execute(executable('pg_ctl'), ['-D', data, '-w', '-t', '15', '-m', 'fast', 'stop']);
      started = false;
      safeRetire(root, parent);
    })();
    return closePromise;
  }
  try {
    fs.writeFileSync(passwordFile, adminPassword + '\n', { mode: 0o600, flag: 'wx' });
    try {
      await execute(executable('initdb'), [
        '-D',
        data,
        '-U',
        admin.user,
        '--encoding=UTF8',
        '--locale=C',
        '--auth=scram-sha-256',
        '--pwfile=' + passwordFile,
        '--no-instructions',
      ]);
    } finally {
      fs.rmSync(passwordFile, { force: true });
    }
    // pg_ctl invokes its own server, hidden; only a numeric chosen port is formatted.
    const options =
      '-h 127.0.0.1 -p ' +
      port +
      ' -c shared_buffers=32MB -c max_connections=50' +
      ' -c logging_collector=off -c log_statement=none -c log_connections=off -c log_disconnections=off';
    // A partially successful startup must still be explicitly stopped on failure.
    started = true;
    await execute(executable('pg_ctl'), [
      '-D',
      data,
      '-l',
      path.join(root, 'postgres.log'),
      '-w',
      '-t',
      '15',
      '-o',
      options,
      'start',
    ]);
    const client = new Client({ ...admin, database: 'postgres' });
    await client.connect();
    try {
      const observed = await client.query('SHOW data_directory');
      if (path.resolve(observed.rows[0].data_directory) !== path.resolve(data))
        throw Error('PostgreSQL fixture ownership mismatch.');
      // Both identifiers are constants; only our generated hexadecimal secret is quoted.
      await client.query(
        "CREATE ROLE cartoteca_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '" +
          appPassword +
          "'",
      );
      await client.query('CREATE DATABASE cartoteca_test OWNER cartoteca_owner');
      await client.query('REVOKE ALL ON DATABASE cartoteca_test FROM PUBLIC');
      await client.query('GRANT CONNECT, TEMPORARY ON DATABASE cartoteca_test TO cartoteca_app');
    } finally {
      await client.end();
    }
    return {
      admin,
      application,
      root,
      data,
      close,
      status: () => ({
        engine: 'postgresql',
        version: 18,
        host: '127.0.0.1',
        port,
        started,
        synthetic: true,
      }),
    };
  } catch (error) {
    try {
      await close();
    } catch {
      /* Keep a failed owned cluster for explicit reconciliation. */
    }
    throw error;
  }
}
module.exports = { startPostgresTestRuntime };
