const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const acorn = require('acorn'),
  eslintScope = require('eslint-scope');
const root = path.resolve(__dirname, '..');
const files = [];
function collect(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) collect(file);
    else if (/\.(cjs|js)$/.test(e.name)) files.push(file);
  }
}
collect(path.join(root, 'src'));
const graph = new Map(),
  parse = (file) =>
    acorn.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', ranges: true });
function visit(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (node.type) fn(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'range') continue;
    if (Array.isArray(value)) value.forEach((x) => visit(x, fn));
    else if (value && typeof value === 'object') visit(value, fn);
  }
}
const globals = new Set([
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'process',
  'Buffer',
  'console',
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'localStorage',
  'fetch',
  'URL',
  'URLSearchParams',
  'FormData',
  'CustomEvent',
  'Event',
  'FileReader',
  'Image',
  'AbortController',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'structuredClone',
  'Intl',
  'Date',
  'Array',
  'Object',
  'String',
  'Number',
  'BigInt',
  'Boolean',
  'Symbol',
  'RegExp',
  'Map',
  'Set',
  'WeakSet',
  'WeakMap',
  'Promise',
  'Error',
  'TypeError',
  'Math',
  'JSON',
  'undefined',
  'NaN',
  'Infinity',
]);
for (const name of [
  'encodeURIComponent',
  'decodeURIComponent',
  'confirm',
  'alert',
  'globalThis',
  'Uint8Array',
  'Uint32Array',
  'Int32Array',
  'Reflect',
  'parseInt',
  'parseFloat',
  'AbortSignal',
])
  globals.add(name);
const adminSources = new Set(
    (require('../src/client/manifest.json').adminSources || []).map((file) =>
      path.join(root, file),
    ),
  ),
  adminBindings = new Set();
const bookingSources = new Set(
    (require('../src/client/manifest.json').bookingSources || []).map((file) =>
      path.join(root, file),
    ),
  ),
  bookingBindings = new Set();
// Browser worker/worklet globals belong only to their exact standalone sources.
const captureWorkletSource = path.join(root, 'src/client/worklets/assistant-capture.js');
const captureWorkletGlobals = new Set([
  'AudioWorkletProcessor',
  'registerProcessor',
  'Float32Array',
  'currentTime',
  'sampleRate',
]);
const playbackWorkletSource = path.join(root, 'src/client/worklets/assistant-playback-worklet.js');
const playbackWorkletGlobals = new Set([
  'AudioWorkletProcessor',
  'registerProcessor',
  'Int16Array',
  'Float32Array',
  'sampleRate',
]);
const workerSource = path.join(root, 'src/client/pwa/service-worker.js'),
  workerGlobals = new Set(['self', 'caches', 'Response', 'Headers']);
const pcmWorkerSource = path.join(root, 'src/client/workers/assistant-pcm-pump.js'),
  pcmWorkerGlobals = new Set(['self', 'DataView', 'Int16Array']);
const echoWorkerSource = path.join(root, 'src/client/workers/assistant-echo-train.js'),
  echoWorkerGlobals = new Set(['self', 'createAssistantEchoMath', 'createAssistantEchoReflection']);
for (const file of adminSources)
  for (const node of parse(file).body)
    if (node.type === 'FunctionDeclaration') {
      if (adminBindings.has(node.id.name)) throw Error('Duplicate admin factory ' + node.id.name);
      adminBindings.add(node.id.name);
    }
// Public functions share only their explicit standalone booking bundle.
for (const file of bookingSources)
  for (const node of parse(file).body)
    if (node.type === 'FunctionDeclaration') {
      if (bookingBindings.has(node.id.name))
        throw Error('Duplicate booking factory ' + node.id.name);
      bookingBindings.add(node.id.name);
    }
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8'),
    ast = parse(file);
  new vm.Script(source, { filename: file });
  const manager = eslintScope.analyze(ast, {
    ecmaVersion: 2024,
    sourceType: 'script',
    optimistic: true,
    ignoreEval: true,
  });
  const unbound = [
    ...new Set(
      manager.globalScope.through
        .map((r) => r.identifier.name)
        .filter(
          (n) =>
            !globals.has(n) &&
            !(file === workerSource && workerGlobals.has(n)) &&
            !(file === pcmWorkerSource && pcmWorkerGlobals.has(n)) &&
            !(file === echoWorkerSource && echoWorkerGlobals.has(n)) &&
            !(file === captureWorkletSource && captureWorkletGlobals.has(n)) &&
            !(file === playbackWorkletSource && playbackWorkletGlobals.has(n)) &&
            !(adminSources.has(file) && adminBindings.has(n)) &&
            !(bookingSources.has(file) && bookingBindings.has(n)),
        ),
    ),
  ];
  if (unbound.length)
    throw Error(path.relative(root, file) + ': unbound references ' + unbound.join(', '));
  const dependencies = [];
  visit(ast, (n) => {
    if (
      n.type === 'CallExpression' &&
      n.callee.name === 'require' &&
      n.arguments[0]?.type === 'Literal' &&
      String(n.arguments[0].value).startsWith('.')
    ) {
      const target = path.resolve(path.dirname(file), n.arguments[0].value);
      if (!fs.existsSync(target)) throw Error('Missing import ' + target);
      dependencies.push(target);
    }
  });
  graph.set(file, dependencies);
}
function cycle(file, trail = []) {
  if (trail.includes(file))
    throw Error(
      'Import cycle: ' + [...trail, file].map((x) => path.relative(root, x)).join(' -> '),
    );
  for (const next of graph.get(file) || []) cycle(next, [...trail, file]);
}
for (const file of graph.keys()) cycle(file);
const manifest = require('../src/client/manifest.json'),
  exportsSet = new Set(),
  exportOwners = new Map(),
  states = new Set(),
  factoryNames = new Set();
visit(parse(path.join(root, manifest.state)), (n) => {
  if (
    n.type === 'AssignmentExpression' &&
    n.left.type === 'MemberExpression' &&
    n.left.object.name === 'state'
  )
    states.add(n.left.property.name);
});
for (const item of manifest.factories) {
  const ast = parse(path.join(root, item.path));
  const factory = ast.body.find(
    (n) => n.type === 'FunctionDeclaration' && n.id.name === item.factory,
  );
  if (!factory || factoryNames.has(item.factory))
    throw Error(item.path + ': missing or duplicate factory ' + item.factory);
  factoryNames.add(item.factory);
  const result = factory?.body.body.findLast((n) => n.type === 'ReturnStatement');
  if (result?.argument?.type !== 'ObjectExpression')
    throw Error(item.path + ': factory must return an explicit actions object.');
  for (const key of result.argument.properties) {
    const name = key.key?.name;
    if (!name || key.computed || key.type !== 'Property')
      throw Error(item.path + ': actions must have explicit names.');
    if (exportOwners.has(name))
      throw Error(
        'Duplicate client action ' + name + ': ' + exportOwners.get(name) + ' and ' + item.path,
      );
    exportOwners.set(name, item.path);
    exportsSet.add(name);
  }
}
const contracts = [];
require('./check-styles.cjs').checkStyles(root, manifest);
require('./check-docs.cjs').checkDocumentation(root);
const { analyzeClient, checkClientContracts } = require('./client-contracts.cjs');
checkClientContracts(analyzeClient(root, manifest), manifest);
require('./check-types.cjs').checkTypes(root);
for (const file of [...manifest.factories.map((x) => x.path), manifest.events]) {
  const actions = new Set(),
    usedState = new Set();
  visit(parse(path.join(root, file)), (n) => {
    if (n.type === 'MemberExpression' && !n.computed) {
      if (n.object.name === 'actions') actions.add(n.property.name);
      if (n.object.name === 'state') usedState.add(n.property.name);
    }
  });
  for (const name of actions)
    if (!exportsSet.has(name)) throw Error(file + ': missing action ' + name);
  for (const name of usedState)
    if (!states.has(name)) throw Error(file + ': unknown state ' + name);
  contracts.push({ file, actions: [...actions].sort(), state: [...usedState].sort() });
}
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const privateFiles = tracked.filter(
  (x) =>
    /(^|\/)(runtime|private|data(?:-[^/]+)?|backups|node_modules)\//.test(x) ||
    /\.(key|sqlite(?:-wal|-shm)?|enc|log)$/.test(x) ||
    (/(^|\/)\.env(?:$|\.)/.test(x) && !x.endsWith('.env.example')),
);
if (privateFiles.length) throw Error('Private files in Git: ' + privateFiles.join(', '));
require('./build-client.cjs');
const { routeGroups } = require('../src/server/application/routes.cjs');
const routes = routeGroups.flatMap((group) =>
  group.routes.map((r) => ({ ...r, file: group.file })),
);
const keys = routes.map((r) => r.method + ' ' + r.path);
if (new Set(keys).size !== keys.length) throw Error('Duplicate HTTP routes.');
const routeDoc =
  '# Реестр серверных маршрутов\n\nСоздаётся `npm run check:architecture`. Авторизация и CSRF выполняются общим сервером.\n\n| Метод | URL | Доступ | Исходник |\n| --- | --- | --- | --- |\n' +
  routes.map((r) => `| ${r.method} | \`${r.path}\` | ${r.access} | \`${r.file}\` |`).join('\n') +
  '\n| GET / HEAD | `/api/photos/:id` | organization; сотрудник — только своё фото | `src/server/http/request-handler.cjs` |\n\nPOST /api/max/webhook — единственное provider-исключение browser-CSRF: Host проверяется, секрет MAX проверяется до чтения тела, затем предел 32 КБ и фиксация шифрованного inbox до HTTP 200. По умолчанию обработчик выключен. Остальные public-маршруты сохраняют browser-CSRF.\n\nPublic означает отсутствие обязательной сессии, но не отсутствие проверки токена, пароля и ограничения запросов. Публичная онлайн-запись работает только после включения владельцем/администратором; бюджет, подпись формы и доступность проверяются на сервере.\n';
function document(file, content) {
  const target = path.join(root, file);
  if (process.argv.includes('--check')) {
    if (
      !fs.existsSync(target) ||
      fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== content.replace(/\r\n/g, '\n')
    )
      throw Error('Stale ' + file + ': run npm run check:architecture.');
  } else fs.writeFileSync(target, content);
}
document('docs/ROUTES.md', routeDoc);
document(
  'docs/CLIENT-CONTRACTS.md',
  '# Связи клиентских модулей\n\nСоздаётся проверкой архитектуры. `state` — состояние одного приложения; `actions` — ограниченные read-only порты из manifest.dependencies. Общий реестр доступен только композиции. Проверяются имена, явные зависимости и арность; строгие типы команд сохранения — contracts/domain.d.ts. Для изменения функции найди строку, не читай весь граф.\n\n| Исходник | Вызываемые действия | Используемое состояние |\n| --- | --- | --- |\n' +
    contracts
      .map((x) => `| \`${x.file}\` | ${x.actions.join(', ')} | ${x.state.join(', ')} |`)
      .join('\n') +
    '\n',
);
document(
  'docs/ACTION-INDEX.md',
  '# Где определено клиентское действие\n\nСоздаётся проверкой архитектуры. Найди имя через `rg -n <имя> docs/ACTION-INDEX.md`, затем открой только исходник определения. Для вызывающих модулей — CLIENT-CONTRACTS.md. Не искать определения в сгенерированном app.js.\n\n| Действие | Исходник определения |\n| --- | --- |\n' +
    [...exportOwners]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, file]) => `| \`${name}\` | \`${file}\` |`)
      .join('\n') +
    '\n',
);
console.log(
  `Architecture: ${files.length} source files; ${routes.length} routes; no unbound references, import cycles or private tracked files.`,
);
