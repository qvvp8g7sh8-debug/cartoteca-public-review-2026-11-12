const fs = require('node:fs');
const { safePath } = require('./files.cjs');
const { writeJson, lock } = require('./state.cjs');
const path = require('node:path');
const stages = [
  'preparation',
  'github',
  'artifact',
  'publication',
  'verification',
  'documentation',
];

function file(root, id) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id || '')) throw Error('Invalid cycle id');
  return safePath(root, '.release/cycles/' + id + '/cycle.json');
}
function start(root, id, requestedAt, now = new Date().toISOString()) {
  if (
    !requestedAt ||
    !Number.isFinite(Date.parse(requestedAt)) ||
    Date.parse(requestedAt) > Date.parse(now)
  )
    throw Error('A real user command timestamp is required');
  const target = file(root, id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    JSON.stringify(
      { version: 1, id, requestedAt, recordedAt: now, status: 'running', attempts: [] },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  return summary(JSON.parse(fs.readFileSync(target)), now);
}
function mark(root, id, stage, event, now = new Date().toISOString()) {
  if (!stages.includes(stage) || !['start', 'passed', 'failed', 'cancelled'].includes(event))
    throw Error('Unknown cycle stage/event');
  const target = file(root, id),
    release = lock(path.dirname(target));
  try {
    const data = JSON.parse(fs.readFileSync(target));
    if (data.status !== 'running') throw Error('Cycle is already closed');
    const open = data.attempts.find((a) => a.stage === stage && !a.finishedAt);
    if (event === 'start') {
      if (open) throw Error('Stage is already running');
      data.attempts.push({ stage, startedAt: now });
    } else {
      if (!open) throw Error('Stage has not started');
      Object.assign(open, {
        finishedAt: now,
        status: event,
        durationMs: Date.parse(now) - Date.parse(open.startedAt),
      });
    }
    writeJson(target, data);
    return summary(data, now);
  } finally {
    release();
  }
}
function finish(root, id, now = new Date().toISOString()) {
  const target = file(root, id),
    release = lock(path.dirname(target));
  try {
    const data = JSON.parse(fs.readFileSync(target));
    if (data.status !== 'running' || data.attempts.some((a) => !a.finishedAt))
      throw Error('Close every running stage before finishing the cycle');
    data.status = 'completed';
    data.finishedAt = now;
    writeJson(target, data);
    return summary(data, now);
  } finally {
    release();
  }
}
function summary(data, now) {
  const end = data.finishedAt || now;
  const intervals = data.attempts
    .filter((a) => a.finishedAt)
    .map((a) => [Date.parse(a.startedAt), Date.parse(a.finishedAt)])
    .sort((a, b) => a[0] - b[0]);
  let measured = 0,
    previous = null;
  for (const [start, finish] of intervals) {
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], finish);
    else {
      if (previous) measured += previous[1] - previous[0];
      previous = [start, finish];
    }
  }
  if (previous) measured += previous[1] - previous[0];
  const totalMs = Date.parse(end) - Date.parse(data.requestedAt);
  return {
    ...data,
    totalMs,
    measuredMs: measured,
    unclassifiedMs: totalMs - measured,
    note: 'Total includes preparation, queues, retries, transfers, checks and documentation. Unclassified time is retained.',
  };
}
function read(root, id) {
  return summary(JSON.parse(fs.readFileSync(file(root, id))), new Date().toISOString());
}
module.exports = { start, mark, finish, read, summary };
