const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configuration } = require('../src/server/config.cjs');
const { createMultiServer } = require('../multi-server.cjs');

test('assistant capacity is explicit, bounded and does not enable saving or change process ownership', () => {
  assert.equal(configuration({}, {}).assistantDialogueCapacity, 100);
  const config = configuration({}, { CARTOTECA_ASSISTANT_DIALOGUE_CAPACITY: '3000' });
  assert.equal(config.assistantDialogueCapacity, 3000);
  assert.equal(config.assistantAppointmentSavingEnabled, false);
  assert.equal(config.processRole, 'combined');
  assert.equal(
    configuration(
      { assistantDialogueCapacity: 700 },
      {
        CARTOTECA_ASSISTANT_DIALOGUE_CAPACITY: '3000',
      },
    ).assistantDialogueCapacity,
    700,
  );
  for (const value of [0, -1, 10001, 1.5, NaN, Infinity, '', ' ', 'garbage'])
    assert.throws(() => configuration({ assistantDialogueCapacity: value }, {}), /Invalid/);
});

test('server passes capacity into assistant and exposes only aggregate runtime counters', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-scale92-config-'));
  const server = createMultiServer({
    dataDir: directory,
    assistantDialogueCapacity: 700,
    metricsEnabled: true,
    metricsIntervalMs: 0,
    processRole: 'preflight',
    origin: '',
    sendMail: null,
    telegramBot: null,
    supportDelivery: {},
  });
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stats = server.requestMetrics.snapshot();
  assert.equal(stats.resources.assistant.dialogues.capacity, 700);
  assert.equal(stats.resources.assistant.dialogues.active, 0);
  assert.equal(stats.resources.assistant.pending.active, 0);
  assert.equal(stats.resources.assistant.commands.active, 0);
  assert.deepEqual(stats.resources.assistant.turns, {
    localCalendar: 0,
    localAvailability: 0,
    localClients: 0,
    localClientCard: 0,
    localPrepareAppointment: 0,
    model: 0,
  });
  assert.ok(
    Object.values(stats.resources.assistant.turns).every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ),
  );
  assert.equal(stats.resources.photoReads.active, 0);
  assert.equal(stats.resources.photoReads.bytes, 0);
  assert.equal(stats.resources.photoReads.maxBytes, 64 * 1024 * 1024);
  const encoded = JSON.stringify(stats.resources.assistant);
  assert.doesNotMatch(encoded, /accountId|organizationId|sessionId|cookie|token|password/);
  assert.equal(server.processRole, 'preflight');
});
