// Test setup only: a new explicit synthetic intent against its actual endpoint.
// Race/stale/negative-auth cases must capture their own expectation and call connect directly.
function connectFresh(store, token, subscription) {
  const { bindingExpectation } = store.status(token, subscription.endpoint);
  return store.connect(token, subscription, bindingExpectation);
}
module.exports = { connectFresh };
