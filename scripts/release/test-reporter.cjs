module.exports = async function* report(events) {
  for await (const event of events) {
    if (!['test:pass', 'test:fail', 'test:summary'].includes(event.type)) continue;
    const data = event.data;
    yield JSON.stringify({
      type: event.type,
      file: data.file,
      name: data.name,
      durationMs: data.details?.duration_ms ?? data.duration_ms,
      passed: event.type === 'test:summary' ? undefined : event.type === 'test:pass',
      skip: data.skip,
      counts: data.counts,
    }) + '\n';
  }
};
