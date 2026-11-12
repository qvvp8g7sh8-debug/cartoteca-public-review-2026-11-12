const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function fixture(t, desktop = true) {
  const w = new JSDOM(
    '<dialog id="editor"><div class="dialog-heading"><h2>Запись</h2><button>Закрыть</button></div><input value="Черновик"><h3 id="section">Контакты</h3></dialog>',
    { runScripts: 'outside-only' },
  ).window;
  t.after(() => w.close());
  w.innerWidth = 1000;
  w.innerHeight = 800;
  let mediaChange;
  const media = {
    matches: desktop,
    addEventListener(type, listener) {
      assert.equal(type, 'change');
      mediaChange = listener;
    },
  };
  w.matchMedia = (query) => {
    assert.equal(query, '(min-width: 701px) and (pointer: fine)');
    return media;
  };
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new w.Event('close'));
  };
  const $ = (selector) => w.document.querySelector(selector);
  function geometry(dialog, left = 200, top = 150, width = 400, height = 300) {
    dialog.getBoundingClientRect = () => {
      const x = parseFloat(dialog.style.getPropertyValue('--dialog-offset-x')) || 0;
      const y = parseFloat(dialog.style.getPropertyValue('--dialog-offset-y')) || 0;
      return { left: left + x, top: top + y, width, height };
    };
  }
  function pointer(target, type, x, y, options = {}) {
    const event = new w.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: options.button || 0,
    });
    Object.defineProperties(event, {
      pointerId: { value: options.pointerId || 1 },
      pointerType: { value: options.pointerType || 'mouse' },
    });
    target.dispatchEvent(event);
    return event;
  }
  w.eval(
    fs.readFileSync(path.join(__dirname, '../src/client/core/dialog-interactions.js'), 'utf8'),
  );
  w.createDialogInteractions().bindDialogInteractionEvents();
  geometry($('#editor'));
  $('#editor').showModal();
  return {
    w,
    $,
    geometry,
    pointer,
    mobile() {
      media.matches = false;
      mediaChange();
    },
  };
}

test('desktop header moves dialog, keeps draft and ends capture on release', (t) => {
  const f = fixture(t);
  const heading = f.$('.dialog-heading');
  let captured = false;
  heading.setPointerCapture = () => {
    captured = true;
  };
  heading.hasPointerCapture = () => captured;
  heading.releasePointerCapture = () => {
    captured = false;
  };
  assert.equal(f.pointer(heading, 'pointerdown', 230, 170).defaultPrevented, true);
  assert.equal(captured, true);
  f.pointer(f.w.document, 'pointermove', 330, 210);
  assert.equal(f.$('#editor').style.getPropertyValue('--dialog-offset-x'), '100px');
  assert.equal(f.$('#editor').style.getPropertyValue('--dialog-offset-y'), '40px');
  assert.equal(f.$('input').value, 'Черновик');
  f.pointer(f.w.document, 'pointerup', 330, 210);
  assert.equal(captured, false);
  f.pointer(f.w.document, 'pointermove', 440, 240);
  assert.equal(f.$('#editor').style.getPropertyValue('--dialog-offset-x'), '100px');
});

test('viewport limits and resize keep dialog accessible, mobile resets desktop position', (t) => {
  const f = fixture(t);
  f.pointer(f.$('h2'), 'pointerdown', 230, 170);
  f.pointer(f.w.document, 'pointermove', 3000, 3000);
  assert.deepEqual(f.$('#editor').getBoundingClientRect(), {
    left: 592,
    top: 492,
    width: 400,
    height: 300,
  });
  f.w.innerWidth = 800;
  f.w.innerHeight = 600;
  f.w.dispatchEvent(new f.w.Event('resize'));
  assert.deepEqual(f.$('#editor').getBoundingClientRect(), {
    left: 392,
    top: 292,
    width: 400,
    height: 300,
  });
  f.mobile();
  assert.equal(f.$('#editor').classList.contains('dialog-positioned'), false);
  assert.equal(f.$('#editor').style.getPropertyValue('--dialog-offset-x'), '');
  f.pointer(f.$('h2'), 'pointerdown', 230, 170);
  f.pointer(f.w.document, 'pointermove', 400, 250);
  assert.equal(f.$('#editor').classList.contains('dialog-positioned'), false);
});

test('only newly opened top dialog moves, underlying draft and position survive', (t) => {
  const f = fixture(t);
  f.pointer(f.$('h2'), 'pointerdown', 230, 170);
  f.pointer(f.w.document, 'pointermove', 260, 190);
  f.pointer(f.w.document, 'pointerup', 260, 190);
  const nested = f.w.document.createElement('dialog');
  nested.innerHTML = '<h3>Подтверждение</h3><button>Отмена</button>';
  f.w.document.body.append(nested);
  f.geometry(nested, 300, 200, 240, 180);
  nested.showModal();
  f.pointer(f.$('h2'), 'pointerdown', 260, 190);
  f.pointer(f.w.document, 'pointermove', 360, 290);
  assert.equal(f.$('#editor').style.getPropertyValue('--dialog-offset-x'), '30px');
  f.pointer(nested.querySelector('h3'), 'pointerdown', 310, 210);
  f.pointer(f.w.document, 'pointermove', 390, 260);
  assert.equal(nested.style.getPropertyValue('--dialog-offset-x'), '80px');
  assert.equal(nested.getAttribute('closedby'), 'closerequest');
  nested.close();
  assert.equal(nested.style.getPropertyValue('--dialog-offset-x'), '');
  assert.equal(f.$('input').value, 'Черновик');
  f.pointer(f.$('h2'), 'pointerdown', 260, 190);
  f.pointer(f.w.document, 'pointermove', 270, 190);
  assert.equal(f.$('#editor').style.getPropertyValue('--dialog-offset-x'), '40px');
});

test('controls, body headings, touch, wrong pointer and secondary mouse do not drag', (t) => {
  const f = fixture(t);
  for (const [target, options] of [
    [f.$('button'), {}],
    [f.$('input'), {}],
    [f.$('#section'), {}],
    [f.$('h2'), { pointerType: 'touch' }],
    [f.$('h2'), { button: 2 }],
  ]) {
    assert.equal(f.pointer(target, 'pointerdown', 230, 170, options).defaultPrevented, false);
    f.pointer(f.w.document, 'pointermove', 350, 250, options);
    assert.equal(f.$('#editor').classList.contains('dialog-positioned'), false);
  }
  f.pointer(f.$('h2'), 'pointerdown', 230, 170);
  f.pointer(f.w.document, 'pointermove', 350, 250, { pointerId: 2 });
  assert.equal(f.$('#editor').classList.contains('dialog-positioned'), false);
  f.pointer(f.w.document, 'pointercancel', 230, 170);
  f.pointer(f.w.document, 'pointermove', 350, 250);
  assert.equal(f.$('#editor').classList.contains('dialog-positioned'), false);
});

test('closing and reopening centers dialog; mobile never acquires a drag', (t) => {
  const f = fixture(t);
  f.pointer(f.$('h2'), 'pointerdown', 230, 170);
  f.pointer(f.w.document, 'pointermove', -3000, -3000);
  assert.equal(f.$('#editor').getBoundingClientRect().left, 8);
  assert.equal(f.$('#editor').getBoundingClientRect().top, 8);
  f.$('#editor').close();
  f.$('#editor').showModal();
  f.pointer(f.w.document, 'pointermove', 500, 500);
  assert.equal(f.$('#editor').classList.contains('dialog-positioned'), false);
  const mobile = fixture(t, false);
  mobile.pointer(mobile.$('h2'), 'pointerdown', 230, 170);
  mobile.pointer(mobile.w.document, 'pointermove', 400, 250);
  assert.equal(mobile.$('#editor').classList.contains('dialog-positioned'), false);
});
