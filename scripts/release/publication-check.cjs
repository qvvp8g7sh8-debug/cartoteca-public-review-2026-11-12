const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { publicAssetRoot } = require('../../src/shared/web-assets.cjs');
const { configuration, artifact, digest, objectHash } = require('./deployment-plan.cjs');
const { transport } = require('./deployment-transport.cjs');
const { readCandidate, writeJson } = require('./state.cjs');
const paid = require('./paid-services-policy.cjs');

const serverStages = [
  'preflight',
  'save-configuration',
  'backup-before',
  'recheck-previous',
  'switch',
  'public-checks',
  'backup-after',
  'restore-backup-timer',
];
function assertServerProof(server, config, request, requiredStages = serverStages) {
  const postgres = config.storageBackend === 'postgres';
  if (postgres) require('./postgres-proof.cjs').assertPostgresServerProof(server, config);
  else if (
    (server.storageBackend && server.storageBackend !== 'sqlite') ||
    (server.public?.storageBackend && server.public.storageBackend !== 'sqlite')
  )
    throw Error('Independent publication storage backend mismatch');
  const target = server.target;
  const expectedImage = target ? target.targetId : request.imageId;
  const latest = new Map(server.stages.map((step) => [step.stage, step.status]));
  const maintenance = latest.get('storage-maintenance');
  const maintenanceValid =
    maintenance === undefined ||
    (maintenance === 'passed' && !server.maintenanceError) ||
    (maintenance === 'failed' && server.maintenanceError === 'STORAGE_MAINTENANCE_FAILED');
  const publicationStages =
    config.publicationGate === true ? ['publication-activate', 'public-checks-activated'] : [];
  const publicationValid =
    config.publicationGate !== true ||
    (server.activationCommitted === true &&
      server.publicationPrepared === true &&
      server.publicationCommitted === true &&
      server.gatedPublic?.passed === true &&
      server.gatedPublic.gated === true &&
      server.gatedPublic.actualImage === server.image &&
      server.gatedPublic.build === server.build &&
      server.public.gated === false);
  if (
    (target &&
      (target.requestedId !== request.imageId ||
        target.imageHash !== request.imageHash ||
        !/^sha256:[a-f0-9]{64}$/.test(target.targetId))) ||
    server.status !== 'completed' ||
    server.published !== true ||
    server.running !== true ||
    server.restarts !== 0 ||
    server.oom !== false ||
    server.timer !== 'active' ||
    server.public.passed !== true ||
    server.gateEnabled !== false ||
    server.image !== expectedImage ||
    server.image !== server.public.actualImage ||
    server.schema !== config.schema ||
    !/^[a-f0-9]{16}$/.test(server.build) ||
    (!postgres &&
      config.schema >= 17 &&
      (!server.pushEnabled || server.maxSchema !== String(config.schema))) ||
    (!postgres &&
      config.schema === 18 &&
      (!server.scheduledNotifications || server.cabinetSchema !== '2')) ||
    (!postgres &&
      config.readBudgetVersion === 1 &&
      (!server.sharedCabinetWrites ||
        !server.isolatedReadBudgets ||
        server.readBudgetVersion !== '1' ||
        server.public.readBudgetVersion !== 1)) ||
    (!postgres && config.bookingLinksVersion === 1 && server.public.bookingLinksVersion !== 1) ||
    (!postgres &&
      config.schema === 19 &&
      (!server.paidServicesRuntime ||
        server.paidServicesRuntime.paymentNetworkEnabled !== false ||
        server.paymentNetworkFlag !== '0' ||
        server.public.paidServices?.paymentNetworkEnabled !== false ||
        server.public.paidServices?.platformOnly !== true ||
        server.public.paidServices?.componentsPreserved !== true ||
        server.public.paidServices?.cabinetSchemaUnchanged !== true ||
        server.public.paidServices?.scheduleModeUnchanged !== true ||
        (paid.paidTransition(config) &&
          (server.migrationCommitted !== true ||
            server.migrationPrepared !== true ||
            server.migrationDurableCommitted !== true ||
            server.gatedPublic?.gated !== true ||
            server.gatedPublic?.paidServices?.paymentNetworkEnabled !== false)))) ||
    !publicationValid ||
    !maintenanceValid ||
    [...latest].some(([stage, status]) => stage !== 'storage-maintenance' && status !== 'passed') ||
    [...requiredStages, ...publicationStages].some((name) => latest.get(name) !== 'passed')
  )
    throw Error('Independent publication verification failed');
}

async function publicationCheck(root, id, configFile, signal) {
  const candidate = readCandidate(root, id),
    config = configuration(configFile);
  const directory = path.join(candidate.directory, 'deployment');
  const local = JSON.parse(fs.readFileSync(path.join(directory, 'local.json')));
  const requestFile = path.join(directory, 'payload/request.json');
  const request = JSON.parse(fs.readFileSync(requestFile));
  const image = await artifact(root, id);
  if (
    !image ||
    local.candidate !== id ||
    local.sourceHash !== candidate.data.sourceHash ||
    local.configHash !== objectHash(config) ||
    (await digest(requestFile)) !== local.requestHash ||
    request.candidate !== id ||
    request.sourceHash !== candidate.data.sourceHash ||
    request.imageId !== image.report.imageId
  )
    throw Error('Publication journal differs from checked package');
  const network = transport(config, directory, signal);
  const code = `import json,sys,subprocess,pathlib
p=pathlib.Path(sys.argv[1])
proof=json.loads((p/'image-proof.json').read_text())
public=json.loads((p/'public-checks.json').read_text())
state=json.loads((p/'state.json').read_text())
gated_public=json.loads((p/'public-checks-gated.json').read_text()) if (p/'public-checks-gated.json').exists() else None
publication=json.loads((p/'publication-state.json').read_text()) if (p/'publication-state.json').exists() else {}
migration=json.loads((p/'migration-state.json').read_text()) if (p/'migration-state.json').exists() else {}
target=json.loads((p/'image-target.json').read_text()) if (p/'image-target.json').exists() else None
stages=[json.loads(line) for line in (p/'timings.jsonl').read_text().splitlines()]
app=json.loads(subprocess.check_output(['docker','inspect',sys.argv[2]]))[0]
env=dict(line.split('=',1) for line in app['Config']['Env'] if '=' in line)
timer=subprocess.check_output(['systemctl','is-active',sys.argv[3]]).decode().strip()
paid_runtime=None
backend=env.get('CARTOTECA_STORAGE_BACKEND','sqlite')
public['storageBackend']=backend
if backend=='postgres':
 public.update({'storageBackend':backend,'postgresProfile':env.get('CARTOTECA_POSTGRES_PROFILE'),'postgresReadiness':json.loads(subprocess.check_output(['docker','exec',sys.argv[2],'node','/app/scripts/postgres-readiness.cjs','--technical-output'])),'backupBefore':json.loads((p/'backup-before-postgres.json').read_text()),'backupAfter':json.loads((p/'backup-after-postgres.json').read_text())})
elif backend=='sqlite' and proof['schema']==19:
 code="const d=new(require('node:sqlite').DatabaseSync)('/data/platform/platform.sqlite',{readOnly:true});try{require('/app/src/server/modules/billing/prepared-schema.cjs').validatePaidSchema(d);const enabled=require('/app/src/server/config.cjs').configuration().paymentNetworkEnabled;if(enabled!==false)process.exit(1);console.log(JSON.stringify({paymentNetworkEnabled:enabled}));}finally{d.close()}"
 paid_runtime=json.loads(subprocess.check_output(['docker','exec',sys.argv[2],'node','-e',code]))
print(json.dumps({'paidServicesRuntime':paid_runtime,'paymentNetworkFlag':env.get('CARTOTECA_PAYMENT_NETWORK_ENABLED'),'migrationCommitted':state.get('migrationCommitted'),'migrationPrepared':migration.get('prepared'),'migrationDurableCommitted':migration.get('committed'),'build':proof['build'],'schema':proof['schema'],'public':public,'gatedPublic':gated_public,'activationCommitted':state.get('activationCommitted'),'publicationPrepared':publication.get('prepared'),'publicationCommitted':publication.get('committed'),'status':state['status'],'published':state.get('published'),'maintenanceError':state.get('maintenanceError'),'stages':stages,'target':target,'image':app['Image'],'running':app['State']['Running'],'restarts':app['RestartCount'],'oom':app['State']['OOMKilled'],'timer':timer,'pushEnabled':env.get('CARTOTECA_PUSH_ENABLED')=='1','maxSchema':env.get('CARTOTECA_MAX_SCHEMA'),'cabinetSchema':env.get('CARTOTECA_CABINET_SCHEMA'),'scheduledNotifications':env.get('CARTOTECA_SCHEDULED_NOTIFICATIONS')=='1','gateEnabled':env.get('CARTOTECA_RELEASE_GATE')=='1','sharedCabinetWrites':env.get('CARTOTECA_SHARED_CABINET_WRITES')=='1','isolatedReadBudgets':env.get('CARTOTECA_ISOLATED_READ_BUDGETS')=='1','readBudgetVersion':env.get('CARTOTECA_READ_BUDGET_VERSION')}))`;
  const server = JSON.parse(
    await network.ssh('independent', [
      'python3',
      '-c',
      code,
      local.remote,
      config.container,
      config.backupTimer,
    ]),
  );
  const requiredStages = [
    ...serverStages,
    ...(config.migration
      ? [
          'migration-stop',
          'migration-prepare',
          'migration-install',
          'migration-activate',
          'public-checks-activated',
        ]
      : []),
  ];
  assertServerProof(server, config, request, requiredStages);
  const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const http = [];
  for (const [endpoint, expected] of [
    ['/', 200],
    ['/login.html', 200],
    ['/api/auth/session', 200],
    ['/ui-extra.css', 200],
    ['/app.js', 401],
    ['/app-settings.js', 401],
    ['/app-assistant.js', 401],
    ['/assistant-capture-worklet.js', 401],
    ['/assistant-playback-worklet.js', 401],
    ['/service-worker.js', 200],
    ['/api/cabinet', 401],
    ['/api/notifications/service-visibility', 401],
    ...(config.bookingLinksVersion === 1
      ? [
          ['/b/aaaaaaaa', 200],
          ['/booking.js', 200],
        ]
      : []),
  ]) {
    const response = await fetch(config.origin + endpoint, {
      redirect: 'manual',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (response.status !== expected) throw Error('Unexpected publication HTTP status');
    if (
      ['/', '/login.html', '/b/aaaaaaaa'].includes(endpoint) &&
      !bytes.includes(Buffer.from(server.build))
    )
      throw Error('Published build differs');
    if (
      ['/ui-extra.css', '/service-worker.js', '/booking.js'].includes(endpoint) &&
      hash(bytes) !==
        hash(fs.readFileSync(path.join(publicAssetRoot(candidate.source), endpoint.slice(1))))
    )
      throw Error('Published resource differs');
    http.push({ endpoint, status: response.status });
  }
  const proof = {
    verifiedAt: new Date().toISOString(),
    candidate: id,
    sourceHash: candidate.data.sourceHash,
    remote: local.remote,
    server,
    http,
    resourcesMatchCandidate: true,
  };
  writeJson(path.join(directory, 'independent-proof.json'), proof);
  return {
    build: server.build,
    schema: server.schema,
    http: http.length,
    serverChecks: server.public.checks,
    backups: true,
  };
}
module.exports = { publicationCheck, assertServerProof, serverStages };
