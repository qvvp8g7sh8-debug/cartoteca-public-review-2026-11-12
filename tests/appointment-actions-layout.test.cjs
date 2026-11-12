const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const { JSDOM } = require('jsdom');
const { appointmentActionsPreview } = require('./helpers/appointment-actions-preview.cjs');

for (const mode of ['card', 'editor']) {
  for (const past of [false, true]) {
    test(`${mode} keeps confirmation/outcome actions inside their layout groups (${past ? 'past' : 'future'})`, () => {
      const w = new JSDOM(appointmentActionsPreview(mode, past)).window;
      try {
        const group = w.document.querySelector(
          mode === 'card' ? '.telegram-strip-tools' : '#form-content',
        );
        assert.ok(group.querySelector('[data-complete-appointment]'));
        assert.ok(group.querySelector('[data-appointment-outcome="cancelled"]'));
        assert.equal(Boolean(group.querySelector('[data-appointment-outcome="no_show"]')), past);
        if (!past) assert.ok(group.querySelector('[data-manual-confirm]'));
        assert.ok(
          group.querySelector(
            mode === 'card' ? '.telegram-service-menu' : '[data-delete-appointment-action]',
          ),
        );
        if (mode === 'editor') {
          assert.equal(group.querySelector('details:not([data-notification-history])'), null);
          assert.equal(group.querySelector('[data-notification-history]').open, false);
        }
      } finally {
        w.close();
      }
    });
  }
}

test('responsive action grids depend on available card width, and controls can wrap without overflow', () => {
  const css = postcss.parse(
    fs.readFileSync(path.resolve(__dirname, '../src/client/styles/workspace.css'), 'utf8'),
  );
  const rules = [];
  css.walkRules((rule) => rules.push(rule));
  const declaration = (rule, prop) => rule.nodes.find((node) => node.prop === prop)?.value;
  const tools = rules.find(
    (r) => r.selector === '.unified-appointments .unified-appointment-row .telegram-strip-tools',
  );
  assert.equal(tools.parent.name, 'container');
  assert.equal(tools.parent.params, '(max-width:900px)');
  assert.equal(declaration(tools, 'grid-template-columns'), 'repeat(2,minmax(0,1fr))');
  const buttons = rules.find((r) => r.selector.endsWith('.telegram-strip-tools>button'));
  // The container-scoped rule, not the previous legacy flex rule.
  const responsiveButtons = rules.find(
    (r) => r.parent.name === 'container' && r.selector.endsWith('.telegram-strip-tools>button'),
  );
  assert.ok(buttons);
  assert.equal(declaration(responsiveButtons, 'white-space'), 'normal');
  assert.equal(declaration(responsiveButtons, 'min-height'), '44px');
  const inspector = postcss.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../src/client/styles/appointment-actions.css'),
      'utf8',
    ),
  );
  const inspectorRules = [];
  inspector.walkRules((rule) => inspectorRules.push(rule));
  assert.ok(
    inspectorRules.some(
      (r) =>
        r.selector === '.appointment-action-options' &&
        declaration(r, 'grid-template-columns') === 'repeat(2, minmax(0, 1fr))',
    ),
  );
  assert.ok(
    inspectorRules.some(
      (r) =>
        r.selector === '.appointment-action-outcomes' && declaration(r, 'flex-wrap') === 'wrap',
    ),
  );
});
