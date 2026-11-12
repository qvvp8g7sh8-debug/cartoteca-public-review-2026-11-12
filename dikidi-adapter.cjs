const fs = require('node:fs');
const path = require('node:path');

function readLocalEnv() {
  const file = path.join(__dirname, '.env.local');
  if (!fs.existsSync(file)) return {};
  const result = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function settings() {
  const env = { ...readLocalEnv(), ...process.env };
  return {
    baseUrl: (env.DIKIDI_API_BASE_URL || '').trim(),
    token: (env.DIKIDI_API_TOKEN || '').trim(),
    authHeader: (env.DIKIDI_API_AUTH_HEADER || 'Authorization').trim(),
    authScheme: (env.DIKIDI_API_AUTH_SCHEME || 'Bearer').trim(),
    endpoints: {
      clients: (env.DIKIDI_ENDPOINT_CLIENTS || '').trim(),
      services: (env.DIKIDI_ENDPOINT_SERVICES || '').trim(),
      appointments: (env.DIKIDI_ENDPOINT_APPOINTMENTS || '').trim()
    }
  };
}

function publicStatus() {
  const cfg = settings();
  return {
    configured: Boolean(cfg.baseUrl && cfg.token),
    baseUrlConfigured: Boolean(cfg.baseUrl),
    tokenConfigured: Boolean(cfg.token),
    endpointsConfigured: Object.fromEntries(Object.entries(cfg.endpoints).map(([key, value]) => [key, Boolean(value)]))
  };
}

function requireConfig(resource) {
  const cfg = settings();
  if (!cfg.baseUrl) throw new Error('Не задан DIKIDI_API_BASE_URL. Нужен официальный адрес API DIKIDI.');
  if (!cfg.token) throw new Error('Не задан DIKIDI_API_TOKEN. Ключ должен храниться только в .env.local на сервере.');
  if (!cfg.endpoints[resource]) throw new Error(`Не задан маршрут DIKIDI для раздела «${resource}».`);
  return cfg;
}

function endpointUrl(cfg, resource, id, query) {
  const route = cfg.endpoints[resource].replace(/\/$/, '') + (id ? `/${encodeURIComponent(id)}` : '');
  const url = new URL(route, cfg.baseUrl.endsWith('/') ? cfg.baseUrl : `${cfg.baseUrl}/`);
  if (query) for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') url.searchParams.set(key, value);
  return url;
}

async function request(resource, { method = 'GET', id, query, body } = {}) {
  const cfg = requireConfig(resource);
  const headers = { Accept: 'application/json' };
  headers[cfg.authHeader] = cfg.authScheme ? `${cfg.authScheme} ${cfg.token}` : cfg.token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(endpointUrl(cfg, resource, id, query), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    const detail = typeof payload === 'string' ? payload : JSON.stringify(payload);
    throw new Error(`DIKIDI API вернул ${response.status}: ${detail.slice(0, 500)}`);
  }
  return payload;
}

module.exports = {
  publicStatus,
  list: (resource, query) => request(resource, { query }),
  create: (resource, body) => request(resource, { method: 'POST', body }),
  update: (resource, id, body) => request(resource, { method: 'PATCH', id, body }),
  remove: (resource, id) => request(resource, { method: 'DELETE', id })
};
