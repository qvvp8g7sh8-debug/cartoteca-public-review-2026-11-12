const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const names = [
  'Консультация',
  'Индивидуальная консультация и составление плана работы',
  'Комплексная услуга с подбором программы и рекомендациями',
  'Повторная консультация специалиста',
  'Разработка индивидуальной программы',
  'Очень длинное название услуги для проверки переноса текста без обрезания и наложения на цену, длительность и кнопки выбора',
];

function servicesLayoutPreview(editing = false) {
  const state = {
    SERVICE_CATEGORIES: [{ id: 'other', title: 'Другое' }],
    services: names.map((name, index) => ({ id: 'test-' + index, name, category: 'other',
      duration: '60 минут', price: 1500, description: index === 2 ? 'Краткое описание услуги' : '' })),
  };
  const actions = {
    accountId: () => 'synthetic-owner',
    canEditServices: () => true, canDelete: () => true,
    plural: () => 'час', serviceGroupControlHtml: () => '',
    esc: (value) => String(value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]),
  };
  const context = vm.createContext({ structuredClone });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/client/modules/service-catalog.js'), 'utf8') +
    ';this.catalogFactory = createServiceCatalog;', context);
  Object.assign(actions, context.catalogFactory(state, actions));
  vm.runInContext(fs.readFileSync(path.join(root, 'src/client/modules/services.js'), 'utf8') +
    ';this.factory = createServices;', context);
  Object.assign(actions, context.factory(state, actions));
  actions.configureServiceView({ editing });
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Проверка компактных услуг</title><link rel="stylesheet" href="/style.css">' +
    '<link rel="stylesheet" href="/ui-extra.css"><link rel="stylesheet" href="/preview.css">' +
    '</head><body><main>' + actions.servicesHtml() + '</main></body></html>';
}
module.exports = { servicesLayoutPreview, names };

if (require.main === module) {
  require('node:http').createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'");
    const url = new URL(request.url, 'http://127.0.0.1');
    if (['/style.css', '/ui-extra.css'].includes(url.pathname)) {
      response.setHeader('Content-Type', 'text/css');
      response.end(require('./interface-assets.cjs').readAsset(url.pathname.slice(1)));
    } else if (url.pathname === '/preview.css') {
      response.setHeader('Content-Type', 'text/css');
      response.end('main{max-width:1440px;padding:16px;margin:auto}@media(max-width:700px){main{padding:8px}.global-panel{padding:12px}}');
    } else {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(servicesLayoutPreview(url.searchParams.has('edit')));
    }
  }).listen(4175, '127.0.0.1', () => process.stdout.write('Synthetic services preview ready\n'));
}
