const crypto = require('node:crypto');
const { fail } = require('../../../shared/errors.cjs');
// Proposals remain unreserved requested rows. Secrets and original wishes stay encrypted.
function createBookingProposalStore(context) {
  const { db, open, seal, limitKey } = context;
  const missing = () => fail(404, 'Предложение недоступно. Обратитесь в организацию.');
  function write(org, record, value, now) {
    if (!db.isTransaction) throw Error('Proposal requires platform transaction.');
    db.prepare(
      'UPDATE booking_requests SET value=?,day_key=?,revision=revision+1 WHERE organization_id=? AND id=? AND revision=?',
    ).run(seal(value), limitKey('booking-day', value.date), org, record.id, record.revision);
    return context.bookingRequests.get(org, record.id, now);
  }
  function offer(org, record, selected, expiresAt, now, timeZone) {
    const row = db
      .prepare('SELECT value FROM booking_requests WHERE organization_id=? AND id=?')
      .get(org, record.id);
    const value = open(row.value);
    value.originalWish ||= { date: value.date, time: value.time };
    Object.assign(value, selected);
    value.proposal = {
      nonce: crypto.randomBytes(24).toString('hex'),
      state: 'waiting',
      baseRevision: record.revision,
      createdAt: now,
      expiresAt: Math.min(expiresAt, record.expiresAt),
      timeZone,
    };
    return write(org, record, value, now);
  }
  function reply(org, record, decision, now) {
    const row = db
      .prepare('SELECT value FROM booking_requests WHERE organization_id=? AND id=?')
      .get(org, record.id);
    const value = open(row.value);
    value.proposal = {
      ...value.proposal,
      state: decision === 'agree' ? 'agreed' : 'declined',
      answeredAt: now,
    };
    const updated = write(org, record, value, now);
    const result =
      decision === 'agree'
        ? updated
        : context.bookingRequests.finish(org, record.id, updated.revision, 'rejected', now);
    context.staffNotifications.enqueue(
      org,
      result,
      decision === 'agree' ? 'client-agreed' : 'client-declined',
      now,
    );
    context.staffMaxNotifications?.enqueue(
      org,
      result,
      decision === 'agree' ? 'client-agreed' : 'client-declined',
      now,
    );
    context.staffPush?.booking(
      org,
      result,
      decision === 'agree' ? 'client-agreed' : 'client-declined',
      now,
    );
    return result;
  }
  function token(org, record) {
    const data = Buffer.from(JSON.stringify([org, record.id, record.proposal.nonce])).toString(
      'base64url',
    );
    return data + '.' + limitKey('booking-proposal', data).split(':').at(-1);
  }
  function resolve(secret, now) {
    if (
      typeof secret !== 'string' ||
      secret.length > 512 ||
      !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(secret)
    )
      throw missing();
    const [data, supplied] = secret.split('.');
    if (
      !crypto.timingSafeEqual(
        Buffer.from(supplied, 'hex'),
        Buffer.from(limitKey('booking-proposal', data).split(':').at(-1), 'hex'),
      )
    )
      throw missing();
    let values;
    try {
      values = JSON.parse(Buffer.from(data, 'base64url').toString());
    } catch {
      throw missing();
    }
    if (!Array.isArray(values) || values.length !== 3 || values.some((v) => typeof v !== 'string'))
      throw missing();
    const [org, id, nonce] = values,
      record = context.bookingRequests.get(org, id, now);
    if (!record?.proposal || record.proposal.nonce !== nonce) throw missing();
    const organization = context.bookingPublication.resolve(org);
    if (record.proposal.timeZone !== organization.timeZone)
      throw fail(409, 'Часовой пояс организации изменился. Запросите новое предложение.');
    if (Math.min(record.proposal.expiresAt, record.expiresAt) <= now)
      throw fail(410, 'Срок предложения истёк. Обратитесь в организацию.');
    if (!['requested', 'accepted', 'rejected'].includes(record.status)) throw missing();
    return { org, record, organization };
  }
  return { offer, reply, token, resolve };
}
module.exports = { createBookingProposalStore };
