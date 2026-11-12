const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const postcss = require('postcss');
const { checkStyles, compactStyles } = require('../scripts/check-styles.cjs');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
function declarations(source) {
  const values = [];
  postcss.parse(source).walkDecls((declaration) => {
    const scope = [];
    for (let node = declaration.parent; node.type !== 'root'; node = node.parent)
      scope.unshift(node.type === 'rule' ? node.selector : '@' + node.name + ' ' + node.params);
    values.push([scope, declaration.prop, declaration.value, !!declaration.important]);
  });
  return values;
}

test('compact build keeps all authored CSS semantics and special token boundaries', () => {
  const semantic = (source) =>
    JSON.parse(
      JSON.stringify(postcss.parse(source).toJSON(), (key, value) =>
        ['raws', 'source', 'inputs', 'lastEach', 'indexes'].includes(key) ? undefined : value,
      ),
    );
  const manifest = require('../src/client/manifest.json');
  const authored = manifest.styles.map(read).join('');
  const special = [
    `
    /* Keep source comments. */
    @supports (display: grid) {
      @media screen and (min-width: 600px) {
        .sample::before {
          --words: "a : b ; { }";
          content: var(--words);
          background: url("data:image/svg+xml,<svg> </svg>");
          color: red /* inline token comment */ !important;
        }
      }
    }
  `,
    String.raw`.escaped\;\{name\} { content: "keep; { } \\\""; color: red; }
      .hex\7d name { color: blue; }`,
    String.raw`.custom { --payload: { first: "a; }"; nested: { other: (x;y); }; };
      --empty: ; --escaped\3a name: { nested: { keep: yes; }; }; color: var(--empty); }`,
    String.raw`.urls { background: url(data:image/svg+xml;utf8,<svg>{x}</svg>);
      mask: url(https://example.test/a/*marker); background-image: u\72l(data:a\)b); }`,
    String.raw`[data-value="a;{ }"] [data-other='b'] { content: "keep \\"; }
      @media (width >= 1px) { .nested { width: calc(1px + var(--x, 2px)); } }`,
    '.plain {}\n\u00a0.identifier { color: red; }\n@supports (display: grid) { .other { color: blue; } }',
  ];
  for (const source of [authored, ...special]) {
    const built = compactStyles(source);
    assert.deepEqual(semantic(built), semantic(source));
    assert.ok(Buffer.byteLength(built) < Buffer.byteLength(source));
  }
});
test('every style source parses independently and split media retains its exact cascade', () => {
  const manifest = require('../src/client/manifest.json');
  assert.equal(checkStyles(root, manifest), manifest.styles.length);
  const calendar = read('src/client/styles/calendar-mobile.css'),
    services = read('src/client/styles/services-layout.css');
  const merged = postcss.parse(calendar),
    serviceTree = postcss.parse(services);
  const calendarMedia = merged.nodes.at(-1),
    serviceMedia = serviceTree.nodes[0];
  assert.equal(calendarMedia.type, 'atrule');
  assert.equal(calendarMedia.name, 'media');
  assert.equal(serviceMedia.name, 'media');
  assert.equal(calendarMedia.params, serviceMedia.params);
  calendarMedia.append(serviceMedia.nodes.map((node) => node.clone()));
  merged.append(serviceTree.nodes.slice(1).map((node) => node.clone()));
  assert.deepEqual(declarations(calendar + services), declarations(merged.toString()));
});
test('standalone validation rejects cross-file braces even if their concatenation is valid', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-style-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'first.css'), '@media(max-width:700px){.sample{color:red}');
  fs.writeFileSync(path.join(directory, 'last.css'), '.second{color:blue}}');
  assert.doesNotThrow(() =>
    postcss.parse(
      fs.readFileSync(path.join(directory, 'first.css'), 'utf8') +
        fs.readFileSync(path.join(directory, 'last.css'), 'utf8'),
    ),
  );
  assert.throws(
    () => checkStyles(directory, { styles: ['first.css', 'last.css'] }),
    /Unclosed block/,
  );
});

test('calendar separates working, closed and unset dates without coloring unknown weekends', () => {
  const rules = new Map();
  postcss.parse(read('src/client/styles/work-schedules.css')).walkRules((rule) => {
    const background = rule.nodes.find((node) => node.prop === 'background');
    if (background) rules.set(rule.selector, background.value);
  });
  const dates = '.calendar-panel :is(.month-day,.overview-day,.date-chip)';
  assert.equal(rules.get(dates + '.calendar-day-working:not(.selected)'), '#e8f3ec');
  assert.equal(rules.get(dates + '.calendar-day-closed:not(.selected)'), '#e4e7eb');
  assert.equal(rules.get(dates + '.calendar-day-unset:not(.selected)'), '#fff');
  assert.equal(rules.get('.calendar-panel .time-day-heading.calendar-day-unset'), '#fff');
  assert.equal(rules.get('.work-day'), '#fff');
});

test('online booking actions have touch-sized targets and responsive scoped layouts', () => {
  const css = postcss.parse(read('src/client/styles/online-booking.css'));
  const sameSelector = (a, b) => a?.replace(/\s+/g, '') === b.replace(/\s+/g, '');
  const rule = (selector) =>
    css.nodes.find((node) => node.type === 'rule' && sameSelector(node.selector, selector));
  const value = (node, prop) => node.nodes.find((item) => item.prop === prop)?.value;
  const actions = rule(
    ':is(#online-booking-settings, #booking-requests-panel) :is(button, .staff-telegram-open)',
  );
  assert.equal(value(actions, 'min-height'), '47px');
  assert.equal(value(actions, 'max-width'), '100%');
  assert.equal(value(actions, 'white-space'), 'normal');
  assert.ok(
    rule(
      ':is(#online-booking-settings, #booking-requests-panel) :is(button, .staff-telegram-open):focus-visible',
    ),
  );
  const mobile = css.nodes.find(
    (node) => node.type === 'atrule' && node.params === '(max-width: 600px)',
  );
  const columns = (selector) =>
    value(
      mobile.nodes.find((node) => sameSelector(node.selector, selector)),
      'grid-template-columns',
    );
  assert.equal(
    columns(
      ':is(#online-booking-settings, #booking-requests-panel) :is(.booking-request-actions, .staff-notification-actions)',
    ),
    '1fr',
  );
  assert.equal(
    columns('#online-booking-settings .booking-link-actions'),
    'repeat(2, minmax(0, 1fr))',
  );
});
