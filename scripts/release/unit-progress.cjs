const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');

function watchUnitFailures(file, expected, onFailure, { intervalMs = 1000 } = {}) {
  let offset = 0, pending = '', stopped = false;
  let decoder = new StringDecoder('utf8');
  const seen = new Set();
  function read() {
    let descriptor;
    try {
      descriptor = fs.openSync(file, 'r');
      const size = fs.fstatSync(descriptor).size;
      if (size < offset) { offset = 0; pending = ''; decoder = new StringDecoder('utf8'); }
      const buffer = Buffer.alloc(65536);
      while (offset < size) {
        const bytes = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!bytes) break;
        offset += bytes;pending += decoder.write(buffer.subarray(0, bytes));
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline);pending = pending.slice(newline + 1);
          let row;try { row = JSON.parse(line); } catch { continue; }
          if (row.type !== 'test:fail' && !(row.type === 'test:summary' &&
              (row.counts?.failed > 0 || row.counts?.cancelled > 0))) continue;
          const name = String(row.file || '').replaceAll('\\', '/');
          const matches = expected.filter(file => name === file || name.endsWith('/' + file));
          if (matches.length !== 1 || seen.has(matches[0])) continue;
          seen.add(matches[0]);onFailure({ file: matches[0], observedAt: new Date().toISOString() });
        }
      }
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  // Poll content directly: watchFile's asynchronous initial stat can already see
  // a newly created file and miss its only write until the process ends.
  const timer = setInterval(read, intervalMs);read();
  return () => {
    if (stopped) return;stopped = true;
    clearInterval(timer);read();
  };
}

module.exports = { watchUnitFailures };
