// Bounded optimal-string-alignment distance; an adjacent letter swap is one edit.
function boundedNameDistance(a, b, limit) {
  if (
    typeof a !== 'string' ||
    typeof b !== 'string' ||
    a.length > 48 ||
    b.length > 48 ||
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > 3 ||
    Math.abs(a.length - b.length) > limit
  )
    return Infinity;
  if (a === b) return 0;
  let prior = Array.from({ length: b.length + 1 }, (_, index) => index),
    older = null;
  for (let row = 1; row <= a.length; row++) {
    const next = Array(b.length + 1).fill(Infinity);
    next[0] = row;
    for (
      let column = Math.max(1, row - limit);
      column <= Math.min(b.length, row + limit);
      column++
    ) {
      next[column] = Math.min(
        next[column - 1] + 1,
        prior[column] + 1,
        prior[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
      if (
        older &&
        column > 1 &&
        a[row - 1] === b[column - 2] &&
        a[row - 2] === b[column - 1] &&
        /^\p{L}$/u.test(a[row - 1]) &&
        /^\p{L}$/u.test(a[row - 2])
      )
        next[column] = Math.min(next[column], older[column - 2] + 1);
    }
    older = prior;
    prior = next;
  }
  return prior[b.length] <= limit ? prior[b.length] : Infinity;
}
module.exports = { boundedNameDistance };
