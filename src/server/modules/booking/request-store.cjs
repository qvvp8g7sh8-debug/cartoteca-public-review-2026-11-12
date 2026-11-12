const crypto = require('node:crypto');
const { fail } = require('../../../shared/errors.cjs');
const { validDate, nextDate } = require('../../../shared/work-schedule.cjs');
const { phoneKey } = require('./contacts.cjs');
const { createBookingRequestSummary } = require('./request-summary.cjs');
const { createBookingRequestOrigins } = require('./request-origins.cjs');
const OTHER_TIME_TTL = 24 * 60 * 60000;

// Internal persistence only. Admission/ACL/collision checks belong to the command layer.
// A caller holds the platform write lock before consulting cabinet occupancy.
function createBookingRequestStore({ db, seal, open, id, limitKey, notify = () => {} }) {
  const feed = createBookingRequestSummary({ db, limitKey });
  const origins = createBookingRequestOrigins({ db, open });
  function writeOnly() {
    if (!db.isTransaction) throw Error('Booking request write requires platform transaction.');
  }
  function decode(row, now) {
    if (!row) return null;
    const value = open(row.value);
    // Legacy requests had no deadline. Derive it from creation, never from a read/restart.
    const expiresAt =
      value.kind === 'other-time'
        ? Math.min(row.expires_at ?? Infinity, row.created_at + OTHER_TIME_TTL)
        : row.expires_at;
    return {
      ...value,
      id: row.id,
      staffId: row.staff_id,
      revision: row.revision,
      createdAt: row.created_at,
      expiresAt,
      status:
        ['pending', 'requested'].includes(row.status) && expiresAt <= now ? 'expired' : row.status,
    };
  }
  function get(org, requestId, now = Date.now()) {
    return decode(
      db
        .prepare('SELECT * FROM booking_requests WHERE organization_id=? AND id=?')
        .get(org, requestId),
      now,
    );
  }
  function create(org, key, payload, reservationMinutes, now = Date.now()) {
    writeOnly();
    if (
      typeof key !== 'string' ||
      key.length < 16 ||
      key.length > 120 ||
      !payload ||
      !validDate(payload.date) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(payload.time) ||
      !Number.isInteger(payload.duration) ||
      payload.duration < 5 ||
      payload.duration > 1440 ||
      payload.duration % 5 ||
      typeof payload.staffId !== 'string' ||
      !payload.staffId ||
      !['reserve', 'other-time'].includes(payload.kind) ||
      !Number.isInteger(reservationMinutes) ||
      reservationMinutes < 1 ||
      reservationMinutes > 1440
    )
      throw fail(400, 'Некорректная заявка.');
    const requestKey = limitKey('booking-request', key);
    // Fixed field order is provided by the command layer. No plaintext contact hash is stored.
    const fingerprint = limitKey('booking-payload', JSON.stringify(payload));
    const existing = db
      .prepare('SELECT * FROM booking_requests WHERE organization_id=? AND request_key=?')
      .get(org, requestKey);
    if (existing) {
      if (open(existing.value).fingerprint !== fingerprint)
        throw Object.assign(fail(409, 'Этот запрос уже использован для другой заявки.'), {
          code: 'BOOKING_KEY_CONFLICT',
        });
      return decode(existing, now);
    }
    const requestId = id(),
      status = payload.kind === 'reserve' ? 'pending' : 'requested';
    const expiresAt = now + (status === 'pending' ? reservationMinutes * 60000 : OTHER_TIME_TTL);
    const value = {
      ...payload,
      fingerprint,
      appointmentId: crypto.randomUUID(),
      patientId: crypto.randomUUID(),
      // Receipt time is server-owned and excluded from the retry fingerprint.
      ...(payload.privacyConsentVersion
        ? {
            privacyConsent: {
              granted: true,
              version: payload.privacyConsentVersion,
              purpose: 'booking',
              at: now,
            },
          }
        : {}),
    };
    db.prepare(
      `INSERT INTO booking_requests
      (id,organization_id,staff_id,request_key,value,status,expires_at,day_key,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      requestId,
      org,
      payload.staffId,
      requestKey,
      seal(value),
      status,
      expiresAt,
      limitKey('booking-day', payload.date),
      now,
    );
    const created = get(org, requestId, now);
    if (payload.bookingMode !== 'classic') notify(org, created, 'new-request', now);
    return created;
  }
  function byKey(org, key, now = Date.now()) {
    return decode(
      db
        .prepare('SELECT * FROM booking_requests WHERE organization_id=? AND request_key=?')
        .get(org, limitKey('booking-request', key)),
      now,
    );
  }
  function list(org, staffId, cursor = null, now = Date.now()) {
    const args = [org];
    let filter = " AND status IN ('pending','requested','expired')";
    if (staffId) {
      filter += ' AND staff_id=?';
      args.push(staffId);
    }
    if (cursor) {
      filter += ' AND (created_at<? OR (created_at=? AND id<?))';
      args.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    return feed.withSummary(
      () => {
        const rows = db
          .prepare(
            'SELECT * FROM booking_requests WHERE organization_id=?' +
              filter +
              ' ORDER BY created_at DESC,id DESC LIMIT 51',
          )
          .all(...args);
        const items = rows.slice(0, 50).map((row) => decode(row, now)),
          last = items.at(-1);
        return {
          items,
          cursor: rows.length > 50 ? { createdAt: last.createdAt, id: last.id } : null,
        };
      },
      org,
      staffId,
      now,
    );
  }
  function openCount(org) {
    return db
      .prepare(
        "SELECT count(*) n FROM booking_requests WHERE organization_id=? AND status IN ('pending','requested','expired')",
      )
      .get(org).n;
  }
  function publicCapacity(org, phone, now) {
    const rows = db
      .prepare(
        `SELECT value,status FROM booking_requests WHERE organization_id=? AND
        ((status='requested' AND MIN(COALESCE(expires_at,created_at+${OTHER_TIME_TTL}),created_at+${OTHER_TIME_TTL})>?)
        OR (status='pending' AND expires_at>?)) LIMIT 1001`,
      )
      .all(org, now, now);
    if (rows.filter((row) => row.status === 'pending').length >= 20)
      throw fail(429, 'Слишком много заявок ожидают решения. Свяжитесь с организацией.');
    if (rows.some((row) => phoneKey(open(row.value).phone) === phoneKey(phone)))
      throw Object.assign(
        fail(409, 'Заявка с этим номером уже ожидает решения. Свяжитесь с организацией.'),
        { code: 'BOOKING_PHONE_PENDING' },
      );
  }
  function reserveRead(org, from, to, now, excludeId) {
    if (!validDate(from) || !validDate(to) || from > to)
      throw fail(400, 'Некорректный период резервов.');
    const days = [];
    for (let date = from; date <= to; date = nextDate(date, 1)) {
      if (days.length >= 32) throw fail(400, 'Слишком большой период резервов.');
      days.push(limitKey('booking-day', date));
    }
    return {
      statement: db.prepare(
        `SELECT * FROM booking_requests WHERE organization_id=? AND status='pending'
      AND expires_at>? AND day_key IN (${days.map(() => '?').join(',')}) AND id!=? ORDER BY created_at,id`,
      ),
      args: [org, now, ...days, excludeId],
    };
  }
  function reserves(org, from, to, now = Date.now(), excludeId = '') {
    const { statement, args } = reserveRead(org, from, to, now, excludeId);
    return statement.all(...args).map((row) => {
      const value = decode(row, now);
      return {
        id: value.id,
        date: value.date,
        time: value.time,
        duration: value.duration,
        staffId: value.staffId,
        roomId: value.roomId,
        status: 'pending',
        expiresAt: value.expiresAt,
      };
    });
  }
  reserves.readRequests = (org, from, to, now = Date.now(), excludeId = '') => {
    if (!db.canPrefetchReads) return [];
    const { statement, args } = reserveRead(org, from, to, now, excludeId);
    return [statement.readRequest('all', args)];
  };
  function finish(org, requestId, revision, status, now = Date.now()) {
    writeOnly();
    if (!['accepted', 'rejected', 'cancelled'].includes(status))
      throw fail(400, 'Неверный статус заявки.');
    const current = get(org, requestId, now);
    if (!current) throw fail(404, 'Заявка не найдена.');
    if (current.revision !== revision) throw fail(409, 'Заявка уже изменена.');
    if (!['pending', 'requested', 'expired'].includes(current.status))
      throw fail(409, 'Заявка уже обработана.');
    if (status === 'accepted' && current.acceptance?.selection) {
      const row = db
        .prepare('SELECT value FROM booking_requests WHERE organization_id=? AND id=?')
        .get(org, requestId);
      const value = open(row.value),
        selected = current.acceptance.selection;
      value.originalWish ||= { date: value.date, time: value.time };
      Object.assign(value, { date: selected.date, time: selected.time, roomId: selected.roomId });
      db.prepare(
        'UPDATE booking_requests SET value=?,day_key=? WHERE organization_id=? AND id=?',
      ).run(seal(value), limitKey('booking-day', selected.date), org, requestId);
    }
    db.prepare(
      'UPDATE booking_requests SET status=?,revision=revision+1 WHERE organization_id=? AND id=? AND revision=?',
    ).run(status, org, requestId, revision);
    if (status === 'accepted' && current.bookingMode === 'classic')
      notify(org, get(org, requestId, now), 'new-classic-booking', now);
    return get(org, requestId, now);
  }
  // Persist the destination before the asynchronous cabinet command. A retry can
  // never create a second card or retarget a partially committed acceptance.
  function prepareAcceptance(
    org,
    requestId,
    revision,
    patientId,
    now = Date.now(),
    selection = null,
  ) {
    writeOnly();
    const current = get(org, requestId, now);
    if (!current) throw fail(404, 'Заявка не найдена.');
    if (current.revision !== revision) throw fail(409, 'Заявка уже изменена.');
    if (!['pending', 'requested', 'expired'].includes(current.status))
      throw fail(409, 'Заявка уже обработана.');
    if (current.acceptance && current.acceptance.patientId !== patientId)
      throw fail(409, 'Принятие заявки уже начато для другой карточки.');
    if (
      current.acceptance &&
      JSON.stringify(current.acceptance.selection || null) !== JSON.stringify(selection)
    )
      throw fail(409, 'Принятие заявки уже начато для другого времени.');
    if (!current.acceptance) {
      const row = db
        .prepare('SELECT value FROM booking_requests WHERE organization_id=? AND id=?')
        .get(org, requestId);
      const value = open(row.value);
      value.acceptance = {
        patientId,
        newPatient: patientId === current.patientId,
        ...(selection ? { selection } : {}),
      };
      db.prepare('UPDATE booking_requests SET value=? WHERE organization_id=? AND id=?').run(
        seal(value),
        org,
        requestId,
      );
    }
    return get(org, requestId, now);
  }
  function cancelAcceptance(org, requestId, patientId) {
    writeOnly();
    const row = db
      .prepare('SELECT value,status FROM booking_requests WHERE organization_id=? AND id=?')
      .get(org, requestId);
    if (!row || !['pending', 'requested', 'expired'].includes(row.status)) return;
    const value = open(row.value);
    if (value.acceptance?.patientId !== patientId) return;
    delete value.acceptance;
    db.prepare('UPDATE booking_requests SET value=? WHERE organization_id=? AND id=?').run(
      seal(value),
      org,
      requestId,
    );
  }
  return {
    get,
    byKey,
    list,
    summary: feed.summary,
    appointmentSources: origins.appointmentSources,
    openCount,
    publicCapacity,
    create,
    reserves,
    finish,
    prepareAcceptance,
    cancelAcceptance,
  };
}
module.exports = { createBookingRequestStore };
