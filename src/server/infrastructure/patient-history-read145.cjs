const { fail } = require('../../shared/errors.cjs');
const { isActiveAppointment, isClosedAppointment } = require('../../shared/appointment-status.cjs');
const { supported, sourceHash, chronological } = require('./cabinet-history-index145.cjs');
const LIMIT = 50;
const invalid = () => fail(400, 'Недействительное продолжение истории.');
const badIndex = () =>
  Object.assign(Error('Canonical history index mismatch'), {
    status: 503,
    code: 'CABINET_HISTORY_INDEX',
  });
function createPatientHistoryReader({
  db,
  encode,
  decode,
  hash,
  schemaVersion = db.catalog?.version,
}) {
  const available = supported(db, schemaVersion);
  const request = (sql, method, ...args) => ({ sql, method, args });
  function scope(current, id, mode) {
    if (!['owner', 'salon_admin', 'cosmetologist'].includes(current.role))
      throw fail(403, 'Нет доступа к карточке.');
    if (!current.sessionId || !current.accountId || !current.organizationId)
      throw fail(403, 'Сеанс завершён.');
    return hash(
      JSON.stringify([
        'patient-page145',
        current.organizationId,
        current.accountId,
        current.sessionId,
        current.role,
        id,
        mode,
      ]),
    );
  }
  function parameters(current, url) {
    const id = url.searchParams.get('id') || url.searchParams.get('patientId');
    if (typeof id !== 'string' || !id || id.length > 120) throw fail(400, 'Укажите карточку.');
    const mode = url.pathname.endsWith('/upcoming')
      ? 'upcoming'
      : url.pathname.endsWith('/history')
        ? 'history'
        : 'card';
    const identity = scope(current, id, mode);
    let cursor = { visit: 0, outcome: 0, upcoming: 0 };
    const token = url.searchParams.get('cursor');
    if (token) {
      try {
        if (token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) throw invalid();
        cursor = decode(Buffer.from(token, 'base64url'));
      } catch {
        throw invalid();
      }
      if (
        cursor.scope !== identity ||
        cursor.mode !== mode ||
        !Number.isSafeInteger(cursor.revision) ||
        !['visit', 'outcome', 'upcoming'].every(
          (key) => Number.isSafeInteger(cursor[key]) && cursor[key] >= 0,
        )
      )
        throw invalid();
    }
    return { id, mode, identity, cursor, hasCursor: Boolean(token) };
  }
  function* project(current, url, selectedIds = null) {
    if (!available) return { viewUnsupported: true };
    const params = parameters(current, url),
      { id, mode, cursor } = params;
    const audience = current.role === 'cosmetologist' ? hash('staff:' + current.accountId) : '*';
    const [profileRow, revisionRow, manifestRows] = yield [
      request('SELECT id,value FROM patients WHERE id=?', 'get', id),
      request('SELECT value FROM meta WHERE key=?', 'get', 'revision'),
      request(
        'SELECT audience,stream,witness_kind,witness_id,value FROM cabinet_history_manifests WHERE patient_id=? AND audience IN (?,?)',
        'all',
        id,
        '*',
        audience,
      ),
    ];
    if (!profileRow) throw fail(404, 'Карточка не найдена.');
    const patient = decode(profileRow.value),
      revision = revisionRow ? decode(revisionRow.value) : 0;
    if (
      !patient ||
      patient.id !== id ||
      'visits' in patient ||
      'appointments' in patient ||
      !Number.isSafeInteger(revision)
    )
      throw badIndex();
    if (params.hasCursor && cursor.revision !== revision)
      throw fail(409, 'Карточка изменилась. Откройте историю заново.');
    const expectedRevision = url.searchParams.get('revision');
    if (
      expectedRevision !== null &&
      (!/^(0|[1-9][0-9]*)$/.test(expectedRevision) ||
        !Number.isSafeInteger(Number(expectedRevision)))
    )
      throw invalid();
    if (expectedRevision !== null && Number(expectedRevision) !== revision)
      throw fail(409, 'Карточка изменилась. Откройте историю заново.');
    const manifests = new Map();
    for (const row of manifestRows) {
      const value = decode(row.value);
      if (
        !['visit', 'outcome', 'upcoming'].includes(row.stream) ||
        value.version !== 1 ||
        value.patientId !== id ||
        value.audience !== row.audience ||
        value.stream !== row.stream ||
        (value.witness?.kind || null) !== row.witness_kind ||
        (value.witness?.id || null) !== row.witness_id ||
        value.profileHash !== hash(profileRow.value) ||
        !Number.isSafeInteger(value.total) ||
        value.total < 0 ||
        !Number.isSafeInteger(value.photoCount) ||
        value.photoCount < 0 ||
        (row.stream !== 'visit' && value.photoCount !== 0)
      )
        throw badIndex();
      manifests.set(row.audience + ':' + row.stream, value);
    }
    for (const stream of ['visit', 'outcome', 'upcoming']) {
      const global = manifests.get('*:' + stream);
      if (
        !global ||
        !Array.isArray(global.audiences) ||
        global.audiences.length > 10000 ||
        global.audiences.some((v) => typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) ||
        new Set(global.audiences).size !== global.audiences.length
      )
        throw badIndex();
      if (
        audience !== '*' &&
        global.audiences.includes(audience) !== manifests.has(audience + ':' + stream)
      )
        throw badIndex();
    }
    const manifest = (stream) =>
      manifests.get(audience + ':' + stream) || { total: 0, photoCount: 0, witness: null };
    const decodeRecord = (row, proof, expectedKind) => {
      if (
        !row ||
        row.patient_id !== id ||
        row.kind !== expectedKind ||
        row.id !== proof.id ||
        row.position !== proof.position ||
        sourceHash(hash, row) !== proof.sourceHash
      )
        throw badIndex();
      const value = decode(row.value);
      if (!value || value.id !== row.id) throw badIndex();
      if (current.role === 'cosmetologist' && value.staffId !== current.accountId)
        throw fail(404, 'Карточка не найдена.');
      return value;
    };
    // Membership/role is fresh outside the owning snapshot. Visibility is proved
    // by a canonical staff record, never by an audience/count/index row alone.
    if (current.role === 'cosmetologist' && patient.createdBy !== current.accountId) {
      const witness = ['visit', 'outcome', 'upcoming']
        .map(manifest)
        .find((m) => m.witness)?.witness;
      if (!witness || !['visit', 'appointment'].includes(witness.kind))
        throw fail(404, 'Карточка не найдена.');
      const [row] = yield [
        request(
          'SELECT kind,id,patient_id,position,value FROM cabinet_patient_records WHERE patient_id=? AND kind=? AND id=?',
          'get',
          id,
          witness.kind,
          witness.id,
        ),
      ];
      decodeRecord(row, witness, witness.kind);
    }
    const token = (pageMode, positions) =>
      encode({
        scope: scope(current, id, pageMode),
        mode: pageMode,
        revision,
        visit: 0,
        outcome: 0,
        upcoming: 0,
        ...positions,
      }).toString('base64url');
    if (selectedIds) {
      if (
        !Array.isArray(selectedIds) ||
        selectedIds.length > 50 ||
        new Set(selectedIds).size !== selectedIds.length ||
        selectedIds.some((v) => typeof v !== 'string' || !v || v.length > 120)
      )
        throw fail(400, 'Некорректный список записей.');
      const [rows] = yield [
        request(
          "SELECT kind,id,patient_id,position,value FROM cabinet_patient_records WHERE patient_id=? AND kind='appointment' AND id IN (SELECT value FROM json_each(?)) ORDER BY position",
          'all',
          id,
          JSON.stringify(selectedIds),
        ),
      ];
      const appointments = rows.map((row) => {
        const value = decode(row.value);
        if (row.patient_id !== id || row.kind !== 'appointment' || !value || value.id !== row.id)
          throw badIndex();
        if (current.role === 'cosmetologist' && value.staffId !== current.accountId)
          throw fail(404, 'Запись не найдена.');
        return value;
      });
      if (appointments.length !== selectedIds.length) throw fail(404, 'Запись не найдена.');
      return { patient: { ...patient, visits: [], appointments }, revision };
    }
    const needed =
      mode === 'card'
        ? ['visit', 'outcome', 'upcoming']
        : mode === 'history'
          ? ['visit', 'outcome']
          : ['upcoming'];
    for (const stream of needed) if (cursor[stream] > manifest(stream).total) throw invalid();
    const batches = yield needed.map((stream) =>
      request(
        'SELECT e.rank,e.kind,e.id,e.position,e.source_hash,r.patient_id,r.value FROM cabinet_history_entries e LEFT JOIN cabinet_patient_records r ON r.patient_id=e.patient_id AND r.kind=e.kind AND r.id=e.id AND r.position=e.position WHERE e.patient_id=? AND e.audience=? AND e.stream=? AND e.rank>? ORDER BY e.rank LIMIT 51',
        'all',
        id,
        audience,
        stream,
        cursor[stream],
      ),
    );
    const selected = new Map();
    for (let i = 0; i < needed.length; i++) {
      const stream = needed[i],
        rows = batches[i],
        expected = Math.min(51, manifest(stream).total - cursor[stream]);
      if (rows.length !== expected) throw badIndex();
      const values = rows.map((row, index) => {
        if (row.rank !== cursor[stream] + index + 1) throw badIndex();
        const value = decodeRecord(
          row,
          { id: row.id, position: row.position, sourceHash: row.source_hash },
          stream === 'visit' ? 'visit' : 'appointment',
        );
        if (
          (stream === 'outcome' && !isClosedAppointment(value)) ||
          (stream === 'upcoming' && !isActiveAppointment(value))
        )
          throw badIndex();
        return { kind: row.kind, record: value, rank: row.rank, position: row.position };
      });
      for (let j = 1; j < values.length; j++) {
        const compared = chronological(
          { value: values[j - 1].record },
          { value: values[j].record },
        );
        if (
          (stream === 'upcoming' ? compared < 0 : compared > 0) ||
          (compared === 0 && values[j - 1].position >= values[j].position)
        )
          throw badIndex();
      }
      selected.set(stream, values);
    }
    const result = { revision };
    if (mode !== 'upcoming') {
      const rows = [...selected.get('visit'), ...selected.get('outcome')]
        .sort(
          (a, b) =>
            chronological({ value: a.record }, { value: b.record }) ||
            (a.kind === b.kind ? a.position - b.position : a.kind === 'visit' ? -1 : 1),
        )
        .slice(0, LIMIT);
      const positions = { visit: cursor.visit, outcome: cursor.outcome };
      for (const row of rows) positions[row.kind === 'visit' ? 'visit' : 'outcome'] = row.rank;
      result.history = {
        entries: rows.map(({ kind, record }) => ({ kind, record })),
        total: manifest('visit').total + manifest('outcome').total,
        photoCount: manifest('visit').photoCount,
        nextCursor:
          positions.visit < manifest('visit').total || positions.outcome < manifest('outcome').total
            ? token('history', positions)
            : null,
      };
    }
    if (mode !== 'history') {
      const rows = selected.get('upcoming').slice(0, LIMIT),
        next = rows.at(-1)?.rank || cursor.upcoming;
      result.upcoming = {
        entries: rows.map(({ record }) => record),
        total: manifest('upcoming').total,
        nextCursor:
          next < manifest('upcoming').total ? token('upcoming', { upcoming: next }) : null,
      };
    }
    if (mode === 'card')
      result.patient = {
        ...patient,
        visits: result.history.entries.filter((e) => e.kind === 'visit').map((e) => e.record),
        appointments: [
          ...result.history.entries.filter((e) => e.kind === 'appointment').map((e) => e.record),
          ...result.upcoming.entries,
        ],
      };
    return mode === 'history'
      ? { revision, ...result.history }
      : mode === 'upcoming'
        ? { revision, ...result.upcoming }
        : result;
  }
  function read(current, url, ids) {
    const iterator = project(current, url, ids);
    let state = iterator.next();
    while (!state.done)
      state = iterator.next(
        state.value.map(({ sql, method, args }) => db.prepare(sql)[method](...args)),
      );
    return state.value;
  }
  function readPrepared(current, url, lookup) {
    const iterator = project(current, url);
    let state = iterator.next();
    while (!state.done) state = iterator.next(state.value.map(lookup));
    return state.value;
  }
  async function readAsync(current, url, ids) {
    const iterator = project(current, url, ids);
    let state = iterator.next();
    while (!state.done) {
      const queries = state.value.map(({ sql, method, args }) => ({
        statement: db.prepare(sql),
        method,
        args,
      }));
      await db.prefetchAll(
        queries.map(({ statement, method, args }) => statement.readRequest(method, args)),
      );
      state = iterator.next(
        queries.map(({ statement, method, args }) => statement[method](...args)),
      );
    }
    return state.value;
  }
  function sources(operation, current, url, selectedIds = null) {
    if (!available) return [];
    const { id, mode, cursor } = parameters(current, url);
    const audience = current.role === 'cosmetologist' ? hash('staff:' + current.accountId) : '*';
    const { scope, cabinetCatalog: catalog } = operation;
    const add = (table, where, values) => ({ scope, catalog, table, where, values });
    const needed =
      mode === 'card'
        ? ['visit', 'outcome', 'upcoming']
        : mode === 'history'
          ? ['visit', 'outcome']
          : ['upcoming'];
    const predicates = needed.map(
      (stream, i) =>
        `(e.stream=$${i * 2 + 4} AND e.rank>$${i * 2 + 5} AND e.rank<=$${i * 2 + 5}+51)`,
    );
    const positions = needed.flatMap((stream) => [stream, cursor[stream]]);
    const entries =
      'e._store_id=$1 AND e.patient_id=$2 AND e.audience=$3 AND (' + predicates.join(' OR ') + ')';
    const canonical = selectedIds
      ? "s.kind='appointment' AND s.id=ANY($4::text[])"
      : 'EXISTS(SELECT 1 FROM cartoteca_cabinet.cabinet_history_entries e WHERE ' +
        entries +
        ' AND e.kind=s.kind AND e.id=s.id AND e.position=s.position)';
    const values = [id, audience, ...(selectedIds ? [selectedIds] : positions)];
    return [
      add('patients', 's.id=$2', [id]),
      add('meta', "s.key IN ('revision','initialized')", []),
      add('cabinet_history_manifests', "s.patient_id=$2 AND s.audience IN ('*',$3)", [
        id,
        audience,
      ]),
      ...(!selectedIds
        ? [
            add('cabinet_history_entries', entries.replaceAll('e.', 's.'), [
              id,
              audience,
              ...positions,
            ]),
          ]
        : []),
      add(
        'cabinet_patient_records',
        's.patient_id=$2 AND ((' +
          canonical +
          ') OR EXISTS(SELECT 1 FROM cartoteca_cabinet.cabinet_history_manifests m WHERE m._store_id=$1 AND m.patient_id=$2 AND m.audience=$3 AND m.witness_kind=s.kind AND m.witness_id=s.id))',
        values,
      ),
    ];
  }
  return { supported: available, read, readAsync, readPrepared, parameters, sources };
}
module.exports = { createPatientHistoryReader, LIMIT };
