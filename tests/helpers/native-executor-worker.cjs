const { parentPort } = require('node:worker_threads');
const { Int32Array, Atomics } = globalThis;
parentPort.on('message', ({ id, kind, payload, cancel }) => {
  try {
    if (!(payload instanceof ArrayBuffer)) throw Error('Expected transferred fixture bytes');
    let text = '{"ok":true}';
    if (kind === 'blocking-read') {
      // A real native wait occupies this worker's event loop. The test controls
      // release through the already shared cancellation word, never the gateway.
      const state = new Int32Array(cancel);
      Atomics.store(state, 0, 2);
      Atomics.notify(state, 0);
      Atomics.wait(state, 0, 2, 20000);
      if (Atomics.load(state, 0) === 2) throw Error('Fixture release guard expired');
      text = '{"released":true}';
    } else if (kind !== 'query') throw Error('Unknown fixture operation');
    const body = Uint8Array.from(Buffer.from(text)).buffer;
    parentPort.postMessage(
      { id, result: { status: 200, headers: { 'content-type': 'application/json' }, body } },
      [body],
    );
  } catch {
    parentPort.postMessage({
      id,
      error: { status: 503, code: 'FIXTURE_STOPPED', message: 'Fixture stopped' },
    });
  }
});
parentPort.postMessage({ ready: true });
