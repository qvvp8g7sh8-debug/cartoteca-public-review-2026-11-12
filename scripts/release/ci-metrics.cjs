const fs = require('node:fs');
const path = require('node:path');
const repository = 'qvvp8g7sh8-debug/cartoteca';
const milliseconds = (start, end) => {
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

function summarize(run, jobs) {
  const measured = jobs.filter((job) => job.name !== 'pipeline-metrics');
  const rows = measured.map((job) => ({
    id: job.id,
    name: String(job.name).slice(0, 240),
    conclusion: job.conclusion || job.status,
    durationMs: milliseconds(job.started_at, job.completed_at),
    queueMs: milliseconds(job.created_at, job.started_at),
    steps: (job.steps || []).map((step) => ({
      name: String(step.name).slice(0, 240),
      conclusion: step.conclusion || step.status,
      durationMs: milliseconds(step.started_at, step.completed_at),
    })),
  }));
  const ends = measured.map((job) => Date.parse(job.completed_at)).filter(Number.isFinite);
  const failures = rows.filter((row) =>
    ['failure', 'timed_out', 'cancelled'].includes(row.conclusion),
  );
  return {
    version: 1,
    run: run.id,
    attempt: run.run_attempt,
    commit: run.head_sha,
    branch: run.head_branch,
    source: 'GitHub job/step timestamps; no logs or secrets',
    wallMs: ends.length
      ? milliseconds(run.created_at, new Date(Math.max(...ends)).toISOString())
      : null,
    machineMs: rows.reduce((sum, row) => sum + (row.durationMs || 0), 0),
    failedMachineMs: failures.reduce((sum, row) => sum + (row.durationMs || 0), 0),
    failedJobs: failures.map(({ name, conclusion, steps }) => ({
      name,
      conclusion,
      steps: steps.filter((step) => step.conclusion === 'failure').map((step) => step.name),
    })),
    slowest: [...rows]
      .filter((row) => row.durationMs !== null)
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 5)
      .map(({ name, durationMs, queueMs }) => ({ name, durationMs, queueMs })),
    jobs: rows,
    publishes: false,
  };
}

async function collect(env = process.env, request = fetch) {
  if (
    env.GITHUB_REPOSITORY !== repository ||
    !/^\d+$/.test(env.GITHUB_RUN_ID || '') ||
    !env.GITHUB_TOKEN
  )
    throw Error('Current private repository CI context required');
  const endpoint =
    'https://api.github.com/repos/' + repository + '/actions/runs/' + env.GITHUB_RUN_ID;
  const get = async (url) => {
    const response = await request(url, {
      headers: {
        Authorization: 'Bearer ' + env.GITHUB_TOKEN,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error('GitHub timing metadata unavailable: HTTP ' + response.status);
    return response.json();
  };
  const run = await get(endpoint);
  const jobs = [];
  for (let page = 1; page <= 10; page++) {
    const result = await get(endpoint + '/jobs?filter=latest&per_page=100&page=' + page);
    jobs.push(...result.jobs);
    if (jobs.length >= result.total_count) return summarize(run, jobs);
  }
  throw Error('Incomplete GitHub job inventory');
}
module.exports = { summarize, collect };
if (require.main === module) {
  collect()
    .then((report) => {
      const directory = path.resolve(__dirname, '../../work/release-ci-metrics');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(
        JSON.stringify({
          run: report.run,
          wallMs: report.wallMs,
          machineMs: report.machineMs,
          failures: report.failedJobs,
          slowest: report.slowest,
        }),
      );
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
