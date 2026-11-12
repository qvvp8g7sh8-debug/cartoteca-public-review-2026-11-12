const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const { defaults, normalizeSettings, validateSettings, assertSchedule } = require('./policy.cjs');
const { hasOverlapProtection } = require('./overlap.cjs');
const { roomAssignmentValues, assertRoomAssignments } = require('./room-assignments.cjs');
function createWorkspace(context) {
  const { db, open, seal, fail, transaction, audit } = context;
  function workspaceSettings(org) {
    const saved = context.organization(org).workspace;
    if (saved?.rooms?.length) return normalizeSettings(saved);
    const owner = db
      .prepare(
        "SELECT account_id FROM memberships WHERE organization_id=? AND role='owner' ORDER BY created_at LIMIT 1",
      )
      .get(org);
    // A stable default is a read-only projection until the owner saves settings.
    return { ...defaults(owner?.account_id), revision: saved?.revision || 0 };
  }
  workspaceSettings.readRequests = (org) =>
    db.canPrefetchReads
      ? [
          ...context.organization.readRequests(org),
          db
            .prepare(
              "SELECT account_id FROM memberships WHERE organization_id=? AND role='owner' ORDER BY created_at LIMIT 1",
            )
            .readRequest('get', [org]),
        ]
      : [];
  const membersQuery = (scoped) =>
    db.prepare(
      'SELECT m.account_id,m.role,m.status,a.status account_status,a.value FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=?' +
        (scoped ? ' AND m.account_id=?' : '') +
        ' ORDER BY m.created_at',
    );
  const identitiesQuery = (scoped) =>
    db.prepare(
      'SELECT m.account_id,m.role,m.status,a.status account_status FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=?' +
        (scoped ? ' AND m.account_id=?' : '') +
        ' ORDER BY m.created_at',
    );
  function workspaceMembers(org, accountId) {
    return membersQuery(accountId !== undefined)
      .all(...(accountId !== undefined ? [org, accountId] : [org]))
      .map((row) => ({
        accountId: row.account_id,
        displayName: open(row.value).displayName,
        role: row.role,
        status: row.status === 'active' && row.account_status === 'active' ? 'active' : 'suspended',
      }));
  }
  function workspaceIdentities(org, accountId) {
    return identitiesQuery(accountId !== undefined)
      .all(...(accountId !== undefined ? [org, accountId] : [org]))
      .map((row) => ({
        accountId: row.account_id,
        role: row.role,
        status: row.status === 'active' && row.account_status === 'active' ? 'active' : 'suspended',
      }));
  }
  for (const [method, query] of [
    [workspaceMembers, membersQuery],
    [workspaceIdentities, identitiesQuery],
  ])
    method.readRequests = (org, accountId) =>
      db.canPrefetchReads
        ? [
            query(accountId !== undefined).readRequest(
              'all',
              accountId !== undefined ? [org, accountId] : [org],
            ),
          ]
        : [];
  function assertWorkspace(org, state, identities = workspaceIdentities(org)) {
    const settings = workspaceSettings(org),
      members = identities,
      staff = new Set(members.filter((m) => m.status === 'active').map((m) => m.accountId));
    assertSchedule(
      settings,
      state,
      staff,
      context.organizationTimeZone(org),
      Date.now(),
      members.find((m) => m.role === 'owner')?.accountId,
    );
  }
  function assertWorkspaceSelection(org, state, storage, identities) {
    if (!hasOverlapProtection(workspaceSettings(org)) || !state.patients.length) return;
    const changed = new Set(state.patients.map((p) => p.id)),
      neighbors = new Map(),
      days = new Set();
    for (const p of state.patients)
      for (const a of p.appointments) {
        if (!isActiveAppointment(a)) continue;
        const date = new Date(a.date + 'T00:00:00Z');
        date.setUTCDate(date.getUTCDate() - 1);
        const from = date.toISOString().slice(0, 10);
        date.setUTCDate(date.getUTCDate() + 2);
        const to = date.toISOString().slice(0, 10);
        if (days.has(a.date)) continue;
        days.add(a.date);
        for (const other of storage.indexes.appointmentOccupancy(from, to))
          if (!changed.has(other.patientId)) neighbors.set(other.id, other);
      }
    assertWorkspace(
      org,
      { patients: [...state.patients, { appointments: [...neighbors.values()] }] },
      identities,
    );
  }
  function saveWorkspace(org, actor, values, readCabinet) {
    const staffOnly =
      values &&
      typeof values === 'object' &&
      !Array.isArray(values) &&
      Object.hasOwn(values, 'staffRules') &&
      Object.keys(values).every((key) => ['revision', 'staffRules'].includes(key));
    const assignmentsOnly =
      values &&
      typeof values === 'object' &&
      !Array.isArray(values) &&
      Object.hasOwn(values, 'roomAssignments') &&
      Object.keys(values).every((key) => ['revision', 'roomAssignments'].includes(key));
    let next;
    transaction(() => {
      const member = db
        .prepare(
          'SELECT m.role,m.status,a.status account_status,o.status organization_status FROM memberships m JOIN accounts a ON a.id=m.account_id JOIN organizations o ON o.id=m.organization_id WHERE m.organization_id=? AND m.account_id=?',
        )
        .get(org, actor);
      if (
        !(
          member?.role === 'owner' ||
          (member?.role === 'salon_admin' && (staffOnly || assignmentsOnly))
        ) ||
        member.status !== 'active' ||
        member.account_status !== 'active' ||
        member.organization_status !== 'active'
      )
        throw fail(
          403,
          'Параметры кабинетов меняет владелец; назначения, пересечения кабинетов и правила сотрудников — также администратор.',
        );
      const prior = workspaceSettings(org),
        state = readCabinet(),
        members = workspaceMembers(org);
      const input = assignmentsOnly
        ? roomAssignmentValues(values, prior, members)
        : staffOnly
          ? {
              revision: values.revision,
              enabled: prior.enabled,
              mode: prior.mode,
              roomLayout: prior.roomLayout,
              rooms: prior.rooms,
              staffRules: values.staffRules,
            }
          : values;
      next = validateSettings(input, members, prior, state);
      if (assignmentsOnly)
        assertRoomAssignments(
          prior,
          next,
          state,
          context.organizationTimeZone(org),
          members.find((m) => m.role === 'owner')?.accountId,
        );
      assertSchedule(
        next,
        state,
        new Set(members.filter((m) => m.status === 'active').map((m) => m.accountId)),
        context.organizationTimeZone(org),
        Date.now(),
        members.find((m) => m.role === 'owner')?.accountId,
      );
      const row = db.prepare('SELECT value FROM organizations WHERE id=?').get(org);
      db.prepare('UPDATE organizations SET value=? WHERE id=?').run(
        seal({ ...open(row.value), workspace: next }),
        org,
      );
      audit('workspace_updated', actor, org, {
        roomLayout: next.roomLayout,
        enabled: next.enabled,
        staffRuleCount: next.staffRules.length,
        roomCount: next.rooms.length,
      });
    });
    return next;
  }
  return {
    workspaceSettings,
    workspaceMembers,
    workspaceIdentities,
    assertWorkspace,
    assertWorkspaceSelection,
    saveWorkspace,
  };
}
module.exports = { createWorkspace };
