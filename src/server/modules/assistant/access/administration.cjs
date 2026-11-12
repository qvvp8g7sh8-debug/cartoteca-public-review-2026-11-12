const { createHash } = require('node:crypto');
const { fail } = require('../../../../shared/errors.cjs');
const { patchSettings, keys, boundedText } = require('./defaults.cjs');
const { normalizedLimits, memberGrant, limitsForMember } = require('./member-limits.cjs');
const { rulesFromPolicy, applyRules } = require('../behavior/behavior-schema.cjs');
const { recordBehaviorChange } = require('../behavior/behavior-history.cjs');
const { createBehaviorAdministration } = require('../behavior/behavior-admin.cjs');
function usageView(state, now = new Date()) {
  const month = now.toISOString().slice(0, 7);
  return {
    month,
    spentRub: state.usage[month]?.spentRub || 0,
    reservedRub: Object.values(state.reservations)
      .filter((r) => r.month === month)
      .reduce((sum, r) => sum + r.amount, 0),
    estimated: true,
  };
}
function createAssistantAdministration(context, store, policy) {
  const read = () => (store.adminSnapshot ? store.adminSnapshot() : store.read());
  const update = (callback) =>
    store.updateAdmin ? store.updateAdmin(callback) : store.update(callback);
  function view(actorId) {
    policy.assertAdmin(actorId);
    const state = read();
    return {
      revision: state.revision,
      policy: state.policy,
      providers: state.providers,
      rates: state.rates,
      credentialStatus: { timeweb: { configured: Boolean(state.credentials.timeweb) } },
      providerStatus: policy.providerStatus(),
      grants: state.grants,
      ...policy.memberships(),
      usage: usageView(state),
      history: state.history.map(({ revision, time }) => ({ revision, time })),
    };
  }
  function command(actorId, body, kind, mutate) {
    policy.assertAdmin(actorId);
    if (
      !body ||
      !Number.isSafeInteger(body.expectedRevision) ||
      body.expectedRevision < 0 ||
      typeof body.requestId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.requestId)
    )
      throw fail(400, 'Нужны версия настроек и уникальный номер операции.');
    const reason = boundedText(body.reason, 300, 'причина').trim();
    if (reason.length < 3) throw fail(400, 'Укажите причину изменения.');
    const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    return context.transaction(() =>
      update((state) => {
        policy.assertAdmin(actorId);
        const prior = state.operations.find(
          (op) => op.actorId === actorId && op.requestId === body.requestId,
        );
        if (prior) {
          if (prior.fingerprint !== fingerprint || prior.kind !== kind)
            throw fail(409, 'Номер операции уже использован для другого изменения.');
          return { revision: prior.revision, replayed: true };
        }
        if (body.expectedRevision !== state.revision)
          throw fail(409, 'Настройки уже изменились. Обновите раздел.');
        const snapshot = {
          revision: state.revision,
          time: Date.now(),
          policy: structuredClone(state.policy),
          providers: structuredClone(state.providers),
          rates: { ...state.rates },
        };
        const beforeRules = rulesFromPolicy(snapshot.policy);
        mutate(state);
        recordBehaviorChange(state, beforeRules, actorId, reason, snapshot.time);
        state.history = [...state.history, snapshot].slice(-10);
        state.revision++;
        state.operations = [
          ...state.operations,
          { actorId, requestId: body.requestId, fingerprint, kind, revision: state.revision },
        ].slice(-100);
        state.audit = [
          ...state.audit,
          {
            time: Date.now(),
            event: kind,
            actorId,
            organizationId: body.organizationId || null,
            detail: {
              reason,
              revision: state.revision,
              enabled: body.enabled ?? undefined,
              accountId: body.accountId || undefined,
              ...(body.limits !== undefined
                ? { limitFields: body.limits === null ? [] : Object.keys(body.limits) }
                : {}),
            },
          },
        ].slice(-100);
        return { revision: state.revision };
      }),
    );
  }
  function settings(actorId, body) {
    policy.assertAdmin(actorId);
    keys(body, [
      'expectedRevision',
      'requestId',
      'reason',
      'policy',
      'providers',
      'rates',
      'timewebApiKey',
    ]);
    command(actorId, body, 'assistant_settings_changed', (state) => {
      const before = rulesFromPolicy(state.policy);
      patchSettings(state, body);
      if (JSON.stringify(before) !== JSON.stringify(rulesFromPolicy(state.policy)))
        throw fail(
          400,
          'Изменяйте инструкции, словарь и примеры в разделе «Примеры поведения» после предпросмотра.',
        );
    });
    return view(actorId);
  }
  function member(actorId, organizationId, accountId) {
    policy.assertAdmin(actorId);
    const state = read(),
      target = policy.membership(organizationId, accountId);
    if (!target) throw fail(404, 'Членство пользователя не найдено.');
    return {
      revision: state.revision,
      membershipId: target.membershipId,
      enabled: Boolean(memberGrant(state, target)),
      limits: memberGrant(state, target)?.limits || null,
      effectiveLimits: limitsForMember(state, target),
      effective: policy.effective(state, target),
    };
  }
  function setMember(actorId, body) {
    policy.assertAdmin(actorId);
    keys(body, [
      'expectedRevision',
      'requestId',
      'reason',
      'organizationId',
      'accountId',
      'enabled',
      'limits',
    ]);
    if (typeof body.enabled !== 'boolean') throw fail(400, 'Укажите состояние доступа.');
    const limits =
      body.limits === undefined || body.limits === null
        ? body.limits
        : normalizedLimits(body.limits, true);
    command(actorId, body, 'assistant_membership_changed', (state) => {
      const target = policy.membership(body.organizationId, body.accountId);
      if (!target || (body.enabled && !target.active))
        throw fail(400, 'Выберите активное членство сотрудника.');
      const previousLimits = memberGrant(state, target)?.limits;
      const nextLimits = limits === undefined ? previousLimits : limits;
      state.grants = state.grants.filter(
        (g) => !(g.organizationId === body.organizationId && g.accountId === body.accountId),
      );
      if (body.enabled) {
        if (state.grants.length >= 500) throw fail(400, 'Достигнут предел участников пилота.');
        state.grants.push({
          organizationId: target.organizationId,
          accountId: target.accountId,
          membershipId: target.membershipId,
          ...(nextLimits && Object.keys(nextLimits).length ? { limits: { ...nextLimits } } : {}),
        });
      }
    });
    return member(actorId, body.organizationId, body.accountId);
  }
  function restore(actorId, body) {
    policy.assertAdmin(actorId);
    keys(body, ['expectedRevision', 'requestId', 'reason', 'revision']);
    command(actorId, body, 'assistant_policy_restored', (state) => {
      const previous = state.history.find((entry) => entry.revision === body.revision);
      if (!previous) throw fail(404, 'Версия политики больше не хранится.');
      const activeRules = rulesFromPolicy(state.policy);
      patchSettings(state, previous);
      applyRules(state, activeRules);
    });
    return view(actorId);
  }
  function audit(actorId) {
    policy.assertAdmin(actorId);
    return { items: read().audit.slice().reverse() };
  }
  const behavior = createBehaviorAdministration(store, policy, command);
  return { view, settings, member, setMember, restore, audit, behavior };
}
module.exports = { createAssistantAdministration, usageView };
