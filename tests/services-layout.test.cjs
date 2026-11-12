const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const { JSDOM } = require('jsdom');
const { servicesLayoutPreview, names } = require('./helpers/services-layout-preview.cjs');

for (const editing of [false, true]) test('compact services retain full names, price, duration and actions; editing=' + editing, () => {
  const w = new JSDOM(servicesLayoutPreview(editing)).window;
  try {
    const cards = [...w.document.querySelectorAll(editing ? '.service-edit-card' : '.service-select-card')];
    assert.equal(cards.length, names.length);
    cards.forEach((card, index) => {
      assert.equal(card.querySelector('.service-row-main>strong').textContent, names[index]);
      assert.match(card.textContent, /60 минут/);
      assert.match(card.textContent, /1\s500 ₽/);
      assert.ok(editing ? card.querySelector('[data-edit-service]') : card.matches('[data-select-service]'));
    });
  } finally { w.close(); }
});

test('service cards have compact flexible height and unclipped titles, keeping single-column mobile layout', () => {
  const css = postcss.parse(fs.readFileSync(path.resolve(__dirname, '../src/client/styles/services.css'), 'utf8'));
  const rules = [];
  css.walkRules((rule) => rules.push(rule));
  const value = (rule, prop) => rule.nodes.find((node) => node.prop === prop)?.value;
  const card = rules.find((rule) => rule.selector === '.service-catalog-modern .service-select-card,.service-catalog-modern .service-edit-card');
  assert.equal(value(card, 'height'), 'auto');
  assert.equal(value(card, 'min-height'), '76px');
  const title = rules.find((rule) => rule.selector === '.service-row-main>strong');
  assert.equal(value(title, 'display'), 'block');
  assert.equal(value(title, '-webkit-line-clamp'), undefined);
  assert.equal(value(title, 'overflow'), undefined);
  assert.ok(rules.some((rule) => rule.parent.name === 'media' && rule.selector === '.service-catalog-modern .service-category-content' && value(rule, 'grid-template-columns') === 'minmax(0,1fr)'));
});
