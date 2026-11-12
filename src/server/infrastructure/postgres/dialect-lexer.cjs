const { fail } = require('../../../shared/errors.cjs');
function unsupported(reason) {
  return Object.assign(fail(503, 'Запрос хранилища требует совместимого PostgreSQL backend.'), {
    code: 'POSTGRES_SQL_UNSUPPORTED',
    detail: reason,
  });
}
function tokenize(sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 1024 * 1024 || sql.includes('\0'))
    throw unsupported('Invalid SQL source');
  const tokens = [];
  for (let i = 0; i < sql.length;) {
    const start = i,
      c = sql[i];
    if (/\s/u.test(c)) {
      i++;
      continue;
    }
    if (sql.startsWith('--', i)) {
      i = sql.indexOf('\n', i + 2);
      if (i < 0) break;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      i = sql.indexOf('*/', i + 2);
      if (i < 0) throw unsupported('Unterminated SQL comment');
      i += 2;
      continue;
    }
    if (["'", '"', '`', '['].includes(c)) {
      const end = c === '[' ? ']' : c;
      let value = '';
      i++;
      for (;;) {
        if (i >= sql.length) throw unsupported('Unterminated SQL quote');
        if (sql[i] === end) {
          if (sql[i + 1] === end && c !== '[') {
            value += end;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += sql[i++];
      }
      tokens.push({
        type: c === "'" ? 'string' : 'identifier',
        value,
        raw: c === "'" ? "'" + value.replaceAll("'", "''") + "'" : quote(value),
        start,
      });
      continue;
    }
    if (c === '?') {
      i++;
      while (i < sql.length && /\d/.test(sql[i])) i++;
      tokens.push({
        type: 'parameter',
        value: sql.slice(start + 1, i),
        raw: sql.slice(start, i),
        start,
      });
      continue;
    }
    if (c === '$' && /\d/.test(sql[i + 1] || '')) {
      i++;
      while (i < sql.length && /\d/.test(sql[i])) i++;
      tokens.push({
        type: 'bound',
        value: Number(sql.slice(start + 1, i)),
        raw: sql.slice(start, i),
        start,
      });
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      i++;
      while (i < sql.length && /[a-zA-Z_0-9$]/.test(sql[i])) i++;
      const value = sql.slice(start, i);
      tokens.push({ type: 'word', value, raw: value, start });
      continue;
    }
    if (/\d/.test(c)) {
      const number = /^(?:\d+(?:\.\d*)?)(?:e[+-]?\d+)?/i.exec(sql.slice(i))[0];
      i += number.length;
      tokens.push({ type: 'number', value: number, raw: number, start });
      continue;
    }
    const operator = ['!=', '<>', '<=', '>=', '==', '||', '<<', '>>', '::'].find((x) =>
      sql.startsWith(x, i),
    );
    if (operator) {
      i += operator.length;
      tokens.push({ type: 'symbol', value: operator, raw: operator, start });
      continue;
    }
    if ('(),.;+-*/%=<>~&|'.includes(c)) {
      i++;
      tokens.push({ type: 'symbol', value: c, raw: c, start });
      continue;
    }
    throw unsupported('Unsupported SQL token');
  }
  return tokens;
}
// SQL structure only: no bound values, results or permission decisions. Both
// translation receives mutable copies; read-only guards can borrow frozen tokens.
const lexEntries = new Map();
const lexMaximumBytes = 256 * 1024;
const lexMaximumEntries = 128;
let lexBytes = 0,
  lexHits = 0,
  lexMisses = 0;
function lexReadonly(sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 1024 * 1024 || sql.includes('\0'))
    throw unsupported('Invalid SQL source');
  let entry = lexEntries.get(sql);
  if (entry) {
    lexHits++;
    lexEntries.delete(sql);
    lexEntries.set(sql, entry);
  } else {
    lexMisses++;
    const tokens = tokenize(sql);
    const bytes =
      sql.length * 2 +
      tokens.reduce(
        (sum, token) =>
          sum + 96 + 2 * (token.type.length + String(token.value).length + token.raw.length),
        0,
      );
    // Even a source too large for the LRU has no mutable shared token aliases.
    entry = { tokens: Object.freeze(tokens.map((token) => Object.freeze(token))), bytes };
    if (bytes <= lexMaximumBytes) {
      while (lexEntries.size >= lexMaximumEntries || lexBytes + bytes > lexMaximumBytes) {
        const oldest = lexEntries.keys().next().value;
        lexBytes -= lexEntries.get(oldest).bytes;
        lexEntries.delete(oldest);
      }
      lexEntries.set(sql, entry);
      lexBytes += bytes;
    }
  }
  return entry.tokens;
}
function lex(sql) {
  return lexReadonly(sql).map((token) => ({ ...token }));
}
function lexCacheStats() {
  return {
    hits: lexHits,
    misses: lexMisses,
    entries: lexEntries.size,
    bytes: lexBytes,
    maximumBytes: lexMaximumBytes,
    maximumEntries: lexMaximumEntries,
  };
}
const quote = (value) => '"' + String(value).replaceAll('"', '""') + '"';
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const word = (token, value) => token?.type === 'word' && token.value.toUpperCase() === value;
const symbol = (token, value) => token?.type === 'symbol' && token.value === value;
const identifier = (token) =>
  token && ['word', 'identifier'].includes(token.type) ? token.value : null;
const render = (tokens) => tokens.map((token) => token.raw).join(' ');
const raw = (value) => ({ type: 'raw', value, raw: value });
function split(tokens, separator = ';') {
  const result = [];
  let start = 0,
    depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (symbol(tokens[i], '(')) depth++;
    else if (symbol(tokens[i], ')')) {
      if (--depth < 0) throw unsupported('Unbalanced SQL');
    } else if (symbol(tokens[i], separator) && depth === 0) {
      if (i > start) result.push(tokens.slice(start, i));
      start = i + 1;
    }
  }
  if (depth) throw unsupported('Unbalanced SQL');
  if (start < tokens.length) result.push(tokens.slice(start));
  return result;
}
function closing(tokens, start) {
  if (!symbol(tokens[start], '(')) throw unsupported('Expected SQL parentheses');
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (symbol(tokens[i], '(')) depth++;
    if (symbol(tokens[i], ')') && --depth === 0) return i;
  }
  throw unsupported('Unbalanced SQL');
}
module.exports = {
  lex,
  lexReadonly,
  lexCacheStats,
  quote,
  literal,
  word,
  symbol,
  identifier,
  render,
  raw,
  split,
  closing,
  unsupported,
};
