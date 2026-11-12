const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { privateAddress } = require('../src/server/infrastructure/postgres/connection.cjs');
const { seed, readFixture, fingerprint } = require('./postgres-rehearsal-fixture.cjs');
const { withOwner } = require('./postgres-ops.cjs');
const { readRuntime } = require('../src/server/infrastructure/postgres/runtime.cjs');
const {
  verifyAssetProfile,
} = require('../src/server/infrastructure/postgres/catalog-postgres.cjs');
const { atomicJson } = require('../src/server/infrastructure/backup/durable.cjs');
function proof(value, message) {
  if (!value) throw Error(message);
}
function loopbackRequest(url, { method = 'GET', headers = {}, body, signal } = {}) {
  const target = new URL(url);
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    target.username ||
    target.password
  )
    throw Error('Synthetic HTTP checks require loopback.');
  return new Promise((resolve, reject) => {
    const request = http.request(target, { method, headers, signal }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) {
          request.destroy(Error('Synthetic response is too large.'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('aborted', () => reject(Error('Synthetic response was interrupted.')));
      response.once('end', () => {
        const content = Buffer.concat(chunks);
        resolve({
          status: response.statusCode,
          json: async () => JSON.parse(content.toString('utf8')),
        });
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}
async function checkLive(environment = process.env, { fetchImpl = loopbackRequest } = {}) {
  const { fixture } = readFixture(environment),
    [actor, foreign] = fixture.actors,
    origin = 'https://synthetic.invalid',
    base = 'http://127.0.0.1:' + (environment.PORT || 4173);
  const headers = (who) => ({
    Host: new URL(origin).host,
    Origin: origin,
    'X-Cartoteca-Request': '1',
    cookie: 'cartoteca_v2_session=' + who.token,
    'x-cartoteca-account-id': who.accountId,
    'x-cartoteca-organization-id': who.organizationId,
  });
  async function request(url, who = actor, options = {}) {
    const response = await fetchImpl(base + url, {
      ...options,
      headers: { ...headers(who), ...options.headers },
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json();
    return { status: response.status, body };
  }
  const login = await request('/api/auth/login', actor, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: actor.email, password: actor.password }),
  });
  proof(login.status === 200, 'Synthetic password login failed.');
  for (const url of [
    '/api/cabinet/bootstrap?paged=1',
    '/api/cabinet/directory',
    '/api/cabinet/patient?id=' + actor.patientId,
    '/api/cabinet/calendar?from=2035-01-01&to=2035-01-31',
  ])
    proof((await request(url)).status === 200, 'Synthetic calendar read failed.');
  const cross = await request('/api/cabinet/patient?id=' + actor.patientId, actor, {
    headers: { cookie: 'cartoteca_v2_session=' + foreign.token },
  });
  proof(cross.status === 428, 'Synthetic account context guard failed.');
  proof(
    (await request('/api/cabinet/patient?id=' + actor.patientId, foreign)).status === 404,
    'Synthetic foreign client isolation failed.',
  );
  const save = {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Cartoteca-Operation': fixture.operationId },
    body: JSON.stringify({
      revision: fixture.revision,
      patients: [
        {
          id: actor.patientId,
          before: fixture.before,
          after: { ...fixture.before, notes: 'Synthetic PostgreSQL committed correction' },
        },
      ],
      services: [],
    }),
  };
  const saved = await request('/api/cabinet/changes', actor, save);
  proof(saved.status === 200, 'Synthetic manual save failed.');
  const replay = await request('/api/cabinet/changes', actor, save);
  proof(
    replay.status === 200 && replay.body.revision === saved.body.revision,
    'Synthetic mutation replay failed.',
  );
  const receipt = await request('/api/cabinet/operation?statusOnly=1&id=' + fixture.operationId);
  proof(
    receipt.status === 200 && receipt.body.status === 'committed',
    'Synthetic operation receipt failed.',
  );
  const card = await request('/api/cabinet/patient?id=' + actor.patientId);
  proof(
    card.body.patients?.[0]?.notes === 'Synthetic PostgreSQL committed correction',
    'Synthetic committed state is missing.',
  );
  return {
    live: true,
    login: true,
    calendar: true,
    manualSave: true,
    replay: true,
    receipt: true,
    accountContextGuard: true,
    foreignClientDenied: true,
  };
}
async function checkRoles(environment = process.env) {
  readFixture(environment);
  return withOwner(environment, async (client, connection) => {
    const roles = (
      await client.query(
        'SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname IN ($1,$2)',
        [connection.user, environment.BACKUP_POSTGRES_APPLICATION_ROLE || 'cartoteca_app'],
      )
    ).rows;
    const app = roles.find((role) => role.rolname !== connection.user);
    proof(
      app && !app.rolsuper && !app.rolbypassrls && !app.rolcreatedb && !app.rolcreaterole,
      'Synthetic application role is unsafe.',
    );
    const marker = readRuntime(environment.CARTOTECA_DATA_DIR);
    await verifyAssetProfile(client, marker);
    const rls = (
      await client.query(
        "SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity) AS protected FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('cartoteca_platform','cartoteca_cabinet','cartoteca_budget') AND c.relkind='r'",
      )
    ).rows[0];
    proof(rls.protected === true, 'Synthetic native RLS is incomplete.');
    return {
      rolesSeparated: true,
      applicationNoSuperuser: true,
      applicationNoBypassRls: true,
      nativeRls: true,
      assetLineage: true,
    };
  });
}
async function retireSource(environment = process.env) {
  const { directory, fixture, source } = readFixture(environment);
  proof(!fixture.sourceRetired, 'Synthetic source was already retired.');
  const ownerFile = path.join(directory, '.synthetic-owner.json'),
    ownerInfo = fs.lstatSync(ownerFile);
  proof(
    ownerInfo.isFile() && !ownerInfo.isSymbolicLink() && ownerInfo.size < 4096,
    'Synthetic source owner is invalid.',
  );
  const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  proof(owner.scope === 'scale123-synthetic', 'Synthetic source owner is missing.');
  proof(
    path.dirname(path.resolve(source)) === path.resolve(directory) &&
      path.basename(source) === 'source',
    'Unsafe synthetic retirement target.',
  );
  proof(
    fingerprint(source) === fixture.sourceFingerprint,
    'Synthetic source changed during migration.',
  );
  await withOwner(environment, (client) =>
    verifyAssetProfile(client, readRuntime(environment.CARTOTECA_DATA_DIR)),
  );
  fs.rmSync(source, { recursive: true, force: false });
  atomicJson(path.join(directory, 'fixture.json'), { ...fixture, sourceRetired: true });
  return { sourceUnchanged: true, sourceRetired: true, cutover: false };
}
async function backupDrill(environment = process.env, dependencies = {}) {
  const { directory, fixture } = readFixture(environment);
  proof(
    fixture.sourceRetired,
    'Retire the proved synthetic source before native backup rehearsal.',
  );
  return (dependencies.withOwner || withOwner)(environment, async (client, connection) => {
    // withOwner has already admitted the logical private hostname and resolved it.
    // Only its exact checked numeric endpoint can be reused by nested operations.
    proof(
      net.isIP(connection.host) !== 0 && privateAddress(connection.host),
      'Checked synthetic private PostgreSQL endpoint required.',
    );
    const connectionOptions = { profile: 'production-v1', allowedHosts: [connection.host] };
    const { createV2Backup } = require('../src/server/infrastructure/backup/service.cjs'),
      { restoreDrill } = require('../src/server/infrastructure/backup/drill.cjs');
    const backup = await (dependencies.createBackup || createV2Backup)({
      source: environment.CARTOTECA_DATA_DIR,
      directory: environment.BACKUP_DIR,
      keyFile: environment.BACKUP_KEY_FILE,
      connection,
      connectionOptions,
      applicationRole: environment.BACKUP_POSTGRES_APPLICATION_ROLE,
    });
    proof(
      backup.verified && backup.photos === 1 && backup.patients === 2,
      'Synthetic native backup differs.',
    );
    const drilled = await (dependencies.restoreDrill || restoreDrill)(
      backup.file,
      environment.BACKUP_KEY_FILE,
      environment.BACKUP_WORK_DIR,
      { connection, connectionOptions },
    );
    proof(
      drilled.started && drilled.restored && drilled.notificationsPaused === true,
      'Synthetic native restore did not start safely.',
    );
    const result = {
      backupVerified: true,
      restoreStarted: true,
      notificationsPaused: drilled.notificationsPaused,
      photos: backup.photos,
      patients: backup.patients,
    };
    atomicJson(path.join(directory, 'backup-proof.json'), result);
    return result;
  });
}
async function main(args = process.argv.slice(2), environment = process.env) {
  if (args.length !== 1) throw Error('One synthetic rehearsal phase is required.');
  if (args[0] === 'seed') return seed(environment);
  if (args[0] === 'check-live') return checkLive(environment);
  if (args[0] === 'check-roles') return checkRoles(environment);
  if (args[0] === 'retire-source') return retireSource(environment);
  if (args[0] === 'backup-drill') return backupDrill(environment);
  if (args[0] === 'summary') {
    const { directory, fixture, source } = readFixture(environment);
    return {
      syntheticOnly: true,
      sourceRetired: fixture.sourceRetired && !fs.existsSync(source),
      organizations: 2,
      patients: 2,
      photos: 1,
      ...JSON.parse(fs.readFileSync(path.join(directory, 'backup-proof.json'), 'utf8')),
    };
  }
  throw Error('Unsupported synthetic rehearsal phase.');
}
if (require.main === module)
  main()
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error('Synthetic PostgreSQL rehearsal phase did not complete.');
      process.exitCode = 1;
    });
module.exports = { main, loopbackRequest, checkLive, checkRoles, retireSource, backupDrill };
