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
  if (command.op === 'hang') {
    Atomics.wait(state, 3, 0);
    return;
  }
  const reply = { id: message.id, ok: true, value: command.op === 'echo' ? command.value : null };
  const bytes = v8.serialize(reply);
  Atomics.store(state, 1, bytes.length);
  Atomics.store(state, 2, command.op === 'wrong-id' ? message.id + 1 : message.id);
  if (bytes.length <= inline.length) {
    inline.set(bytes);
    Atomics.store(state, 0, 1);
  } else {
    const owned = Uint8Array.from(bytes);
    workerData.replyPort.postMessage({ id: message.id, bytes: owned.buffer }, [owned.buffer]);
    Atomics.store(state, 0, 2);
  }
  Atomics.notify(state, 0);
  if (command.op === 'shutdown') {
    workerData.replyPort.close();
    parentPort.close();
  }
});
parentPort.postMessage({ type: 'ready' });
