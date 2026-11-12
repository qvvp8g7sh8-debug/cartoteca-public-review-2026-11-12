const fs = require('node:fs');
const path = require('node:path');

function fileNames(text) {
  const expanded = text.replace(/([\w./-]+)\{([\w,.-]+)\}([.\w-]*)/g, (_, prefix, names, suffix) =>
    names
      .split(',')
      .map((name) => prefix + name + suffix)
      .join('; '),
  );
  return expanded.match(/(?:[\w.-]+\/)*[\w.-]+\.(?:md|cjs|js|css|json|yaml|ts)\b/g) || [];
}

function references(root, text, rules = false) {
  const found = fileNames(text);
  if (rules) {
    // Compact rule cells use documented names such as ACCESS; DATABASE; STYLES.
    const aliases = text.split(';').map((name) => name.trim());
    found.push(
      ...aliases
        .filter((name) => /^[A-Z][A-Z0-9-]+$/.test(name))
        .map((name) => 'docs/' + name + '.md'),
    );
  }
  let directory = '.';
  return found.map((name) => {
    if (name.includes('/')) directory = path.posix.dirname(name);
    else if (!fs.existsSync(path.join(root, name))) {
      if (name.endsWith('.test.cjs') && fs.existsSync(path.join(root, 'tests', name)))
        name = 'tests/' + name;
      else if (name.endsWith('.md') && fs.existsSync(path.join(root, 'docs', name)))
        name = 'docs/' + name;
      else if (directory !== '.') name = directory + '/' + name;
    }
    return name;
  });
}

function generatedReportReference(file) {
  if (
    localEvidenceReference(file) ||
    (file.startsWith('../work/') && localEvidenceReference(file.slice(3)))
  )
    return true;
  const match = /^\.release\/candidates\/([a-z0-9][a-z0-9-]{0,63})\/(.+\.json)$/.exec(file);
  if (!match || match[2].split('/').some((part) => !part || part === '.' || part === '..'))
    return false;
  return (
    /^(?:reports\/|deployment\/|stand(?:-[a-z0-9-]+)?\/|image-\d+\/)/.test(match[2]) ||
    /^stand(?:-[a-z0-9-]+)?\.json$/.test(match[2])
  );
}

function localEvidenceReference(file) {
  if (
    typeof file !== 'string' ||
    file.length > 4096 ||
    !file.startsWith('work/') ||
    !file.endsWith('.json')
  )
    return false;
  const parts = file.split('/');
  return (
    parts.length >= 3 &&
    parts
      .slice(1)
      .every(
        (part) =>
          /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) &&
          !/^(?:private|runtime|backups|node_modules)$/i.test(part),
      )
  );
}

function checkDocumentation(root) {
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
  const instructions = read('AGENTS.md');
  const agentLines = instructions.trimEnd().split('\n').length;
  if (/cartoteca:v2-|\d+ passed|## Сохранённая версия/.test(instructions))
    throw Error('Release history belongs in docs/RELEASES.md, not AGENTS.md.');
  if (agentLines > 55) throw Error('AGENTS.md is no longer a short navigation guide.');
  if (
    !instructions.includes('Разработка только локально') ||
    !instructions.includes('docs/RELEASES.md')
  )
    throw Error('AGENTS.md must retain the local-only scope and release journal link.');

  const assertFile = (file) => {
    const target = path.resolve(root, file);
    if (
      !target.startsWith(path.resolve(root) + path.sep) ||
      !fs.statSync(target, { throwIfNoEntry: false })?.isFile()
    )
      throw Error('Documentation points to a missing or unsafe file: ' + file);
  };
  // Root instructions also include shell command fragments and folder notation;
  // check the explicit document links rather than treating those as paths.
  for (const file of fileNames(instructions).filter((file) => file.endsWith('.md')))
    assertFile(file);
  if (!read('docs/RELEASES.md').includes('не разрешение на публикацию'))
    throw Error('The release journal must distinguish history from authorization.');
  const rows = read('docs/MODULES.md')
    .split('\n')
    .filter((line) => line.startsWith('| '));
  if (rows[0] !== '| Функция | Исходники | Правила | Тесты |')
    throw Error('MODULES.md must map function → source → rules → tests.');
  const functions = new Set();
  for (const row of rows.slice(2)) {
    const cells = row
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 4 || cells.some((cell) => !cell) || functions.has(cells[0]))
      throw Error('Invalid or duplicate module map row: ' + row);
    functions.add(cells[0]);
    for (const [index, cell] of cells.slice(1).entries()) {
      const files = references(root, cell, index === 1);
      if (!files.length) throw Error('Module map cell has no concrete file: ' + cell);
      files.forEach(assertFile);
    }
    if (!fileNames(cells[3]).some((file) => file.endsWith('.test.cjs')))
      throw Error('Module map row has no focused test: ' + cells[0]);
  }
  if (functions.size < 30) throw Error('The module map omits major feature groups.');
  // Historical output reports are excluded from a code-only release snapshot.
  // Source, rule and module-map references still require real files.
  for (const file of references(root, read('docs/TESTS.md')).filter(
    (file) => !generatedReportReference(file),
  ))
    assertFile(file);
  return { agentLines, moduleCount: functions.size };
}
if (require.main === module) {
  const result = checkDocumentation(path.resolve(__dirname, '..'));
  console.log(
    `Short documentation verified: ${result.agentLines} instruction lines; ${result.moduleCount} feature routes.`,
  );
}
module.exports = {
  checkDocumentation,
  fileNames,
  references,
  generatedReportReference,
  localEvidenceReference,
};
