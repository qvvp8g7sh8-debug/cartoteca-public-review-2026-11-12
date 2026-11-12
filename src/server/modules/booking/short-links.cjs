const crypto = require('node:crypto');
const { fail } = require('../../../shared/errors.cjs');
const { validate } = require('../../infrastructure/booking-public-links-schema.cjs');

const codeRule = /^[a-z0-9]{8}$/;
const idRule = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
const legacyPath = (org, staff = '') =>
  '/booking.html?organization=' +
  encodeURIComponent(org) +
  (staff ? '&staff=' + encodeURIComponent(staff) : '');

// Codes are permanent public addresses, not access tokens. Startup never creates
// the component: only an explicitly prepared data copy may contain these tables.
function createBookingShortLinks(context) {
  const { db, transaction } = context;
  const available = Boolean(validate(db));
  const missing = () => fail(404, 'Онлайн-запись недоступна.');
  if (!available)
    return {
      available: false,
      hasTargets: () => true,
      ensure() {},
      path: legacyPath,
      resolve() {
        throw missing();
      },
    };

  const byTarget = db.prepare(
    'SELECT code FROM booking_public_links WHERE organization_id=? AND staff_id=?',
  );
  const byCode = db.prepare(
    `SELECT l.organization_id,l.staff_id FROM booking_public_links l
     JOIN organizations o ON o.id=l.organization_id
     WHERE l.code=? AND o.status='active'`,
  );
  const organization = db.prepare("SELECT 1 FROM organizations WHERE id=? AND status='active'");
  const member = db.prepare(
    `SELECT 1 FROM memberships m JOIN accounts a ON a.id=m.account_id
     WHERE m.organization_id=? AND m.account_id=? AND m.status='active'
     AND a.status='active' AND m.role IN ('owner','cosmetologist')`,
  );
  const insert = db.prepare(
    `INSERT INTO booking_public_links(code,organization_id,staff_id,created_at)
     VALUES(?,?,?,?) ON CONFLICT(code) DO NOTHING`,
  );

  function targetsFor(org, staffIds) {
    if (
      typeof org !== 'string' ||
      !idRule.test(org) ||
      !Array.isArray(staffIds) ||
      staffIds.length > 2000 ||
      staffIds.some((staff) => typeof staff !== 'string' || !idRule.test(staff))
    )
      throw fail(400, 'Проверьте организацию и сотрудников онлайн-записи.');
    return ['', ...new Set(staffIds)];
  }

  function hasTargets(org, staffIds = []) {
    return targetsFor(org, staffIds).every((staff) => byTarget.get(org, staff));
  }

  function ensure(org, staffIds = []) {
    const targets = targetsFor(org, staffIds);
    // Most settings reads are read-only. Recheck under the write lock so another
    // process cannot allocate a second address for the same target.
    if (targets.every((staff) => byTarget.get(org, staff))) return;
    const create = () => {
      if (!organization.get(org)) throw missing();
      for (const staff of targets) {
        if (staff && !member.get(org, staff)) throw missing();
        if (byTarget.get(org, staff)) continue;
        let saved = false;
        for (let attempt = 0; attempt < 16; attempt++) {
          const random = context.crypto || crypto;
          const code = Array.from(
            { length: 8 },
            () => alphabet[random.randomInt(alphabet.length)],
          ).join('');
          if (insert.run(code, org, staff, Date.now()).changes === 1) {
            saved = true;
            break;
          }
        }
        if (!saved) throw fail(503, 'Не удалось подготовить ссылку записи. Попробуйте позже.');
      }
    };
    return db.isTransaction ? create() : transaction(create);
  }

  function path(org, staff = '') {
    const record = byTarget.get(org, staff);
    return record ? '/b/' + record.code : legacyPath(org, staff);
  }

  function resolve(code) {
    if (typeof code !== 'string' || !codeRule.test(code)) throw missing();
    const record = byCode.get(code);
    if (
      !record ||
      (record.staff_id &&
        (!member.get(record.organization_id, record.staff_id) ||
          context.onlineBooking.settings(record.organization_id).staff[record.staff_id]?.enabled ===
            false))
    )
      throw missing();
    return { organizationId: record.organization_id, staffId: record.staff_id };
  }
  return { available, hasTargets, ensure, path, resolve };
}

module.exports = { createBookingShortLinks };
