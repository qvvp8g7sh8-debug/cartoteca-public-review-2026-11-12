const test = require('node:test'), assert = require('node:assert/strict');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const { createAdminEmailRuntime } = require('../src/server/modules/admin/email-queue.cjs');
function ticket(f, text = 'Синтетический вопрос') {
  return f.store.support.create({ accountId: f.owner.accountId, organizationId: f.owner.organizationId },
    { requestId: f.database.id(), description: text });
}

test('operator workflow is separate from delivery; private notes and mail replies stay isolated', async t => {
  const f = await adminFixture(t), receipt = ticket(f), actor = f.admin.accountId;
  assert.throws(() => f.store.support.receipt(actor, receipt.id), { status: 404 });
  assert.throws(() => f.store.admin.support.detail(f.other.accountId, receipt.id), { status: 403 });
  f.store.admin.support.update(actor, receipt.id, f.command('support', receipt.id, { state: 'in_progress', claim: true }));
  const note = f.command('support', receipt.id, { kind: 'internal', text: 'ВНУТРЕННЯЯ СЕКРЕТНАЯ ЗАМЕТКА' });
  f.store.admin.support.message(actor, receipt.id, note);
  const body = f.command('support', receipt.id, { kind: 'reply', text: 'Ответ пользователю' });
  const result = f.store.admin.support.message(actor, receipt.id, body);
  assert.deepEqual(f.store.admin.support.message(actor, receipt.id, body), result);
  const author = f.store.support.receipt(f.owner.accountId, receipt.id);
  assert.equal(author.state, 'in_progress');
  assert.equal(author.messages.length, 1);
  assert.doesNotMatch(JSON.stringify(author), /СЕКРЕТНАЯ/);
  assert.equal(f.store.admin.support.detail(actor, receipt.id).messages.length, 2);
  assert.equal(author.deliveries.telegram, 'pending');
  const sent = [];
  const runtime = createAdminEmailRuntime({ queue: f.store.admin.emailQueue,
    sendMail: async (email, link, metadata) => sent.push({ email, metadata }) });
  await runtime.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].email, 'owner@admin.test');
  assert.equal(sent[0].metadata.message, 'Ответ пользователю');
  assert.equal(sent[0].metadata.kind, 'support-reply');
  assert.equal(f.store.admin.support.detail(actor, receipt.id).messages.find(x => x.kind === 'reply').deliveries[0].status, 'sent');
});

test('author can reopen only their own case; duplicate answers are idempotent and invalidate stale operator forms', async t => {
  const f = await adminFixture(t), receipt = ticket(f), actor = f.admin.accountId;
  f.store.admin.support.update(actor, receipt.id, f.command('support', receipt.id, { state: 'resolved' }));
  const stale = f.command('support', receipt.id, { state: 'waiting' });
  const body = { requestId: f.database.id(), text: 'Дополнительный вопрос', caseId: receipt.id };
  assert.throws(() => f.store.admin.support.authorReply(f.other.accountId, receipt.id, body), { status: 404 });
  f.store.admin.support.authorReply(f.owner.accountId, receipt.id, body);
  f.store.admin.support.authorReply(f.owner.accountId, receipt.id, body);
  assert.equal(f.store.support.receipt(f.owner.accountId, receipt.id).state, 'new');
  assert.equal(f.store.support.receipt(f.owner.accountId, receipt.id).messages.length, 1);
  assert.throws(() => f.store.admin.support.update(actor, receipt.id, stale), { status: 409 });
  assert.throws(() => f.store.admin.support.authorReply(f.owner.accountId, receipt.id, { ...body, text: 'Другой текст' }), { status: 409 });
  assert.throws(() => f.store.admin.support.conversation(f.other.accountId, receipt.id, {}, true), { status: 404 });
  assert.equal(f.store.admin.support.conversation(f.owner.accountId, receipt.id, {}, true).items.length, 1);
});

test('operator conversation loads bounded history and author never receives internal messages', async t => {
  const f = await adminFixture(t), receipt = ticket(f), actor = f.admin.accountId;
  for (let i = 0; i < 62; i++)
    f.store.admin.support.message(actor, receipt.id, f.command('support', receipt.id,
      { kind: i % 2 ? 'reply' : 'internal', text: 'Синтетическое сообщение ' + i }));
  const first = f.store.admin.support.conversation(actor, receipt.id);
  assert.equal(first.items.length, 50);
  const second = f.store.admin.support.conversation(actor, receipt.id, first.next);
  assert.equal(second.items.length, 12);
  assert.equal(new Set([...first.items, ...second.items].map(x => x.id)).size, 62);
  const author = f.store.admin.support.conversation(f.owner.accountId, receipt.id, {}, true);
  assert.equal(author.items.length, 31);
  assert.equal(author.items.some(x => x.kind === 'internal'), false);
  assert.equal('actorId' in author.items[0], false);
});

test('retention keeps old unresolved cases and deletes only cases resolved more than 90 days ago', async t => {
  const f = await adminFixture(t), open = ticket(f, 'Старый нерешённый вопрос'), resolved = ticket(f, 'Закрытый вопрос');
  const old = Date.now() - 100 * 86400000;
  f.database.db.prepare('UPDATE support_requests SET created_at=? WHERE id IN (?,?)').run(old, open.id, resolved.id);
  f.store.admin.support.update(f.admin.accountId, resolved.id, f.command('support', resolved.id, { state: 'resolved' }));
  f.database.db.prepare('UPDATE support_cases SET resolved_at=? WHERE request_id=?').run(old, resolved.id);
  ticket(f, 'Новое обращение для запуска очистки');
  assert.equal(f.store.support.receipt(f.owner.accountId, open.id).state, 'new');
  assert.throws(() => f.store.support.receipt(f.owner.accountId, resolved.id), { status: 404 });
  assert.equal(f.store.admin.support.page(f.admin.accountId, { state: 'open' }).total, 2);
});

test('queued support email is cancelled if its recipient or operator loses access', async t => {
  for (const target of ['recipient', 'operator']) {
    const f = await adminFixture(t), receipt = ticket(f);
    f.store.admin.support.message(f.admin.accountId, receipt.id,
      f.command('support', receipt.id, { kind: 'reply', text: 'Не отправлять после отзыва доступа' }));
    if (target === 'recipient') f.store.admin.updateAccountAccess(f.admin.accountId, f.owner.accountId,
      f.command('account', f.owner.accountId, { status: 'suspended' }));
    else f.database.db.prepare("UPDATE accounts SET status='suspended' WHERE id=?").run(f.admin.accountId);
    let sends = 0;
    await createAdminEmailRuntime({ queue: f.store.admin.emailQueue, sendMail: async () => { sends++; } }).tick();
    assert.equal(sends, 0);
    assert.equal(f.database.db.prepare('SELECT status FROM admin_email_jobs').get().status, 'cancelled');
  }
});
