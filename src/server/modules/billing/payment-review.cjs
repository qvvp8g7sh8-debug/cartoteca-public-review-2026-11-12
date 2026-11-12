const { createPaymentReviewProvider } = require('./payment-review-provider.cjs');
const ACTIONS = [
  'reconcile',
  'retry_create',
  'request_refund_review',
  'request_receipt_review',
  'check_refund',
  'check_receipt',
];
function createPaymentReview(core, settings, ledger) {
  const {
    db,
    open,
    seal,
    transaction,
    now,
    fail,
    ready,
    admin,
    fields,
    identifier,
    fingerprint,
    audit,
  } = core;
  const remote = createPaymentReviewProvider(core, settings, ledger);
  function auditSnapshot(row) {
    const dto = ledger.adminView(row);
    return {
      revision: ledger.revision(row),
      paymentState: row.state,
      paidConfirmed: row.paid_confirmed_at !== null,
      packageIssued: row.fulfilled_at !== null,
      reconciliationStatus: dto.reconciliation.status,
      refundStatus: dto.refund.status,
      closingReceiptStatus: dto.closingReceipt.status,
      knownRefundedKopecks: dto.refund.knownRefundedKopecks,
    };
  }
  const notices = {
    safe_retry_disabled:
      'Административное создание платежа выключено. Сверьте существующий платёж по ID; неизвестный результат не считается неоплаченным.',
    merchant_unavailable: 'Сверка приостановлена: нужен текущий ключ того же магазина и режима.',
    payment_id_required:
      'Нужен идентификатор платежа из кабинета провайдера. Оплата вручную не подтверждается.',
    restored_requires_reconcile: 'Сначала выполните явную сверку восстановленного заказа.',
    provider_unavailable:
      'Провайдер не подтвердил результат. Доступ и денежная история не изменены.',
    payment_mismatch: 'Платёж не совпал с суммой, кабинетом, заказом или тестовым режимом.',
    reference_mismatch: 'Указанный объект провайдера не относится к этому платежу.',
    payment_not_confirmed: 'Сначала подтвердите исходный платёж через сверку.',
    order_changed: 'Заказ изменился во время проверки. Обновите его состояние.',
    refund_review_required:
      'Заявка сохранена. Возврат денег не отправлен; требуется согласованный регламент.',
    receipt_review_required:
      'Заявка сохранена. Закрывающий чек не создан; налоговый сценарий требует согласования.',
    paid_access_blocked:
      'Оплата подтверждена; выдача пакета требует проверки владельца или действующего доступа.',
  };
  function guard(actorId, assertCurrent) {
    if (assertCurrent) {
      const result = assertCurrent();
      if (result && typeof result.then === 'function')
        throw Error('Payment guard must be synchronous.');
    }
    admin(actorId);
  }
  function validate(input) {
    fields(input, [
      'checkoutId',
      'action',
      'expectedRevision',
      'requestId',
      'reason',
      'paymentId',
      'referenceId',
    ]);
    identifier(input.checkoutId);
    identifier(input.requestId);
    if (
      !ACTIONS.includes(input.action) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      typeof input.reason !== 'string' ||
      input.reason.trim().length < 3 ||
      input.reason.trim().length > 500
    )
      throw fail(400, 'Укажите действие, версию заказа и причину сверки.');
    if (
      input.paymentId !== undefined &&
      (input.action !== 'reconcile' ||
        typeof input.paymentId !== 'string' ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(input.paymentId))
    )
      throw fail(400, 'Неверный идентификатор исходного платежа.');
    if (['check_refund', 'check_receipt'].includes(input.action)) {
      if (
        typeof input.referenceId !== 'string' ||
        !/^(?:rt[-_])?[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(input.referenceId)
      )
        throw fail(400, 'Укажите идентификатор существующего возврата или чека.');
    } else if (input.referenceId !== undefined) throw fail(400, 'Лишний идентификатор проверки.');
  }
  const operation = (actorId, requestId) =>
    db
      .prepare('SELECT * FROM billing_payment_operations WHERE actor_id=? AND request_id=?')
      .get(actorId, requestId);
  function completeOperation(actorId, input, digest, result) {
    db.prepare(
      'UPDATE billing_payment_operations SET value=? WHERE actor_id=? AND request_id=? AND fingerprint=?',
    ).run(seal({ phase: 'done', result }), actorId, input.requestId, digest);
    return result;
  }
  function reserve(actorId, input, assertCurrent) {
    return transaction(() => {
      guard(actorId, assertCurrent);
      const digest = fingerprint({ kind: 'payment-review', input }),
        prior = operation(actorId, input.requestId);
      if (prior && prior.fingerprint !== digest)
        throw fail(409, 'Номер операции уже использован с другими параметрами.');
      const previous = prior ? open(prior.value) : null;
      const row = ledger.load(input.checkoutId);
      if (!row) throw fail(404, 'Заказ не найден.');
      if (previous?.phase === 'done') {
        const restored = ledger.value(row).restoredReview;
        return {
          result: {
            ...ledger.adminView(row),
            operation: {
              ...previous.result.operation,
              ...(restored
                ? {
                    code: 'restored_requires_reconcile',
                    notice: notices.restored_requires_reconcile,
                  }
                : {}),
              replayed: true,
            },
          },
        };
      }
      if (previous && previous.leaseUntil > now())
        return {
          result: { ...ledger.adminView(row), operation: { status: 'pending', replayed: true } },
        };
      const data = ledger.value(row);
      if (previous && previous.lockedRevision !== ledger.revision(row)) {
        const result = {
          ...ledger.adminView(row),
          operation: { status: 'done', code: 'order_changed', notice: notices.order_changed },
        };
        return { result: completeOperation(actorId, input, digest, result) };
      }
      if (!previous && ledger.revision(row) !== input.expectedRevision)
        throw fail(409, 'Заказ изменился. Обновите список перед сверкой.');
      if (row.lease_until > now() || data.reviewLock?.leaseUntil > now())
        throw fail(409, 'Другая операция ещё проверяет заказ. Дождитесь результата.');
      data.reviewLock = { actorId, requestId: input.requestId, leaseUntil: now() + 30000 };
      const locked = ledger.save(row, data),
        value = {
          phase: 'pending',
          leaseUntil: now() + 30000,
          lockedRevision: ledger.revision(locked),
        };
      if (prior)
        db.prepare(
          'UPDATE billing_payment_operations SET value=? WHERE actor_id=? AND request_id=?',
        ).run(seal(value), actorId, input.requestId);
      else
        db.prepare('INSERT INTO billing_payment_operations VALUES(?,?,?,?,?)').run(
          actorId,
          input.requestId,
          digest,
          seal(value),
          now(),
        );
      return { row: locked, digest, lockedRevision: value.lockedRevision };
    });
  }
  function finish(actorId, input, reservation, outcome, assertCurrent) {
    return transaction(() => {
      guard(actorId, assertCurrent);
      let row = ledger.load(input.checkoutId),
        data = ledger.value(row),
        code = outcome.code || 'provider_verified';
      const before = auditSnapshot(row);
      if (ledger.revision(row) !== reservation.lockedRevision) {
        outcome = { kind: 'blocked', code: 'order_changed' };
        code = outcome.code;
      }
      if (outcome.kind === 'payment') {
        if (!ledger.matched(row, outcome.dto)) {
          outcome = { kind: 'blocked', code: 'payment_mismatch' };
          code = outcome.code;
        } else {
          ledger.applyInTransaction(row.id, outcome.dto, {
            allowRestored: input.action === 'reconcile',
          });
          row = ledger.load(row.id);
          data = ledger.value(row);
          if (row.state === 'review') code = 'paid_access_blocked';
        }
      }
      if (outcome.kind === 'refund') {
        const records = data.refunds || [],
          prior = records.find((item) => item.id === outcome.dto.id),
          next = records
            .filter((item) => item.id !== outcome.dto.id)
            .concat({
              id: outcome.dto.id,
              paymentId: outcome.dto.paymentId,
              status: outcome.dto.status,
              amountKopecks: outcome.dto.amountKopecks,
              currency: outcome.dto.currency,
              receiptRegistration: outcome.dto.receiptRegistration ?? null,
              checkedAt: now(),
            });
        const sum = next
          .filter((item) => item.status === 'succeeded')
          .reduce((total, item) => total + BigInt(item.amountKopecks), 0n);
        if (
          next.length > 20 ||
          sum > BigInt(row.price_kopecks) ||
          (prior &&
            (prior.amountKopecks !== outcome.dto.amountKopecks ||
              (prior.status === 'succeeded' && outcome.dto.status !== 'succeeded')))
        ) {
          outcome = { kind: 'blocked', code: 'reference_mismatch' };
          code = outcome.code;
        } else {
          data.refunds = next;
          data.refundReview = null;
          if (core.packages.multipleServices() && sum === BigInt(row.price_kopecks))
            core.packages.revokeOrder(row.id, outcome.dto.id);
        }
      }
      if (outcome.kind === 'receipt') {
        const records = data.receipts || [],
          prior = records.find((item) => item.id === outcome.dto.id),
          next = records
            .filter((item) => item.id !== outcome.dto.id)
            .concat({
              id: outcome.dto.id,
              type: outcome.dto.type,
              paymentId: outcome.dto.paymentId,
              status: outcome.dto.status,
              classification:
                outcome.dto.classification === 'prepayment_offset_observed'
                  ? 'prepayment_offset_observed'
                  : 'unclassified',
              checkedAt: now(),
            });
        if (
          next.length > 20 ||
          (prior?.status === 'succeeded' && outcome.dto.status !== 'succeeded')
        ) {
          outcome = { kind: 'blocked', code: 'reference_mismatch' };
          code = outcome.code;
        } else {
          data.receipts = next;
          data.receiptReview = null;
        }
      }
      if (outcome.kind === 'local') {
        if (row.paid_confirmed_at === null) {
          outcome = { kind: 'blocked', code: 'payment_not_confirmed' };
          code = outcome.code;
        } else if (input.action === 'request_refund_review') {
          data.refundReview = { requestedAt: now(), actorId };
          code = 'refund_review_required';
        } else {
          data.receiptReview = { requestedAt: now(), actorId };
          code = 'receipt_review_required';
        }
      }
      if (data.reviewLock?.actorId === actorId && data.reviewLock?.requestId === input.requestId)
        delete data.reviewLock;
      data.reconciliation = {
        status:
          outcome.kind === 'blocked'
            ? 'blocked'
            : code === 'paid_access_blocked'
              ? 'required'
              : 'checked',
        code,
        checkedAt: now(),
      };
      row = ledger.save(row, data);
      const result = {
        ...ledger.adminView(row),
        operation: {
          status: 'done',
          code,
          notice: notices[code] || 'Техническая проверка завершена.',
          replayed: false,
        },
      };
      completeOperation(actorId, input, reservation.digest, result);
      audit('billing_payment_review', actorId, row.organization_id, {
        targetId: row.id,
        reason: input.reason.trim(),
        operationId: input.requestId,
        before,
        after: { ...auditSnapshot(row), action: input.action, resultCode: code },
      });
      return result;
    });
  }
  async function review(actorId, input, { assertCurrent } = {}) {
    ready();
    guard(actorId, assertCurrent);
    validate(input);
    const reservation = reserve(actorId, input, assertCurrent);
    if (reservation.result) return reservation.result;
    const outcome = await remote.perform(reservation.row, input);
    return finish(actorId, input, reservation, outcome, assertCurrent);
  }
  return { review };
}
module.exports = { createPaymentReview };
