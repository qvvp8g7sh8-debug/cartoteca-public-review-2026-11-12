const path = require('node:path');
const vm = require('node:vm');
const { freshTest } = require('./verification-profile-policy.cjs');

// The ordinary impact planner is advisory. This selector additionally treats
// dynamic imports and filesystem reads as unknown dependencies and runs their
// transitive consumers freshly rather than inheriting an optimistic cache hit.
function selectFreshTests(files, read, tests) {
  const reverse = new Map(),
    uncertain = new Set(),
    client = new Set();
  const add = (dependency, consumer) => {
    if (!reverse.has(dependency)) reverse.set(dependency, new Set());
    reverse.get(dependency).add(consumer);
  };
  const resolve = (value, name) => {
    for (const prefix of [path.posix.dirname(name), '.']) {
      const joined = path.posix.normalize(path.posix.join(prefix, value));
      const found = [
        joined,
        joined + '.js',
        joined + '.cjs',
        joined + '/index.js',
        joined + '/index.cjs',
      ].find((candidate) => files[candidate]);
      if (found) add(found, name);
    }
  };
  for (const name of Object.keys(files)) {
    if (
      name.startsWith('src/client/') ||
      /^(?:app(?:-settings|-assistant)?\.js|ui-extra\.css)$/.test(name)
    )
      client.add(name);
    if (!/\.(?:js|cjs|mjs)$/.test(name)) continue;
    const source = read(name);
    // Parse only: never execute project code, and do not need npm before prepare.
    try {
      new vm.Script(source, { filename: name });
    } catch {
      uncertain.add(name);
    }
    for (const token of source.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)) {
      const value = token[0].slice(1, -1);
      if (value.includes('\\')) {
        uncertain.add(name);
        continue;
      }
      if (value.startsWith('.') || /^(?:src|scripts|tests)\//.test(value) || files[value])
        resolve(value, name);
    }
    const mentions = [...source.matchAll(/\brequire\b/g)];
    const literalCalls = [...source.matchAll(/\brequire\s*\(\s*(?:"[^"\\]*"|'[^'\\]*')\s*\)/g)];
    if (
      mentions.length !== literalCalls.length ||
      /\b(?:import|eval|Function|readFile|readFileSync|createReadStream|readdir|readdirSync|readlink|readlinkSync|exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\b/.test(
        source,
      )
    )
      uncertain.add(name);
  }
  const affected = new Set([...client, ...uncertain]),
    queue = [...affected];
  while (queue.length) {
    for (const consumer of reverse.get(queue.shift()) || [])
      if (!affected.has(consumer)) {
        affected.add(consumer);
        queue.push(consumer);
      }
  }
  return {
    files: tests.filter((name) => freshTest(name) || affected.has(name)).sort(),
    uncertain: [...uncertain].sort(),
    dependencyHash: require('./files.cjs').objectHash(
      [...reverse]
        .map(([name, consumers]) => [name, [...consumers].sort()])
        .sort(([a], [b]) => a.localeCompare(b, 'en')),
    ),
  };
}
module.exports = { selectFreshTests };
