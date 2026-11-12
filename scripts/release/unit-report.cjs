function validateUnitEvents(text, expected) {
  const events = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const summaries = events.filter((row) => row.type === 'test:summary');
  const totals = summaries.filter((row) => !row.file);
  const seen = new Set();
  const counts = { tests: 0, passed: 0, skipped: 0 };
  if (totals.length !== 1 || events.some((row) => row.type === 'test:fail'))
    throw Error('Unit summary is missing or failed');
  for (const row of summaries.filter((r) => r.file)) {
    const name = String(row.file).replaceAll('\\', '/');
    const matches = expected.filter((file) => name === file || name.endsWith('/' + file));
    if (matches.length !== 1 || seen.has(matches[0])) throw Error('Unknown or duplicate test file');
    seen.add(matches[0]);
    const c = row.counts;
    if (
      !c ||
      c.failed !== 0 ||
      c.cancelled !== 0 ||
      c.todo !== 0 ||
      !Number.isInteger(c.tests) ||
      !Number.isInteger(c.passed) ||
      c.passed < 0 ||
      !Number.isInteger(c.skipped) ||
      c.skipped < 0 ||
      c.tests < 1 ||
      c.tests !== c.passed + c.skipped
    )
      throw Error('Incomplete unit file summary');
    for (const key of Object.keys(counts)) counts[key] += c[key];
  }
  if (seen.size !== expected.length || expected.some((file) => !seen.has(file)))
    throw Error('Missing test file coverage');
  const total = totals[0].counts;
  if (
    !total ||
    total.failed !== 0 ||
    total.cancelled !== 0 ||
    total.todo !== 0 ||
    Object.keys(counts).some((key) => total[key] !== counts[key])
  )
    throw Error('Conflicting unit totals');
  return { files: [...seen].sort(), counts };
}
module.exports = { validateUnitEvents };
