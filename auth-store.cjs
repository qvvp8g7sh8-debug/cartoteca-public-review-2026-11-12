const crypto = require('node:crypto');
const { promisify } = require('node:util');
const OTPAuth = require('otpauth');
const QRCode = require('qrcode');
const { createStorage, fail } = require('./storage.cjs');
const scrypt = promisify(crypto.scrypt);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const SESSION_MS = 12 * 3600000;
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
function passwordRule(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw fail(400, 'Пароль должен содержать от 12 до 128 символов.');
}
async function passwordFields(password) {
  passwordRule(password);
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, passwordHash: (await scrypt(password, salt, 64, options)).toString('hex') };
}
function createStore(directory) {
  const storage = createStorage(directory);
  const { db, get, set, encode, decode, transaction, audit } = storage;
  let settingUp = false;
  function throttle(key, maximum = 10) {
    const now = Date.now();
    db.prepare('DELETE FROM limits WHERE until<=?').run(now);
    const entry = db.prepare('SELECT count,until FROM limits WHERE key=?').get(key) || { count: 0, until: now + 900000 };
    if (entry.count >= maximum) throw fail(429, 'Слишком много попыток. Попробуйте через 15 минут.');
    db.prepare('INSERT OR REPLACE INTO limits(key,count,until) VALUES(?,?,?)').run(key, entry.count + 1, entry.until);
  }
  function clear(key) { db.prepare('DELETE FROM limits WHERE key=?').run(key); }
  function version() { return get('authVersion', 0); }
  function invalidatePendingAuth() { set('authVersion', version() + 1); }
  function assertCurrent(owner) {
    const fresh=get('owner');
    if(!fresh || owner.authVersion!==version() || fresh.passwordHash!==owner.passwordHash || fresh.salt!==owner.salt) throw fail(401, 'Настройки входа изменились. Войдите заново.');
    return fresh;
  }
  async function checkPassword(password) {
    const owner = get('owner');
    const authVersion=version();
    if (typeof password !== 'string' || password.length > 128) throw fail(401, 'Неверная почта или пароль.');
    const derived = await scrypt(password, owner?.salt || 'missing-account-salt', 64, options);
    if (!owner || !crypto.timingSafeEqual(derived, Buffer.from(owner.passwordHash, 'hex'))) throw fail(401, 'Неверная почта или пароль.');
    const fresh=assertCurrent({...owner,authVersion});
    return {...fresh,authVersion};
  }
  function sessionRecord(token) {
    if (!token || token.length > 128) return null;
    const row = db.prepare('SELECT id,value FROM sessions WHERE hash=?').get(hash(token));
    if (!row) return null;
    const value = decode(row.value);
    if (value.expires <= Date.now()) { db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(token)); return null; }
    return { ...value, id: row.id };
  }
  function session(token) { return Boolean(sessionRecord(token)?.verified); }
  function newSession(verified, userAgent = '') {
    for (const row of db.prepare('SELECT hash,value FROM sessions').all()) if (decode(row.value).expires <= Date.now()) db.prepare('DELETE FROM sessions WHERE hash=?').run(row.hash);
    if (db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n >= 100) db.prepare('DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions ORDER BY rowid LIMIT 1)').run();
    const token = random();
    db.prepare('INSERT INTO sessions(hash,id,value) VALUES(?,?,?)').run(hash(token), crypto.randomUUID(), encode({ verified, created: Date.now(), expires: Date.now() + (verified ? SESSION_MS : 300000), device: String(userAgent).slice(0, 200) }));
    return token;
  }
  function requireSession(token) { const s = sessionRecord(token); if (!s?.verified) throw fail(401, 'Войдите в картотеку.'); return s; }
  function totp(secret) { return new OTPAuth.TOTP({ issuer: 'Картотека', label: get('owner').email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }); }
  function checkCode(owner, code) {
    if (!owner.mfa) return owner;
    code = String(code || '').trim();
    const delta = /^\d{6}$/.test(code) ? totp(owner.mfa.secret).validate({ token: code, window: 1 }) : null;
    const counter = Math.floor(Date.now() / 30000) + (delta || 0);
    if (delta !== null && counter > (owner.mfa.counter ?? -1)) return { ...owner, mfa: { ...owner.mfa, counter } };
    const digest = hash(code.replace(/\s/g, '').toUpperCase());
    if (owner.mfa.recovery.includes(digest)) return { ...owner, mfa: { ...owner.mfa, recovery: owner.mfa.recovery.filter(c => c !== digest) } };
    throw fail(400, 'Неверный или уже использованный код. Дождитесь следующего кода либо используйте резервный.');
  }
  async function reauthenticate(token, body) {
    requireSession(token); const key='reauth:'+hash(token); throttle(key); const checked=await checkPassword(body.password);
    // Recheck after the asynchronous hash, in case another device revoked the session.
    requireSession(token);
    const owner = checkCode(assertCurrent(checked), body.code);
    set('owner', owner); clear(key); return {...owner,authVersion:version()};
  }
  return {
    storage, close: storage.close, read: storage.read, write: storage.write, photo: storage.photo,
    configured: () => Boolean(get('owner')), user: () => ({ email: get('owner').email }), session,
    logout(token) { if (token && db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(token)).changes) invalidatePendingAuth(); },
    async setup(email, password, ip, userAgent) {
      throttle(ip);
      if (get('owner') || settingUp) throw fail(409, 'Кабинет уже настроен. Войдите с почтой и паролем.');
      email = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'Укажите корректную почту.');
      passwordRule(password); settingUp = true;
      try {
        const fields = await passwordFields(password);
        transaction(() => { if (get('owner')) throw fail(409, 'Кабинет уже настроен.'); set('owner', { email, ...fields }); audit('account_created'); });
        clear(ip); return newSession(true, userAgent);
      } finally { settingUp = false; }
    },
    async login(email, password, ip, userAgent) {
      throttle(ip);
      const owner = await checkPassword(password);
      const fresh=assertCurrent(owner);
      if (typeof email !== 'string' || email.trim().toLowerCase() !== fresh.email) throw fail(401, 'Неверная почта или пароль.');
      clear(ip); audit('password_accepted'); return newSession(!fresh.mfa, userAgent);
    },
    verify(token, code) {
      const pending = sessionRecord(token);
      if (!pending || pending.verified) throw fail(401, 'Начните вход заново.');
      throttle('mfa');
      return transaction(() => {
        set('owner', checkCode(get('owner'), code));
        db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(token));
        clear('mfa'); audit('login_verified'); return newSession(true, pending.device);
      });
    },
    security(token) {
      const current = requireSession(token);
      return { mfa: Boolean(get('owner').mfa), recoveryRemaining: get('owner').mfa?.recovery.length || 0,
        sessions: db.prepare('SELECT id,value FROM sessions').all().map(r => ({ id: r.id, ...decode(r.value) })).filter(s => s.verified && s.expires > Date.now()).map(s => ({ id: s.id, current: s.id === current.id, device: s.device, created: s.created, expires: s.expires })),
        backup: get('backupStatus'), audit: db.prepare('SELECT time,event FROM audit ORDER BY id DESC LIMIT 20').all() };
    },
    revoke(token, id) {
      const current = requireSession(token);
      if (id === 'others') db.prepare('DELETE FROM sessions WHERE id<>?').run(current.id);
      else if (typeof id === 'string') db.prepare('DELETE FROM sessions WHERE id=?').run(id);
      invalidatePendingAuth();
      audit('sessions_revoked'); return { ok: true };
    },
    async prepareMfa(token, body) {
      const owner = await reauthenticate(token, body);
      requireSession(token); assertCurrent(owner);
      if (owner.mfa) throw fail(409, 'Подтверждение входа уже включено.');
      const secret = new OTPAuth.Secret({ size: 20 }).base32;
      const uri = totp(secret).toString();
      set('mfaPending', { secret, session: hash(token), expires: Date.now() + 600000 });
      const qr=await QRCode.toDataURL(uri);
      requireSession(token); assertCurrent(owner);
      if(get('mfaPending')?.secret!==secret)throw fail(409,'Начните настройку заново.');
      return { secret, qr };
    },
    enableMfa(token, code) {
      requireSession(token); throttle('mfa');
      const pending = get('mfaPending');
      if (!pending || pending.session !== hash(token) || pending.expires < Date.now() || get('owner').mfa) throw fail(400, 'Начните настройку заново.');
      const delta = totp(pending.secret).validate({ token: String(code), window: 1 });
      if (delta === null) throw fail(400, 'Неверный код.');
      const codes = Array.from({ length: 10 }, () => crypto.randomBytes(10).toString('hex').toUpperCase());
      transaction(() => {
        set('owner', { ...get('owner'), mfa: { secret: pending.secret, counter: Math.floor(Date.now()/30000) + delta, recovery: codes.map(hash) } });
        invalidatePendingAuth();
        set('mfaPending', null); db.prepare('DELETE FROM sessions WHERE hash<>?').run(hash(token)); clear('mfa'); audit('mfa_enabled');
      });
      return { codes };
    },
    async disableMfa(token, body) {
      const owner = await reauthenticate(token, body);
      requireSession(token); const fresh=assertCurrent(owner);
      delete fresh.mfa; set('owner', fresh); set('mfaPending', null); invalidatePendingAuth();
      db.prepare('DELETE FROM sessions WHERE hash<>?').run(hash(token)); audit('mfa_disabled'); return { ok: true };
    },
    async changePassword(token, body) {
      passwordRule(body.newPassword);
      const owner=await reauthenticate(token, body);
      const fields = await passwordFields(body.newPassword);
      requireSession(token);
      assertCurrent(owner);
      transaction(() => { set('owner', { ...get('owner'), ...fields }); invalidatePendingAuth(); set('reset', null); set('mfaPending',null); db.exec('DELETE FROM sessions'); audit('password_changed'); });
      return { ok: true };
    },
    async requestReset(email, send, origin, ip) {
      throttle('reset:' + ip, 3);
      if (!send || !origin) throw fail(503, 'Отправка писем ещё не настроена. Обратитесь к владельцу картотеки.');
      const owner = get('owner');
      if (owner && typeof email === 'string' && email.trim().toLowerCase() === owner.email) {
        const token = random();
        set('reset', { digest: hash(token), expires: Date.now() + 900000 });
        try { await send(owner.email, `${origin}/#reset=${token}`); }
        catch { if(get('reset')?.digest===hash(token))set('reset', null); throw fail(503, 'Не удалось отправить письмо. Повторите позже.'); }
        audit('password_reset_requested');
      }
      return { ok: true, message: 'Если адрес совпадает с почтой кабинета, письмо для восстановления отправлено.' };
    },
    async resetPassword(body, ip) {
      throttle('reset-confirm:' + ip);
      passwordRule(body.password);
      const fields = await passwordFields(body.password);
      return transaction(() => {
        const reset = get('reset');
        if (!reset || reset.expires < Date.now() || typeof body.token !== 'string' || hash(body.token) !== reset.digest) throw fail(400, 'Ссылка недействительна или истекла. Запросите новое письмо.');
        const owner = checkCode(get('owner'), body.code);
        set('owner', { ...owner, ...fields }); invalidatePendingAuth(); set('reset', null); set('mfaPending', null); db.exec('DELETE FROM sessions'); audit('password_reset');
        return { ok: true };
      });
    }
  };
}
module.exports = { createStore, SESSION_MS, fail };
