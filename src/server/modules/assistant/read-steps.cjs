// Domain readers support both synchronous fixtures/SQLite and native async PG.
// Only promises suspend a step; no transaction or mutating operation is replayed.
function readSteps(operation) {
  return function (...args) {
    const iterator = operation.apply(this, args);
    function advance(method, value) {
      let step = iterator[method](value);
      while (!step.done) {
        if (step.value && typeof step.value.then === 'function')
          return Promise.resolve(step.value).then(
            (result) => advance('next', result),
            (error) => advance('throw', error),
          );
        step = iterator.next(step.value);
      }
      return step.value;
    }
    return advance('next');
  };
}
module.exports = { readSteps };
