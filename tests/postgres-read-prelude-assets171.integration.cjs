const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { preludeFixture171, bounded169 } = require('./helpers/postgres-read-prelude171-fixture.cjs');

test(
  '171 false stamp hint cannot upgrade to an appearing body without checking cabinet assets',
  { timeout: 180000 },
  async (t) => {
    const f = await preludeFixture171(t);
    let k,
      moved = false,
      releaseAsset = () => {},
      resultGate,
      mock;
    const key = path.join(f.dir, 'encryption.key'),
      backup = path.join(f.dir, 'temporary171-cabinet-key');
    const digest = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    const originalKey = digest(key);
    try {
      k = await f.make();
      await f.warm(k);
      f.bumpSummary(17177);
      k.clear();
      resultGate = k.arm('result');
      const first = f.raw(k);
      await bounded169(resultGate.entered);
      let signal,
        held = false,
        cabinetChecks = 0;
      const enteredAsset = new Promise((resolve) => {
        signal = resolve;
      });
      const waitAsset = new Promise((resolve) => {
        releaseAsset = resolve;
      });
      const original = fs.promises.lstat.bind(fs.promises);
      mock = t.mock.method(fs.promises, 'lstat', async (p, ...args) => {
        if (path.resolve(String(p)) === key) cabinetChecks++;
        const value = await original(p, ...args);
        if (!held && path.resolve(String(p)) === path.join(f.dir, 'platform/platform.key')) {
          held = true;
          signal();
          await waitAsset;
        }
        return value;
      });
      resultGate.release();
      await bounded169(enteredAsset);
      assert.equal(cabinetChecks, 0, 'false hint defers Casset check to the ordinary RR');
      const second = await f.raw(k);
      assert.equal(second.status, 200);
      assert.equal(second.body.directory.find((p) => p.id === 'patient').visitCount, 17177);
      assert.ok(k.operations.viewStats().directoryResponses165.entries > 0);
      assert.ok(cabinetChecks > 0, 'second acknowledged producer checked its Casset');
      const afterSecond = k.trace.length,
        checkedBySecond = cabinetChecks;
      // This is a real rename of a temporary synthetic key, deliberately changing
      // file/directory stamps. We restore the exact key bytes, not their old ctime.
      assert.equal(path.resolve(key), path.join(path.resolve(f.dir), 'encryption.key'));
      assert.equal(path.dirname(backup), path.resolve(f.dir));
      assert.equal(fs.lstatSync(key).isFile(), true);
      assert.equal(fs.lstatSync(key).isSymbolicLink(), false);
      assert.equal(fs.existsSync(backup), false);
      fs.renameSync(key, backup);
      moved = true;
      releaseAsset();
      const denied = await first;
      assert.equal(denied.status, 503);
      assert.equal(denied.body.directory, undefined);
      assert.ok(
        cabinetChecks > checkedBySecond,
        'first request makes its own mandatory Casset check',
      );
      const remaining = k.trace.slice(afterSecond).map((r) => r.text);
      assert.ok(remaining.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
      assert.equal(
        remaining.some((text) => /\bcartoteca_cabinet\./.test(text)),
        false,
        'missing Ckey is rejected before clinical source fetch',
      );
    } finally {
      releaseAsset();
      resultGate?.release();
      mock?.mock.restore();
      if (moved) {
        assert.equal(fs.existsSync(key), false);
        fs.renameSync(backup, key);
        moved = false;
      }
      assert.equal(digest(key), originalKey);
      await k?.close();
      await f.close();
    }
  },
);
