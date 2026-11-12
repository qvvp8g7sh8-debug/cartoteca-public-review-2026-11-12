const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { fail } = require('../../shared/errors.cjs');

const { passwordWork } = require('./password-work.cjs');
const nativeScrypt = promisify(crypto.scrypt);
const scrypt = (password, salt, length, options, credentialId) =>
  passwordWork.run(() => nativeScrypt(password, salt, length, options), {
    ...(credentialId ? { key: credentialId } : {}),
  });
const passwordOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const roles = new Set(['owner', 'salon_admin', 'cosmetologist']);
const staffRoles = new Set(['salon_admin', 'cosmetologist']);
const SESSION_MS = 7 * 24 * 3600000;
const LOGIN_ATTEMPT_WINDOW_MS = 10 * 60000;
const LOGIN_BLOCK_MS = 15 * 60000;
const LOGIN_MAX_FAILURES = 5;
const FREE_LIMITS = Object.freeze({
  patients: 10,
  photos: 50,
  publicBooking: true,
  automaticNotifications: true,
});

const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const emailRule = (email) => {
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw fail(400, 'Укажите корректную почту.');
};
const passwordRule = (password) => {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128)
    throw fail(400, 'Пароль должен содержать от 12 до 128 символов.');
};
const textRule = (value, label, maximum = 120) => {
  value = typeof value === 'string' ? value.trim() : '';
  if (!value || value.length > maximum) throw fail(400, `Укажите ${label}.`);
  return value;
};

module.exports = {
  crypto,
  scrypt,
  passwordOptions,
  roles,
  staffRoles,
  SESSION_MS,
  LOGIN_ATTEMPT_WINDOW_MS,
  LOGIN_BLOCK_MS,
  LOGIN_MAX_FAILURES,
  FREE_LIMITS,
  normalizeEmail,
  emailRule,
  passwordRule,
  textRule,
};
