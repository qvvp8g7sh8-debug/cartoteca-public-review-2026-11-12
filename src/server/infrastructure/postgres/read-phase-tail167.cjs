const { authorityQuery } = require('./read-session152.cjs');
const denied = (code) => Object.assign(Error(code), { code, status: 503 });

// The caller still owns the physical read client/work lease. This is a queued
// tail, never an authority cache: every invocation executes a new post-COMMIT
// statement and awaits fresh asset/decode/context acceptance before returning.
async function finishRead167({
  sql,
  platform,
  currentScope,
  token,
  accept,
  assertActive,
  onCommitAck,
  onScopeAck,
}) {
  if (
    typeof token !== 'string' ||
    typeof accept !== 'function' ||
    [sql, assertActive, onCommitAck, onScopeAck].some((fn) => typeof fn !== 'function')
  )
    throw denied('POSTGRES_READ_FINISH_CONTEXT167');
  assertActive();
  const key = platform.kind + ':' + platform.storeId,
    auth = authorityQuery(platform, token);
  const pending = [sql('COMMIT')];
  if (currentScope !== key)
    pending.push(
      sql(
        "SELECT set_config('cartoteca.kind',$1,false),set_config('cartoteca.store_id',$2,false)",
        [platform.kind, platform.storeId],
      ),
    );
  const authorityPosition = pending.length;
  pending.push(sql(auth.text, auth.values));
  const results = await Promise.allSettled(pending);
  const commit = results[0];
  if (commit.status === 'rejected') throw commit.reason;
  if (commit.value?.command !== 'COMMIT') throw denied('POSTGRES_READ_COMMIT_INVALID167');
  // Clear transaction ownership even when a later tail statement failed. Every
  // result is already drained, but those later failures cannot authorize output.
  onCommitAck();
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  onScopeAck(key);
  assertActive();
  await accept(results[authorityPosition].value.rows);
  assertActive();
}
module.exports = { finishRead167 };
