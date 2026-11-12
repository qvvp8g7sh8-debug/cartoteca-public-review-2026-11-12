const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { JSDOM } = require('jsdom');

test('card keeps appointment and services equal-sized, with edit and More underneath', () => {
  const css = require('postcss').parse(
    fs.readFileSync(
      path.join(__dirname, '../src/client/styles/client-contact-actions.css'),
      'utf8',
    ),
  );
  const rules = new Map();
  css.walkRules((rule) =>
    rules.set(rule.selector, {
      ...rules.get(rule.selector),
      ...Object.fromEntries(
        rule.nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]),
      ),
    }),
  );
  assert.equal(
    rules.get('.card-mode .patient-actions')['grid-template-columns'],
    'minmax(0, 1fr) auto',
  );
  assert.equal(
    rules.get('.card-mode .patient-actions > #new-patient-appointment')['grid-column'],
    '1 / -1',
  );
  const services = rules.get('.patient-actions details.patient-connections');
  assert.equal(services['grid-column'], '1 / -1');
  assert.equal(services.width, '100%');
  assert.equal(services.height, '44px');
  const source = fs.readFileSync(path.join(__dirname, '../src/client/modules/card.js'), 'utf8');
  assert.ok(
    source.indexOf('id="new-patient-appointment"') <
      source.indexOf('actions.patientConnectionsHtml(p.id)'),
  );
  assert.ok(
    source.indexOf('actions.patientConnectionsHtml(p.id)') < source.indexOf('id="edit-patient"'),
  );
});
test('summary differentiates checking, unlinked, linked, incompatible and unavailable without leaking a stale card', (t) => {
  const w = new JSDOM(
    '<details class="patient-connections" data-patient-id="p"><small class="patient-connections-status" data-telegram="checking" data-max="checking"></small></details>',
    { runScripts: 'outside-only' },
  ).window;
  t.after(() => w.close());
  w.eval(
    fs.readFileSync(
      path.join(__dirname, '../src/client/modules/client-service-summary.js'),
      'utf8',
    ),
  );
  const api = w.createClientServiceSummary({}, { $: (s) => w.document.querySelector(s) }),
    status = w.document.querySelector('small'),
    root = w.document.querySelector('details');
  api.updateClientServiceSummary('p', 'telegram', 'unlinked');
  assert.match(status.textContent, /Проверяем/);
  assert.equal(root.dataset.connectionState, 'checking');
  api.updateClientServiceSummary('p', 'max', 'unlinked');
  assert.equal(status.textContent, 'Не подключено');
  assert.equal(root.dataset.connectionState, 'unlinked');
  api.updateClientServiceSummary('p', 'telegram', 'linked');
  assert.equal(status.textContent, 'Подключены: Telegram');
  assert.equal(root.dataset.connectionState, 'linked');
  api.updateClientServiceSummary('p', 'max', 'linked');
  assert.equal(status.textContent, 'Подключены: Telegram, MAX');
  api.updateClientServiceSummary('other', 'telegram', 'unlinked');
  assert.equal(status.textContent, 'Подключены: Telegram, MAX');
  api.updateClientServiceSummary('p', 'telegram', 'unlinked');
  api.updateClientServiceSummary('p', 'max', 'reconnect');
  assert.match(status.textContent, /переподключить/);
  assert.equal(root.dataset.connectionState, 'unlinked');
  api.updateClientServiceSummary('p', 'max', 'unavailable');
  assert.match(status.textContent, /доступность/);
  assert.equal(root.dataset.connectionState, 'unlinked');
});

test('service colours accompany labels and never imply that a future channel is connected', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '../src/client/styles/client-contact-actions.css'),
    'utf8',
  );
  assert.match(css, /data-connection-state='linked'[\s\S]*?background: #edf7ef/);
  assert.match(css, /data-connection-state='unlinked'[\s\S]*?background: #fff9e7/);
  assert.match(css, /connection-service:not\(\.is-linked, \.is-future, \.is-loading\)/);
});
