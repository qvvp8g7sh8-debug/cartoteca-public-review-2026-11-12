const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Explicit documentation-only list: never enumerate the repository or runtime.
const root = path.resolve(__dirname, '..');
const sources = [
  'docs/GPT-CONTEXT.md',
  'docs/STATUS.md',
  'AGENTS.md',
  'docs/CHAT-WORKFLOW.md',
];
const references = [
  { source: 'docs/ROADMAP.md', file: 'CARTOTECA-REFERENCE-PLAN.txt', title: 'План задач' },
  { source: 'docs/USER-SCENARIOS.md', file: 'CARTOTECA-REFERENCE-SCENARIOS.txt', title: 'Пользовательские сценарии' },
  { source: 'docs/MODULES.md', file: 'CARTOTECA-REFERENCE-MODULES.txt', title: 'Карта исходников и тестов' },
];
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--date' || args[2] !== '--edition') {
  throw new Error('Usage: node scripts/export-context.cjs --date YYYY-MM-DD --edition YYYY-MM-DD-context-NN[N]');
}
const date = args[1];
const edition = args[3];
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date ||
    !new RegExp(`^${date}-context-\\d{2,3}$`).test(edition)) {
  throw new Error('Invalid context date or edition');
}
const documents = [...sources, ...references.map(({ source }) => source)].map((name) => {
  const file = path.join(root, name);
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) {
    throw new Error(`Expected an ordinary documentation file: ${name}`);
  }
  const resolved = fs.realpathSync(file);
  if (!resolved.startsWith(`${fs.realpathSync(root)}${path.sep}`)) {
    throw new Error(`Documentation escapes repository: ${name}`);
  }
  const content = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
  return { name, content, hash: crypto.createHash('sha256').update(content).digest('hex') };
});
if (!documents[0].content.includes(`Редакция: ${edition}.`)) {
  throw new Error('Update docs/GPT-CONTEXT.md edition before exporting');
}
function compactModuleReference(content) {
  const aliases = [
    ['@P/', 'src/server/infrastructure/postgres/'],
    ['@I/', 'src/server/infrastructure/'],
    ['@M/', 'src/server/modules/'],
    ['@C/', 'src/client/'],
    ['@S/', 'src/server/'],
  ];
  if (aliases.some(([alias]) => content.includes(alias)))
    throw Error('Module reference alias collision');
  const lines = content.split('\n');
  const cells = (line) => {
    if (!line.endsWith('|') || line.includes('\\|')) throw Error('Ambiguous module table row');
    let ticks = 0;
    for (const match of line.matchAll(/`+|\|/g)) {
      const token = match[0];
      if (token === '|') {
        if (ticks) throw Error('Pipe inside module table code span');
      } else if (!ticks) ticks = token.length;
      else if (ticks === token.length) ticks = 0;
    }
    const result = line.slice(1, -1).split('|');
    if (ticks || result.length !== 4) throw Error('Unsupported module table format');
    return result;
  };
  const compact = lines.map((line) => line.startsWith('|')
    ? `| ${cells(line).map((cell) => cell.replace(/^ +| +$/g, '')).join(' | ')} |`
    : line).join('\n');
  const encoded = aliases.reduce((text, [alias, prefix]) => text.replaceAll(prefix, alias), compact);
  const expanded = aliases.reduce((text, [alias, prefix]) => text.replaceAll(alias, prefix), encoded).split('\n');
  if (expanded.length !== lines.length) throw Error('Module reference line loss');
  for (let i = 0; i < lines.length; i++) {
    const equal = lines[i].startsWith('|')
      ? JSON.stringify(cells(lines[i]).map((cell) => cell.trim())) ===
        JSON.stringify(cells(expanded[i]).map((cell) => cell.trim()))
      : expanded[i] === lines[i];
    if (!equal) throw Error('Module reference content changed');
  }
  const legend = 'Только в этой TXT-карте ' +
    aliases.map(([alias, prefix]) => alias + ' = ' + prefix).join('; ') +
    '. Табличное выравнивание сокращено; ' +
    'содержимое ячеек и порядок строк сохранены. SHA-256 ниже относится к полному исходному документу.';
  return `${legend}\n\n${encoded}`;
}

function makePacket(title, selected, guide) {
  const header = [
    `# КАРТОТЕКА — ${title}`,
    `Редакция: ${edition}; состояние документов на ${date}.`,
    'Это снимок документации, не резервная копия данных и не вложенные исходники.',
    'Дата экспорта не означает повторную проверку кода/сервера или новую публикацию.',
    'Обновление: заменить старое вложение в ChatGPT; автоматической синхронизации нет.',
    '',
    guide,
  ];
  const body = selected.map(({ name, content }) => `\n\n---\n\nДокумент: ${name}\n\n${name === 'docs/MODULES.md' ? compactModuleReference(content) : content}`);
  const provenance = [
    '## Технические сведения об экспорте',
    'Состав и SHA-256 исходных документов:',
    ...selected.map(({ name, hash }) => `${name}: ${hash}`),
  ];
  return `${header.join('\n')}${body.join('')}\n\n---\n\n${provenance.join('\n')}\n`;
}
const packets = [
  {
    file: 'CARTOTECA-GPT-CONTEXT.txt',
    packet: makePacket('ОСНОВНАЯ ПАМЯТКА ДЛЯ GPT', documents.slice(0, sources.length),
      'Читайте по порядку: памятка → текущее состояние → правила → порядок работы.\n' +
      'Справочники добавляются по задаче, той же редакции:\n\n' +
      references.map(({ file, title }) => `- ${file} — ${title}`).join('\n')),
  },
  ...references.map(({ source, file, title }) => ({
    file,
    packet: makePacket(title.toUpperCase(), [documents.find(({ name }) => name === source)],
      'Дополнение к CARTOTECA-GPT-CONTEXT.txt, не замена основной памятки.\n' +
      'Разрешения и актуальный статус берите из основной памятки той же редакции.\n' +
      'Исторический сценарий или предложенная задача не означают текущую публикацию или разрешение.'),
  })),
].map(({ file, packet }) => ({ file, packet, bytes: Buffer.byteLength(packet, 'utf8') }));
for (const { file, bytes } of packets) {
  if (bytes > 128 * 1024) throw new Error(`${file} exceeds 128 KiB; shorten its source, do not add archives`);
}

// Fixed sibling output, outside the served app; no arbitrary destination flag.
const outputDirectory = path.resolve(root, '..', 'cartoteca-context');
if (fs.existsSync(outputDirectory) && fs.lstatSync(outputDirectory).isSymbolicLink()) {
  throw new Error('Context output must not be a link');
}
fs.mkdirSync(outputDirectory, { recursive: true });
if (fs.realpathSync(outputDirectory) !== outputDirectory) {
  throw new Error('Context output must not traverse a link');
}
for (const { file } of packets) {
  const output = path.join(outputDirectory, file);
  if (fs.existsSync(output) && (!fs.lstatSync(output).isFile() || fs.lstatSync(output).isSymbolicLink())) {
    throw new Error(`Context output must be an ordinary file: ${file}`);
  }
}
for (const { file, packet, bytes } of packets) {
  const output = path.join(outputDirectory, file);
  fs.writeFileSync(output, packet, 'utf8');
  console.log(`Context exported: ${file}, ${bytes} bytes, ${edition}`);
  console.log(output);
}
