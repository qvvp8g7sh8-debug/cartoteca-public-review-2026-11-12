const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { adminLayout } = require('./browser/appearance.cjs');

// A geometry model exercises the real oracle. It does not claim real CSS,
// keyboard, touch or browser-engine coverage; the scoped browser run does that.
function fixture(t, options = {}) {
  const tag = options.navTag || 'nav';
  const dom = new JSDOM(
    '<body class="' +
      (options.adminPage === false ? '' : 'admin-page') +
      '">' +
      '<main id="panel"><' +
      tag +
      ' class="admin-tabs" style="overflow-x:' +
      (options.overflowX || 'auto') +
      '"><div>' +
      ['overview', 'organizations', 'accounts', 'support', 'voice-assistant', 'system', 'audit']
        .map(
          (id) =>
            '<button type="button" data-admin-view="' + id + '"><span>' + id + '</span></button>',
        )
        .join('') +
      '</div></' +
      tag +
      '><form><input id="ordinary"><button id="save">Save</button></form></main>',
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://synthetic.test/' },
  );
  const w = dom.window,
    d = w.document;
  t.after(() => w.close());
  const width = options.width || 390,
    height = 500;
  Object.defineProperties(w, {
    innerWidth: { value: width, configurable: true },
    innerHeight: { value: height, configurable: true },
  });
  const nav = d.querySelector('.admin-tabs'),
    panel = d.querySelector('#panel');
  const buttons = [...nav.querySelectorAll('button')];
  const group = nav.firstElementChild;
  const owners = [d.documentElement, d.body, panel, nav, group, ...buttons];
  const positions = new Map(owners.map((node) => [node, { left: 0, top: 0 }]));
  const windowPosition = { x: 0, y: options.windowY ?? 240 };
  positions.get(d.documentElement).top = windowPosition.y;
  positions.get(d.body).top = 11;
  positions.get(panel).top = 23;
  positions.get(nav).left = options.initialNavScroll ?? 45;
  positions.get(group).left = 7;
  positions.get(group).top = 3;
  const calls = { scroll: [], hit: [], focus: 0, click: 0, bind: 0 };
  const clientWidth = options.clientWidth || width - 32;
  const widths = buttons.map((_, index) =>
    options.oversized && index === 0 ? clientWidth + 40 : 140,
  );
  const offsets = widths.map((_, index) =>
    widths.slice(0, index).reduce((sum, value) => sum + value + 4, 0),
  );
  const contentWidth = widths.reduce((sum, value) => sum + value + 4, -4);
  Object.defineProperties(nav, {
    clientLeft: { value: 0, configurable: true },
    clientWidth: { value: clientWidth, configurable: true },
    scrollWidth: { value: contentWidth, configurable: true },
  });
  Object.defineProperty(d, 'scrollingElement', { value: d.documentElement, configurable: true });
  Object.defineProperty(d.documentElement, 'scrollWidth', {
    value: options.bodyOverflow ? width + 30 : width,
    configurable: true,
  });
  for (const [node, position] of positions) {
    Object.defineProperties(node, {
      scrollLeft: {
        get: () => position.left,
        set: (value) => {
          position.left = value;
        },
        configurable: true,
      },
      scrollTop: {
        get: () => position.top,
        set: (value) => {
          position.top = value;
        },
        configurable: true,
      },
    });
    node.scrollTo = (left, top) => {
      position.left = left;
      position.top = top;
    };
  }
  Object.defineProperties(w, {
    scrollX: { get: () => windowPosition.x, configurable: true },
    scrollY: { get: () => windowPosition.y, configurable: true },
  });
  w.scrollTo = (x, y) => {
    windowPosition.x = x;
    windowPosition.y = y;
    positions.get(d.documentElement).left = x;
    positions.get(d.documentElement).top = y;
  };
  w.requestAnimationFrame = (callback) => {
    queueMicrotask(() => callback(0));
    return 1;
  };
  const rect = (left, top, boxWidth, boxHeight) => ({
    x: left,
    y: top,
    left,
    top,
    right: left + boxWidth,
    bottom: top + boxHeight,
    width: boxWidth,
    height: boxHeight,
  });
  const navTop = () => 180 - windowPosition.y - panel.scrollTop - d.body.scrollTop;
  nav.getBoundingClientRect = () => rect(options.navLeft ?? 16, navTop(), clientWidth, 56);
  for (const [index, button] of buttons.entries()) {
    button.getBoundingClientRect = () =>
      rect(
        nav.getBoundingClientRect().left + offsets[index] - nav.scrollLeft,
        navTop() + 4,
        widths[index],
        40,
      );
    button.scrollIntoView = () => {
      calls.scroll.push(button.dataset.adminView);
      group.scrollLeft = 0;
      group.scrollTop = 0;
      // Generic nearest-scroll model: move the horizontal strip and both outer
      // vertical owners. The test asserts every owner is restored afterwards.
      const box = button.getBoundingClientRect(),
        frame = nav.getBoundingClientRect();
      if (!options.refuseScroll) {
        if (box.left < frame.left) nav.scrollLeft -= frame.left - box.left;
        else if (box.right > frame.right) nav.scrollLeft += box.right - frame.right;
        nav.scrollLeft = Math.max(0, Math.min(contentWidth - clientWidth, nav.scrollLeft));
      }
      panel.scrollTop = 0;
      d.body.scrollTop = 0;
      w.scrollTo(0, 160);
    };
    button.focus = () => {
      calls.focus++;
    };
    button.click = () => {
      calls.click++;
    };
    button.addEventListener = () => {
      calls.bind++;
    };
  }
  d.querySelector('#ordinary').getBoundingClientRect = () =>
    rect(options.outsideControl ? width + 5 : 20, 90, 120, 35);
  d.querySelector('#save').getBoundingClientRect = () => rect(20, 140, 100, 35);
  if (options.nonNavControl) {
    const input = d.createElement('input');
    input.id = 'unidentified-nav-control';
    nav.append(input);
    input.getBoundingClientRect = () => rect(width + 5, 20, 100, 30);
  }
  const overlay = d.createElement('div');
  d.body.append(overlay);
  d.elementFromPoint = (x, y) => {
    calls.hit.push({ x, y });
    if (options.hitThrows) throw Error('Synthetic hit-test failure');
    if (options.overlay) return overlay;
    if (options.hidden) return null;
    const frame = nav.getBoundingClientRect();
    if (
      x < 0 ||
      x >= width ||
      y < 0 ||
      y >= height ||
      x < frame.left ||
      x >= frame.right ||
      y < frame.top ||
      y >= frame.bottom
    )
      return null;
    const button = buttons.find((candidate) => {
      const box = candidate.getBoundingClientRect();
      return x >= box.left && x < box.right && y >= box.top && y < box.bottom;
    });
    return button?.firstElementChild || null;
  };
  const snapshot = () => ({
    x: w.scrollX,
    y: w.scrollY,
    owners: owners.map((node) => ({ left: node.scrollLeft, top: node.scrollTop })),
    focused: d.activeElement,
  });
  const before = snapshot();
  const page = {
    evaluate: async (callback) => {
      // Match browser serialization instead of leaking cross-realm Array prototypes.
      const value = await w.eval('(' + callback.toString() + ')()');
      return JSON.parse(JSON.stringify(value));
    },
  };
  return { page, calls, buttons, before, snapshot };
}

for (const width of [320, 390, 412]) {
  test(
    'mobile admin strip proves every button reachable at ' +
      width +
      'px and restores all scroll owners',
    async (t) => {
      const f = fixture(t, { width });
      await adminLayout(f.page);
      assert.deepEqual(
        f.calls.scroll,
        f.buttons.map((button) => button.dataset.adminView),
      );
      assert.equal(f.calls.hit.length, 7);
      assert.deepEqual(f.snapshot(), f.before);
      assert.equal(f.calls.focus + f.calls.click + f.calls.bind, 0);
    },
  );
}

for (const [label, options, message] of [
  ['ordinary form overflow', { outsideControl: true }, /Form controls overflow/],
  ['non-button control inside the nav', { nonNavControl: true }, /Form controls overflow/],
  ['hidden clipping is not a scroll exception', { overflowX: 'hidden' }, /Form controls overflow/],
  ['clip is not a scroll exception', { overflowX: 'clip' }, /Form controls overflow/],
  ['desktop has no mobile exception', { width: 900 }, /Form controls overflow/],
  ['matching class on a non-nav element', { navTag: 'div' }, /Form controls overflow/],
  ['matching nav outside admin page', { adminPage: false }, /Form controls overflow/],
  ['document overflow remains strict', { bodyOverflow: true }, /Horizontal page overflow/],
  ['button wider than the nav aperture', { oversized: true }, /Admin navigation overflow/],
  ['nav viewport itself is out of bounds', { navLeft: -20 }, /Admin navigation overflow/],
  ['scroller cannot reveal the whole target', { refuseScroll: true }, /Admin navigation overflow/],
  ['overlay blocks the scrolled target', { overlay: true }, /Admin navigation is unreachable/],
  ['non-hittable target is not accepted', { hidden: true }, /Admin navigation is unreachable/],
]) {
  test('admin layout still rejects ' + label, async (t) => {
    const f = fixture(t, options);
    await assert.rejects(adminLayout(f.page), message);
    assert.deepEqual(f.snapshot(), f.before);
    assert.equal(f.calls.focus + f.calls.click + f.calls.bind, 0);
  });
}

test('scroll owners are restored even when the real hit-test evaluation throws', async (t) => {
  const f = fixture(t, { hitThrows: true });
  await assert.rejects(adminLayout(f.page), /Synthetic hit-test failure/);
  assert.ok(f.calls.scroll.length > 0);
  assert.deepEqual(f.snapshot(), f.before);
  assert.equal(f.calls.focus + f.calls.click + f.calls.bind, 0);
});
