const { serialize, deserialize } = require('node:v8');

// Retain exact owned byte storage, never a caller's mutable object graph or slab.
function ownedBytes(value) {
  if (!(value instanceof Uint8Array)) throw TypeError('Retained bytes require Uint8Array.');
  const bytes = Buffer.allocUnsafeSlow(value.byteLength);
  bytes.set(value);
  return bytes;
}
function retainValueBytes(value) {
  return ownedBytes(serialize(value));
}
function readValueBytes(bytes) {
  if (!Buffer.isBuffer(bytes)) throw TypeError('Invalid retained value bytes.');
  // A deserialized typed view must never reference the retained backing store.
  return deserialize(ownedBytes(bytes));
}
module.exports = { ownedBytes, retainValueBytes, readValueBytes };
