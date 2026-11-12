function encode(context, registration, table, key, value) {
  return context.seal({ format: 1, storeId: registration.store_id, table, key, value });
}
function decode(context, registration, table, key, blob) {
  const value = context.open(blob);
  if (
    !value ||
    value.format !== 1 ||
    value.storeId !== registration.store_id ||
    value.table !== table ||
    JSON.stringify(value.key) !== JSON.stringify(key) ||
    !Object.hasOwn(value, 'value')
  )
    throw Error('Assistant row encrypted identity mismatch');
  return value.value;
}
module.exports = { encode, decode };
