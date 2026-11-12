const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { digest: hashFile } = require('../backup/archive.cjs');
const { readRuntime } = require('./runtime.cjs');
const { digest } = require('./catalog-sqlite.cjs');
const { nativeSchemaPlan } = require('./schema-plan.cjs');
const { validPostgresArchiveName, readTypedRows, hashRow } = require('./backup-rows.cjs');
const { createAssistantBackupValidator, registrationRow } = require('./backup-assistant.cjs');
function jsonFile(directory, name, maximum = 16 * 1024 * 1024) {
  if (!validPostgresArchiveName(name)) throw Error('Invalid PostgreSQL backup entry.');
  const file = path.join(directory, name),
    stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)
    throw Error('Invalid PostgreSQL backup metadata.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function openBytes(key, value) {
  const bytes = Buffer.from(value);
  if (bytes.length < 28) throw Error('Invalid encrypted backup value.');
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
}
async function validatePostgresDirectory(directory, seen) {
  const manifest = jsonFile(directory, 'manifest.json');
  if (
    manifest.format !== 2 ||
    manifest.backend !== 'postgres' ||
    manifest.postgresFormat !== 1 ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.stores)
  )
    throw Error('Unsupported PostgreSQL backup manifest.');
  const profile = readRuntime(directory),
    listed = new Set();
  if (digest(profile) !== digest(manifest.profile))
    throw Error('PostgreSQL asset profile differs from its manifest.');
  for (const file of manifest.files) {
    if (
      !file ||
      !validPostgresArchiveName(file.name) ||
      file.name === 'manifest.json' ||
      listed.has(file.name) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw Error('Invalid PostgreSQL backup file inventory.');
    const stat = fs.lstatSync(path.join(directory, file.name));
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== file.size ||
      (await hashFile(path.join(directory, file.name))) !== file.sha256
    )
      throw Error('PostgreSQL backup file integrity mismatch.');
    listed.add(file.name);
  }
  if (
    seen.size !== listed.size + 1 ||
    [...seen].some((name) => name !== 'manifest.json' && !listed.has(name))
  )
    throw Error('Unlisted PostgreSQL backup entries.');
  const templates = jsonFile(directory, 'postgres/templates.json'),
    native = jsonFile(directory, 'postgres/native-manifests.json');
  if (!Array.isArray(templates) || !Array.isArray(native))
    throw Error('Invalid PostgreSQL native schema inventory.');
  for (const row of native)
    if (
      !['platform', 'cabinet', 'budget'].includes(row.kind) ||
      digest(row.signature) !== row.digest
    )
      throw Error('PostgreSQL native protection manifest is invalid.');
  require('./revision-profile132.cjs').validateArchivedRevisionProfile(
    native,
    manifest.revisionProfile,
  );
  for (const row of templates) {
    if (digest(row.metadata) !== row.catalog_hash)
      throw Error('PostgreSQL template hash is invalid.');
    nativeSchemaPlan(row.kind, row.metadata);
  }
  const counts = {
      organizations: 0,
      cabinets: 0,
      patients: 0,
      photos: 0,
      stores: manifest.stores.length,
    },
    stores = [];
  const identities = new Set();
  for (const entry of manifest.stores) {
    const mapping = profile.stores.find(
      (row) => row.kind === entry.kind && row.storeId === entry.storeId,
    );
    if (
      !mapping ||
      identities.has(entry.kind + ':' + entry.storeId) ||
      entry.catalog !== 'postgres/catalog/' + entry.storeId + '.json'
    )
      throw Error('Invalid PostgreSQL store inventory.');
    identities.add(entry.kind + ':' + entry.storeId);
    const metadata = jsonFile(directory, entry.catalog);
    if (digest(metadata) !== entry.catalogHash || metadata.version !== mapping.schemaVersion)
      throw Error('PostgreSQL virtual schema differs.');
    nativeSchemaPlan(entry.kind, metadata);
    if (!Array.isArray(entry.tables) || entry.tables.length !== Object.keys(metadata.tables).length)
      throw Error('Incomplete PostgreSQL table inventory.');
    const tableNames = new Set(),
      keyPath =
        entry.kind === 'platform'
          ? 'platform/platform.key'
          : entry.kind === 'cabinet'
            ? (mapping.relativeDirectory === '.' ? '' : mapping.relativeDirectory + '/') +
              'encryption.key'
            : null;
    const key = keyPath ? fs.readFileSync(path.join(directory, keyPath)) : null;
    if (key && key.length !== 32) throw Error('Invalid backup key asset.');
    let assistant;
    if (metadata.tables.assistant_state_schema) {
      const registrationTable = metadata.tables.assistant_state_schema,
        registrationFile =
          'postgres/' + entry.kind + '/' + entry.storeId + '/assistant_state_schema.jsonl';
      if (entry.kind !== 'platform' || !listed.has(registrationFile))
        throw Error('Assistant backup registration is missing.');
      let registration;
      for await (const row of readTypedRows(
        path.join(directory, registrationFile),
        registrationTable,
      )) {
        if (registration) throw Error('Assistant backup registration is not a singleton.');
        registration = registrationRow(row, registrationTable);
      }
      if (!registration) throw Error('Assistant backup registration is missing.');
      assistant = createAssistantBackupValidator(
        {
          directory: path.join(directory, 'platform'),
          open: (bytes) => JSON.parse(openBytes(key, bytes).toString('utf8')),
        },
        registration,
      );
    }
    const activePhotos = new Set(),
      references = new Set(),
      patientIds = new Set(),
      recordOwners = new Set();
    for (const report of entry.tables) {
      const table = metadata.tables[report.name],
        expected = 'postgres/' + entry.kind + '/' + entry.storeId + '/' + report.name + '.jsonl';
      if (
        !table ||
        report.file !== expected ||
        !listed.has(expected) ||
        tableNames.has(report.name) ||
        !Number.isSafeInteger(report.rows) ||
        report.rows < 0 ||
        !/^[a-f0-9]{64}$/.test(report.sha256)
      )
        throw Error('Invalid PostgreSQL typed table inventory.');
      tableNames.add(report.name);
      const hash = crypto.createHash('sha256');
      let count = 0;
      for await (const row of readTypedRows(path.join(directory, report.file), table)) {
        hashRow(hash, row, table);
        count++;
        let value;
        for (const column of table.columns.filter(
          (column) => column.type.toUpperCase() === 'BLOB',
        )) {
          if (row[column.name] === null) continue;
          if (!key) throw Error('Unexpected encrypted budget value.');
          const decoded = JSON.parse(openBytes(key, row[column.name]).toString('utf8'));
          if (column.name === 'value') value = decoded;
        }
        if (assistant && report.name.startsWith('assistant_'))
          assistant.row(report.name, row, table);
        if (entry.kind === 'platform' && report.name === 'organizations') counts.organizations++;
        if (entry.kind === 'cabinet') {
          if (report.name === 'patients') {
            counts.patients++;
            patientIds.add(row.id);
            for (const visit of value?.visits || [])
              for (const photo of visit.photos || []) references.add(photo.data);
          }
          if (report.name === 'cabinet_patient_records') {
            recordOwners.add(row.patient_id);
            if (row.kind === 'visit')
              for (const photo of value?.photos || []) references.add(photo.data);
          }
          if (report.name === 'photos' && row.active === 1n) activePhotos.add(row.id);
        }
      }
      if (count !== report.rows || hash.digest('hex') !== report.sha256)
        throw Error('PostgreSQL typed table integrity mismatch.');
    }
    if (assistant) assistant.finish();
    if (entry.kind === 'cabinet') {
      counts.cabinets++;
      const prefix = mapping.relativeDirectory === '.' ? '' : mapping.relativeDirectory + '/';
      for (const owner of recordOwners)
        if (!patientIds.has(owner)) throw Error('Invalid normalized record owner.');
      for (const id of activePhotos) {
        const name = prefix + 'photos/' + id + '.enc';
        if (!listed.has(name)) throw Error('Active backup photo is missing.');
        openBytes(key, fs.readFileSync(path.join(directory, name)));
        counts.photos++;
      }
      for (const reference of references) {
        const match = /^\/api\/photos\/([a-f0-9]{32})$/.exec(reference || '');
        if (!match || !activePhotos.has(match[1]))
          throw Error('Clinical backup photo reference is invalid.');
      }
    }
    stores.push({ ...entry, metadata });
  }
  if (identities.size !== profile.stores.length)
    throw Error('Incomplete PostgreSQL store lineage.');
  if (listed.has('platform/assistant-state.enc'))
    JSON.parse(
      openBytes(
        fs.readFileSync(path.join(directory, 'platform', 'platform.key')),
        fs.readFileSync(path.join(directory, 'platform', 'assistant-state.enc')),
      ).toString('utf8'),
    );
  return { manifest: { ...manifest, stores }, counts };
}
module.exports = { validatePostgresDirectory, jsonFile, openBytes };
