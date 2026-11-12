// Fixed synthetic workload; importing this module never starts load or creates data.
const assert = require('node:assert/strict');
const { actorOrder, dateRange } = require('./benchmark-organizations-profile.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const MIX = Object.freeze({
  calendar: 350,
  search: 200,
  card: 150,
  save: 100,
  auth: 30,
  'photo-upload': 10,
  'photo-read': 40,
  ics: 100,
  assistant: 20,
});
const SLO = Object.freeze({
  calendar: 300,
  search: 300,
  card: 300,
  save: 700,
  auth: 1000,
  'photo-upload': 1500,
  'photo-read': 1500,
  ics: 500,
  assistant: 4000,
});
const SLO_P99 = Object.freeze({
  calendar: 1000,
  search: 1000,
  card: 1000,
  ics: 1000,
  save: 1500,
  auth: 2000,
  'photo-upload': 3000,
  'photo-read': 3000,
  assistant: 4500,
});
const PROFILE = Object.freeze({
  name: 'mixed92-v1',
  schema: 19,
  accounts: 30000,
  organizations: 10000,
  active: 3000,
  thinkMs: 5000,
  actionRate: 600,
  maxInFlight: 3000,
  maxLagMs: 100,
  requestTimeoutMs: 15000,
  modelDelayMs: 3000,
  modelShare: 0.5,
  photoBytesMin: 256 * 1024,
  photoBytesMax: 512 * 1024,
  providerNetwork: false,
  assistantMode: 'initial-only',
  assistantDialogueCapacity: 500,
  sloStatus: 'proposed-not-proven',
});
function endpoint(value, kind = 'api') {
  const url = new URL(value);
  const port = kind === 'api' ? '4173' : '4179';
  assert.ok(['127.0.0.1', '10.234.12.2'].includes(url.hostname), 'Synthetic literal host only');
  assert.equal(url.protocol, 'http:');
  assert.equal(url.port, port);
  assert.equal(url.username + url.password + url.search + url.hash, '');
  assert.equal(url.pathname, '/');
  return url.origin;
}
function actionDeck(seed = 20261021) {
  const ordered = Object.entries(MIX).flatMap(([name, count]) => Array(count).fill(name));
  return actorOrder(ordered.length, seed).map((index) => ordered[index]);
}
function actorsFor(fixture, active = PROFILE.active, cohort = 0, seed = 20261021) {
  assert.ok(
    Number.isInteger(active) && active >= 1 && active <= 3000 && active <= fixture.actors.length,
  );
  assert.ok(Number.isInteger(cohort) && cohort >= 0 && cohort < 100);
  const voice = fixture.actors.filter((actor) => actor.assistant);
  const photo = voice.find((actor) => actor.photo);
  const eligible = (photo ? [photo, ...voice.filter((actor) => actor !== photo)] : voice).slice(
    0,
    Math.min(500, active),
  );
  const fixed = new Set(eligible.map((actor) => actor.id));
  const rest = fixture.actors.filter((actor) => !fixed.has(actor.id));
  const order = rest.length ? actorOrder(rest.length, seed) : [];
  const count = active - eligible.length;
  return [
    ...eligible,
    ...Array.from({ length: count }, (_, n) => rest[order[(cohort * count + n) % rest.length]]),
  ];
}
function validate(fixture) {
  assert.equal(fixture.profile, PROFILE.name);
  assert.equal(fixture.schema, 19);
  dateRange(fixture.first);
  assert.ok(fixture.actors.length >= 1 && fixture.actors.length <= 30000);
  assert.equal(new Set(fixture.actors.map((actor) => actor.id)).size, fixture.actors.length);
  const organizations = new Set(fixture.organizations);
  assert.equal(organizations.size, fixture.organizations.length);
  assert.ok(fixture.actors.every((actor) => organizations.has(actor.org)));
  assert.ok(fixture.cards >= 10 && fixture.cards <= 200);
  assert.match(fixture.jpegSha256, /^[a-f0-9]{64}$/);
  assert.ok(fixture.actors.some((actor) => actor.assistant));
  assert.ok(fixture.actors.some((actor) => actor.photo));
  return fixture;
}
function identity() {
  const names = [
    'benchmark-mixed92.cjs',
    ...['profile', 'fixture', 'client', 'scheduler', 'results', 'providers', 'server'].map(
      (name) => 'benchmark-mixed92-' + name + '.cjs',
    ),
    'benchmark-organizations-fixture.cjs',
    'benchmark-organizations-profile.cjs',
    'benchmark-notifications-fixture.cjs',
    'benchmark-notifications-adapters.cjs',
  ];
  const files = Object.fromEntries(
    names.map((name) => [
      name,
      createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, name)))
        .digest('hex'),
    ]),
  );
  return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}
module.exports = {
  MIX,
  SLO,
  SLO_P99,
  PROFILE,
  endpoint,
  actionDeck,
  actorsFor,
  validate,
  identity,
};
