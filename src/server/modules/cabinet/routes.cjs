const { readCabinetSnapshot } = require('../../infrastructure/cabinet-read-snapshot.cjs');
const { cabinetForUser } = require('../access/cabinet-policy.cjs');
const { validateState } = require('./validation.cjs');
const { validateChanges, changedResponse } = require('./changes.cjs');
const { saveMutation } = require('./mutations.cjs');
const {
  validateAppointmentCommand,
  createAppointmentMutation,
} = require('./appointment-commands.cjs');
const {
  operationId,
  readReceipt,
  readOperationStatus,
} = require('../../infrastructure/mutation-receipts.cjs');
const routes = [
  {
    method: 'GET',
    path: '/api/cabinet/operation',
    access: 'organization',
    handle(context) {
      const id = operationId(context.url.searchParams.get('id'));
      if (!id)
        return context.json(context.res, 400, {
          error: 'Укажите номер операции.',
        });
      const storage = context.tenantStore(context.current.organizationId);
      if (context.url.searchParams.get('statusOnly') === '1') {
        const status = readCabinetSnapshot(storage, () => {
          context.assertCurrent();
          return readOperationStatus(storage, context.current, id);
        });
        return context.json(context.res, 200, status);
      }
      const receipt = readCabinetSnapshot(storage, () => {
        // assertCurrent is an assertion-only port; a successful guard need not
        // return the actor. The HTTP guard pins the captured identity and role.
        context.assertCurrent();
        return readReceipt(storage, context.current, id);
      });
      if (!receipt) return context.json(context.res, 200, { status: 'unknown' });
      const result = receipt.partial
        ? changedResponse(context.current, receipt.saved, receipt.recipe)
        : cabinetForUser(context.current, receipt.saved);
      if (receipt.partial)
        result.summaries = storage.indexes.summaries(
          context.current,
          receipt.recipe.patients.map((p) => p.id),
        );
      return context.json(context.res, 200, {
        status: 'committed',
        result: context.appointmentState.decorate(result, context.current.organizationId),
      });
    },
  },
  {
    method: 'GET',
    path: '/api/cabinet',
    access: 'organization',
    async handle(context) {
      const { res, current, tenantStore, json } = context;
      return json(
        res,
        200,
        context.appointmentState.decorate(
          {
            ...cabinetForUser(current, tenantStore(current.organizationId).read()),
            ...context.platform.personalEvents?.view(current),
            serviceGroups: context.platform.serviceGroups(current.organizationId),
            serviceCatalog: context.platform.serviceCatalog(current.organizationId),
            partialWrites: true,
            appointmentWrites: true,
            idempotentWrites: true,
          },
          current.organizationId,
        ),
      );
    },
  },
  // Compatibility for old clients and explicit full imports; still uses global revision protection.
  {
    method: 'PUT',
    path: '/api/cabinet',
    access: 'organization',
    async handle(context) {
      const body = await context.readBody(context.req, 50 * 1024 * 1024);
      validateState(body);
      const saved = await saveMutation(context, body);
      return context.json(
        context.res,
        200,
        context.appointmentState.decorate(
          cabinetForUser(context.current, { ...saved, initialized: true }),
          context.current.organizationId,
        ),
      );
    },
  },
  {
    method: 'PATCH',
    path: '/api/cabinet/changes',
    access: 'organization',
    async handle(context) {
      const body = validateChanges(await context.readBody(context.req, 50 * 1024 * 1024));
      const saved = await saveMutation(context, body, { partial: true });
      const result = changedResponse(context.current, saved, body);
      result.summaries = context.tenantStore(context.current.organizationId).indexes.summaries(
        context.current,
        body.patients.map((c) => c.id),
      );
      return context.json(
        context.res,
        200,
        context.appointmentState.decorate(result, context.current.organizationId),
      );
    },
  },
  {
    method: 'POST',
    path: '/api/cabinet/appointments',
    access: 'organization',
    async handle(context) {
      const body = validateAppointmentCommand(await context.readBody(context.req, 5 * 1024 * 1024));
      const saved = await saveMutation(context, body, { appointmentCommand: true });
      const result = changedResponse(
        context.current,
        saved,
        createAppointmentMutation(body).receiptBody,
      );
      result.summaries = context
        .tenantStore(context.current.organizationId)
        .indexes.summaries(context.current, [body.patientId]);
      return context.json(
        context.res,
        200,

        context.req?.headers?.['x-cartoteca-appointment-response'] === 'point-v1'
          ? context.appointmentState.decorate(
              require('./appointment-edit161.cjs').pointResponse(result, body),
              context.current.organizationId,
              { boundedCanonical: true },
            )
          : context.appointmentState.decorate(result, context.current.organizationId),
      );
    },
  },
];
module.exports = { routes };
