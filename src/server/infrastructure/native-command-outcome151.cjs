// Only this private admission path can attest that HTTP was never forwarded.
// Error properties or a client header cannot manufacture that evidence.
const rejected = new WeakSet();
function commandNotStarted(error) {
  if (error && typeof error === 'object') rejected.add(error);
  return error;
}
const isCommandNotStarted = (error) =>
  Boolean(error && typeof error === 'object' && rejected.has(error));
module.exports = { commandNotStarted, isCommandNotStarted };
