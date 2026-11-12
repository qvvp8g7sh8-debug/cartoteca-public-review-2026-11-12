const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { isDeepStrictEqual } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const { validateState } = require('../modules/cabinet/validation.cjs');
const { normalizeImage, normalizeImageAsync } = require('./photos/image-processing.cjs');
const { photoReader } = require('./photos/photo-reader.cjs');
const { fail } = require('../../shared/errors.cjs');
const { encryptionKey } = require('./encryption-key.cjs');
const { createCabinetIndexes } = require('./cabinet-indexes.cjs');
const { configureSqlite } = require('./sqlite-configuration.cjs');
const { createServiceReadCache } = require('./service-read-cache.cjs');
const { createReadCacheBudget } = require('./read-cache-budget.cjs');
const { createPreparedStatements } = require('./prepared-statements.cjs');
const { createPatientRecords, prepareRecordCiphers } = require('./cabinet-records.cjs');
const { createPreparedWrites } = require('./cabinet-prepared-write.cjs');
const { createAppointmentWriter145 } = require('./cabinet-appointment-write145.cjs');
const { createWriteBatch } = require('./write-batch155.cjs');
const { createReadVersion } = require('./read-version.cjs');
const { createPatientHistoryReader } = require('./patient-history-read145.cjs');
const { createCalendarOccupancyVersion } = require('./calendar-occupancy-version.cjs');

function createStorage(
  directory,
  {
    readCacheBudget = createReadCacheBudget(),
    cabinetSchema = 0,
    observeOpen,
    photoOrganizationId,
    databaseOwner = null,
    databaseRoot = null,
  } = {},
) {
  function openingPhase(name, callback) {
    const started = performance.now();
    let failed = true;
    try {
      const result = callback();
      failed = false;
      return result;
    } finally {
      try {
        observeOpen?.(name, performance.now() - started, failed);
      } catch {}
    }
  }
  const pgAssets = require('./postgres/runtime.cjs');
  const pgDatabase =
    databaseOwner?.dialect === 'postgres'
      ? pgAssets.openRuntimeStore(databaseOwner, databaseRoot, directory, 'cabinet', {
          organizationId: photoOrganizationId,
          schemaVersion: cabinetSchema,
        })
      : null;
  if (!pgDatabase) pgAssets.rejectSqliteOnPostgresAssets(directory);
  if (![0, 1, 2].includes(cabinetSchema)) throw Error('Unsupported requested cabinet schema');
  let keyAssets;
  try {
    keyAssets = openingPhase('key', () => {
      if (fs.existsSync(path.join(directory, '.cabinet-records-in-progress')))
        throw Error('Incomplete cabinet records copy; do not activate it');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const filename = path.join(directory, 'cabinet.sqlite');
      const newDatabase = pgDatabase ? pgDatabase.newStore : !fs.existsSync(filename);
      const keyFile = path.join(directory, 'encryption.key');
      const key = pgDatabase
        ? pgAssets.storeKey(directory, 'encryption.key', pgDatabase)
        : encryptionKey(
            directory,
            filename,
            keyFile,
            'Encryption key is missing; restore the complete backup.',
          );
      // Never share a key object across tenant stores or pool reopens.
      const cipherKey = crypto.createSecretKey(key);
      const photoDir = path.join(directory, 'photos');
      fs.mkdirSync(photoDir, { recursive: true, mode: 0o700 });
      return { filename, newDatabase, cipherKey, photoDir };
    });
  } catch (error) {
    pgDatabase?.close();
    throw error;
  }
  const { filename, newDatabase, cipherKey, photoDir } = keyAssets;
  if (
    photoOrganizationId !== undefined &&
    (typeof photoOrganizationId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(photoOrganizationId))
  )
    throw Error('Invalid photo organization scope.');
  // The server pool supplies the verified organization. Direct internal/legacy
  // stores use their canonical directory; HTTP options cannot replace this key.
  const photoScopeKey =
    photoOrganizationId === undefined
      ? 'storage:' + crypto.createHash('sha256').update(fs.realpathSync(directory)).digest('hex')
      : 'organization:' + photoOrganizationId;
  function seal(buffer) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', cipherKey, iv);
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }
  // The async photo reader supplies its private, already-owned ciphertext.
  // GCM reads these views without modifying or copying that complete input.
  function openOwnedBuffer(buffer) {
    const cipher = crypto.createDecipheriv('aes-256-gcm', cipherKey, buffer.subarray(0, 12));
    cipher.setAuthTag(buffer.subarray(12, 28));
    return Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]);
  }
  function open(buffer) {
    // Preserve the existing copy/accepted-input semantics for SQL and legacy callers.
    return openOwnedBuffer(Buffer.from(buffer));
  }
  const hash = (value) => crypto.createHmac('sha256', cipherKey).update(value).digest('hex');
  const encode = (value) => seal(Buffer.from(JSON.stringify(value)));
  const decode = (value) => JSON.parse(open(value).toString('utf8'));
  let db;
  try {
    openingPhase('configuration', () => {
      db = pgDatabase || new DatabaseSync(filename);
      if (!pgDatabase) configureSqlite(db);
      if (!pgDatabase) db.exec('PRAGMA foreign_keys=ON');
    });
  } catch (error) {
    if (db?.isOpen) db.close();
    throw error;
  }
  const statements = createPreparedStatements(db),
    prepare = statements.prepare;
  const snapshotMode = pgDatabase ? 'READONLY' : 'DEFERRED';
  let schemaVersion, records;
  try {
    openingPhase('schema', () => {
      // Read once on this new connection. Offline migrations/reopens must always
      // re-read the actual file; this is not a tenant-level schema cache.
      schemaVersion = pgDatabase
        ? db.catalog.version
        : db.prepare('PRAGMA user_version').get().user_version;
      if (!newDatabase && cabinetSchema && schemaVersion !== cabinetSchema)
        throw Error('Prepare the requested cabinet schema on an offline copy');
      // Prepared version1/2 already owns these tables. Malformed prepared
      // databases fail closed, not self-repair.
      if (schemaVersion === 0)
        db.exec(
          'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB NOT NULL); CREATE TABLE IF NOT EXISTS patients(id TEXT PRIMARY KEY, value BLOB NOT NULL); CREATE TABLE IF NOT EXISTS services(id TEXT PRIMARY KEY, value BLOB NOT NULL); CREATE TABLE IF NOT EXISTS photos(id TEXT PRIMARY KEY, mime TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1); CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, time INTEGER NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, value BLOB NOT NULL); CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);',
        );
      records = createPatientRecords({ db, prepare, encode, decode, hash, schemaVersion });
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const preparedWrites = createPreparedWrites({
    budget: readCacheBudget,
    copyInput: false,
    prepare: (input) => prepareRecordCiphers(input, records ? 2 : 1, encode),
  });
  let captureMutationRead = false;
  const mutationReads = new WeakMap();
  const freezeMutation = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freezeMutation(child);
      Object.freeze(value);
    }
    return value;
  };
  const decodeRows = (table, rows) =>
    table === 'patients' && records
      ? records.hydrate(rows, captureMutationRead)
      : rows.map((row) => decode(row.value));
  const serviceReads = createServiceReadCache({
    db,
    decode,
    budget: readCacheBudget,
    owner: encode,
  });
  function get(name, fallback = null) {
    const row = prepare('SELECT value FROM meta WHERE key=?').get(name);
    return row ? decode(row.value) : fallback;
  }
  function set(name, value) {
    prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(name, encode(value));
  }
  const calendarOccupancy = createCalendarOccupancyVersion({
    db,
    get,
    set,
    hash: (value) => crypto.createHmac('sha256', cipherKey).update(value).digest('hex'),
    prepare,
    decode,
  });
  function audit(event, detail = {}) {
    prepare('INSERT INTO audit(time,event,detail) VALUES(?,?,?)').run(
      Date.now(),
      event,
      JSON.stringify(detail),
    );
    prepare('DELETE FROM audit WHERE time < ?').run(Date.now() - 90 * 86400000);
  }
  let inTransaction = false,
    transactionGeneration = 0;
  const writeClock = () =>
    pgDatabase ? db.localMutationClock : prepare('SELECT total_changes() AS n').get().n;
  function transaction(callback, mode = 'IMMEDIATE', committed) {
    if (inTransaction) throw Error('Nested cabinet transaction');
    db.exec('BEGIN ' + mode);
    inTransaction = true;
    transactionGeneration++;
    try {
      const result = callback();
      if (result && typeof result.then === 'function')
        throw Error('Asynchronous cabinet transaction is not allowed');
      const started = performance.now();
      db.exec('COMMIT');
      try {
        committed?.(performance.now() - started);
      } catch {}
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      inTransaction = false;
    }
  }
  function read() {
    const snapshot = () => ({
      patients: decodeRows(
        'patients',
        prepare('SELECT id,value FROM patients ORDER BY rowid').all(),
      ),
      services: prepare('SELECT value FROM services ORDER BY rowid')
        .all()
        .map((r) => decode(r.value)),
      revision: get('revision', 0),
      initialized: get('initialized', false),
    });
    return inTransaction ? snapshot() : transaction(snapshot, snapshotMode);
  }
  function readSelected(patientIds = [], serviceIds = []) {
    const select = (table, ids) => {
      if (ids.length <= 1)
        return decodeRows(
          table,
          ids.flatMap((id) => {
            const row = prepare('SELECT id,value FROM ' + table + ' WHERE id=?').get(id);
            return row ? [row] : [];
          }),
        );
      const result = [];
      // Drive indexed lookups from requested IDs; retain their order and duplicates.
      // One stable statement per table, without a growing IN-placeholder cache.
      const query = prepare(
        'SELECT selected.id,selected.value FROM json_each(?) AS requested CROSS JOIN ' +
          table +
          ' AS selected WHERE selected.id=requested.value ORDER BY CAST(requested.key AS INTEGER)',
      );
      for (let offset = 0; offset < ids.length; offset += 200)
        for (const row of query.all(JSON.stringify(ids.slice(offset, offset + 200))))
          result.push(row);
      return decodeRows(table, result);
    };
    const snapshot = () => {
      if (
        typeof db.readSelectedBundle === 'function' &&
        db.canReadSelectedBundle === true &&
        db.transactionIntent === 'READONLY' &&
        patientIds.length <= 200 &&
        serviceIds.length <= 200
      ) {
        const bundle = db.readSelectedBundle(patientIds, serviceIds);
        const metadata = new Map(bundle.meta.map((row) => [row.key, decode(row.value)]));
        return {
          patients: records
            ? records.hydrateRows(bundle.patients, bundle.records, captureMutationRead)
            : bundle.patients.map((row) => decode(row.value)),
          services: bundle.services.map((row) => decode(row.value)),
          revision: metadata.has('revision') ? metadata.get('revision') : 0,
          initialized: metadata.has('initialized') ? metadata.get('initialized') : false,
        };
      }
      return {
        patients: select('patients', patientIds),
        services: select('services', serviceIds),
        revision: get('revision', 0),
        initialized: get('initialized', false),
      };
    };
    return inTransaction ? snapshot() : transaction(snapshot, snapshotMode);
  }
  // A fresh synchronous writer snapshot is consumed only in this transaction.
  // Caller/HTTP objects, previous transactions and intervening SQL writes cannot
  // replace the authoritative before used by sync/index bookkeeping.
  function readForMutation(changedIds) {
    if (!inTransaction) throw Error('Cabinet mutation read requires transaction');
    captureMutationRead = true;
    let value;
    try {
      value = changedIds ? readSelected(changedIds.patients, changedIds.services) : read();
    } finally {
      captureMutationRead = false;
    }
    mutationReads.set(value, {
      generation: transactionGeneration,
      clock: writeClock(),
      records: records?.captureWrite(value.patients),
    });
    return freezeMutation(value);
  }
  function overview(current, project) {
    return transaction(() => {
      const snapshot = {
        patients: [],
        services: serviceReads.read(),
        revision: get('revision', 0),
        initialized: get('initialized', false),
      };
      // A paged projection reads its directory inside this same SQLite snapshot.
      // It can reuse the bounded directory cache without first decoding every row.
      return project ? project(snapshot) : { ...snapshot, directory: indexes.summaries(current) };
    }, snapshotMode);
  }
  function readServices() {
    return transaction(serviceReads.read, snapshotMode);
  }
  function readPatientAppointments(patientId) {
    const read = () =>
      records
        ? records.appointments(patientId)
        : readSelected([patientId]).patients[0]?.appointments || [];
    return inTransaction ? read() : transaction(read, snapshotMode);
  }
  function readSelectedAppointments(patientIds = []) {
    if (!patientIds.length) return [];
    const read = () =>
      records
        ? records.selectedAppointments(patientIds)
        : readSelected(patientIds).patients.map(({ id, appointments }) => ({ id, appointments }));
    return inTransaction ? read() : transaction(read, snapshotMode);
  }
  function readAppointment(patientId, id) {
    const read = () =>
      records
        ? records.appointment(patientId, id)
        : readPatientAppointments(patientId).find((row) => row.id === id) || null;
    return inTransaction ? read() : transaction(read, snapshotMode);
  }
  function calendarSnapshot(from, to, options) {
    return transaction(() => {
      const revision = get('revision', 0);
      return {
        revision,
        appointments:
          options?.projection === 'overview'
            ? []
            : indexes.appointments(from, to, {
                ...options,
                ...(options?.projection === 'occupancy' ? { includeNames: false } : {}),
                ...(options?.projection === 'subscription' ? { includeNames: 'subscription' } : {}),
              }),
        ...(options?.overview
          ? {
              overview: calendarProjection(
                revision,
                options.overview.from,
                options.overview.to,
                options.staffId,
              ),
            }
          : {}),
      };
    }, snapshotMode);
  }
  function photo(id) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw fail(404, 'Фотография не найдена.');
    const row = prepare('SELECT mime FROM photos WHERE id=? AND active=1').get(id);
    if (!row) throw fail(404, 'Фотография не найдена.');
    return { mime: row.mime, buffer: open(fs.readFileSync(path.join(photoDir, id + '.enc'))) };
  }
  async function photoAsync(id, options = {}) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw fail(404, 'Фотография не найдена.');
    const selected = prepare('SELECT mime FROM photos WHERE id=? AND active=1');
    const row = selected.get(id);
    if (!row) throw fail(404, 'Фотография не найдена.');
    return photoReader.read({
      filename: path.join(photoDir, id + '.enc'),
      mime: row.mime,
      decode: openOwnedBuffer,
      scopeKey: photoScopeKey,
      cancelled: options.cancelled,
      retain: options.retain,
      authorize: () => {
        options.authorize?.();
        if (selected.get(id)?.mime !== row.mime) throw fail(404, 'Фотография не найдена.');
      },
    });
  }
  function write(
    payload,
    {
      migrating = false,
      normalizedImages,
      insideTransaction = false,
      changedIds,
      preparedWrite,
      preparedBefore,
      appointmentOnly = false,
    } = {},
  ) {
    if (insideTransaction && !inTransaction) throw Error('Cabinet transaction required');
    if (appointmentWriter.owns(preparedBefore)) {
      if (!insideTransaction) throw Error('Appointment writer requires owning transaction');
      return appointmentWriter.write(payload, preparedBefore, { appointmentOnly });
    }
    const captured = preparedBefore && mutationReads.get(preparedBefore);
    if (captured) mutationReads.delete(preparedBefore);
    const trustedBefore =
      captured &&
      inTransaction &&
      captured.generation === transactionGeneration &&
      captured.clock === writeClock()
        ? preparedBefore
        : null;
    validateState(payload);
    const prepared =
      preparedWrite && preparedWrites.take(preparedWrite, preparedBefore, payload, changedIds);
    const encoder = prepared
      ? (value) => {
          const cached = prepared.get(JSON.stringify(value));
          return cached ? Buffer.from(cached) : encode(value);
        }
      : encode;
    if (!payload || !Array.isArray(payload.patients) || !Array.isArray(payload.services))
      throw fail(400, 'Неверный формат картотеки.');
    if (payload.patients.length > 20000 || payload.services.length > 2000)
      throw fail(400, 'Превышено число карточек или услуг.');
    const created = [],
      used = new Set();
    const ids = (values) =>
      values.every(
        (v) => v && typeof v.id === 'string' && v.id.length <= 120 && typeof v.name === 'string',
      ) && new Set(values.map((v) => v.id)).size === values.length;
    if (!ids(payload.patients) || !ids(payload.services))
      throw fail(400, 'Карточки и услуги должны иметь уникальные идентификаторы.');
    const priorPatients = new Map(
      (trustedBefore?.patients || []).map((patient) => [patient.id, patient]),
    );
    const retainedVisits = new Set();
    const patients = payload.patients.map((patient) => {
      const prior = priorPatients.get(patient.id);
      if (
        prior &&
        prior.visits.every((visit) => Array.isArray(visit.photos)) &&
        isDeepStrictEqual(prior.visits, patient.visits)
      ) {
        retainedVisits.add(patient.id);
        return {
          ...patient,
          visits: prior.visits,
          appointments: structuredClone(patient.appointments),
        };
      }
      return structuredClone(patient);
    });
    function convert(ph) {
      if (!ph || typeof ph.data !== 'string') throw fail(400, 'Некорректная фотография.');
      let id;
      const ref = ph.data.match(/^\/api\/photos\/([a-f0-9]{32})$/);
      if (ref) {
        id = ref[1];
        if (!db.prepare('SELECT id FROM photos WHERE id=? AND active=1').get(id))
          throw fail(400, 'Фотография недоступна.');
      } else {
        const match = ph.data.match(
          /^data:(image\/(?:jpeg|png|webp));base64,([a-zA-Z0-9+/=\r\n]+)$/,
        );
        if (!match) throw fail(400, 'Разрешены фотографии JPEG, PNG и WebP.');
        let buffer = Buffer.from(match[2], 'base64');
        const mime = match[1];
        const valid =
          mime === 'image/jpeg'
            ? buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
            : mime === 'image/png'
              ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
              : buffer.subarray(0, 4).toString() === 'RIFF' &&
                buffer.subarray(8, 12).toString() === 'WEBP';
        if (!valid || buffer.length > 10 * 1024 * 1024)
          throw fail(400, 'Повреждённая фотография или размер больше 10 МБ.');
        try {
          buffer = normalizedImages?.get(ph.data) || normalizeImage(buffer, mime);
        } catch {
          throw fail(
            400,
            'Не удалось прочитать фотографию. Разрешены целые JPEG, PNG и WebP до 10 МБ и 40 миллионов пикселей.',
          );
        }
        id = crypto.randomBytes(16).toString('hex');
        fs.writeFileSync(path.join(photoDir, id + '.enc'), seal(buffer), {
          flag: 'wx',
          mode: 0o600,
        });
        created.push(id);
        db.prepare('INSERT INTO photos(id,mime,active) VALUES(?,?,1)').run(id, mime);
      }
      used.add(id);
      return { ...ph, data: '/api/photos/' + id };
    }
    try {
      const commit = () => {
        if (!migrating && payload.revision !== get('revision', 0))
          throw fail(
            409,
            'Картотека изменилась в другой вкладке. Обновите страницу перед повторным сохранением.',
          );
        indexes.assertUnique(
          patients,
          changedIds?.patients ||
            prepare('SELECT id FROM patients')
              .all()
              .map((row) => row.id),
        );
        const oldPhotos = changedIds
          ? changedIds.patients.flatMap((id) =>
              prepare('SELECT photo_id FROM cabinet_photo_refs WHERE patient_id=?')
                .all(id)
                .map((row) => row.photo_id),
            )
          : [];
        for (const p of patients) {
          if (!Array.isArray(p.visits) || !Array.isArray(p.appointments))
            throw fail(400, 'Неверный формат посещений.');
          for (const v of p.visits) {
            if (!v || typeof v.id !== 'string') throw fail(400, 'Неверный формат посещения.');
            if (v.photos !== undefined && (!Array.isArray(v.photos) || v.photos.length > 6))
              throw fail(400, 'Допускается до шести фотографий на посещение.');
            if (retainedVisits.has(p.id)) {
              for (const photo of v.photos || []) convert(photo);
            } else v.photos = (v.photos || []).map(convert);
          }
        }
        // Keep unchanged encrypted rows and their order. Only changed records are written.
        const { previousPatients, indexedIds } = records
          ? records.sync(
              patients,
              changedIds?.patients,
              encoder,
              trustedBefore ? captured.records : null,
            )
          : { previousPatients: new Map(), indexedIds: new Set() };
        const sync = (table, values) => {
          const selected = changedIds?.[table];
          const trusted =
            trustedBefore &&
            (table === 'patients'
              ? priorPatients
              : new Map(trustedBefore.services.map((service) => [service.id, service])));
          const prior = trusted
            ? new Map(trusted)
            : new Map(
                (selected
                  ? selected.flatMap((id) => {
                      const row = prepare('SELECT id,value FROM ' + table + ' WHERE id=?').get(id);
                      return row ? [row] : [];
                    })
                  : prepare('SELECT id,value FROM ' + table).all()
                ).map((row) => [row.id, row.value]),
              );
          const put = prepare(
            'INSERT INTO ' +
              table +
              '(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
          );
          for (const value of values) {
            const old = prior.get(value.id),
              before = trusted ? old : old ? decode(old) : null;
            if (!old || JSON.stringify(before) !== JSON.stringify(value)) {
              put.run(value.id, encoder(value));
              if (table === 'patients') {
                previousPatients.set(value.id, before);
                indexedIds.add(value.id);
              }
            }
            prior.delete(value.id);
          }
          const remove = prepare('DELETE FROM ' + table + ' WHERE id=?');
          for (const id of prior.keys()) {
            remove.run(id);
            if (table === 'patients') indexedIds.add(id);
          }
        };
        if (!records) sync('patients', patients);
        sync('services', payload.services);
        calendarOccupancy.update(patients, indexedIds, previousPatients);
        indexes.replace(
          patients.filter((patient) => indexedIds.has(patient.id)),
          [...indexedIds],
          previousPatients,
        );
        // Retain encrypted orphan files until the next verified backup, but immediately deny HTTP access.
        const deactivate = prepare('UPDATE photos SET active=0 WHERE id=?');
        const candidates = changedIds
          ? [...new Set(oldPhotos)].map((id) => ({ id }))
          : prepare('SELECT id FROM photos WHERE active=1').all();
        for (const row of candidates)
          if (!prepare('SELECT 1 FROM cabinet_photo_refs WHERE photo_id=? LIMIT 1').get(row.id))
            deactivate.run(row.id);
        const revision = migrating ? payload.revision || 0 : get('revision', 0) + 1;
        set('revision', revision);
        set('initialized', true);
        audit(migrating ? 'migration' : 'cabinet_saved', {
          patients: patients.length,
          services: payload.services.length,
          partial: Boolean(changedIds),
        });
        return { revision, patients, services: payload.services };
      };
      return insideTransaction ? commit() : transaction(commit);
    } catch (error) {
      for (const id of created) fs.unlinkSync(path.join(photoDir, id + '.enc'));
      throw error;
    }
  }
  async function prepareImages(payload, authorize = () => {}) {
    validateState(payload);
    authorize();
    const normalizedImages = new Map(),
      deadline = Date.now() + 60000;
    for (const p of payload.patients)
      for (const v of p.visits)
        for (const ph of v.photos || []) {
          if (/^\/api\/photos\/[a-f0-9]{32}$/.test(ph.data) || normalizedImages.has(ph.data))
            continue;
          const match = ph.data.match(
            /^data:(image\/(?:jpeg|png|webp));base64,([a-zA-Z0-9+/=\r\n]+)$/,
          );
          if (!match) throw fail(400, 'Разрешены фотографии JPEG, PNG и WebP.');
          if (Date.now() > deadline)
            throw fail(400, 'Слишком много новых фотографий. Разделите загрузку на части.');
          try {
            normalizedImages.set(
              ph.data,
              await normalizeImageAsync(
                Buffer.from(match[2], 'base64'),
                match[1],
                authorize,
                photoScopeKey,
              ),
            );
          } catch (error) {
            if (error.status) throw error;
            throw fail(
              400,
              'Повреждённая фотография или превышены ограничения: 10 МБ, 40 миллионов пикселей.',
            );
          }
          authorize();
        }
    authorize(); // Recheck after every asynchronous decoder and immediately before committing.
    return normalizedImages;
  }
  async function writeAsync(payload, authorize = () => {}) {
    validateState(payload);
    authorize();
    if (payload.revision !== get('revision', 0))
      throw fail(409, 'Картотека изменилась в другой вкладке. Обновите страницу.');
    const normalizedImages = await prepareImages(payload, authorize);
    return write(payload, { normalizedImages });
  }
  let indexes;
  try {
    indexes = openingPhase('indexes', () =>
      createCabinetIndexes({
        db,
        prepare,
        directory,
        encode,
        decode,
        schemaVersion,
        hash: (value) => crypto.createHmac('sha256', cipherKey).update(value).digest('hex'),
      }),
    );
    // Only brand-new empty databases use the selected format at creation.
    // Existing tenants must come from the separately verified offline upgrade.
    if (newDatabase && cabinetSchema === 2) {
      require('../migrations/002-cabinet-records.cjs').migrateCabinetRecords({
        db,
        encode,
        decode,
      });
      records = createPatientRecords({ db, prepare, encode, decode, hash });
    }
  } catch (error) {
    db.close();
    throw error;
  }
  const appointmentWriter = createAppointmentWriter145({
    prepare,
    runWrites: createWriteBatch({ db, prepare }),
    encode,
    decode,
    get,
    set,
    audit,
    hash: (value) => crypto.createHmac('sha256', cipherKey).update(value).digest('hex'),
    clock: writeClock,
    generation: () => transactionGeneration,
    active: () => inTransaction,
    records,
    historyIndex: records?.historyIndex,
    indexes,
    calendarOccupancy,
    readSelected,
    freeze: freezeMutation,
    historyIndex: records?.historyIndex || null,
  });
  const legacy = path.join(directory, 'cabinet.json');
  const calendarProjection = require('./calendar-projection.cjs').createCalendarProjection({
    indexes,
    budget: readCacheBudget,
    owner: encode,
  });
  if (fs.existsSync(legacy) && !get('migrated')) {
    const raw = fs.readFileSync(legacy);
    const state = JSON.parse(raw);
    if (!state.owner) throw Error('Legacy cabinet has no owner');
    // Original source is retained encrypted before migration. Failure leaves the JSON intact.
    fs.writeFileSync(path.join(directory, 'migration-original.enc'), seal(raw), { mode: 0o600 });
    write(
      {
        patients: state.patients || [],
        services: state.services || [],
        revision: state.revision || 0,
      },
      { migrating: true },
    );
    transaction(() => {
      set('owner', state.owner);
      set('initialized', Boolean(state.initialized));
    });
    // Verify all new rows and photo payloads before retiring the plaintext source.
    for (const p of read().patients)
      for (const v of p.visits) for (const ph of v.photos) photo(ph.data.split('/').pop());
    set('migrated', true);
    fs.unlinkSync(legacy);
    const prior = legacy + '.backup';
    if (fs.existsSync(prior)) {
      fs.writeFileSync(
        path.join(directory, 'migration-previous.enc'),
        seal(fs.readFileSync(prior)),
        { mode: 0o600 },
      );
      fs.unlinkSync(prior);
    }
  }
  const patientHistory = createPatientHistoryReader({
    db,
    encode,
    decode,
    hash,
    schemaVersion: records ? 2 : 1,
  });
  return {
    db,
    readCacheBudget,
    statementStats: statements.stats,
    directory,
    filename,
    photoDir,
    get,
    set,
    audit,
    transaction,
    readOnlySnapshot: (callback) => transaction(callback, snapshotMode),
    read,
    readSelected,
    readForMutation,
    readAppointmentMutation: appointmentWriter.read,
    overview,
    readServices,
    readPatientAppointments,
    readSelectedAppointments,
    readAppointment,
    patientView: (current, url) =>
      transaction(() => patientHistory.read(current, url), snapshotMode),
    patientViewAppointments: (current, url, ids) =>
      transaction(() => patientHistory.read(current, url, ids), snapshotMode),
    historyIndex: records?.historyIndex || null,
    patientHistory: records?.historyIndex || null,
    capabilities: Object.freeze({
      cabinetSchemaVersion: records ? 2 : 1,
      normalizedRecords: Boolean(records),
    }),
    readVersion: createReadVersion(db),
    calendarSnapshot,
    calendarOccupancyVersion: calendarOccupancy.version,
    indexes,
    write,
    prepareWrite: (before, next, { changedIds } = {}) =>
      preparedWrites.prepare(before, next, changedIds),
    discardPreparedWrite: preparedWrites.discard,
    writeAsync,
    prepareImages,
    photo,
    photoAsync,
    encode,
    decode,
    seal,
    open,
    close: (observe) => {
      const phase = (name, callback) => {
        const started = performance.now();
        let failed = true;
        try {
          callback();
          failed = false;
        } finally {
          try {
            observe?.(name, performance.now() - started, failed);
          } catch {}
        }
      };
      phase('cleanup', () => {
        preparedWrites.clear();
        serviceReads.clear();
        readCacheBudget.releaseOwner(encode);
        statements.clear();
      });
      phase('database', () => db.close());
    },
  };
}
module.exports = { createStorage, fail };
