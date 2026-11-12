const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createAssistant } = require('../src/server/modules/assistant/service.cjs');
const {
  availabilityFixture,
  day,
} = require('./helpers/assistant-availability-native-fixture99.cjs');
const { wav } = require('./helpers/assistant-boundaries-fixture.cjs');
for (const combined of [false, true])
  test(
    'paid availability accepts one task and one speech proof, combined=' + combined,
    async (t) => {
      const f = await availabilityFixture(t);
      f.settings({ policy: { commands: { prepareAppointment: false } } });
      const requestId = randomUUID(),
        events = [],
        recognition = [];
      const ticket = { id: randomUUID(), grantId: randomUUID(), requestId, attempt: 1 };
      const api = createAssistant(
        {
          ...f.database,
          organizationTimeZone: f.store.organizationTimeZone,
          billing: {
            hasServiceConnection: () => true,
            isServiceEnabled: () => true,
            wallet: {
              reserve(input) {
                assert.equal(combined, true);
                assert.equal(input.kind, 'stt');
                assert.equal(input.task.requestId, requestId);
                recognition.push('reserve');
                return { id: 'synthetic-reservation', amountRub: 0 };
              },
              markOutbound: () => recognition.push('outbound'),
              settle: () => recognition.push('settled'),
            },
            packages: {
              status: () => ({ active: true, remainingTasks: 1 }),
              reserveTask(input) {
                assert.equal(input.requestId, requestId);
                assert.equal(input.current.organizationId, f.owner.organizationId);
                events.push('reserve-task');
                return ticket;
              },
              acceptTask(value, proof) {
                assert.equal(value, ticket);
                assert.equal(proof.outbound, undefined);
                events.push('accept-task');
              },
              requireAcceptedTask({ current, requestId: id }) {
                assert.equal(id, requestId);
                assert.equal(current.accountId, f.ownerId);
                assert.deepEqual(events, ['reserve-task', 'accept-task']);
                return ticket;
              },
              rejectTask: () => assert.fail('A successful local read must not reject its task'),
            },
          },
        },
        { directory: f.platformDirectory, ...f.ports },
      );
      const before = f.readState(),
        clinical = f.clinic.read();
      const text = 'Найди свободные окна на ' + day + ' на 30 минут';
      f.hooks.stt = () => ({ text });
      const reply = combined
        ? (
            await api.transcribe(f.context(), {
              ...wav(),
              policyVersion: f.revision(),
              taskRequestId: requestId,
              availabilityTurn: 'plain',
            })
          ).availabilityReply
        : await f.turn(text, { taskRequestId: requestId }, 'owner', api);
      assert.equal(reply.intent, 'availability');
      assert.equal(reply.taskRequestId, requestId);
      assert.equal(reply.action, null);
      assert.equal(reply.dialogue, undefined);
      assert.ok(reply.readOnlySlots.length > 0);
      assert.ok(reply.speechPermit.token);
      assert.equal(reply.usage, undefined);
      assert.deepEqual(events, ['reserve-task', 'accept-task']);
      assert.deepEqual(recognition, combined ? ['reserve', 'outbound', 'settled'] : []);
      assert.deepEqual(f.calls, { llm: 0, stt: Number(combined), tts: 0 });
      assert.deepEqual(f.readState(), before);
      assert.deepEqual(f.clinic.read(), clinical);
      assert.equal(api.runtimeStats().turns.localAvailability, 1);
    },
  );
