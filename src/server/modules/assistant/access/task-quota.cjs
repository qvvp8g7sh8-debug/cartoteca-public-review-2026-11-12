const { createHash } = require('node:crypto');
const { fail } = require('../../../../shared/errors.cjs');
const { createSpeechPermits } = require('../speech/speech-permits.cjs');
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
function createAssistantTaskQuota(context, dialogues, scope, { speechPermitCapacity } = {}) {
  const permits = createSpeechPermits({ capacity: speechPermitCapacity });
  const packages = () => context.billing.packages;
  const paid = (c, version) => scope(c, version).scope.billing?.paid === true;
  function requestId(value) {
    if (typeof value !== 'string' || !UUID.test(value))
      throw fail(400, 'Нужен уникальный номер задачи помощника.');
    return value;
  }
  function begin(c, body, text) {
    if (!paid(c, body.policyVersion)) return null;
    const ticket = packages().reserveTask({
      current: c.current,
      requestId: requestId(body.taskRequestId),
      payloadHash: createHash('sha256')
        .update(JSON.stringify(['initial-command', text]))
        .digest('hex'),
    });
    return { ticket, outbound: false };
  }
  function outbound(task) {
    if (!task || task.outbound) return;
    packages().acceptTask(task.ticket, { outbound: true });
    task.outbound = true;
  }
  function attach(c, request, response, fresh) {
    const dialogueId = response.dialogue?.id || response.action?.executionId;
    if (dialogueId)
      dialogues.get(c, fresh.member, fresh.state, dialogueId).packageTaskRequestId = request;
    const ticket = packages().requireAcceptedTask({ current: c.current, requestId: request });
    if (dialogueId) packages().acceptTask(ticket, { dialogueId });
    return {
      ...response,
      taskRequestId: request,
      speechPermit: permits.issue(
        c,
        ticket,
        response,
        fresh.state.policy?.limits.maxReplyChars,
        c.assistantSpeechReservation,
      ),
    };
  }
  function complete(task, c, response) {
    if (!task) return response;
    packages().acceptTask(task.ticket, {
      ...(response.dialogue?.id || response.action?.executionId
        ? { dialogueId: response.dialogue?.id || response.action.executionId }
        : {}),
    });
    return attach(c, task.ticket.requestId, response, scope(c, response.policyVersion));
  }
  function failed(task) {
    if (!task) return;
    packages().rejectTask(task.ticket, { outbound: task.outbound, uncertain: task.outbound });
  }
  function continuation(c, body, entry) {
    if (!paid(c, body.policyVersion)) return null;
    if (body.cancel === true && !entry?.packageTaskRequestId) return null;
    const request = entry?.packageTaskRequestId;
    packages().requireAcceptedTask({ current: c.current, requestId: requestId(request) });
    return request;
  }
  function finishContinuation(c, request, response) {
    if (!request) return response;
    return attach(c, request, response, scope(c, response.policyVersion));
  }
  function transcribe(c, body, fresh) {
    if (!fresh.scope.billing?.paid) return;
    if (body.dialogueId) {
      const entry = dialogues.get(c, fresh.member, fresh.state, body.dialogueId);
      if (entry.complete || entry.cancelled)
        throw fail(409, 'Диалог уже завершён. Начните новую команду.');
      if (body.dialogueVersion !== entry.version)
        throw fail(409, 'Диалог изменился. Повторите ответ в текущем диалоге.');
      continuation(c, body, entry);
      return;
    }
    requestId(body.taskRequestId);
    const status = packages().status(c.current.organizationId);
    if (!status.active || status.remainingTasks < 1)
      throw Object.assign(
        fail(
          402,
          'Задачи пакета закончились. Продолжите текущий диалог или дождитесь нового периода.',
        ),
        { code: 'ASSISTANT_PACKAGE_EXHAUSTED' },
      );
  }
  function authorizeSpeech(c, body) {
    if (!paid(c, body.policyVersion)) return;
    const ticket = packages().requireAcceptedTask({
      current: c.current,
      requestId: requestId(body.taskRequestId),
    });
    permits.requirePermit(c, ticket, body);
    return { ticket, outbound: true };
  }
  function resume(c, request) {
    return request
      ? {
          ...c,
          assistantTask: {
            ticket: packages().requireAcceptedTask({
              current: c.current,
              requestId: request,
            }),
            outbound: true,
          },
        }
      : c;
  }
  function evidence(c) {
    const ticket = c.assistantTask?.ticket;
    const request = ticket?.requestId || c.assistantTaskRequestId;
    if (!request) return undefined;
    return {
      requestId: request,
      sessionHash: createHash('sha256').update(c.current.sessionId).digest('hex'),
      ...(ticket ? { id: ticket.id, grantId: ticket.grantId, attempt: ticket.attempt } : {}),
    };
  }
  async function response(c, version, run, enabled = paid(c, version)) {
    if (!enabled || c.assistantSpeechReservation) return run(c);
    const reservation = permits.reserve(c, version);
    try {
      return await run({ ...c, assistantSpeechReservation: reservation });
    } finally {
      permits.release(reservation);
    }
  }
  async function execute(c, body, run) {
    if (!paid(c, body.policyVersion)) return run(c, body);
    return response(
      c,
      body.policyVersion,
      async (owned) => {
        const ticket = packages().requireAcceptedTask({
          current: owned.current,
          dialogueId: body.executionId,
        });
        const result = await run(owned, body);
        const fresh = scope(owned, result.policyVersion);
        if (result.recovery)
          return { ...result, recovery: attach(owned, ticket.requestId, result.recovery, fresh) };
        return {
          ...result,
          taskRequestId: ticket.requestId,
          speechPermit: permits.issue(
            owned,
            ticket,
            result,
            fresh.state.policy?.limits.maxReplyChars,
            owned.assistantSpeechReservation,
          ),
        };
      },
      true,
    );
  }
  return {
    begin,
    outbound,
    complete,
    failed,
    continuation,
    finishContinuation,
    transcribe,
    authorizeSpeech,
    resume,
    execute,
    evidence,
    response,
    stats: permits.stats,
    clearSession: permits.clearSession,
    clearAccount: permits.clearAccount,
  };
}
module.exports = { createAssistantTaskQuota };
