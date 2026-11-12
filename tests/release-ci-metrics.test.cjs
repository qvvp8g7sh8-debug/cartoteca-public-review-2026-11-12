const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, collect } = require('../scripts/release/ci-metrics.cjs');
test('CI telemetry separates wall time, machine time, queue and errors without raw logs', () => {
  const start = '2026-10-09T00:00:00Z';
  const jobs = [
    {
      id: 1,
      name: 'unit',
      created_at: start,
      started_at: '2026-10-09T00:00:05Z',
      completed_at: '2026-10-09T00:02:05Z',
      conclusion: 'failure',
      steps: [
        {
          name: 'tests',
          conclusion: 'failure',
          started_at: start,
          completed_at: '2026-10-09T00:02:00Z',
        },
      ],
    },
    {
      id: 2,
      name: 'browser',
      created_at: start,
      started_at: start,
      completed_at: '2026-10-09T00:01:00Z',
      conclusion: 'success',
    },
    { id: 3, name: 'package', status: 'skipped', steps: [{ name: 'build', status: 'skipped' }] },
    { id: 4, name: 'pipeline-metrics', started_at: start, status: 'in_progress' },
  ];
  const report = summarize({ id: 1, created_at: start, run_attempt: 2 }, jobs);
  assert.equal(report.wallMs, 125000);
  assert.equal(report.machineMs, 180000);
  assert.equal(report.failedMachineMs, 120000);
  assert.equal(report.slowest[0].queueMs, 5000);
  assert.deepEqual(report.failedJobs[0].steps, ['tests']);
  assert.equal(report.jobs.length, 3);
  assert.equal(report.jobs[2].durationMs, null);
  assert.equal(report.jobs[2].steps[0].durationMs, null);
  assert.equal(report.publishes, false);
});
test('metadata collection is confined to current CI and paginates without serializing credentials', async () => {
  const env = {
    GITHUB_REPOSITORY: 'qvvp8g7sh8-debug/cartoteca',
    GITHUB_RUN_ID: '123',
    GITHUB_TOKEN: 'synthetic-only',
  };
  const urls = [];
  const request = async (url) => {
    urls.push(url);
    return {
      ok: true,
      json: async () =>
        url.includes('/jobs')
          ? { total_count: 2, jobs: [{ name: url.includes('page=1') ? 'one' : 'two' }] }
          : { id: 123 },
    };
  };
  const report = await collect(env, request);
  assert.equal(urls.length, 3);
  assert.equal(report.jobs.length, 2);
  assert.equal(JSON.stringify(report).includes(env.GITHUB_TOKEN), false);
  await assert.rejects(collect({ ...env, GITHUB_REPOSITORY: 'other/repo' }, request));
  await assert.rejects(
    collect(env, async () => ({ ok: false, status: 403 })),
    /HTTP 403/,
  );
});
