const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const cli = path.resolve(__dirname, '../scripts/prune-revoked-invitations.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-prune-invitations-'));
  const platform = path.join(directory, 'platform');
  fs.mkdirSync(platform);
  const database = path.join(platform, 'platform.sqlite');
  const key = path.join(platform, 'platform.key');
  fs.writeFileSync(key, crypto.randomBytes(32));
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE organizations(id TEXT PRIMARY KEY);
    CREATE TABLE accounts(id TEXT PRIMARY KEY,value BLOB);
    CREATE TABLE memberships(organization_id TEXT,account_id TEXT,role TEXT);
    CREATE TABLE platform_sessions(id TEXT PRIMARY KEY,value BLOB);
    CREATE TABLE platform_audit(id INTEGER PRIMARY KEY,time INTEGER,actor_id TEXT,
      organization_id TEXT,event TEXT,detail TEXT);
    CREATE TABLE invitations(token_hash TEXT PRIMARY KEY,organization_id TEXT
      REFERENCES organizations(id),used_at INTEGER);
    CREATE TABLE email_invitations(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE
      REFERENCES invitations(token_hash) ON DELETE CASCADE,organization_id TEXT
      REFERENCES organizations(id),status TEXT,value BLOB);
    INSERT INTO organizations VALUES('org-a'),('org-b');
    INSERT INTO accounts VALUES('account-a',X'010203');
    INSERT INTO memberships VALUES('org-a','account-a','owner');
    INSERT INTO platform_sessions VALUES('session-a',X'040506');`);
  const cases = [
    ['remove-a', 'org-a', null, 'revoked', 'org-a'],
    ['remove-b', 'org-b', null, 'revoked', 'org-b'],
    ['accepted', 'org-a', 1234, 'revoked', 'org-a'],
    ['live', 'org-a', null, 'sent', 'org-a'],
    ['mismatch', 'org-a', null, 'revoked', 'org-b'],
    ['internal', 'org-a', null, null, 'org-a'],
  ];
  for (const [token, organization, used, status, mailOrganization] of cases) {
    db.prepare('INSERT INTO invitations VALUES(?,?,?)').run(token, organization, used);
    if (status)
      db.prepare('INSERT INTO email_invitations VALUES(?,?,?,?,?)').run(
        'mail-' + token,
        token,
        mailOrganization,
        status,
        Buffer.from('synthetic encrypted email@example.test'),
      );
  }
  db.close();
  t.after(() => {
    const target = path.resolve(directory);
    if (
      path.dirname(target) !== path.resolve(os.tmpdir()) ||
      !path.basename(target).startsWith('cartoteca-prune-invitations-')
    )
      throw Error('Unsafe synthetic fixture cleanup path.');
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { directory, database, key, snapshot: path.join(directory, 'snapshot') };
}
function command(f, ...args) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(CARTOTECA_|BACKUP_|TELEGRAM_|MAX_|NODE_OPTIONS$)/.test(name),
    ),
  );
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: f.directory,
    env: { ...environment, CARTOTECA_DATA_DIR: path.join(f.directory, 'must-not-open') },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  for (const privateValue of [f.directory, 'email@example.test', 'remove-a', 'account-a', 'org-a'])
    assert.equal((result.stdout + result.stderr).includes(privateValue), false);
  return result;
}
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const argumentsFor = (f) => [
  '--database',
  f.database,
  '--apply',
  '--stopped',
  '--expected-count',
  '2',
  '--snapshot-directory',
  f.snapshot,
];
function rows(file, sql) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

test('cleanup CLI defaults to read-only counts and does not discover ambient data or keys', (t) => {
  const f = fixture(t);
  const before = hash(f.database);
  const key = hash(f.key);
  const result = command(f, '--database', f.database);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { matched: 2, deleted: 0 });
  assert.equal(hash(f.database), before);
  assert.equal(hash(f.key), key);
  assert.equal(fs.existsSync(f.snapshot), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'must-not-open')), false);
});

test('cleanup creates and verifies ciphertext snapshot then deletes only unused matching revoked pairs', (t) => {
  const f = fixture(t);
  const key = hash(f.key);
  const protectedRows = ['accounts', 'organizations', 'memberships', 'platform_sessions'].map((name) =>
    rows(f.database, 'SELECT * FROM ' + name),
  );
  const result = command(f, ...argumentsFor(f));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { matched: 2, deleted: 2 });
  assert.equal(hash(f.key), key);
  assert.deepEqual(fs.readdirSync(f.snapshot).sort(), ['manifest.json', 'platform.sqlite']);
  assert.equal(rows(path.join(f.snapshot, 'platform.sqlite'), 'SELECT * FROM invitations').length, 6);
  assert.deepEqual(
    rows(f.database, 'SELECT token_hash FROM invitations ORDER BY token_hash'),
    ['accepted', 'internal', 'live', 'mismatch'].map((token_hash) => ({ token_hash })),
  );
  assert.deepEqual(
    ['accounts', 'organizations', 'memberships', 'platform_sessions'].map((name) =>
      rows(f.database, 'SELECT * FROM ' + name),
    ),
    protectedRows,
  );
  const audit = rows(f.database, 'SELECT event,actor_id,organization_id,detail FROM platform_audit');
  assert.deepEqual(audit, [
    {
      event: 'invitation_revoked_cleanup',
      actor_id: null,
      organization_id: null,
      detail: '{"deleted":2}',
    },
  ]);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.snapshot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sha256, hash(path.join(f.snapshot, 'platform.sqlite')));
});

test('explicit organization scope preserves revoked invitations belonging to another organization', (t) => {
  const f = fixture(t);
  const args = argumentsFor(f);
  args[args.indexOf('--expected-count') + 1] = '1';
  const result = command(f, ...args, '--organization', 'org-a');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { matched: 1, deleted: 1 });
  assert.equal(rows(f.database, "SELECT 1 FROM invitations WHERE token_hash='remove-b'").length, 1);
});

test('cleanup rejects missing approvals, stale counts, duplicate or relative paths without mutation', (t) => {
  const f = fixture(t);
  const before = hash(f.database);
  const complete = argumentsFor(f);
  const withoutStopped = complete.filter((value) => value !== '--stopped');
  const stale = [...complete];
  stale[stale.indexOf('--expected-count') + 1] = '3';
  for (const args of [
    [],
    ['--database', 'platform.sqlite'],
    ['--database', f.database, '--database', f.database],
    ['--database', f.database, '--unknown'],
    ['--database', f.database, '--expected-count', '2'],
    [...complete, '--dry-run'],
    withoutStopped,
    stale,
  ]) {
    const result = command(f, ...args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Очистка приглашений не завершена/);
    assert.equal(hash(f.database), before);
    assert.equal(fs.existsSync(f.snapshot), false);
  }
});

test('existing snapshot directory is never overwritten and snapshot failure precedes every deletion', (t) => {
  const f = fixture(t);
  const before = hash(f.database);
  fs.mkdirSync(f.snapshot);
  fs.writeFileSync(path.join(f.snapshot, 'keep.txt'), 'keep');
  const result = command(f, ...argumentsFor(f));
  assert.equal(result.status, 1);
  assert.equal(hash(f.database), before);
  assert.deepEqual(fs.readdirSync(f.snapshot), ['keep.txt']);
});

test('snapshot integrity failure rolls back without deleting invitations or hiding the failed copy', (t) => {
  const f = fixture(t);
  const db = new DatabaseSync(f.database);
  try {
    // Deliberately corrupt only this synthetic fixture so snapshot verification is exercised.
    db.exec(
      "PRAGMA foreign_keys=OFF; INSERT INTO invitations VALUES('orphan','missing-organization',NULL)",
    );
  } finally {
    db.close();
  }
  const before = hash(f.database);
  const result = command(f, ...argumentsFor(f));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(hash(f.database), before);
  assert.equal(rows(f.database, "SELECT 1 FROM invitations WHERE token_hash='remove-a'").length, 1);
  assert.equal(rows(f.database, 'SELECT 1 FROM platform_audit').length, 0);
  assert.equal(fs.existsSync(path.join(f.snapshot, 'platform.sqlite')), true);
  assert.equal(fs.existsSync(path.join(f.snapshot, 'manifest.json')), false);
});

test('apply without the platform key still works without replacing it or reading encrypted identities', (t) => {
  const f = fixture(t);
  // The database snapshot is ciphertext only; key lifecycle stays with the normal backup process.
  fs.unlinkSync(f.key);
  const result = command(f, ...argumentsFor(f));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { matched: 2, deleted: 2 });
  assert.equal(fs.existsSync(f.key), false);
  assert.equal(fs.existsSync(path.join(f.snapshot, 'platform.key')), false);
});

test('cleanup rejects a lookalike invitation schema without cascade before snapshot or mutation', (t) => {
  const f = fixture(t);
  const db = new DatabaseSync(f.database);
  db.exec(`ALTER TABLE email_invitations RENAME TO email_invitations_before;
    CREATE TABLE email_invitations(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE,
      organization_id TEXT,status TEXT,value BLOB);
    INSERT INTO email_invitations SELECT * FROM email_invitations_before;
    DROP TABLE email_invitations_before;`);
  db.close();
  const before = hash(f.database);
  const result = command(f, ...argumentsFor(f));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Очистка приглашений не завершена/);
  assert.equal(hash(f.database), before);
  assert.equal(fs.existsSync(f.snapshot), false);
  assert.equal(rows(f.database, 'SELECT 1 FROM invitations').length, 6);
  assert.equal(rows(f.database, 'SELECT 1 FROM email_invitations').length, 5);
  assert.equal(rows(f.database, 'SELECT 1 FROM platform_audit').length, 0);
});
