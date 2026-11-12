const { fail } = require('../../../shared/errors.cjs');
const { availableRooms, busyIntervals } = require('./policy.cjs');
const { calendarPeriod } = require('../cabinet/queries.cjs');
function view(c) {
  const settings = c.platform.workspaceSettings(c.current.organizationId),
    staff = c.current.role === 'cosmetologist';
  return {
    ...settings,
    canEdit: c.current.role === 'owner',
    canEditRoomAssignments: ['owner', 'salon_admin'].includes(c.current.role),
    canEditRoomOverlap: ['owner', 'salon_admin'].includes(c.current.role),
    canEditStaffRules: ['owner', 'salon_admin'].includes(c.current.role),
    staffRules: staff
      ? (settings.staffRules || []).filter((rule) => rule.staffId === c.current.accountId)
      : settings.staffRules || [],
    rooms: staff
      ? availableRooms(settings, c.current.accountId).map(
          ({ id, name, active, preventOverlap }) => ({
            id,
            name,
            active,
            preventOverlap,
          }),
        )
      : settings.rooms,
    members: staff ? [] : c.platform.workspaceMembers(c.current.organizationId),
  };
}
const routes = [
  {
    method: 'GET',
    path: '/api/workspace',
    access: 'organization',
    handle(c) {
      return c.json(c.res, 200, view(c));
    },
  },
  {
    method: 'POST',
    path: '/api/workspace',
    access: 'organization',
    async handle(c) {
      const body = await c.readBody(c.req);
      c.platform.saveWorkspace(c.current.organizationId, c.current.accountId, body, () =>
        c.tenantStore(c.current.organizationId).read(),
      );
      return c.json(c.res, 200, view(c));
    },
  },
  {
    method: 'GET',
    path: '/api/workspace/availability',
    access: 'organization',
    handle(c) {
      const { from, to } = calendarPeriod(c.url),
        settings = c.platform.workspaceSettings(c.current.organizationId);
      return c.json(c.res, 200, {
        revision: settings.revision,
        busy: busyIntervals(
          settings,
          {
            patients: [
              {
                appointments: c
                  .tenantStore(c.current.organizationId)
                  .indexes.appointments(from, to),
              },
            ],
          },
          c.current,
          from,
          to,
        ),
      });
    },
  },
];
module.exports = { routes };
