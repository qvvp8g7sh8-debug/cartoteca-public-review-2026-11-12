const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (name) =>
  fs.readFileSync(path.join(__dirname, '..', name), 'utf8').replace(/\r\n/g, '\n');
function service(source, name) {
  const match = source.match(
    new RegExp('^  ' + name + ':\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|^networks:)', 'm'),
  );
  assert.ok(match, 'missing service ' + name);
  return match[1];
}
test('PostgreSQL deployment keeps the database private and the application least privileged', () => {
  const source = read('compose.postgres.yaml'),
    database = service(source, 'postgres'),
    app = service(source, 'app'),
    operator = service(source, 'postgres-operator');
  assert.match(database, /postgres:18\.6-bookworm@sha256:[a-f0-9]{64}/);
  assert.match(database, /postgres_data:\/var\/lib\/postgresql\n/);
  assert.match(database, /PGDATA: \/var\/lib\/postgresql\/18\/docker/);
  for (const block of [database, app]) {
    assert.doesNotMatch(block, /^    ports:/m);
    assert.match(block, /read_only: true/);
    assert.match(block, /on-failure:3/);
    assert.match(block, /mem_limit:/);
  }
  assert.match(source, /database:\n    internal: true/);
  assert.match(database, /log_min_error_statement=panic/);
  assert.match(app, /env_file:.*CARTOTECA_APP_ENV_FILE/);
  assert.match(app, /secrets: \[\s*postgres_app_password\s*\]/);
  assert.doesNotMatch(app, /postgres_owner_password|postgres_backup_key/);
  assert.match(operator, /profiles: \[\s*ops\s*\]/);
  assert.match(operator, /postgres_owner_password/);
  assert.match(operator, /postgres_app_password/);
  assert.match(app, /postgres-readiness\.cjs/);
  assert.match(source, /CARTOTECA_PG_PASSWORD_FILE:/);
  assert.doesNotMatch(source, /CARTOTECA_PG_PASSWORD:/);
});
test('synthetic rehearsal drops real provider configuration, ingress and egress', () => {
  const source = read('compose.postgres.rehearsal.yaml'),
    app = service(source, 'app'),
    operator = service(source, 'postgres-operator');
  assert.match(app, /env_file: !reset \[\]/);
  assert.match(app, /networks: !override/);
  assert.doesNotMatch(app, /egress/);
  assert.match(source, /private:\n    internal: true/);
  assert.match(source, /ipam: !override/);
  assert.match(operator, /volumes: !override/);
  assert.doesNotMatch(operator, /migration\/source/);
  assert.match(source, /profiles: \[\s*never-start-in-rehearsal\s*\]/);
  assert.doesNotMatch(source, /ports:/);
});
test('runtime image includes only explicit PostgreSQL tools and gives its synthetic volume to node', () => {
  const docker = read('Dockerfile'),
    ignore = read('.dockerignore');
  for (const file of [
    'start-postgres-server.cjs',
    'postgres-ops.cjs',
    'postgres-rehearsal.cjs',
    'postgres-rehearsal-fixture.cjs',
    'postgres-readiness.cjs',
  ]) {
    assert.ok(docker.includes('scripts/' + file));
    assert.ok(ignore.split(/\r?\n/).includes('!scripts/' + file));
    assert.ok(fs.existsSync(path.join(__dirname, '../scripts', file)));
  }
  assert.match(docker, /chown node:node[^\n]*\/rehearsal/);
  assert.doesNotMatch(docker, /COPY scripts[\/ ]+\.\/scripts/);
  assert.ok(!ignore.split(/\r?\n/).includes('!scripts/**'));
  assert.match(ignore, /\*\*\/\.env\*/);
});
