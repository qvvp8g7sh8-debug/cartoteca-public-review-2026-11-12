const { fail } = require('../../shared/errors.cjs');
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
};
async function readBody(req, limit = 16384, reviver = undefined, options = {}) {
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json')
    throw fail(415, 'Ожидается JSON.');
  if (
    req.headers['content-encoding'] &&
    req.headers['content-encoding'].toLowerCase() !== 'identity'
  )
    throw fail(415, 'Сжатые JSON-запросы не поддерживаются.');
  const declared = req.headers['content-length'];
  if (
    declared !== undefined &&
    (!/^\d+$/.test(String(declared)) ||
      !Number.isSafeInteger(Number(declared)) ||
      Number(declared) > limit)
  )
    throw fail(413, 'Превышен размер запроса.');
  const { jsonBodyBudget } = require('./json-body-budget.cjs');
  // Unknown/chunked bodies reserve the route cap. A declared size is enforced
  // against every received chunk before retaining it, never just trusted.
  const bodyLimit = declared === undefined ? limit : Number(declared);
  const release = (options.budget || jsonBodyBudget).acquire(
    Math.max(1, bodyLimit),
    options.identity,
  );
  const finish = options.retain ? options.retain(release) : release;
  let timer,
    size = 0;
  const chunks = [];
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(fail(408, 'Время загрузки истекло. Повторите запрос.')),
      options.timeoutMs ?? 60000,
    );
    timer.unref?.();
  });
  try {
    const iterator = req.iterator({ destroyOnReturn: false });
    while (true) {
      const next = await Promise.race([iterator.next(), timeout]);
      if (next.done) break;
      size += next.value.length;
      if (size > bodyLimit) throw fail(413, 'Превышен размер запроса.');
      chunks.push(next.value);
    }
    if (declared !== undefined && size !== bodyLimit)
      throw fail(400, 'Некорректный размер запроса.');
    const parse = () => {
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'), reviver);
      } catch {
        throw fail(400, 'Некорректный запрос.');
      }
    };
    // Admission errors remain 503/499, never a false JSON-validation failure.
    // The body budget stays held while waiting for this synchronous parse unit.
    return options.runParse ? await options.runParse(parse, size) : parse();
  } finally {
    clearTimeout(timer);
    finish();
  }
}
module.exports = { json, readBody };
