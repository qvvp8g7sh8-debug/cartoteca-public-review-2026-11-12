const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const organizationId = '10000000-0000-4000-8000-000000000001';
const executionId = '20000000-0000-4000-8000-000000000001';
const nextExecutionId = '20000000-0000-4000-8000-000000000002';
const policyVersion = 7;
const action = (id = executionId) => ({
  type: 'createAppointment',
  executionId: id,
  patientId: 'SYNTHETIC_PRIVATE_CLIENT',
  serviceQuery: 'SYNTHETIC_PRIVATE_SERVICE',
});
const saved = (extra = {}) => ({
  saved: true,
  text: 'Запись сохранена.',
  appointmentId: '30000000-0000-4000-8000-000000000001',
  action: null,
  policyVersion,
  ...extra,
});
const expired = () => ({
  saved: false,
  definitive: true,
  code: 'ASSISTANT_EXECUTION_EXPIRED',
  text: 'Срок подготовки истёк. Повторите команду.',
  action: null,
  policyVersion,
});
const unknown = () =>
  Object.assign(Error('Synthetic disconnected response'), { outcomeUnknown: true });
const rejected = (status = 409) => Object.assign(Error('Synthetic request refused'), { status });
const plain = (value) => JSON.parse(JSON.stringify(value));
function storageRows(w) {
  return Array.from({ length: w.sessionStorage.length }, (_, index) => {
    const key = w.sessionStorage.key(index);
    return [key, w.sessionStorage.getItem(key)];
  });
}
function fixture(t, request, { rows = [] } = {}) {
  const w = new JSDOM('', { url: 'http://localhost:4186/', runScripts: 'outside-only' }).window;
  t.after(() => w.close());
  let hidden = false;
  Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => hidden });
  for (const [key, value] of rows) w.sessionStorage.setItem(key, value);
  w.eval(
    fs.readFileSync(
      path.resolve(__dirname, '../src/client/modules/assistant-appointment-save.js'),
      'utf8',
    ),
  );
  const state = {
    account: { id: '40000000-0000-4000-8000-000000000001', organizationId, role: 'owner' },
    assistantScope: {
      enabled: true,
      appointmentSavingEnabled: true,
      organizationId,
      policyVersion,
    },
    assistantGeneration: 1,
    currentView: 'calendar',
    editorMode: null,
    busy: false,
  };
  const calls = [],
    ui = [];
  const actions = {
    request: async (url, options = {}) => {
      const body =
        typeof options.body === 'string' ? JSON.parse(options.body) : plain(options.body);
      const call = { url, options, body, rowsAtDispatch: storageRows(w) };
      calls.push(call);
      return request ? request(call, calls.length) : saved();
    },
    runAssistantAction: async (value) => {
      ui.push(plain(value));
      return true;
    },
  };
  const create = () => w.eval('createAssistantAppointmentSave')(state, actions);
  const f = {
    w,
    state,
    actions,
    calls,
    ui,
    create,
    api: create(),
    setHidden: (value) => {
      hidden = value;
    },
    rows: () => storageRows(w),
  };
  return f;
}
async function unresolved(t) {
  const f = fixture(t, async () => {
    throw unknown();
  });
  await assert.rejects(() => f.api.saveAssistantAppointment(action()));
  assert.equal(f.calls.length, 2, 'one automatic same-token retry only');
  assert.equal(f.rows().length, 1);
  assert.deepEqual(JSON.parse(f.rows()[0][1]), { executionId, policyVersion, uncertain: true });
  return f.rows();
}

test('save posts only its execution token and durably records the minimal pending receipt before dispatch', async (t) => {
  const f = fixture(t);
  const result = await f.api.saveAssistantAppointment(action());
  assert.equal(result.saved, true);
  assert.equal(result.text, saved().text);
  assert.equal(f.calls.length, 1);
  const sent = f.calls[0];
  assert.equal(sent.url, '/api/assistant/execute');
  assert.equal(sent.options.method, 'POST');
  assert.equal(typeof sent.options.body, 'string');
  assert.equal(sent.options.assistantRequest, true);
  assert.equal(sent.options.signal, undefined, 'a save cannot use the speech/read abort signal');
  assert.deepEqual(sent.body, { executionId, policyVersion });
  assert.equal(sent.rowsAtDispatch.length, 1);
  const receipt = JSON.parse(sent.rowsAtDispatch[0][1]);
  assert.deepEqual(receipt, { executionId, policyVersion, uncertain: true });
  assert.doesNotMatch(JSON.stringify(sent), /SYNTHETIC_PRIVATE_CLIENT|SYNTHETIC_PRIVATE_SERVICE/u);
  assert.equal(f.rows().length, 0);
});

for (const [name, change] of [
  [
    'assistant disabled',
    (f) => {
      f.state.assistantScope.enabled = false;
    },
  ],
  [
    'save capability absent',
    (f) => {
      delete f.state.assistantScope.appointmentSavingEnabled;
    },
  ],
  [
    'save capability disabled',
    (f) => {
      f.state.assistantScope.appointmentSavingEnabled = false;
    },
  ],
  [
    'different organization',
    (f) => {
      f.state.assistantScope.organizationId = '10000000-0000-4000-8000-000000000002';
    },
  ],
  [
    'malformed execution token',
    (_f, command) => {
      command.executionId = 'not-a-uuid';
    },
  ],
  [
    'missing policy version',
    (f) => {
      delete f.state.assistantScope.policyVersion;
    },
  ],
  [
    'negative policy version',
    (f) => {
      f.state.assistantScope.policyVersion = -1;
    },
  ],
  [
    'unsafe policy version',
    (f) => {
      f.state.assistantScope.policyVersion = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    'wrong action kind',
    (_f, command) => {
      command.type = 'clientCard';
    },
  ],
])
  test('save refuses before a POST when ' + name, async (t) => {
    const f = fixture(t),
      command = action();
    change(f, command);
    await assert.rejects(() => f.api.saveAssistantAppointment(command));
    assert.equal(f.calls.length, 0);
    assert.equal(f.rows().length, 0);
  });

test('same-token concurrent callers share one in-flight save instead of posting twice', async (t) => {
  let release;
  const f = fixture(
    t,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = f.api.saveAssistantAppointment(action());
  const second = f.api.saveAssistantAppointment(action());
  await Promise.resolve();
  assert.equal(f.calls.length, 1);
  release(saved());
  const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => result.saved === true));
  assert.equal(f.calls.length, 1);
  assert.equal(f.rows().length, 0);
});

test('unknown outcome retries exactly the same token once and accepts an already-saved receipt', async (t) => {
  const f = fixture(t, async (_call, count) => {
    if (count === 1) throw unknown();
    return saved({ alreadySaved: true });
  });
  const result = await f.api.saveAssistantAppointment(action());
  assert.equal(result.saved, true);
  assert.equal(result.alreadySaved, true);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(
    f.calls.map((call) => call.body),
    [
      { executionId, policyVersion },
      { executionId, policyVersion },
    ],
  );
  assert.equal(JSON.parse(f.calls[1].rowsAtDispatch[0][1]).uncertain, true);
  assert.equal(f.rows().length, 0);
});

test('a known initial refusal does not retry and clears its non-uncertain pending token', async (t) => {
  const f = fixture(t, async () => {
    throw rejected(400);
  });
  await assert.rejects(
    () => f.api.saveAssistantAppointment(action()),
    (error) => error.status === 400,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.rows().length, 0);
});

test('a known refusal after an unknown outcome cannot erase uncertainty or claim that no save occurred', async (t) => {
  const f = fixture(t, async (_call, count) => {
    throw count === 1 ? unknown() : rejected(409);
  });
  await assert.rejects(
    () => f.api.saveAssistantAppointment(action()),
    (error) => {
      assert.equal(error.outcomeUnknown, true);
      return true;
    },
  );
  assert.equal(f.calls.length, 2);
  assert.deepEqual(JSON.parse(f.rows()[0][1]), { executionId, policyVersion, uncertain: true });
});

test('reload reconciles an unresolved token before any new command and never sends the new token if the old save succeeded', async (t) => {
  const rows = await unresolved(t);
  const f = fixture(t, async () => saved({ alreadySaved: true }), { rows });
  const result = await f.api.saveAssistantAppointment(action(nextExecutionId));
  assert.equal(result.saved, true);
  assert.equal(result.text, 'Предыдущая запись сохранена. Повторите новую команду.');
  assert.deepEqual(
    f.calls.map((call) => call.body),
    [{ executionId, policyVersion }],
  );
  assert.equal(f.rows().length, 0);
});

test('reload never sends a new token when reconciliation still has an unknown outcome', async (t) => {
  const rows = await unresolved(t);
  const f = fixture(
    t,
    async () => {
      throw unknown();
    },
    { rows },
  );
  await assert.rejects(() => f.api.saveAssistantAppointment(action(nextExecutionId)));
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((call) => call.body.executionId === executionId));
  assert.deepEqual(JSON.parse(f.rows()[0][1]), { executionId, policyVersion, uncertain: true });
});

test('definitive expiry clears pending and surfaces an ordinary error rather than uncertain-save feedback', async (t) => {
  const f = fixture(t, async () => expired());
  await assert.rejects(
    () => f.api.saveAssistantAppointment(action()),
    (error) => {
      assert.notEqual(error.outcomeUnknown, true);
      assert.match(error.message, /ист[её]к|Повторите команду/u);
      return true;
    },
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.rows().length, 0);
});

test('definitive expiry of the unresolved old token permits exactly the requested new token afterwards', async (t) => {
  const rows = await unresolved(t);
  const f = fixture(
    t,
    async (call) => (call.body.executionId === executionId ? expired() : saved()),
    { rows },
  );
  const result = await f.api.saveAssistantAppointment(action(nextExecutionId));
  assert.equal(result.saved, true);
  assert.deepEqual(
    f.calls.map((call) => call.body.executionId),
    [executionId, nextExecutionId],
  );
  assert.equal(f.rows().length, 0);
});

for (const [name, change] of [
  [
    'account object replaced',
    (f) => {
      f.state.account = { ...f.state.account };
    },
  ],
  [
    'account switched',
    (f) => {
      f.state.account.id = '40000000-0000-4000-8000-000000000002';
    },
  ],
  [
    'organization switched',
    (f) => {
      f.state.account.organizationId = '10000000-0000-4000-8000-000000000002';
    },
  ],
  [
    'role switched',
    (f) => {
      f.state.account.role = 'salon_admin';
    },
  ],
  [
    'assistant generation replaced',
    (f) => {
      f.state.assistantGeneration++;
    },
  ],
  [
    'policy version mutated in place',
    (f) => {
      f.state.assistantScope.policyVersion++;
    },
  ],
  [
    'view switched',
    (f) => {
      f.state.currentView = 'clients';
    },
  ],
  [
    'editor opened',
    (f) => {
      f.state.editorMode = { kind: 'appointment' };
    },
  ],
  [
    'document hidden',
    (f) => {
      f.setHidden(true);
    },
  ],
])
  test(
    'late saved response clears its original receipt but does not confirm into a changed UI: ' +
      name,
    async (t) => {
      let release;
      const f = fixture(
        t,
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const pending = f.api.saveAssistantAppointment(action());
      await Promise.resolve();
      assert.equal(f.calls.length, 1);
      change(f);
      release(saved());
      assert.equal(await pending, false);
      assert.equal(f.rows().length, 0, 'completion belongs to the original scoped storage key');
      assert.deepEqual(f.ui, []);
    },
  );

test('unavailable session storage prevents even the first POST', async (t) => {
  const f = fixture(t);
  Object.defineProperty(f.w, 'sessionStorage', {
    configurable: true,
    get() {
      throw Error('Synthetic storage denied');
    },
  });
  await assert.rejects(() => f.api.saveAssistantAppointment(action()));
  assert.equal(f.calls.length, 0);
});

test('malformed scoped pending data fails before any POST rather than silently forgetting an uncertain save', async (t) => {
  const rows = await unresolved(t);
  const f = fixture(t, null, { rows: [[rows[0][0], '{"executionId":']] });
  await assert.rejects(() => f.api.saveAssistantAppointment(action(nextExecutionId)));
  assert.equal(f.calls.length, 0);
  assert.equal(f.rows()[0][1], '{"executionId":');
});

test('pending reconciliation is isolated across accounts and organizations', async (t) => {
  const rows = await unresolved(t);
  for (const [name, change] of [
    [
      'account',
      (f) => {
        f.state.account.id = '40000000-0000-4000-8000-000000000002';
      },
    ],
    [
      'organization',
      (f) => {
        f.state.account.organizationId = '10000000-0000-4000-8000-000000000002';
        f.state.assistantScope.organizationId = f.state.account.organizationId;
      },
    ],
  ]) {
    const f = fixture(t, null, { rows });
    change(f);
    await f.api.saveAssistantAppointment(action(nextExecutionId));
    assert.deepEqual(
      f.calls.map((call) => call.body.executionId),
      [nextExecutionId],
      name,
    );
    assert.deepEqual(f.rows(), rows, 'the other scoped receipt is not consumed or erased');
  }
});

test('HTTP success with an invalid confirmation remains uncertain rather than displaying a false success', async (t) => {
  const f = fixture(t, async () => ({ ...saved(), appointmentId: null }));
  await assert.rejects(
    () => f.api.saveAssistantAppointment(action()),
    (error) => error.outcomeUnknown === true,
  );
  assert.equal(f.calls.length, 1, 'malformed success is not blindly retried in a new request');
  assert.deepEqual(JSON.parse(f.rows()[0][1]), { executionId, policyVersion, uncertain: true });
});

test('session storage write failure prevents POST even when its existing data can be read', async (t) => {
  const f = fixture(t);
  Object.defineProperty(f.w.Storage.prototype, 'setItem', {
    configurable: true,
    value() {
      throw Error('Synthetic storage quota');
    },
  });
  await assert.rejects(() => f.api.saveAssistantAppointment(action()));
  assert.equal(f.calls.length, 0);
});

test('replay after a policy update uses the persisted version and accepts its already-saved receipt', async (t) => {
  const rows = await unresolved(t);
  const f = fixture(t, async () => saved({ alreadySaved: true }), { rows });
  f.state.assistantScope.policyVersion = policyVersion + 1;
  const result = await f.api.saveAssistantAppointment(action(nextExecutionId));
  assert.equal(result.saved, true);
  assert.deepEqual(
    f.calls.map((call) => call.body),
    [{ executionId, policyVersion }],
  );
  assert.equal(f.rows().length, 0);
});

test('HTTP known refusal while replaying an already-uncertain saved token preserves that token', async (t) => {
  const rows = await unresolved(t);
  const f = fixture(
    t,
    async () => {
      throw rejected(403);
    },
    { rows },
  );
  await assert.rejects(
    () => f.api.saveAssistantAppointment(action(nextExecutionId)),
    (error) => error.outcomeUnknown === true,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.executionId, executionId);
  assert.deepEqual(f.rows(), rows);
});

test('reload after a role change reconciles the previous account-and-organization token before a new command', async (t) => {
  const rows = await unresolved(t);
  const f = fixture(t, async () => saved({ alreadySaved: true }), { rows });
  f.state.account.role = 'salon_admin';
  const result = await f.api.saveAssistantAppointment(action(nextExecutionId));
  assert.equal(result.saved, true);
  assert.equal(result.text, 'Предыдущая запись сохранена. Повторите новую команду.');
  assert.deepEqual(
    f.calls.map((call) => call.body.executionId),
    [executionId],
  );
  assert.equal(f.rows().length, 0);
});

test('a changed account refuses an uncertain replay without erasing its original receipt or retrying', async (t) => {
  const rows = await unresolved(t);
  const refusal = Object.assign(Error('Synthetic changed account'), {
    status: 428,
    code: 'AUTH_CONTEXT_CHANGED',
    outcomeUnknown: false,
  });
  const f = fixture(
    t,
    async () => {
      throw refusal;
    },
    { rows },
  );
  await assert.rejects(
    () => f.api.saveAssistantAppointment(action(nextExecutionId)),
    (error) => error === refusal && error.outcomeUnknown === false,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.executionId, executionId);
  assert.deepEqual(f.rows(), rows);
  assert.deepEqual(f.ui, []);
});

for (const status of [401, 403, 500]) {
  test(
    'first response ' +
      status +
      ' preserves a token that may have committed before access/error changed',
    async (t) => {
      const f = fixture(t, async () => {
        throw rejected(status);
      });
      await assert.rejects(
        () => f.api.saveAssistantAppointment(action()),
        (error) => error.outcomeUnknown === true,
      );
      assert.equal(f.calls.length, 1);
      assert.equal(JSON.parse(f.rows()[0][1]).uncertain, true);
    },
  );
}

// CANCEL-EXECUTION-36

const cancelAction = (id = executionId) => ({
  type: 'cancelAppointment',
  executionId: id,
  patientId: 'SYNTHETIC_PRIVATE_CLIENT',
  appointmentId: 'SYNTHETIC_PRIVATE_APPOINTMENT',
});
const cancelled = (extra = {}) =>
  saved({ cancelled: true, operation: 'cancel', text: 'Запись отменена.', ...extra });
const cancelReceipt = (id = executionId) => ({
  executionId: id,
  policyVersion,
  operation: 'cancel',
  uncertain: true,
});
async function unresolvedCancellation(t) {
  const f = fixture(t, async () => {
    throw unknown();
  });
  await assert.rejects(
    () => f.api.saveAssistantAppointment(cancelAction()),
    (error) => {
      assert.equal(error.outcomeUnknown, true);
      assert.equal(error.message, 'Результат отмены пока неизвестен. Повторите проверку.');
      return true;
    },
  );
  assert.equal(f.calls.length, 2);
  assert.deepEqual(JSON.parse(f.rows()[0][1]), cancelReceipt());
  return f.rows();
}

test('cancellation persists only its operation and opaque execution token before dispatch', async (t) => {
  const f = fixture(t, async () => cancelled());
  const result = await f.api.saveAssistantAppointment(cancelAction());
  assert.equal(result.cancelled, true);
  assert.equal(result.operation, 'cancel');
  assert.equal(f.calls.length, 1);
  const sent = f.calls[0];
  assert.equal(sent.url, '/api/assistant/execute');
  assert.equal(sent.options.method, 'POST');
  assert.equal(sent.options.signal, undefined);
  assert.deepEqual(sent.body, { executionId, policyVersion });
  assert.deepEqual(JSON.parse(sent.rowsAtDispatch[0][1]), cancelReceipt());
  assert.doesNotMatch(JSON.stringify(sent), /SYNTHETIC_PRIVATE_|patientId|appointmentId/u);
  assert.equal(f.rows().length, 0);
});

test('a cancellation accepts the permanent already-saved replay even when its appointment was deleted later', async (t) => {
  const f = fixture(t, async () => cancelled({ alreadySaved: true, appointmentId: null }));
  const result = await f.api.saveAssistantAppointment(cancelAction());
  assert.equal(result.cancelled, true);
  assert.equal(result.alreadySaved, true);
  assert.equal(result.appointmentId, null);
  assert.equal(f.rows().length, 0);
});

for (const [label, reply] of [
  ['create receipt', saved()],
  ['missing cancellation flag', saved({ operation: 'cancel' })],
  ['wrong operation', cancelled({ operation: 'create' })],
  ['missing initial appointment id', cancelled({ appointmentId: null })],
])
  test('an invalid cancellation confirmation stays uncertain: ' + label, async (t) => {
    const f = fixture(t, async () => reply);
    await assert.rejects(
      () => f.api.saveAssistantAppointment(cancelAction()),
      (error) => {
        assert.equal(error.outcomeUnknown, true);
        assert.equal(error.message, 'Не удалось подтвердить отмену. Повторите проверку.');
        return true;
      },
    );
    assert.equal(f.calls.length, 1);
    assert.deepEqual(JSON.parse(f.rows()[0][1]), cancelReceipt());
    assert.deepEqual(f.ui, []);
  });

test('a creation cannot accept a cancellation receipt as if the new appointment was saved', async (t) => {
  const f = fixture(t, async () => cancelled());
  await assert.rejects(
    () => f.api.saveAssistantAppointment(action()),
    (error) => error.outcomeUnknown === true,
  );
  assert.deepEqual(JSON.parse(f.rows()[0][1]), { executionId, policyVersion, uncertain: true });
});

test('an unknown cancellation retries the same token only once and consumes a verified replay', async (t) => {
  const f = fixture(t, async (_call, count) => {
    if (count === 1) throw unknown();
    return cancelled({ alreadySaved: true, appointmentId: null });
  });
  assert.equal((await f.api.saveAssistantAppointment(cancelAction())).cancelled, true);
  assert.deepEqual(
    f.calls.map((call) => call.body),
    [
      { executionId, policyVersion },
      { executionId, policyVersion },
    ],
  );
  assert.ok(f.calls.every((call) => JSON.parse(call.rowsAtDispatch[0][1]).operation === 'cancel'));
  assert.equal(f.rows().length, 0);
});

test('reload reconciles a cancellation before allowing a new creation', async (t) => {
  const rows = await unresolvedCancellation(t);
  const f = fixture(t, async () => cancelled({ alreadySaved: true, appointmentId: null }), {
    rows,
  });
  const result = await f.api.saveAssistantAppointment(action(nextExecutionId));
  assert.equal(result.text, 'Предыдущая запись отменена. Повторите новую команду.');
  assert.equal(result.cancelled, true);
  assert.deepEqual(
    f.calls.map((call) => call.body),
    [{ executionId, policyVersion }],
  );
  assert.equal(f.rows().length, 0);
});

test('reload reconciles an old creation before allowing a new cancellation', async (t) => {
  const rows = await unresolved(t);
  const f = fixture(t, async () => saved({ alreadySaved: true }), { rows });
  const result = await f.api.saveAssistantAppointment(cancelAction(nextExecutionId));
  assert.equal(result.text, 'Предыдущая запись сохранена. Повторите новую команду.');
  assert.equal(result.cancelled, undefined);
  assert.deepEqual(
    f.calls.map((call) => call.body),
    [{ executionId, policyVersion }],
  );
  assert.equal(f.rows().length, 0);
});

test('unknown cancellation reconciliation retains its operation and never dispatches a new creation', async (t) => {
  const rows = await unresolvedCancellation(t);
  const f = fixture(
    t,
    async () => {
      throw unknown();
    },
    { rows },
  );
  await assert.rejects(
    () => f.api.saveAssistantAppointment(action(nextExecutionId)),
    (error) => error.outcomeUnknown === true,
  );
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((call) => call.body.executionId === executionId));
  assert.deepEqual(f.rows(), rows);
});

test('definitive expiry of an old cancellation permits exactly the requested new creation', async (t) => {
  const rows = await unresolvedCancellation(t);
  const f = fixture(
    t,
    async (call) => (call.body.executionId === executionId ? expired() : saved()),
    { rows },
  );
  const result = await f.api.saveAssistantAppointment(action(nextExecutionId));
  assert.equal(result.saved, true);
  assert.deepEqual(
    f.calls.map((call) => call.body.executionId),
    [executionId, nextExecutionId],
  );
  assert.equal(JSON.parse(f.calls[1].rowsAtDispatch[0][1]).operation, undefined);
  assert.equal(f.rows().length, 0);
});

for (const firstCancel of [false, true])
  test(
    'concurrent create and cancel share the active account mutation: firstCancel=' + firstCancel,
    async (t) => {
      let release;
      const f = fixture(
        t,
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const first = f.api.saveAssistantAppointment(firstCancel ? cancelAction() : action());
      const second = f.api.saveAssistantAppointment(
        firstCancel ? action(nextExecutionId) : cancelAction(nextExecutionId),
      );
      await Promise.resolve();
      assert.equal(f.calls.length, 1, 'the second operation waits; it cannot repost the old token');
      release(firstCancel ? cancelled() : saved());
      assert.equal((await first).saved, true);
      const result = await second;
      assert.equal(
        result.text,
        firstCancel
          ? 'Предыдущая запись отменена. Повторите новую команду.'
          : 'Предыдущая запись сохранена. Повторите новую команду.',
      );
      assert.equal(
        f.calls.length,
        1,
        'no second execution token is dispatched after reconciliation',
      );
      assert.equal(f.rows().length, 0);
    },
  );

test('same-token cancellation callers still share one request', async (t) => {
  let release;
  const f = fixture(
    t,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = f.api.saveAssistantAppointment(cancelAction());
  const second = f.api.saveAssistantAppointment(cancelAction());
  await Promise.resolve();
  assert.equal(f.calls.length, 1);
  release(cancelled());
  assert.ok((await Promise.all([first, second])).every((reply) => reply.cancelled === true));
  assert.equal(f.calls.length, 1);
});

test('a late cancellation commit clears its original receipt without confirming into a changed account', async (t) => {
  let release;
  const f = fixture(
    t,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.api.saveAssistantAppointment(cancelAction());
  await Promise.resolve();
  f.state.account = { ...f.state.account, id: nextExecutionId };
  release(cancelled());
  assert.equal(await pending, false);
  assert.equal(f.rows().length, 0);
  assert.deepEqual(f.ui, []);
});

test('an unrecognized persisted operation blocks dispatch rather than forgetting an uncertain mutation', async (t) => {
  const rows = await unresolvedCancellation(t);
  const f = fixture(t, null, {
    rows: [[rows[0][0], JSON.stringify({ ...cancelReceipt(), operation: 'other' })]],
  });
  await assert.rejects(() => f.api.saveAssistantAppointment(action(nextExecutionId)));
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.parse(f.rows()[0][1]).operation, 'other');
});

// AUTO-MOVE-37

const moveAction = (id = executionId) => ({ type: 'moveAppointment', executionId: id });
const moved = (extra = {}) =>
  saved({
    moved: true,
    operation: 'move',
    text: 'Перенёс запись на 20 октября в 15:00.',
    ...extra,
  });
const moveReceipt = () => ({ executionId, policyVersion, uncertain: true, operation: 'move' });
async function unresolvedMove(t) {
  const f = fixture(t, async () => {
    throw unknown();
  });
  await assert.rejects(
    () => f.api.saveAssistantAppointment(moveAction()),
    (error) => error.outcomeUnknown === true,
  );
  assert.equal(f.calls.length, 2);
  assert.deepEqual(JSON.parse(f.rows()[0][1]), moveReceipt());
  return f.rows();
}
test('move uses only opaque execution metadata and clears its pending operation after confirmed commit', async (t) => {
  const f = fixture(t, async () => moved());
  const result = await f.api.saveAssistantAppointment(moveAction());
  assert.equal(result.moved, true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, { executionId, policyVersion });
  assert.deepEqual(JSON.parse(f.calls[0].rowsAtDispatch[0][1]), moveReceipt());
  assert.equal(f.rows().length, 0);
});
for (const reply of [
  saved(),
  cancelled(),
  moved({ moved: false }),
  moved({ cancelled: true }),
  moved({ appointmentId: null }),
])
  test(
    'move rejects an unproven or wrong-operation result and retains uncertainty: ' +
      JSON.stringify(reply),
    async (t) => {
      const f = fixture(t, async () => reply);
      await assert.rejects(
        () => f.api.saveAssistantAppointment(moveAction()),
        (error) => error.outcomeUnknown === true,
      );
      assert.deepEqual(JSON.parse(f.rows()[0][1]), moveReceipt());
    },
  );
test('a verified moved marker replay accepts null ID and retries the same token once after a lost response', async (t) => {
  const f = fixture(t, async (_call, count) => {
    if (count === 1) throw unknown();
    return moved({ alreadySaved: true, appointmentId: null });
  });
  assert.equal((await f.api.saveAssistantAppointment(moveAction())).moved, true);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((c) => c.body.executionId === executionId));
  assert.equal(f.rows().length, 0);
});
for (const next of [action, cancelAction])
  test(
    'reload reconciles an old move before another requested operation: ' + next().type,
    async (t) => {
      const rows = await unresolvedMove(t);
      const f = fixture(t, async () => moved({ alreadySaved: true, appointmentId: null }), {
        rows,
      });
      const result = await f.api.saveAssistantAppointment(next(nextExecutionId));
      assert.equal(result.text, 'Предыдущая запись перенесена. Повторите новую команду.');
      assert.equal(result.moved, true);
      assert.deepEqual(
        f.calls.map((c) => c.body.executionId),
        [executionId],
      );
    },
  );
test('a pending cancellation is reconciled before a new move', async (t) => {
  const rows = await unresolvedCancellation(t);
  const f = fixture(t, async () => cancelled({ alreadySaved: true, appointmentId: null }), {
    rows,
  });
  const result = await f.api.saveAssistantAppointment(moveAction(nextExecutionId));
  assert.equal(result.cancelled, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.executionId, executionId);
});
test('concurrent move and cancellation share one account mutation without dispatching a second token', async (t) => {
  let release;
  const f = fixture(
    t,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = f.api.saveAssistantAppointment(moveAction());
  const second = f.api.saveAssistantAppointment(cancelAction(nextExecutionId));
  assert.equal(f.calls.length, 1);
  release(moved());
  await first;
  assert.equal((await second).text, 'Предыдущая запись перенесена. Повторите новую команду.');
  assert.equal(f.calls.length, 1);
});
test('a late move outcome clears its receipt without feedback into another account', async (t) => {
  let release;
  const f = fixture(
    t,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.api.saveAssistantAppointment(moveAction());
  f.state.account = { ...f.state.account, id: nextExecutionId };
  release(moved());
  assert.equal(await pending, false);
  assert.equal(f.rows().length, 0);
});
