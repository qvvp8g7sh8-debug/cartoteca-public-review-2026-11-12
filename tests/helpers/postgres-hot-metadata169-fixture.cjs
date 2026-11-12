// Synthetic-only proposal helper. The author has not executed PostgreSQL/tests.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { calendarFixture163 } = require('./postgres-calendar163-fixture.cjs');
const {
  authorityQuery,
  authorityValue,
} = require('../../src/server/infrastructure/postgres/read-session152.cjs');
const { identifier } = require('../../src/server/infrastructure/postgres/catalog-sqlite.cjs');

async function hotMetadataFixture169(t) {
  const f = await calendarFixture163(t),
    clients = [],
    trace = [];
  let closed = false;
  async function client(admin = false) {
    const value = new Client(admin ? f.runtime.admin : f.runtime.application);
    clients.push(value);
    await value.connect();
    return value;
  }
  let app;
  try {
    app = await client();
    // Existing business triggers use the established writer store context.
    // The metadata helper is tested separately against unrelated application GUCs.
    await f.admin.query(
      "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
      [f.platform.storeId],
    );
  } catch (error) {
    await close();
    throw error;
  }
  const query = app.query.bind(app);
  app.query = (input, ...args) => {
    // Static SQL only: never retain SQL values/token/ciphertext in diagnostics.
    trace.push(typeof input === 'string' ? input : input.text);
    return query(input, ...args);
  };
  async function fingerprints() {
    const rows = {};
    for (const [kind, catalog, stores] of [
      ['platform', f.catalog, [f.platform.storeId]],
      ['cabinet', f.cabinetCatalog, f.cabinets.map((s) => s.storeId)],
    ])
      for (const table of Object.keys(catalog.tables).sort()) {
        const result = await f.admin.query(
          `SELECT count(*)::text n,md5(COALESCE(string_agg(md5(row_to_json(t)::text),',' ORDER BY md5(row_to_json(t)::text)),'')) fingerprint
          FROM ${identifier('cartoteca_' + kind)}.${identifier(table)} t WHERE _store_id=ANY($1::text[])`,
          [stores],
        );
        rows[kind + '.' + table] = result.rows[0];
      }
    return rows;
  }
  function assetStats() {
    return ['postgresql-runtime.json', 'platform/platform.key', 'encryption.key'].map(
      (relative) => {
        const value = fs.lstatSync(path.join(f.dir, relative), { bigint: true });
        return [
          relative,
          ...['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink', 'mode'].map((k) =>
            String(value[k]),
          ),
        ];
      },
    );
  }
  async function oldAuthority(actor = f.actors[0]) {
    await app.query(
      "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
      [f.platform.storeId],
    );
    const plan = authorityQuery(f.platform, actor.token),
      result = await app.query(plan.text, plan.values);
    return authorityValue(result.rows, f.database.open);
  }
  async function close() {
    if (closed) return;
    closed = true;
    try {
      for (const value of clients) await value.end().catch(() => {});
    } finally {
      await f.close();
    }
  }
  return { ...f, app, client, trace, fingerprints, assetStats, oldAuthority, close };
}

async function deadline169(predicate, message, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= end) throw Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
module.exports = { hotMetadataFixture169, deadline169 };
