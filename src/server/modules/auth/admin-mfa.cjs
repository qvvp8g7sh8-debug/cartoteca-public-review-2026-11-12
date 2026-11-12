const { totp, consume, passwordProof, recoveryCodes } = require('./admin-mfa-values.cjs');
const OTPAuth = require('otpauth');
function createAdminMfa(c) {
  const { db, open, seal, transaction, fail, crypto, tokenHash, audit, verifyPassword } = c;
  const keys = (id) => [c.limitKey('admin-mfa', id)];
  function failure(id, message = 'Код неверен, истёк или уже использован.') {
    try {
      c.recordLoginFailure(keys(id));
    } catch (error) {
      if (error.status === 401) throw Object.assign(fail(401, message), { code: 'MFA_INVALID' });
      throw error;
    }
  }
  function account(token) {
    const current = c.session(token);
    if (!current?.globalAdmin) throw fail(403, 'Настройки доступны главному администратору.');
    const row = db
      .prepare("SELECT * FROM accounts WHERE id=? AND global_admin=1 AND status='active'")
      .get(current.accountId);
    if (!row) throw fail(403, 'Доступ изменился.');
    return { row, value: open(row.value), current };
  }
  function fields(input, names) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((name) => !names.includes(name))
    )
      throw fail(400, 'Неверные поля настройки защиты.');
  }
  function save(id, value) {
    db.prepare('UPDATE accounts SET value=? WHERE id=?').run(seal(value), id);
  }
  function bindSession(token, id, revision) {
    db.prepare('DELETE FROM platform_sessions WHERE account_id=? AND token_hash<>?').run(
      id,
      tokenHash(token),
    );
    const row = db
      .prepare('SELECT value FROM platform_sessions WHERE token_hash=? AND account_id=?')
      .get(tokenHash(token), id);
    if (!row) throw fail(401, 'Войдите снова.');
    db.prepare('UPDATE platform_sessions SET value=? WHERE token_hash=?').run(
      seal({ ...open(row.value), adminMfaRevision: revision }),
      tokenHash(token),
    );
  }
  async function password(token, input, options = {}) {
    options.assertCurrent?.();
    const before = account(token);
    c.assertLoginAllowed(keys(before.row.id));
    if (!(await verifyPassword(before.value, input.password, before.row.id)))
      return failure(before.row.id, 'Неверный текущий пароль.');
    options.assertCurrent?.();
    const fresh = account(token);
    if (passwordProof(fresh.value) !== passwordProof(before.value))
      throw fail(409, 'Пароль изменился. Повторите действие.');
    return fresh;
  }
  function status(token) {
    const { value } = account(token);
    return {
      enabled: Boolean(value.adminMfa?.enabled),
      recoveryRemaining: value.adminMfa?.recoveryHashes?.length || 0,
    };
  }
  async function prepare(token, input, options = {}) {
    fields(input, ['password', 'requestId']);
    if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.requestId))
      throw fail(400, 'Нужен номер настройки.');
    const auth = await password(token, input, options);
    const result = transaction(() => {
      options.assertCurrent?.();
      const { row, value, current } = account(token);
      if (passwordProof(value) !== passwordProof(auth.value)) throw fail(409, 'Пароль изменился.');
      if (value.adminMfa?.enabled) throw fail(409, 'Подтверждение входа уже включено.');
      let pending = value.adminMfaPending;
      if (
        !pending ||
        pending.requestId !== input.requestId ||
        pending.sessionId !== current.sessionId ||
        pending.expiresAt <= Date.now()
      ) {
        pending = {
          requestId: input.requestId,
          setupId: crypto.randomUUID(),
          sessionId: current.sessionId,
          secret: new OTPAuth.Secret({ size: 20 }).base32,
          expiresAt: Date.now() + 600000,
          passwordProof: passwordProof(value),
        };
        save(row.id, { ...value, adminMfaPending: pending });
        audit('admin_mfa_setup_started', row.id);
      }
      return {
        setupId: pending.setupId,
        secret: pending.secret,
        uri: totp(pending.secret, value.email).toString(),
        expiresAt: pending.expiresAt,
      };
    });
    return {
      ...result,
      qr: await require('qrcode').toDataURL(result.uri, { width: 240, margin: 2 }),
    };
  }
  function enable(token, input, options = {}) {
    fields(input, ['setupId', 'code']);
    options.assertCurrent?.();
    const auth = account(token);
    c.assertLoginAllowed(keys(auth.row.id));
    const result = transaction(() => {
      options.assertCurrent?.();
      const { row, value, current } = account(token);
      if (value.adminMfa?.enabled && value.adminMfa.activationId === input.setupId)
        return { enabled: true, recoveryCodes: null };
      const pending = value.adminMfaPending;
      if (
        !pending ||
        pending.setupId !== input.setupId ||
        pending.sessionId !== current.sessionId ||
        pending.expiresAt <= Date.now() ||
        pending.passwordProof !== passwordProof(value)
      )
        throw fail(409, 'Настройка истекла. Начните заново.');
      const accepted = consume({ secret: pending.secret, lastCounter: -1 }, input.code, row.id);
      if (!accepted) return null;
      const recovery = recoveryCodes(row.id),
        revision = crypto.randomUUID();
      const next = {
        ...value,
        adminMfa: {
          ...accepted,
          enabled: true,
          activationId: pending.setupId,
          revision,
          recoveryHashes: recovery.hashes,
        },
      };
      delete next.adminMfaPending;
      save(row.id, next);
      bindSession(token, row.id, revision);
      audit('admin_mfa_enabled', row.id);
      return { enabled: true, recoveryCodes: recovery.codes };
    });
    if (!result) return failure(auth.row.id);
    c.clearLoginFailures(keys(auth.row.id));
    return result;
  }
  async function change(token, input, action, options = {}) {
    fields(input, ['password', 'code']);
    const auth = await password(token, input, options);
    const result = transaction(() => {
      options.assertCurrent?.();
      const { row, value } = account(token);
      if (passwordProof(value) !== passwordProof(auth.value)) throw fail(409, 'Пароль изменился.');
      if (!value.adminMfa?.enabled) throw fail(409, 'Подтверждение входа не включено.');
      const accepted = consume(value.adminMfa, input.code, row.id);
      if (!accepted) return null;
      const revision = crypto.randomUUID(),
        next = { ...value };
      let codes = null;
      if (action === 'disable') {
        delete next.adminMfa;
        delete next.adminMfaPending;
      } else {
        const recovery = recoveryCodes(row.id);
        codes = recovery.codes;
        next.adminMfa = { ...accepted, revision, recoveryHashes: recovery.hashes };
      }
      save(row.id, next);
      bindSession(token, row.id, action === 'disable' ? null : revision);
      audit(action === 'disable' ? 'admin_mfa_disabled' : 'admin_mfa_recovery_rotated', row.id);
      return { enabled: action !== 'disable', recoveryCodes: codes };
    });
    if (!result) return failure(auth.row.id);
    c.clearLoginFailures(keys(auth.row.id));
    return result;
  }
  // Called only in the session-creation transaction after current password proof.
  function loginCheck(row, value, code) {
    if (!db.isTransaction) throw Error('MFA login requires transaction.');
    if (!row.global_admin || !value.adminMfa?.enabled) return { ok: true, revision: null };
    if (!code) return { ok: false, required: true };
    const accepted = consume(value.adminMfa, code, row.id);
    if (!accepted) return { ok: false };
    save(row.id, { ...value, adminMfa: accepted });
    return { ok: true, revision: accepted.revision };
  }
  return {
    status,
    prepare,
    enable,
    disable: (token, input, options) => change(token, input, 'disable', options),
    recovery: (token, input, options) => change(token, input, 'recovery', options),
    loginCheck,
  };
}
module.exports = { createAdminMfa };
