const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { checkLayout } = require('./browser/appearance.cjs');
function page({
  open = false,
  closeLeft = 220,
  optionTop = 120,
  sheetLeft = 30,
  ordinaryLeft = 40,
} = {}) {
  const dom = new JSDOM(
    `<dialog id="editor" open><input id="ordinary"><details id="appointment-service" data-service-window ${open ? 'open' : ''}><summary>Services</summary><div class="appointment-service-menu"><button id="close">×</button><div id="appointment-service-groups" style="overflow-y:auto"><button id="option">Long service</button></div></div></details></dialog>`,
    { runScripts: 'outside-only' },
  );
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', { value: 320 });
  Object.defineProperty(window, 'innerHeight', { value: 600 });
  Object.defineProperty(window.document.documentElement, 'scrollWidth', { value: 320 });
  const set = (selector, left, top, width, height) => {
    const element = window.document.querySelector(selector),
      box = { left, top, right: left + width, bottom: top + height, width, height };
    element.getBoundingClientRect = () => box;
    element.getClientRects = () => [box];
    element.checkVisibility = undefined;
  };
  set('#editor', 20, 20, 280, 500);
  set('#ordinary', ordinaryLeft, 40, 100, 30);
  set('summary', 40, 80, 200, 30);
  set('.appointment-service-menu', sheetLeft, 60, 260, 400);
  set('#close', closeLeft, 70, 44, 44);
  set('#appointment-service-groups', 40, 120, 240, 300);
  set('#option', 40, optionTop, 240, 44);
  return { dom, evaluate: async (fn, arg) => window.eval('(' + fn.toString() + ')')(arg) };
}
test('closed details layout rectangles are hidden while ordinary editor controls remain bounded', async () => {
  const target = page({ closeLeft: 700, optionTop: 900 });
  try {
    await checkLayout(target, '#editor');
  } finally {
    target.dom.window.close();
  }
  const overflow = page({ closeLeft: 700, ordinaryLeft: 290 });
  try {
    await assert.rejects(() => checkLayout(overflow, '#editor'), /Control overflow: ordinary/);
  } finally {
    overflow.dom.window.close();
  }
});
test('open service sheet must remain in the viewport and contain its own visible controls', async () => {
  for (const options of [
    { open: true, closeLeft: 280 },
    { open: true, sheetLeft: -10 },
  ]) {
    const target = page(options);
    try {
      await assert.rejects(
        () => checkLayout(target, '#editor'),
        /Control overflow: close|Service window outside/,
      );
    } finally {
      target.dom.window.close();
    }
  }
});
test('open scrolling service options may extend below their own scrollport without hiding a header overflow', async () => {
  const target = page({ open: true, optionTop: 900 });
  try {
    await checkLayout(target, '#editor');
  } finally {
    target.dom.window.close();
  }
  const overflow = page({ open: true, optionTop: 900, closeLeft: 280 });
  try {
    await assert.rejects(() => checkLayout(overflow, '#editor'), /Control overflow: close/);
  } finally {
    overflow.dom.window.close();
  }
});
