// Exact-image HTTP producer: synthetic tmpfs data, loopback only, no live model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const CASES = Object.freeze([
  'structured-output-and-action-guard',
  'create-complete-and-idempotent',
  'create-clarifications-preserve-fields',
  'move-explicit-and-relative',
  'move-time-required-and-busy',
  'cancel-bound-confirmation-and-replay',
  'delete-alias-safe-cancellation',
  'client-card-visible-choice',
  'calendar-read-vs-edit',
  'rights-and-five-minute-guard',
]);
function identity(value) {
  assert.deepEqual(Object.keys(value).sort(), [
    'candidate',
    'helperSha256',
    'imageId',
    'profileHash',
    'sourceHash',
  ]);
  assert.match(value.candidate, /^[a-z0-9][a-z0-9-]{0,79}$/u);
  for (const field of ['sourceHash', 'profileHash', 'helperSha256'])
    assert.match(value[field], /^[a-f0-9]{64}$/u);
  assert.match(value.imageId, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(
    createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    value.helperSha256,
  );
  return value;
}
async function main(input) {
  const verified = identity(input),
    root = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-behavior-image-'));
  const originalFetch = globalThis.fetch;
  const cases = [],
    rejectedOutbounds = [];
  let store, tenant, server, origin, ownerSession, otherSession, revision, owner, serviceId;
  let plan = null,
    providerCalls = 0,
    httpRequests = 0;
  const day = '2099-01-05',
    closed = '2099-01-06';
  const patientIds = Array.from({ length: 6 }, () => randomUUID());
  const patient = (index, firstName, lastName, phone) => ({
    id: patientIds[index],
    firstName,
    lastName,
    name: firstName + ' ' + lastName,
    phone,
    createdBy: owner.accountId,
    appointments: [],
    visits: [],
  });
  const appointment = (time, date = day) => ({
    id: randomUUID(),
    date,
    time,
    duration: 60,
    staffId: owner.accountId,
    roomId: 'main',
    status: 'scheduled',
    service: 'Консультация',
    serviceItems: [
      { id: serviceId, name: 'Консультация', duration: 60, price: 100, category: 'other' },
    ],
    notes: 'Synthetic preserved history',
  });
  function reset(appointments = [], busy = []) {
    plan = null;
    const patients = [
      patient(0, 'Анна', 'Иванова', '+79990009999'),
      patient(1, 'Мария', 'Петрова', '+78880001002'),
      ...['Алексей', 'Олег', 'Иван', 'Сергей'].map((name, index) =>
        patient(index + 2, name, 'Семёнов', '+7999000' + (1000 + index)),
      ),
    ];
    patients[0].appointments = appointments;
    patients[1].appointments = busy;
    tenant.write({
      revision: tenant.get('revision', 0),
      patients,
      services: [
        {
          id: serviceId,
          staffId: owner.accountId,
          name: 'Консультация',
          duration: '60',
          price: 100,
          category: 'other',
        },
      ],
    });
  }
  const rows = () => tenant.readSelected([patientIds[0]]).patients[0].appointments;
  const command = (expectedRevision, values) => ({
    expectedRevision,
    requestId: randomUUID(),
    reason: 'Synthetic behavior image acceptance',
    ...values,
  });
  function request(route, body, session = ownerSession) {
    assert.ok(++httpRequests <= 100, 'Bounded HTTP scope exceeded');
    return new Promise((resolve, reject) => {
      const raw = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        origin + route,
        {
          method: raw === null ? 'GET' : 'POST',
          agent: false,
          headers: {
            Cookie: 'cartoteca_v2_session=' + session.token,
            'X-Cartoteca-Account-Id': session.account.id,
            'X-Cartoteca-Organization-Id': session.organizationId || '',
            Origin: origin,
            'X-Cartoteca-Request': '1',
            'Content-Type': 'application/json',
            ...(raw === null ? {} : { 'Content-Length': Buffer.byteLength(raw) }),
          },
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > 1024 * 1024) req.destroy(Error('OVERSIZED_SYNTHETIC_HTTP'));
            else chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.setTimeout(12000, () => req.destroy(Error('SYNTHETIC_HTTP_TIMEOUT')));
      req.on('error', reject);
      if (raw !== null) req.write(raw);
      req.end();
    });
  }
  async function initial(text, proposal, expected = 200, { local = false } = {}) {
    const { intentEnvelope } = require(
      path.join(root, 'src/server/modules/assistant/interpretation/intent-contract.cjs'),
    );
    assert.equal(plan, null);
    const callsBefore = providerCalls;
    plan = { text, output: JSON.stringify({ ...intentEnvelope(proposal), ...proposal }) };
    const response = await request('/api/assistant/turn', { policyVersion: revision, text });
    assert.equal(response.status, expected, JSON.stringify(response.body));
    if (local) {
      assert.equal(providerCalls, callsBefore, 'An unambiguous read must not call the model');
      assert.ok(plan, 'The local read must leave the adversarial model proposal unused');
      plan = null;
    } else assert.equal(plan, null, 'Initial command did not consume its synthetic model parse');
    return response.body;
  }
  async function follow(reply, text, extra = {}) {
    assert.ok(reply.dialogue);
    const response = await request('/api/assistant/turn', {
      policyVersion: revision,
      dialogueId: reply.dialogue.id,
      dialogueVersion: reply.dialogue.version,
      ...(text === null ? {} : { text }),
      ...extra,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  async function execute(reply) {
    assert.ok(reply.action?.executionId, JSON.stringify(reply));
    const body = { executionId: reply.action.executionId, policyVersion: revision };
    const response = await request('/api/assistant/execute', body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.saved, true);
    return { result: response.body, body };
  }
  try {
    globalThis.fetch = async (url, options) => {
      if (url !== 'https://api.timeweb.ai/v1/chat/completions') {
        rejectedOutbounds.push(true);
        throw Error('UNEXPECTED_OUTBOUND');
      }
      assert.ok(plan, 'Unexpected model call for a local continuation');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      const payload = JSON.parse(options.body);
      assert.equal(payload.messages.at(-1).content, plan.text);
      assert.ok(++providerCalls <= 30, 'Synthetic model scope exceeded');
      const content = plan.output;
      plan = null;
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content } }],
          usage: { prompt_tokens: 20, completion_tokens: 20 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    };
    store = require(path.join(root, 'platform-store.cjs')).createPlatformStore(
      path.join(directory, 'platform'),
    );
    const password = 'Synthetic-behavior-image-password-2026';
    owner = await store.registerOwner({
      email: 'behavior-owner@synthetic.test',
      password,
      displayName: 'Синтетический владелец',
      organizationName: 'Синтетический стенд',
      city: 'Казань',
    });
    store.verifyEmail(owner.verificationToken);
    const other = await store.registerOwner({
      email: 'behavior-other@synthetic.test',
      password,
      displayName: 'Другой владелец',
      organizationName: 'Другая синтетическая организация',
      city: 'Казань',
    });
    store.verifyEmail(other.verificationToken);
    const admin = await store.bootstrapGlobalAdmin({
      email: 'behavior-operator@synthetic.test',
      password,
      displayName: 'Синтетический оператор',
    });
    ownerSession = await store.login('behavior-owner@synthetic.test', password);
    otherSession = await store.login('behavior-other@synthetic.test', password);
    const settings = store.assistant.admin;
    let view = settings.settings(
      admin.accountId,
      command(settings.view(admin.accountId).revision, {
        policy: { mode: 'selected', limits: { dailyRequests: 1000 } },
        providers: { llm: { provider: 'timeweb' } },
        timewebApiKey: 'synthetic-behavior-image-provider-key',
      }),
    );
    for (const actor of [owner, other])
      view = settings.setMember(
        admin.accountId,
        command(view.revision, {
          organizationId: actor.organizationId,
          accountId: actor.accountId,
          enabled: true,
        }),
      );
    tenant = require(
      path.join(root, 'src/server/infrastructure/cabinet-storage.cjs'),
    ).createStorage(path.join(directory, 'tenants', owner.organizationId));
    serviceId = randomUUID();
    reset();
    const zone = store.organizationTimeZone(owner.organizationId);
    const schedule = store.workSchedules.view(ownerSession.token, owner.accountId, day, day);
    store.workSchedules.save(
      ownerSession.token,
      {
        staffId: owner.accountId,
        dates: [day],
        status: 'working',
        intervals: [['09:00', '18:00']],
        revision: schedule.revision,
        expectedTimeZone: zone,
      },
      tenant,
    );
    server = require(path.join(root, 'multi-server.cjs')).createMultiServer({
      dataDir: directory,
      host: '127.0.0.1',
      port: 0,
      production: false,
      origin: '',
      additionalOrigins: [],
      trustedProxies: [],
      processRole: 'web',
      releaseGate: false,
      sendMail: null,
      telegramBot: null,
      supportBot: null,
      supportDelivery: { telegram: null, email: null },
      telegramAutostart: false,
      telegramIdentityAutostart: false,
      maxAutostart: false,
      pushAutostart: false,
      supportAutostart: false,
      adminEmailAutostart: false,
      bookingPublicationAutostart: false,
      commonNotificationsEnabled: false,
      scheduledNotifications: false,
      maxEnabled: false,
      maxConnectionsEnabled: false,
      pushEnabled: false,
      assistantAppointmentSavingEnabled: true,
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    origin = 'http://127.0.0.1:' + server.address().port;
    const scope = await request('/api/assistant/scope');
    assert.equal(scope.status, 200);
    assert.equal(scope.body.appointmentSavingEnabled, true);
    revision = scope.body.policyVersion;
    const create = (time, date = day) => ({
      intent: 'prepareAppointment',
      query: 'Анну Иванову',
      serviceQuery: 'консультацию',
      date,
      time,
    });
    const move = (time) => ({
      intent: 'moveAppointment',
      query: 'Анны Ивановой',
      date: day,
      ...(time ? { time } : {}),
    });
    for (const name of CASES) {
      try {
        if (name === 'structured-output-and-action-guard') {
          reset();
          await initial(
            'Запиши Анну Иванову на консультацию ' + day + ' в 10:00',
            { ...create('10:00'), action: 'save' },
            502,
          );
          await initial(
            'Удали клиента Анну Иванову',
            { intent: 'cancelAppointment', query: 'Анну Иванову' },
            400,
          );
          assert.equal(rows().length, 0);
        } else if (name === 'create-complete-and-idempotent') {
          reset();
          const reply = await initial(
            'Запиши Анну Иванову на консультацию ' + day + ' в 10:00',
            create('10:00'),
          );
          assert.equal(reply.action?.type, 'createAppointment');
          assert.equal(rows().length, 0);
          const saved = await execute(reply);
          assert.equal(rows().length, 1);
          assert.equal(rows()[0].time, '10:00');
          assert.equal(
            (await request('/api/assistant/execute', saved.body)).body.alreadySaved,
            true,
          );
          assert.equal(rows().length, 1);
        } else if (name === 'create-clarifications-preserve-fields') {
          reset();
          let reply = await initial('Запиши Анну Иванову на консультацию', {
            intent: 'prepareAppointment',
            query: 'Анну Иванову',
            serviceQuery: 'консультацию',
          });
          assert.equal(reply.dialogue?.step, 'date');
          reply = await follow(reply, day);
          assert.equal(reply.dialogue?.step, 'time');
          reply = await follow(reply, 'на двенадцать часов');
          assert.equal(reply.action?.type, 'createAppointment');
          await execute(reply);
          assert.equal(rows()[0].time, '12:00');
          assert.equal(rows()[0].duration, 60);
          reset();
          reply = await initial(
            'Запиши Анну Иванову на консультацию ' + closed + ' в 13:00',
            create('13:00', closed),
          );
          assert.equal(reply.dialogue?.phase, 'closedDay');
          assert.equal(reply.action, null);
          assert.equal(rows().length, 0);
          reply = await follow(reply, 'ага');
          assert.equal(reply.action?.type, 'createAppointment');
          await execute(reply);
          assert.equal(rows()[0].date, closed);
          assert.equal(rows()[0].time, '13:00');
        } else if (name === 'move-explicit-and-relative') {
          const source = appointment('10:00');
          reset([source]);
          let reply = await initial(
            'Перенеси запись Анны Ивановой на ' + day + ' в 12:30',
            move('12:30'),
          );
          assert.equal(reply.action?.type, 'moveAppointment');
          assert.equal(rows()[0].time, '10:00');
          await execute(reply);
          assert.equal(rows()[0].id, source.id);
          assert.equal(rows()[0].time, '12:30');
          reply = await initial('Перенеси запись Анны Ивановой на час позже', {
            intent: 'moveAppointment',
            query: 'Анны Ивановой',
          });
          assert.equal(reply.action?.type, 'moveAppointment');
          await execute(reply);
          assert.equal(rows()[0].time, '13:30');
        } else if (name === 'move-time-required-and-busy') {
          const source = appointment('10:00');
          reset([source], [appointment('12:00')]);
          let reply = await initial('Перенеси запись Анны Ивановой на ' + day, move());
          assert.equal(reply.dialogue?.step, 'time');
          assert.equal(reply.action, null);
          reply = await follow(reply, '12:00');
          assert.equal(reply.action, null);
          assert.equal(reply.dialogue?.phase, 'period');
          assert.equal(rows()[0].time, '10:00');
          reply = await follow(reply, '14:00');
          assert.equal(reply.action?.type, 'moveAppointment');
          await execute(reply);
          assert.equal(rows()[0].time, '14:00');
        } else if (name === 'cancel-bound-confirmation-and-replay') {
          const first = appointment('10:00'),
            selected = appointment('13:00');
          reset([first, selected]);
          let reply = await initial('Отмени запись Анны Ивановой', {
            intent: 'cancelAppointment',
            query: 'Анны Ивановой',
          });
          assert.equal(reply.dialogue?.phase, 'appointmentChoice');
          assert.equal(reply.dialogue.options.length, 2);
          const choice = reply.dialogue.options.find((option) => option.label.includes('13:00'));
          assert.ok(choice);
          reply = await follow(reply, null, { choice: choice.id });
          assert.equal(reply.dialogue?.phase, 'cancelConfirmation');
          assert.equal(reply.action, null);
          assert.ok(!reply.dialogue.prompt.includes('Анна'));
          assert.equal(reply.dialogue.options[0].label, 'Да, отменить');
          assert.equal(
            (
              await request('/api/assistant/execute', {
                executionId: reply.dialogue.id,
                policyVersion: revision,
              })
            ).status,
            409,
          );
          reply = await follow(reply, 'Да, отменить');
          assert.equal(reply.action?.type, 'cancelAppointment');
          const saved = await execute(reply);
          assert.equal(saved.result.appointmentId, selected.id);
          assert.equal(rows().length, 2);
          assert.equal(rows().find((row) => row.id === first.id).status, 'scheduled');
          assert.equal(rows().find((row) => row.id === selected.id).status, 'cancelled');
          assert.equal(
            (await request('/api/assistant/execute', saved.body)).body.alreadySaved,
            true,
          );
        } else if (name === 'delete-alias-safe-cancellation') {
          const source = appointment('10:00');
          reset([source]);
          let reply = await initial('Удали запись Анны Ивановой на ' + day + ' в 10:00', {
            intent: 'help',
          });
          assert.equal(reply.dialogue?.phase, 'cancelConfirmation');
          assert.equal(rows()[0].status, 'scheduled');
          reply = await follow(reply, 'да, удали');
          const saved = await execute(reply);
          assert.equal(saved.result.cancelled, true);
          assert.equal(rows().length, 1);
          assert.equal(rows()[0].id, source.id);
          assert.equal(rows()[0].status, 'cancelled');
          assert.equal(rows()[0].notes, source.notes);
        } else if (name === 'client-card-visible-choice') {
          reset();
          let reply = await initial(
            'Открой карточку Семенова',
            { intent: 'clientCard', query: 'Семенова' },
            200,
            { local: true },
          );
          assert.equal(reply.dialogue?.prompt, 'Какое имя?');
          assert.equal(reply.dialogue.options.length, 4);
          const foreign = await request(
            '/api/assistant/turn',
            {
              policyVersion: revision,
              dialogueId: reply.dialogue.id,
              dialogueVersion: reply.dialogue.version,
              text: '1002',
            },
            otherSession,
          );
          assert.ok([403, 409].includes(foreign.status));
          reply = await follow(reply, '9999');
          assert.equal(reply.action, null);
          assert.equal(reply.dialogue.options.length, 4);
          reply = await follow(reply, '1002');
          assert.deepEqual(reply.action, { type: 'clientCard', patientId: patientIds[4] });
          assert.equal(rows().length, 0);
        } else if (name === 'calendar-read-vs-edit') {
          const source = appointment('10:00');
          reset([source]);
          let reply = await initial(
            'Открой записи на 21',
            { intent: 'editAppointment', query: 'Анны Ивановой' },
            200,
            { local: true },
          );
          const clock = require(path.join(root, 'src/shared/time-zone.cjs')).zonedClock(
            new Date(),
            zone,
          );
          assert.equal(reply.action?.type, 'calendar');
          assert.equal(reply.action.date, clock.date.slice(0, 7) + '-21');
          reply = await initial('Открой запись Анны Ивановой', {
            intent: 'editAppointment',
            query: 'Анны Ивановой',
          });
          assert.equal(reply.action?.type, 'appointmentPreview');
          assert.equal(reply.action.operation, 'edit');
          assert.equal(reply.action.appointmentId, source.id);
          assert.deepEqual(rows(), [source]);
        } else if (name === 'rights-and-five-minute-guard') {
          reset();
          let reply = await initial(
            'Запиши Анну Иванову на консультацию ' + day + ' в 10:03',
            create('10:03'),
          );
          assert.equal(reply.action, null);
          assert.equal(reply.dialogue?.step, 'time');
          assert.equal(rows().length, 0);
          reply = await follow(reply, '11:00');
          assert.equal(reply.action?.type, 'createAppointment');
          const denied = await request(
            '/api/assistant/execute',
            { executionId: reply.action.executionId, policyVersion: revision },
            otherSession,
          );
          assert.equal(denied.status, 200);
          assert.equal(denied.body.saved, false);
          assert.equal(denied.body.definitive, true);
          assert.equal(denied.body.code, 'ASSISTANT_EXECUTION_EXPIRED');
          assert.equal(denied.body.action, null);
          assert.equal(rows().length, 0);
          await execute(reply);
          assert.equal(rows()[0].time, '11:00');
        }
        cases.push({ case: name, passed: true });
      } catch (error) {
        plan = null;
        cases.push({ case: name, passed: false });
        console.error(
          JSON.stringify({
            case: name,
            reason: error.code || error.name || 'CASE_FAILED',
            detail: String(error.message).slice(0, 1800),
          }),
        );
      }
    }
    assert.equal(rejectedOutbounds.length, 0);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    tenant?.close();
    store?.close();
    globalThis.fetch = originalFetch;
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cartoteca-behavior-image-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
  const result = {
    version: 1,
    ...verified,
    syntheticOnly: true,
    externalProviderRequests: 0,
    passed: cases.length === CASES.length && cases.every((row) => row.passed),
    cases,
  };
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
  return result;
}
module.exports = { main, identity, CASES };
if (require.main === module)
  main(JSON.parse(process.argv[2])).catch((error) => {
    console.error(
      JSON.stringify({
        reason: error.code || error.name || 'BEHAVIOR_HTTP_STAND_FAILED',
        detail: String(error.message).slice(0, 1800),
      }),
    );
    process.exitCode = 1;
  });
