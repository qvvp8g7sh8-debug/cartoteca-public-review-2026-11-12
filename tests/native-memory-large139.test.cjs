const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const {
  createNativeMemoryBudget,
  nativeMemoryProcess,
} = require('../src/server/infrastructure/native-memory-budget.cjs');

test(
  'managed query compatibility ceiling returns the complete valid 32 MB card without losing its bytes',
  { timeout: 30000 },
  async (t) => {
    const plan = createNativeMemoryBudget({ budgetMiB: 1536, commandCount: 2, postgres: true });
    const processPlan = nativeMemoryProcess(plan, 'gateway');
    assert.equal(processPlan.oldGenerationMiB, 256);
    assert.equal(processPlan.workingOldTargetMiB, 48);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-memory-large139-'));
    const child = spawn(
      process.execPath,
      [...processPlan.execArgv, path.join(__dirname, 'helpers/native-memory-physical139.cjs')],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          TMPDIR: temporary,
          TEMP: temporary,
          TMP: temporary,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const stdout = [],
      stderr = [];
    let bytes = 0,
      errorBytes = 0,
      closed = false,
      exceeded = false;
    const timer = setTimeout(() => {
      exceeded = true;
      child.kill();
    }, 28000);
    t.after(async () => {
      clearTimeout(timer);
      if (!closed) {
        child.kill();
        await new Promise((resolve) => {
          const stop = setTimeout(resolve, 5000);
          child.once('close', () => {
            clearTimeout(stop);
            resolve();
          });
        });
      }
      assert.equal(
        closed,
        true,
        'the owned process must close before its transient directory is removed',
      );
      assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
      assert.ok(path.basename(temporary).startsWith('cartoteca-memory-large139-'));
      fs.rmSync(temporary, { recursive: true, force: true });
      assert.equal(fs.existsSync(temporary), false);
    });
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 65536) {
        exceeded = true;
        child.kill();
      } else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errorBytes += chunk.length;
      if (errorBytes > 65536) {
        exceeded = true;
        child.kill();
      } else stderr.push(chunk);
    });
    const outcome = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        closed = true;
        clearTimeout(timer);
        resolve({ code, signal });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(
        JSON.stringify({ processPlan, label: 'gateway', tree: [], largeQuery: true }),
      );
    });
    assert.deepEqual({ ...outcome, exceeded }, { code: 0, signal: null, exceeded: false });
    // Node may emit its standard SQLite experimental warning; no fixture data is logged.
    assert.equal(Buffer.concat(stderr).toString().includes('PRIVATE_'), false);
    const result = JSON.parse(Buffer.concat(stdout));
    assert.equal(result.accepted, true);
    assert.equal(result.sample.heapSizeLimitBytes, 262 * 1024 * 1024);
    assert.equal(result.largeQuery.status, 200);
    assert.equal(result.largeQuery.visits, 800);
    assert.ok(
      result.largeQuery.bodyBytes > 32000000 && result.largeQuery.bodyBytes < 64 * 1024 * 1024,
    );
    assert.equal(result.largeQuery.bodySha256, result.largeQuery.expectedBodySha256);
    assert.equal(
      result.largeQuery.textSha256,
      '7c3c56a288ce6fe5cfadb4f27d12eaf24ada9ec0ef6aeb3a7610d1f1c778406d',
    );
    assert.equal(result.largeQuery.actualQueryKernel, true);
    assert.equal(result.largeQuery.fixtureRemoved, true);
    assert.equal(result.descendantsStarted, 0);
  },
);
