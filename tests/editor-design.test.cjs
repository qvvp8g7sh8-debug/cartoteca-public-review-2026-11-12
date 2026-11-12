const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const postcss = require('postcss');
const source = fs.readFileSync(path.join(__dirname, '../src/client/core/editor.js'), 'utf8');

for (const kind of ['patient', 'appointment', 'visit', 'service', 'workSchedule'])
  test('bounded editor presentation preserves fields and mode for ' + kind, (t) => {
    const w = new JSDOM(
      '<dialog id="editor"><form id="editor-form"><div class="dialog-heading"><h2 id="dialog-title">Форма</h2></div><div id="form-content"><input name="draft" value="Несохранённое"><input type="hidden" name="service" value="snapshot"></div><p id="form-error"></p><div class="dialog-actions"><button id="save-editor">Сохранить</button></div></form></dialog>',
      { runScripts: 'outside-only' },
    ).window;
    t.after(() => w.close());
    w.eval(source);
    const state = { multiUser: true, editorMode: { kind }, uploadItems: [] };
    const actions = {
      $: (selector) => w.document.querySelector(selector),
      cancelPhotoProcessing() {},
      mountServiceGroupControl() {},
      renderSaveRecovery() {},
      updatePhotoSaveButton() {},
    };
    const dialog = actions.$('#editor');
    dialog.showModal = () => {
      dialog.open = true;
    };
    const editor = w.eval('createEditor')(state, actions);
    editor.openDialog();
    assert.equal(dialog.open, true);
    assert.equal(dialog.classList.contains('editor-designed'), true);
    assert.equal(dialog.dataset.editorKind, kind);
    assert.equal(dialog.getAttribute('aria-labelledby'), 'dialog-title');
    assert.equal(actions.$('[name="draft"]').value, 'Несохранённое');
    assert.equal(actions.$('[name="service"]').value, 'snapshot');
    assert.equal(state.editorMode.kind, kind);
    state.multiUser = false;
    editor.openDialog();
    assert.equal(dialog.classList.contains('editor-designed'), false);
  });

test('editor design is screen-only, scoped, bounded, and leaves invalid-state colors intact', () => {
  const sheet = postcss.parse(
    fs.readFileSync(path.join(__dirname, '../src/client/styles/editor-design.css'), 'utf8'),
  );
  sheet.walkRules((rule) => {
    assert.match(rule.selector, /#editor\.editor-designed/);
    let root = rule;
    while (root.parent?.type !== 'root') root = root.parent;
    assert.equal(root.type, 'atrule');
    assert.equal(root.params, 'screen');
  });
  const declarations = (selector) => {
    let result;
    sheet.walkRules(selector, (rule) => {
      if (!result)
        result = Object.fromEntries(
          rule.nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]),
        );
    });
    return result;
  };
  assert.equal(declarations('#editor.editor-designed #form-content').overflow, 'auto');
  assert.equal(declarations('#editor.editor-designed .dialog-actions').position, 'static');
  assert.equal(
    declarations("#editor.editor-designed :is([hidden], input[type='hidden'])").display,
    'none',
  );
  sheet.walkDecls('border-color', () => assert.fail('Do not override invalid input colors'));
});
