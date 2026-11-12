// Advisory diagnostics only: never authorize reuse, packaging or skipping any test.
function summarizeFailure(text, expected) {
  const failed = new Set(),
    seen = new Set();
  let incomplete = false,
    totals = 0;
  const lines = text.trim().split('\n').filter(Boolean);
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      incomplete = true;
      continue;
    }
    if (!row || typeof row !== 'object') {
      incomplete = true;
      continue;
    }
    if (row.type === 'test:summary' && !row.file) {
      totals++;
      continue;
    }
    if (!['test:summary', 'test:fail'].includes(row.type)) continue;
    const name = String(row.file || '').replaceAll('\\', '/');
    const matches = expected.filter((file) => name === file || name.endsWith('/' + file));
    if (matches.length !== 1) {
      incomplete = true;
      continue;
    }
    const file = matches[0];
    if (row.type === 'test:fail') failed.add(file);
    else {
      if (seen.has(file) || !row.counts) incomplete = true;
      seen.add(file);
      if (row.counts?.failed > 0 || row.counts?.cancelled > 0) failed.add(file);
    }
  }
  const missingFiles = expected.filter((file) => !seen.has(file)).sort();
  return {
    failedFiles: [...failed].sort(),
    missingFiles,
    incomplete: incomplete || totals !== 1 || missingFiles.length > 0,
    fullRequired: true,
  };
}
module.exports = { summarizeFailure };
