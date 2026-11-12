// Fixed process-local owners only. A lease spans pre-authority, one physical RR
// operation, and post-authority. No queue, tenant pools, replacement or replay.
function createFixedReadOwnerPool166({ owners }) {
  if (
    !Array.isArray(owners) ||
    ![1, 2].includes(owners.length) ||
    new Set(owners).size !== owners.length ||
    owners.some(
      (owner) =>
        !owner ||
        ['authority', 'run', 'sqlCalls', 'close', 'available166'].some(
          (name) => typeof owner[name] !== 'function',
        ),
    )
  )
    throw Error('Invalid fixed read owner pool166');
  const slots = owners.map((owner) => ({ owner, leased: false })),
    totals = { borrows: 0, rejected: 0, released: 0 };
  let next = 0,
    closing = false,
    closed = false,
    closePromise,
    drained;
  return {
    capacity166: slots.length,
    borrow166() {
      if (!closing) {
        for (let offset = 0; offset < slots.length; offset++) {
          const index = (next + offset) % slots.length,
            slot = slots[index];
          if (slot.leased || !slot.owner.available166()) continue;
          slot.leased = true;
          next = (index + 1) % slots.length;
          totals.borrows++;
          let released = false;
          return {
            owner: slot.owner,
            release() {
              if (released) return;
              released = true;
              slot.leased = false;
              totals.released++;
              if (closing && slots.every((entry) => !entry.leased)) drained?.();
            },
          };
        }
      }
      totals.rejected++;
      return null;
    },
    stats() {
      return {
        capacity: slots.length,
        borrowed: slots.filter((slot) => slot.leased).length,
        available: closing
          ? 0
          : slots.filter((slot) => !slot.leased && slot.owner.available166()).length,
        unhealthy: slots.filter((slot) => !slot.owner.available166()).length,
        ...totals,
        closing,
        closed,
      };
    },
    close() {
      if (!closePromise) {
        closing = true;
        closePromise = (async () => {
          if (slots.some((slot) => slot.leased))
            await new Promise((resolve) => {
              drained = resolve;
            });
          const results = await Promise.allSettled(
            slots.map((slot) => Promise.resolve().then(() => slot.owner.close())),
          );
          closed = true;
          const failed = results.find((result) => result.status === 'rejected');
          if (failed) throw failed.reason;
        })();
      }
      return closePromise;
    },
  };
}
module.exports = { createFixedReadOwnerPool166 };
