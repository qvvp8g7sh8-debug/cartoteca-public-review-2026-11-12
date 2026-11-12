const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Documentation only. No repository walk, runtime reads, tests or network calls.
const root = fs.realpathSync(path.resolve(__dirname, '..'));
const output = path.join(root, 'project-handbook');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--date') {
  throw new Error('Usage: node scripts/export-handbook.cjs --date YYYY-MM-DD');
}
const date = args[1];
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
  throw new Error('Invalid handbook date');
}
const topics = [
  ['Начало и состояние', [
    ['AGENTS.md', 'Текущие разрешения и ограничения'],
    ['docs/STATUS.md', 'Публикация, текущий этап и границы готовности'],
    ['docs/CHAT-WORKFLOW.md', 'Передача работы между чатами'],
    ['docs/GPT-CONTEXT.md', 'Основная памятка GPT и правила экспорта'],
    ['docs/ROADMAP.md', 'Активные и отложенные задачи'],
  ]],
  ['Устройство продукта', [
    ['docs/USER-SCENARIOS.md', 'Пользовательские сценарии по разделам'],
    ['docs/APPOINTMENTS.md', 'Записи, посещения, личное время и выбор услуг'],
    ['docs/MANAGEMENT.md', 'Услуги и группы'],
    ['docs/WORKSPACE.md', 'Сотрудники, доступ и кабинеты'],
    ['docs/WORK-SCHEDULES.md', 'Рабочее время и нерабочие дни'],
    ['docs/ONLINE-BOOKING.md', 'Публичная запись, заявки и короткие ссылки'],
    ['docs/INVITATIONS.md', 'Приглашение команды и ограничения'],
    ['docs/UNIVERSAL.md', 'Универсальные карточки и посещения'],
  ]],
  ['Права и сохранность данных', [
    ['docs/ACCESS.md', 'Серверные права и границы ролей'],
    ['docs/DATABASE.md', 'Хранилища, коллекции и компоненты схемы'],
    ['docs/MIGRATION.md', 'Порядок миграции и возврата'],
    ['docs/PRIVACY.md', 'Данные, согласия и организационные ограничения'],
    ['docs/BACKUPS.md', 'Полные зашифрованные копии, ротация и проверка восстановления'],
    ['docs/ORGANIZATION-RESTORE.md', 'Выборочное восстановление и поддержанные версии'],
  ]],
  ['Код и интерфейс', [
    ['ARCHITECTURE.md', 'Устройство модульного приложения'],
    ['docs/TECHNOLOGY-PASSPORT.md', 'Платформы, библиотеки и сервисы'],
    ['docs/DEVELOPMENT.md', 'Изменения кода, контракты и границы модулей'],
    ['docs/MODULES.md', 'Функция → исходники → правила → тесты'],
    ['docs/ACTION-INDEX.md', 'Поиск реализации конкретного действия'],
    ['docs/CLIENT-CONTRACTS.md', 'Вызывающие модули и явные зависимости'],
    ['docs/STYLES.md', 'Каскад, дизайн, мобильные состояния'],
    ['docs/TIME-PICKER.md', 'Выбор времени и ограничения полей'],
    ['docs/MOBILE-LANDSCAPE-2026-10-10.md', 'Горизонтальный телефон и приёмка'],
    ['docs/IMPECCABLE.md', 'Локальный навык проектирования интерфейсов'],
    ['docs/ADMIN.md', 'Глобальное управление без клинических данных'],
  ]],
  ['Проверки и эксплуатация', [
    ['docs/LOCAL-WORKSPACE.md', 'Папки, данные и безопасный локальный запуск'],
    ['docs/ENVIRONMENT.md', 'Назначения переменных без секретных значений'],
    ['docs/TESTS.md', 'Карта проверок и ссылки на отчёты'],
    ['docs/RELEASE-PIPELINE.md', 'Единый порядок выпуска и условия повторов'],
    ['docs/RELEASE-EARLY-CHECKS.md', 'Выборочный ранний план'],
    ['docs/RELEASE-FLOW.md', 'Оператор и переходы между этапами'],
    ['DEPLOYMENT.md', 'Рабочая топология, публикация, активация и откат'],
    ['docs/TIMEWEB-TEST-SERVERS.md', 'Текущий паспорт проверочного стенда'],
    ['docs/TIMEWEB-WINDOWS.md', 'Повторная настройка Windows при новом заказе'],
    ['docs/TIMEWEB-UBUNTU.md', 'Повторная настройка отдельного Ubuntu-стенда'],
    ['docs/SCALING.md', 'Ограничения архитектуры и измерений'],
    ['docs/PERFORMANCE.md', 'Методика и интерпретация производительности'],
  ]],
  ['Уведомления и будущие функции', [
    ['docs/TELEGRAM.md', 'Клиентские уведомления и привязки Telegram'],
    ['docs/MAX.md', 'Клиентский канал MAX'],
    ['docs/STAFF-MAX.md', 'MAX владельца и сотрудников'],
    ['docs/STAFF-PUSH.md', 'Push, устройства, сессии и отозванный доступ'],
    ['docs/INTEGRATIONS.md', 'Границы внешних интеграций'],
    ['docs/SUPPORT.md', 'Поддержка и обратная связь'],
    ['docs/EARLY-ACCESS.md', 'Бесплатный период, предложения и будущая цена'],
    ['docs/DECISIONS.md', 'Принятые архитектурные решения'],
  ]],
];
const manuals = [
  '00-НАЧАТЬ-ЗДЕСЬ.md',
  '02-ПРОДУКТ-И-ДАННЫЕ.md',
  '03-РАЗРАБОТКА-И-ПРОВЕРКИ.md',
  '04-ЗАПУСК-ПУБЛИКАЦИЯ-И-ВОССТАНОВЛЕНИЕ.md',
  '05-ЗАДАЧИ-И-РЕШЕНИЯ.md',
  '07-ПРОВЕРКА-ПЕРЕД-ПЕРЕУСТАНОВКОЙ.md',
];
function ordinaryFile(relative) {
  const file = path.join(root, relative);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() ||
      !fs.realpathSync(file).startsWith(`${root}${path.sep}`)) {
    throw new Error(`Expected ordinary project document: ${relative}`);
  }
  const content = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return { path: relative.replaceAll('\\', '/'), content,
    bytes: Buffer.byteLength(content),
    sha256: crypto.createHash('sha256').update(content).digest('hex') };
}
if (fs.existsSync(output) && (fs.lstatSync(output).isSymbolicLink() ||
    fs.realpathSync(output) !== output)) {
  throw new Error('Handbook output must not traverse links');
}
fs.mkdirSync(output, { recursive: true });
const names = [...new Set(topics.flatMap(([, entries]) => entries.map(([name]) => name)))];
const sources = names.map(ordinaryFile);
const contents = new Map(sources.map((item) => [item.path, item.content]));
const authored = manuals.map((name) => ordinaryFile(`project-handbook/${name}`));
const status = contents.get('docs/STATUS.md');
const sections = [...status.matchAll(/^## (.+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)]
  .map((match) => ({ heading: match[1], body: match[2].trim() }));
const publishedHeading = (heading) =>
  /(?:^|[\s—])опубликован(?:о|а)?(?=$|[\s,.;])/iu.test(heading) &&
  !/(?:^|\s)не\s+опубликован/iu.test(heading);
const publicationIndex = sections.findIndex((section) => publishedHeading(section.heading));
const published = publicationIndex >= 0 ? sections[publicationIndex] : null;
// An older candidate cannot remain active after a newer confirmed publication.
const unpublished = publicationIndex >= 0 ? sections.slice(0, publicationIndex) : sections;
const active = unpublished.find((section) => /^RELEASE-/.test(section.heading) &&
  !publishedHeading(section.heading));
function currentExcerpt(section) {
  return section.body.split(/\nНиже — истори[^\n]*\n/)[0].trim();
}
const local = sections.filter((section) =>
  /^(APPOINTMENT-SHORT-HINTS|CALENDAR-PERSONAL|TIME-PICKER|SERVICE-SEARCH|UX-LANDSCAPE|WORKSPACE-SPLIT)\b/.test(section.heading));
const state = [
  '# Текущее состояние Картотеки', '',
  `Снимок документов на ${date}. Это не новая проверка или публикация.`, '',
  'При продолжении сначала прочитать живой [STATUS](../docs/STATUS.md).',
  'Проверка относится к конкретным коду, пакету, проверяющим инструментам и среде.', '',
  ...(sections[0] && sections[0] !== published ?
    ['## Последний этап', '', sections[0].heading, '', currentExcerpt(sections[0]), ''] : []),
  '## Последняя подтверждённая публикация', '',
  ...(published ? [published.heading, '', currentExcerpt(published)] :
    ['Сводка публикации не найдена автоматически. Уточнить STATUS и DEPLOYMENT до выпуска.']), '',
  '## Незавершённый выпуск', '',
  ...(active ? [active.heading, '', currentExcerpt(active)] :
    ['Отдельный незавершённый RELEASE-этап не отмечен. Это не разрешение начать публикацию.']), '',
  '## Новые области разработки', '',
  ...local.map((section) => `- ${section.heading.split(/\s+\//)[0]}. Поведение — предметные документы; текущая проверка — верх STATUS.`), '',
  'Ранние пометки отдельных функций не заменяют итоговый отчёт нынешнего кандидата.',
  'Пройденные unit/browser-наборы не означают готовую публикацию при незавершённом стенде.', '',
  '## Перед продолжением незавершённого действия', '',
  '1. Прочитать активный этап и определить последний подтверждённый результат.',
  '2. Установить неизменность проверяемого кода/пакета и отдельно изменённого checker.',
  '3. Продолжать только разрешённое действие по RELEASE-PIPELINE; не менять failed-отчёт.',
  '4. Сохранять рабочий сайт до подтверждения всех обязательных условий выпуска.',
  '5. Публикация, нагрузка, аренда и удаление не запускаются самим чтением памятки.', '',
  'Последние пути/версии берутся из STATUS, DEPLOYMENT и паспорта тестового сервера.',
  'Исторические кандидаты, планы и номера VM не использовать как текущую конфигурацию.', '',
].join('\n');
const index = [
  '# Где искать подробности о Картотеке', '',
  'Это ссылки на действующие файлы внутри сохранённого проекта.',
  'Читайте только нужную тему. Архивы и старые протоколы в стартовый пакет не входят.', '',
  ...topics.flatMap(([title, entries]) => [
    `## ${title}`, '', '| Документ | Назначение |', '| --- | --- |',
    ...entries.map(([name, purpose]) => `| [${name}](../${name}) | ${purpose} |`), '',
  ]),
  '## Исходники и инструменты', '',
  '| Путь | Назначение |', '| --- | --- |',
  '| src/client/core, modules, styles | Исходники интерфейса |',
  '| src/client/manifest.json | Порядок сборки, модули, зависимости и стили |',
  '| src/client/contracts/ports.d.ts, src/client/contracts/domain.d.ts | Явные порты и доменные типы |',
  '| src/shared | Общие правила клиента и сервера |',
  '| src/server/application, http, modules, infrastructure | Сервер, HTTP, бизнес-логика, данные и резервирование |',
  '| tests, tests/browser, tests/helpers | Предметные, браузерные и стендовые сценарии |',
  '| scripts/release.cjs, scripts/release | Оператор выпуска; вызовы только в заказанном этапе |',
  '| scripts/start-local.ps1, scripts/local-preview.cjs | Локальный просмотр без внешних отправок |',
  '| scripts/export-context.cjs | Четыре обычных справочных TXT вне папки проекта |',
  '| scripts/export-handbook.cjs | Обновление этой папки и единого TXT |',
  '| package.json, package-lock.json | Команды, требования и закреплённые зависимости |', '',
  '## Что не читать без конкретной причины', '',
  'Скомпилированные app.js/ui-extra.css, архивные STATUS/TESTS/ROADMAP,',
  'старые RELEASE-/CHECK-отчёты, TASK-HISTORY целиком, сырые журналы чатов.',
  'История и доказательства сохранены на своих местах; они не являются новым планом.', '',
  'runtime/private/.env/базы/ключи/фото не являются источниками поиска кода.',
  'Для сохранения машины нужны защищённые данные, но их нельзя прикладывать к этой памятке.', '',
].join('\n');
const generated = [
  { file: '01-ТЕКУЩЕЕ-СОСТОЯНИЕ.md', content: state },
  { file: '06-ГДЕ-ИСКАТЬ-ПОДРОБНОСТИ.md', content: index },
];
const ordered = [authored[0], { path: generated[0].file, content: state },
  ...authored.slice(1), { path: generated[1].file, content: index }];
const packet = [
  '# Картотека для нового чата', '', `Документация на ${date}.`,
  'Место хранения: C:\\Cartoteca\\cartoteca-v2\\project-handbook.',
  'Источники и код остаются в проекте. Пакет не содержит рабочих данных и секретов.',
  'Если приложен TXT без доступа к компьютеру, относительные ссылки требуют файлов проекта.', '',
  ...ordered.flatMap((item) => [`Документ: ${item.path}`, '', item.content.trim(), '', '---', '']),
].join('\n');
if (Buffer.byteLength(packet) > 128 * 1024) {
  throw new Error('Handbook packet exceeds 128 KiB; remove duplication before exporting');
}
generated.push({ file: 'КАРТОТЕКА-ДЛЯ-НОВОГО-ЧАТА.txt', content: packet });
generated.push({ file: 'ИСТОЧНИКИ.json', content: `${JSON.stringify({
  date, exportedAtUtc: new Date().toISOString(),
  purpose: 'Documentation provenance only; not code, server or publication validation',
  sources: [...sources, ...authored].map(({ content, ...entry }) => entry),
  generated: generated.map(({ file, content }) => ({ file,
    bytes: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex') })),
}, null, 2)}\n` });
for (const { file } of generated) {
  const target = path.join(output, file);
  if (path.dirname(target) !== output || (fs.existsSync(target) &&
      (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()))) {
    throw new Error(`Unsafe handbook target: ${file}`);
  }
}
for (const { file, content } of generated) fs.writeFileSync(path.join(output, file), content, 'utf8');
console.log(`Handbook exported: ${generated.length} generated files, ${sources.length} source documents, ${Buffer.byteLength(packet)} byte packet`);
console.log(output);
