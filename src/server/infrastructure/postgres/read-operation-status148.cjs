const { fail } = require('../../../shared/errors.cjs');
const { operationId, readOperationStatusAsync } = require('../mutation-receipts.cjs');

// The existing status-only HTTP contract, inside the owning READONLY snapshot.
// Each lazy metadata fetch is bounded before ciphertext is loaded. Keeping all
// earlier keys in the next probe also covers the results retained by that RR.
async function readOperationStatus148(operation, prepared, current, url) {
  const id = operationId(url.searchParams.get('id'));
  if (!id) throw fail(400, 'Укажите номер операции.');
  const db = prepared.cabinetDb,
    statement = db.prepare('SELECT value FROM meta WHERE key=?'),
    keys = new Set(),
    decoded = new Map();
  return readOperationStatusAsync(
    {
      async prefetchMeta(names) {
        names.forEach((name) => keys.add(name));
        await operation.probe([
          {
            scope: operation.scope,
            catalog: operation.cabinetCatalog,
            table: 'meta',
            where: 's.key=ANY($2::text[])',
            values: [[...keys]],
          },
        ]);
        await db.prefetchAll(names.map((name) => statement.readRequest('get', [name])));
      },
      get(name) {
        operation.assertActive();
        if (!decoded.has(name)) {
          const row = statement.get(name);
          decoded.set(name, row ? prepared.decode(row.value) : null);
        }
        return decoded.get(name);
      },
    },
    current,
    id,
  );
}
module.exports = { readOperationStatus148 };
