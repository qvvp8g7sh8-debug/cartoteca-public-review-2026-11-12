const { markupBps } = require('./money.cjs');
function createWalletSettings(ledger) {
  const { db, ready, available, organization, fail, recordOperation, audit } = ledger;
  function getSettings() {
    const row = available() ? db.prepare('SELECT * FROM billing_settings WHERE id=1').get() : null;
    return {
      available: available(),
      revision: row?.revision || 0,
      defaultMarkupBps: row?.default_markup_bps || 0,
      configured: Boolean(row?.configured),
      insufficientFundsPolicy: row?.insufficient_funds_policy || 'prepaid',
      changedAt: row?.changed_at || null,
    };
  }
  function organizationSettings(organizationId) {
    organization(organizationId);
    const settings = getSettings();
    const row = available()
      ? db
          .prepare('SELECT * FROM billing_organization_settings WHERE organization_id=?')
          .get(organizationId)
      : null;
    return {
      organizationId,
      organizationRevision: row?.revision || 0,
      organization_revision: row?.revision || 0,
      markupBps: row?.markup_bps ?? null,
      effectiveMarkupBps: row?.markup_bps ?? settings.defaultMarkupBps,
    };
  }
  function changeSettings(actorId, input) {
    ready();
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) =>
          ![
            'requestId',
            'expectedRevision',
            'reason',
            'defaultMarkupBps',
            'configured',
            'insufficientFundsPolicy',
          ].includes(key),
      )
    )
      throw fail(400, 'Неверные поля денежных настроек.');
    if (input.defaultMarkupBps !== undefined) markupBps(input.defaultMarkupBps);
    if (input.configured !== undefined && typeof input.configured !== 'boolean')
      throw fail(400, 'Укажите состояние денежного учёта.');
    if (
      input.insufficientFundsPolicy !== undefined &&
      !['unconfigured', 'prepaid'].includes(input.insufficientFundsPolicy)
    )
      throw fail(400, 'Правило недостаточного баланса ещё не поддерживается.');
    return recordOperation(actorId, input, { kind: 'settings', ...input }, (reason) => {
      const before = getSettings();
      if (before.revision !== input.expectedRevision)
        throw fail(409, 'Денежные настройки изменились. Обновите раздел.');
      db.prepare(
        `UPDATE billing_settings SET revision=revision+1,default_markup_bps=?,configured=?,
        insufficient_funds_policy=?,changed_at=? WHERE id=1`,
      ).run(
        input.defaultMarkupBps ?? before.defaultMarkupBps,
        Number(input.configured ?? before.configured),
        input.insufficientFundsPolicy ?? before.insufficientFundsPolicy,
        Date.now(),
      );
      audit('billing_settings_changed', actorId, null, { revision: before.revision + 1, reason });
      return getSettings();
    });
  }
  function setOrganizationSettings(actorId, organizationId, input) {
    ready();
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !['requestId', 'expectedRevision', 'reason', 'markupBps'].includes(key),
      ) ||
      input.markupBps === undefined
    )
      throw fail(400, 'Укажите наценку кабинета или наследование общей.');
    if (input.markupBps !== null) markupBps(input.markupBps);
    return recordOperation(
      actorId,
      input,
      { kind: 'organization', organizationId, ...input },
      (reason) => {
        const before = organizationSettings(organizationId);
        if (before.organizationRevision !== input.expectedRevision)
          throw fail(409, 'Наценка кабинета изменилась. Обновите раздел.');
        db.prepare(
          `INSERT INTO billing_organization_settings(organization_id,revision,markup_bps,changed_at)
        VALUES(?,1,?,?) ON CONFLICT(organization_id) DO UPDATE SET revision=revision+1,markup_bps=excluded.markup_bps,changed_at=excluded.changed_at`,
        ).run(organizationId, input.markupBps, Date.now());
        audit('billing_organization_markup_changed', actorId, organizationId, {
          revision: before.organizationRevision + 1,
          markupBps: input.markupBps,
          reason,
        });
        return organizationSettings(organizationId);
      },
    );
  }
  return { getSettings, organizationSettings, changeSettings, setOrganizationSettings };
}
module.exports = { createWalletSettings };
