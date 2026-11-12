const { createHash } = require('node:crypto');
const { fail } = require('../../../../shared/errors.cjs');
const { limitsForMember } = require('./member-limits.cjs');
function createAssistantPolicy(context, store, { codex, localSpeech } = {}) {
  const { db, open } = context;
  function assertAdmin(actorId) {
    if (typeof actorId !== 'string' || !actorId)
      throw fail(403, 'Недостаточно платформенных полномочий.');
    if (
      !db
        .prepare("SELECT 1 FROM accounts WHERE id=? AND global_admin=1 AND status='active'")
        .get(actorId)
    )
      throw fail(403, 'Настройки помощника доступны только главному администратору.');
  }
  function membership(organizationId, accountId) {
    if (typeof organizationId !== 'string' || typeof accountId !== 'string') return null;
    const row = db
      .prepare(
        `SELECT m.role,m.status,m.created_at,a.status account_status,
      a.global_admin,o.status organization_status FROM memberships m
      JOIN accounts a ON a.id=m.account_id JOIN organizations o ON o.id=m.organization_id
      WHERE m.organization_id=? AND m.account_id=?`,
      )
      .get(organizationId, accountId);
    return memberFromRow(organizationId, accountId, row);
  }
  function memberFromRow(organizationId, accountId, row) {
    if (!row) return null;
    return {
      organizationId,
      accountId,
      role: row.role,
      status: row.status,
      active:
        row.status === 'active' &&
        row.account_status === 'active' &&
        row.organization_status === 'active' &&
        !row.global_admin &&
        ['owner', 'salon_admin', 'cosmetologist'].includes(row.role),
      membershipId: createHash('sha256')
        .update(JSON.stringify([organizationId, accountId, row.created_at]))
        .digest('base64url'),
    };
  }
  function effective(state, member) {
    if (!member?.active) return { enabled: false, reason: 'Нет активного членства в организации.' };
    if (state.policy.mode !== 'selected')
      return { enabled: false, reason: 'Помощник выключен главным администратором.' };
    let paid = false,
      connected = false;
    try {
      connected =
        context.billing?.hasServiceConnection(member.organizationId, 'voice-assistant') === true;
      paid = context.billing?.isServiceEnabled(member.organizationId, 'voice-assistant') === true;
    } catch {
      return { enabled: false, reason: 'Не удалось проверить подключение платного помощника.' };
    }
    if (connected && !paid)
      return { enabled: false, reason: 'Платный голосовой помощник отключён для кабинета.' };
    if (paid)
      return {
        enabled: true,
        reason: 'Платный голосовой помощник подключён к кабинету.',
        billing: { paid: true, service: 'voice-assistant' },
      };
    const granted = state.grants.some(
      (grant) =>
        grant.membershipId === member.membershipId &&
        grant.organizationId === member.organizationId &&
        grant.accountId === member.accountId,
    );
    if (!granted)
      return { enabled: false, reason: 'Участие в закрытом тестировании не разрешено.' };
    return { enabled: true, reason: 'Доступ к закрытому тестированию включён.' };
  }
  function providerStatus() {
    return {
      codex: {
        available: Boolean(codex?.available && typeof codex.run === 'function'),
        localOnly: true,
        billing: 'codex-subscription',
      },
      local: {
        available: Boolean(localSpeech?.available && typeof localSpeech.run === 'function'),
        localOnly: true,
        billing: 'local',
        stt: {
          available: Boolean(
            localSpeech?.available &&
            localSpeech?.sttAvailable &&
            typeof localSpeech.run === 'function',
          ),
        },
        tts: {
          available: Boolean(
            localSpeech?.available &&
            localSpeech?.ttsAvailable &&
            typeof localSpeech.run === 'function',
          ),
        },
      },
    };
  }
  function providerReady(kind, provider, state) {
    if (provider === 'demo') return true;
    if (provider === 'codex') return providerStatus().codex.available;
    if (provider === 'local') return Boolean(providerStatus().local[kind]?.available);
    return provider === 'timeweb' && Boolean(state.credentials.timeweb);
  }
  function evaluateAccess(current, state, knownMember) {
    const scope = {
      enabled: false,
      organizationId: current?.organizationId || null,
      policyVersion: state.revision,
    };
    // The default-off feature must not add identity/organization reads to startup.
    if (state.policy.mode !== 'selected' || !current?.organizationId || current.globalAdmin)
      return { scope, member: null };
    const member =
      knownMember === undefined
        ? membership(current.organizationId, current.accountId)
        : knownMember;
    const decision = effective(state, member);
    const allowed =
      current &&
      member?.role === current.role &&
      !current.globalAdmin &&
      ['owner', 'salon_admin', 'cosmetologist'].includes(current.role) &&
      decision.enabled;
    if (!allowed) return { scope, member };
    const providers = Object.entries(state.providers);
    return {
      scope: {
        ...scope,
        enabled: true,
        ...(decision.billing ? { billing: decision.billing } : {}),
        ready: providers.every(([kind, p]) => providerReady(kind, p.provider, state)),
        demo: providers.every(([, p]) => p.provider === 'demo'),
        capabilities: Object.fromEntries(
          Object.entries(state.providers).map(([kind, p]) => [
            kind,
            {
              demo: p.provider === 'demo',
              ...(kind === 'tts' && p.provider === 'timeweb'
                ? { streaming: true, directPcm: false, turnTicket: true }
                : {}),
              ...(kind === 'stt' && ['local', 'timeweb'].includes(p.provider)
                ? { contextHints: true, availabilityTurn: true }
                : {}),
              ready: providerReady(kind, p.provider, state),
              ...(p.provider === 'local' ? { local: true } : {}),
            },
          ]),
        ),
        commands: { ...state.policy.commands },
        limits: limitsForMember(state, member),
      },
      member,
    };
  }
  function inspect(current, provided) {
    const read = () => {
      if (store.backend === 'rows-v1' && typeof store.readScope === 'function') {
        const result = store.readScope(current);
        const state = { ...result.state, grants: result.grant ? [result.grant] : [] };
        const member = memberFromRow(current?.organizationId, current?.accountId, result.memberRow);
        return { ...evaluateAccess(current, state, member), state };
      }
      const base = store.backend === 'rows-v1' ? store.readPolicy() : provided || store.read();
      let state = base;
      if (store.backend === 'rows-v1') {
        const granted =
          base.policy.mode === 'selected' && current?.organizationId && !current.globalAdmin
            ? store.grant(current.organizationId, current.accountId)
            : null;
        state = { ...base, grants: granted ? [granted] : [] };
      }
      return { ...evaluateAccess(current, state), state };
    };
    return store.backend === 'rows-v1' ? store.readSnapshot(read) : read();
  }
  function inspectAccess(current) {
    if (store.backend === 'rows-v1' || typeof store.readAccess !== 'function')
      return inspect(current);
    const { state, member } = store.readAccess((mode) =>
      mode === 'selected' && current?.organizationId && !current.globalAdmin
        ? membership(current.organizationId, current.accountId)
        : null,
    );
    return { ...evaluateAccess(current, state, member), state };
  }
  function access(current, state) {
    return (state ? inspect(current, state) : inspectAccess(current)).scope;
  }
  function requireScope(current, revision, provided) {
    const { scope, member, state } = inspect(current, provided);
    if (!scope.enabled) throw fail(403, 'Доступ к голосовому помощнику выключен.');
    if (!Number.isSafeInteger(revision) || revision !== state.revision)
      throw fail(409, 'Настройки помощника изменились. Откройте его заново.');
    return {
      state: { ...state, policy: { ...state.policy, limits: { ...scope.limits } } },
      scope,
      member,
    };
  }
  function memberships() {
    const rows = db
      .prepare(
        `SELECT m.organization_id,m.account_id,m.role,m.status,
      a.value account_value,o.value organization_value FROM memberships m
      JOIN accounts a ON a.id=m.account_id JOIN organizations o ON o.id=m.organization_id
      WHERE a.global_admin=0 ORDER BY m.created_at DESC LIMIT 101`,
      )
      .all();
    return {
      memberships: rows.slice(0, 100).map((row) => ({
        ...membership(row.organization_id, row.account_id),
        displayName: open(row.account_value).displayName || '',
        organizationName: open(row.organization_value).name || '',
      })),
      membershipsTruncated: rows.length > 100,
    };
  }
  return {
    assertAdmin,
    membership,
    effective,
    access,
    inspect,
    inspectAccess,
    requireScope,
    memberships,
    providerStatus,
  };
}
module.exports = { createAssistantPolicy };
