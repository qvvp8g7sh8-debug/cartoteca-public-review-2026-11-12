const { sourceWitness } = require('./read-source-probe152.cjs');
const bad = () =>
  Object.assign(Error('Invalid admitted patient capsule'), {
    status: 503,
    code: 'POSTGRES_PATIENT_CAPSULE_BOUND197',
  });

function patientCapsuleBound197(packet, sources) {
  if (!packet.supported) {
    if (packet.rows.length) throw bad();
    return null;
  }
  if (packet.sources.length !== sources.length || packet.rows.length > 199) throw bad();
  const counts = new Map(),
    sourceBounds = new Map(),
    proofs = [],
    witnesses = [];
  let bytes = 0,
    rows = 0;
  for (const [index, source] of sources.entries()) {
    const value = packet.sources[index];
    if (
      value.source !== index ||
      !Number.isSafeInteger(value.rows) ||
      value.rows < 0 ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0
    )
      throw bad();
    bytes += value.bytes;
    rows += value.rows;
    const key = source.scope.kind + ':' + source.table;
    counts.set(key, value.rows);
    sourceBounds.set(key, { rows: value.rows, bytes: value.bytes });
    witnesses.push(value.witness);
    proofs.push({ source, witness: value.witness, rows: value.rows, bytes: value.bytes });
  }
  const decodedBound = bytes * 6 * 24 + rows * 6 * 256;
  if (bytes > 65536 || rows > 20000 || decodedBound > 64 * 1024 * 1024) throw bad();
  let retainedBytes = 0;
  for (const row of packet.rows) {
    retainedBytes += 128;
    for (const value of Object.values(row))
      retainedBytes += Buffer.isBuffer(value)
        ? value.byteLength
        : typeof value === 'string'
          ? Buffer.byteLength(value) * 2
          : 16;
  }
  return {
    proofs,
    retainedBytes,
    byteLimit: Math.min(128 * 1024 * 1024, Math.max(65536, bytes * 6 + rows * 256)),
    rowLimit: Math.min(2000000, Math.max(256, rows * 6)),
    bound: {
      bytes,
      rows,
      decodedBound,
      counts,
      sourceBounds,
      patientPageEmpty165: packet.patientPageEmpty165,
      clinicalWitness: sourceWitness(sources, witnesses),
    },
  };
}
module.exports = { patientCapsuleBound197 };
