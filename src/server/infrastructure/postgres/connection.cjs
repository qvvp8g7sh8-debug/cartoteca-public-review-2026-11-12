const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns').promises;
const privateAddresses = new net.BlockList();
for (const [address, prefix] of [
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
])
  privateAddresses.addSubnet(address, prefix, 'ipv4');
privateAddresses.addSubnet('fc00::', 7, 'ipv6');
privateAddresses.addAddress('::1', 'ipv6');
function privateAddress(address) {
  if (typeof address !== 'string') return false;
  const family = net.isIP(address);
  return family !== 0 && privateAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
function secretFile(filename) {
  if (typeof filename !== 'string' || !filename) throw Error('Invalid PostgreSQL secret file.');
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 4096)
    throw Error('Invalid PostgreSQL secret file.');
  const value = fs.readFileSync(filename, 'utf8').replace(/\r?\n$/, '');
  if (!value || value.includes('\0') || value.includes('\r') || value.includes('\n'))
    throw Error('Invalid PostgreSQL secret file.');
  return value;
}
function secretValue(environment, name) {
  const file = environment[name + '_FILE'],
    direct = environment[name];
  if (file && direct) throw Error('Choose one PostgreSQL secret source.');
  return file ? secretFile(file) : direct;
}
function allowedHosts(value) {
  const hosts = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
  if (
    hosts.length > 8 ||
    hosts.some(
      (host) =>
        typeof host !== 'string' ||
        host !== host.toLowerCase() ||
        host.length > 253 ||
        (!net.isIP(host) &&
          !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
            host,
          )),
    )
  )
    throw Error('Invalid private PostgreSQL host allowlist.');
  return [...new Set(hosts)];
}
function connectionSettings(input, { profile = 'local', allowedHosts: hostList = [] } = {}) {
  if (typeof input === 'string') {
    const value = new URL(input);
    if (!['postgres:', 'postgresql:'].includes(value.protocol) || value.search || value.hash)
      throw Error('Invalid PostgreSQL connection.');
    input = {
      host: value.hostname.replace(/^\[|\]$/g, ''),
      port: Number(value.port || 5432),
      database: decodeURIComponent(value.pathname.slice(1)),
      user: decodeURIComponent(value.username),
      password: decodeURIComponent(value.password),
    };
  }
  if (
    !input ||
    !['local', 'production-v1'].includes(profile) ||
    typeof input.host !== 'string' ||
    !Number.isSafeInteger(input.port) ||
    input.port < 1 ||
    input.port > 65535 ||
    ![input.database, input.user].every(
      (v) => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(v),
    ) ||
    typeof input.password !== 'string' ||
    input.password.length < 1 ||
    input.password.length > 1024 ||
    input.password.includes('\0')
  )
    throw Error('Explicit PostgreSQL connection required.');
  if (profile === 'local') {
    if (!['127.0.0.1', '::1', 'localhost'].includes(input.host))
      throw Error('Explicit loopback PostgreSQL connection required.');
  } else {
    const hosts = allowedHosts(hostList);
    if (
      !hosts.length ||
      !hosts.includes(input.host) ||
      (net.isIP(input.host) && !privateAddress(input.host))
    )
      throw Error('Explicit private PostgreSQL host required.');
  }
  return {
    host: input.host,
    port: input.port,
    database: input.database,
    user: input.user,
    password: input.password,
    connectionTimeoutMillis: 5000,
  };
}
function localConnection(input) {
  try {
    return connectionSettings(input);
  } catch {
    throw Error('An explicit local PostgreSQL operator connection is required.');
  }
}
function validatePin(pin, host) {
  if (
    !pin ||
    typeof pin !== 'object' ||
    Object.keys(pin).sort().join(',') !== 'address,host,version' ||
    pin.version !== 1 ||
    pin.host !== host ||
    !privateAddress(pin.address) ||
    (net.isIP(host) && pin.address !== host)
  )
    throw Error('Invalid private PostgreSQL address pin.');
  return pin.address;
}
async function serverConnection(input, options = {}) {
  const connection = connectionSettings(input, options);
  if (options.profile !== 'production-v1') {
    if (options.pin) throw Error('Private PostgreSQL pins require the server profile.');
    return connection;
  }
  if (options.pin) return { ...connection, host: validatePin(options.pin, connection.host) };
  if (net.isIP(connection.host)) return connection;
  let timer;
  const answers = await Promise.race([
    (options.lookup || dns.lookup)(connection.host, { all: true, verbatim: true }),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('PostgreSQL address lookup deadline exceeded.')), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
  if (
    !Array.isArray(answers) ||
    !answers.length ||
    answers.length > 32 ||
    answers.some((answer) => !privateAddress(answer.address))
  )
    throw Error('PostgreSQL host must resolve only to private addresses.');
  // Pass the checked numeric address to pg. A later resolver change cannot move
  // the already admitted connection to an external endpoint.
  return { ...connection, host: answers[0].address };
}
function productionPostgresProfile(config) {
  if (config?.storageBackend !== 'postgres' || config.postgresProfile !== 'production-v1')
    return false;
  try {
    connectionSettings(config.postgres, {
      profile: config.postgresProfile,
      allowedHosts: config.postgresAllowedHosts,
    });
    if (config.postgresPin) validatePin(config.postgresPin, config.postgres.host);
    return true;
  } catch {
    return false;
  }
}
function operatorConnection(value, environment = process.env) {
  return localConnection(
    value ||
      secretValue(environment, 'CARTOTECA_BACKUP_POSTGRES_URL') ||
      secretValue(environment, 'CARTOTECA_POSTGRES_URL'),
  );
}
function operatorOptions(environment, connectionOptions) {
  return {
    profile: environment.CARTOTECA_POSTGRES_PROFILE || 'local',
    allowedHosts: allowedHosts(environment.CARTOTECA_PG_ALLOWED_HOSTS),
    ...connectionOptions,
  };
}
function operatorSettings(value, environment = process.env, connectionOptions) {
  const options = operatorOptions(environment, connectionOptions),
    production = options.profile === 'production-v1';
  let supplied = value;
  if (supplied && production && (typeof supplied !== 'object' || Array.isArray(supplied)))
    throw Error('Production PostgreSQL requires a secret file or a private connection object.');
  if (!supplied) {
    const urlName = ['CARTOTECA_BACKUP_POSTGRES_URL', 'CARTOTECA_POSTGRES_URL'].find(
      (name) => environment[name] || environment[name + '_FILE'],
    );
    if (urlName) {
      if (production && environment[urlName])
        throw Error('Production PostgreSQL credentials require a secret file.');
      supplied = secretValue(environment, urlName);
    } else {
      if (production && environment.CARTOTECA_PG_PASSWORD)
        throw Error('Production PostgreSQL credentials require a secret file.');
      supplied = {
        host: environment.CARTOTECA_PG_HOST || '127.0.0.1',
        port: Number(environment.CARTOTECA_PG_PORT || 5432),
        database: environment.CARTOTECA_PG_DATABASE || '',
        user: environment.CARTOTECA_PG_USER || '',
        password: secretValue(environment, 'CARTOTECA_PG_PASSWORD') || '',
      };
    }
  }
  return connectionSettings(supplied, options);
}

async function operatorServerConnection(value, environment = process.env, connectionOptions) {
  return serverConnection(
    operatorSettings(value, environment, connectionOptions),
    operatorOptions(environment, connectionOptions),
  );
}

function applicationRole(value, environment = process.env) {
  const role =
    value ||
    environment.BACKUP_POSTGRES_APPLICATION_ROLE ||
    environment.CARTOTECA_PG_USER ||
    'cartoteca_app';
  if (typeof role !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(role))
    throw Error('Invalid PostgreSQL application role.');
  return role;
}
module.exports = {
  localConnection,
  operatorConnection,
  operatorSettings,
  operatorServerConnection,
  validatePin,
  applicationRole,
  connectionSettings,
  serverConnection,
  productionPostgresProfile,
  allowedHosts,
  secretFile,
  secretValue,
  privateAddress,
};
