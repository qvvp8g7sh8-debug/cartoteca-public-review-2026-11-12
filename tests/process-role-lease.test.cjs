const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createPlatformStore } = require('../src/server/application/platform.cjs');

test('encrypted role registry excludes mixed and duplicate background processes across connections and fences stale leases', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-process-roles-synthetic-'));
  const first = createPlatformStore(directory);
  const second = createPlatformStore(directory);
  const a = randomUUID(),
    b = randomUUID(),
    c = randomUUID(),
    now = Date.now();
  try {
    const ta = first.processRoles.acquire('combined', a, now);
    const tb = second.processRoles.acquire('combined', b, now);
    assert.throws(() => second.processRoles.acquire('background', c, now), { status: 503 });
    first.processRoles.release(a, ta);
    assert.throws(() => second.processRoles.acquire('background', c, now), { status: 503 });
    second.processRoles.release(b, tb);
    const tc = second.processRoles.acquire('background', c, now);
    assert.throws(() => first.processRoles.acquire('background', a, now), { status: 503 });
    assert.throws(() => first.processRoles.acquire('combined', a, now), { status: 503 });
    second.processRoles.release(c, 'stale-token');
    assert.equal(first.processRoles.renew(c, tc, now + 1), true);
    const next = first.processRoles.acquire('background', c, now + 60002);
    assert.notEqual(next, tc);
    assert.equal(second.processRoles.renew(c, tc, now + 60003), false);
    second.processRoles.release(c, tc);
    assert.equal(first.processRoles.renew(c, next, now + 60003), true);
    assert.throws(() => first.processRoles.acquire('combined', a, now + 60003), { status: 503 });
    first.processRoles.release(c, next);
    const recovered = second.processRoles.acquire('combined', a, now + 60004);
    assert.equal(first.processRoles.renew(a, recovered, now + 60005), true);
    second.processRoles.release(a, recovered);
  } finally {
    first.close();
    second.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cartoteca-process-roles-synthetic-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
