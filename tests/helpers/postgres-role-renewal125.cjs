const { parentPort, workerData } = require('node:worker_threads');
const v8 = require('node:v8');
const state = new Int32Array(workerData.mailbox, 0, 4);
const inline = new Uint8Array(workerData.mailbox, 16);
parentPort.on('message', (message) => {
  if (message.close) {
    workerData.replyPort.close();
    parentPort.close();
    return;
  }
  const command = v8.deserialize(Buffer.from(message.bytes));
  const reply =
    command.op === 'fault'
      ? { id: message.id, ok: false, error: command.error }
      : { id: message.id, ok: true, value: command.op === 'echo' ? command.value : null };
  const bytes = v8.serialize(reply);
  if (bytes.length > inline.length) throw Error('Synthetic reply exceeds inline frame');
  inline.set(bytes);
  Atomics.store(state, 1, bytes.length);
  Atomics.store(state, 2, message.id);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
  if (command.op === 'shutdown') {
    workerData.replyPort.close();
    parentPort.close();
  }
});
parentPort.postMessage({ type: 'ready' });
