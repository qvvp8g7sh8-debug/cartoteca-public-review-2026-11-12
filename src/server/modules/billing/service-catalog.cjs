const { fail } = require('../../../shared/errors.cjs');
const VOICE = 'voice-assistant';
const VOICE_TITLE = 'Голосовой помощник';
function serviceCode(value = VOICE) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value))
    throw fail(400, 'Некорректная услуга.');
  return value;
}
function createServiceCatalog(core) {
  const { db, now } = core;
  let prepared;
  function multiple() {
    if (prepared === undefined)
      prepared = Boolean(
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='billing_services'")
          .get(),
      );
    return prepared;
  }
  function catalog() {
    return multiple()
      ? db
          .prepare('SELECT code,title FROM billing_services ORDER BY title,code LIMIT 100')
          .all()
          .map((row) => ({ ...row }))
      : [{ code: VOICE, title: VOICE_TITLE }];
  }
  function title(code) {
    return catalog().find((item) => item.code === code)?.title || code;
  }
  function ensure(code, label) {
    serviceCode(code);
    if (!multiple()) {
      if (code !== VOICE) throw fail(503, 'Несколько услуг требуют отдельной подготовки схемы20.');
      return;
    }
    if (db.prepare('SELECT 1 FROM billing_services WHERE code=?').get(code)) return;
    if (
      typeof label !== 'string' ||
      !label.trim() ||
      label.trim().length > 120 ||
      /[\u0000-\u001f]/u.test(label)
    )
      throw fail(400, 'Укажите название новой услуги.');
    if (catalog().length >= 100) throw fail(400, 'Достигнут лимит услуг.');
    db.prepare('INSERT INTO billing_services(code,title,created_at) VALUES(?,?,?)').run(
      code,
      label.trim(),
      now(),
    );
  }
  return { multiple, catalog, title, ensure };
}
module.exports = { VOICE, VOICE_TITLE, serviceCode, createServiceCatalog };
