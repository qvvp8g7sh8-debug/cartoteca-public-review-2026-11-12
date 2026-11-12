const crypto = require('node:crypto');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase(),
  );

function signCanonical(config, canonical, timestamp) {
  const day = timestamp.slice(0, 8),
    scope = day + '/' + config.region + '/s3/aws4_request';
  const signingKey = hmac(
    hmac(hmac(hmac('AWS4' + config.secretKey, day), config.region), 's3'),
    'aws4_request',
  );
  return {
    scope,
    signature: hmac(
      signingKey,
      ['AWS4-HMAC-SHA256', timestamp, scope, hash(canonical)].join('\n'),
    ).toString('hex'),
  };
}
function signS3({
  config,
  method,
  key,
  query = {},
  headers = {},
  payloadHash = hash(''),
  now = new Date(),
}) {
  if (!key || key.split('/').some((part) => !part || part === '.' || part === '..'))
    throw Error('BACKUP_REMOTE_FAILED');
  const uri = '/' + [config.bucket, ...key.split('/')].map(encode).join('/');
  const parameters = Object.entries(query)
    .map(([name, value]) => [encode(name), encode(value)])
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => name + '=' + value)
    .join('&');
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const signed = {
    ...headers,
    host: new URL(config.endpoint).host,
    'x-amz-date': timestamp,
    'x-amz-content-sha256': payloadHash,
  };
  const normalized = Object.fromEntries(
    Object.entries(signed).map(([name, value]) => [
      name.toLowerCase(),
      String(value).trim().replace(/\s+/g, ' '),
    ]),
  );
  const names = Object.keys(normalized).sort(),
    headerNames = names.join(';');
  const canonical = [
    method,
    uri,
    parameters,
    names.map((name) => name + ':' + normalized[name] + '\n').join(''),
    headerNames,
    payloadHash,
  ].join('\n');
  const { scope, signature } = signCanonical(config, canonical, timestamp);
  return {
    url: config.endpoint + uri + (parameters ? '?' + parameters : ''),
    headers: {
      ...normalized,
      authorization:
        'AWS4-HMAC-SHA256 Credential=' +
        config.accessKey +
        '/' +
        scope +
        ', SignedHeaders=' +
        headerNames +
        ', Signature=' +
        signature,
    },
  };
}
module.exports = { signS3, signCanonical, encode };
