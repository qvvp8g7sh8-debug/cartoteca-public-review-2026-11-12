const path = require('node:path');
const { fileNames } = require('../check-docs.cjs');

function linkedTests(files, read, changed, tests) {
  // Planning/prepare/matrix must boot on clean CI workers before npm installation.
  const acorn = require('acorn');
  const reverse = new Map(),
    unresolved = [];
  const add = (dependency, consumer) => {
    if (!reverse.has(dependency)) reverse.set(dependency, new Set());
    reverse.get(dependency).add(consumer);
  };
  for (const name of Object.keys(files).filter((n) => /\.(?:js|cjs|mjs)$/.test(n))) {
    let ast;
    try {
      ast = acorn.parse(read(name), { ecmaVersion: 'latest', sourceType: 'module' });
    } catch {
      unresolved.push(name);
      continue;
    }
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'Literal' && typeof node.value === 'string') {
        const value = node.value;
        if (value.startsWith('.') || /^(?:src|scripts|tests)\//.test(value)) {
          for (const prefix of [path.posix.dirname(name), '.']) {
            const joined = path.posix.normalize(path.posix.join(prefix, value));
            const target = [
              joined,
              joined + '.js',
              joined + '.cjs',
              joined + '/index.js',
              joined + '/index.cjs',
            ].find((n) => files[n]);
            if (target) add(target, name);
          }
        }
      }
      if (
        node.type === 'CallExpression' &&
        node.callee?.name === 'require' &&
        node.arguments[0]?.type !== 'Literal'
      )
        unresolved.push(name);
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') walk(value);
      }
    }
    walk(ast);
  }
  const distance = new Map(changed.map((name) => [name, 0]));
  const affected = new Set(changed),
    queue = [...changed];
  while (queue.length) {
    const dependency = queue.shift();
    for (const consumer of reverse.get(dependency) || [])
      if (!affected.has(consumer)) {
        affected.add(consumer);
        distance.set(consumer, distance.get(dependency) + 1);
        queue.push(consumer);
      }
  }
  const selected = new Map(
    tests
      .filter((n) => files[n] && affected.has(n))
      .map((n) => [n, [distance.get(n) === 1 ? 'direct-source' : 'source-reference-or-import']]),
  );
  if (files['docs/MODULES.md'])
    for (const line of read('docs/MODULES.md').split('\n')) {
      const cells = line.split('|');
      if (cells.length < 6) continue;
      const sources = fileNames(cells[2]);
      if (!sources.some((name) => affected.has(name))) continue;
      for (const file of fileNames(cells[4])) {
        const name = tests.includes(file) ? file : 'tests/' + file;
        if (tests.includes(name))
          selected.set(name, [
            ...(selected.get(name) || []),
            sources.some((source) => changed.includes(source)) ? 'module-map-direct' : 'module-map',
          ]);
      }
    }
  return { selected, affected: [...affected].sort(), unresolved: [...new Set(unresolved)].sort() };
}
module.exports = { linkedTests };
