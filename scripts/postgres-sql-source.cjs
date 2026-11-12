const acorn = require('acorn');

// A bounded source evaluator, not eval/require of the application's modules.
// Unknown parameters, mutations and builders stay explicitly unresolved.
function sourceModel(source) {
  const tree = acorn.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    locations: true,
  });
  const parents = new Map(),
    bindings = new Map(),
    mutations = new Set();
  function visit(node, parent, scope) {
    if (!node || typeof node.type !== 'string') return;
    parents.set(node, parent);
    if (node.type === 'Program' || /Function/.test(node.type) || node.type === 'BlockStatement')
      scope = node;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      const entries = bindings.get(node.id.name) || [];
      entries.push({ scope, init: node.init, node });
      bindings.set(node.id.name, entries);
    }
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      ['push', 'pop', 'splice', 'shift', 'unshift'].includes(node.callee.property.name) &&
      node.callee.object.type === 'Identifier'
    )
      mutations.add(node.callee.object.name);
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier')
      mutations.add(node.left.name);
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach((child) => visit(child, node, scope));
      else if (value && typeof value.type === 'string') visit(value, node, scope);
    }
  }
  visit(tree, null, tree);
  const union = (values) => [...new Set(values)];
  let rootExpression, branchChoices, discovered, memo, evaluations;
  function combine(left, right, callback) {
    if (!left || !right || left.length * right.length > 128) return null;
    return union(left.flatMap((a) => right.map((b) => callback(a, b))));
  }
  function parameter(name, node, seen) {
    let current = node;
    while ((current = parents.get(current))) {
      if (!/Function/.test(current.type)) continue;
      const call = parents.get(current);
      const parameterIndex = current.params.findIndex(
        (entry) =>
          entry.name === name || (entry.type === 'AssignmentPattern' && entry.left.name === name),
      );
      const functionName =
        current.type === 'FunctionDeclaration'
          ? current.id?.name
          : call?.type === 'VariableDeclarator'
            ? call.id.name
            : null;
      if (parameterIndex >= 0 && functionName) {
        const referenced = new Set();
        nodes(rootExpression, (entry) => {
          if (
            entry.type === 'Identifier' &&
            current.params.some(
              (parameter) =>
                parameter.name === entry.name ||
                (parameter.type === 'AssignmentPattern' && parameter.left.name === entry.name),
            )
          )
            referenced.add(entry.name);
        });
        // Independent parameter unions invent calls that never occur (e.g.
        // another queue's SET lease_id on a client table). Actual builder
        // capture covers these dependent tuples as one real function call.
        if (referenced.size > 1) return null;
        const collected = [],
          defaultParameter = current.params[parameterIndex];
        let owner = parents.get(current);
        while (
          owner &&
          !['Program', 'BlockStatement'].includes(owner.type) &&
          !/Function/.test(owner.type)
        )
          owner = parents.get(owner);
        if (defaultParameter.type === 'AssignmentPattern') {
          const defaults = evaluate(defaultParameter.right, seen);
          if (defaults) collected.push(...defaults);
        }
        nodes(tree, (candidate) => {
          if (
            candidate.type === 'CallExpression' &&
            candidate.callee.type === 'Identifier' &&
            candidate.callee.name === functionName &&
            candidate.start >= owner.start &&
            candidate.end <= owner.end
          ) {
            const variants = evaluate(candidate.arguments[parameterIndex], seen);
            if (variants) collected.push(...variants);
          }
        });
        if (collected.length) return union(collected);
      }
      if (
        call?.type !== 'CallExpression' ||
        call.callee.type !== 'MemberExpression' ||
        call.callee.property.name !== 'map' ||
        call.arguments[0] !== current
      )
        continue;
      const pattern = current.params[0],
        index =
          pattern?.type === 'ArrayPattern'
            ? pattern.elements.findIndex((element) => element?.name === name)
            : -1;
      if (pattern?.name !== name && index < 0) continue;
      const inputs = evaluate(call.callee.object, seen);
      if (!inputs || inputs.some((input) => !Array.isArray(input))) return null;
      return union(
        inputs.flatMap((input) => input.map((value) => (index < 0 ? value : value[index]))),
      );
    }
    return null;
  }
  function evaluate(node, seen = new Set()) {
    if (!node || seen.has(node) || ++evaluations > 20000) return null;
    if (memo?.has(node)) return memo.get(node);
    const result = valueOf(node, seen);
    if (result) memo?.set(node, result);
    return result;
  }
  function valueOf(node, seen) {
    if (!node || seen.has(node)) return null;
    seen = new Set(seen);
    seen.add(node);
    if (node.type === 'Literal' && !node.regex) return [node.value];
    if (node.type === 'Identifier') {
      if (mutations.has(node.name)) return null;
      const candidates = (bindings.get(node.name) || []).filter(
        (binding) => binding.scope.start <= node.start && binding.scope.end >= node.end,
      );
      candidates.sort((a, b) => a.scope.end - a.scope.start - (b.scope.end - b.scope.start));
      const selected = candidates[0];
      if (!selected) return parameter(node.name, node, seen);
      if (selected.init) return evaluate(selected.init, seen);
      const declaration = parents.get(selected.node),
        loop = parents.get(declaration);
      if (loop?.type === 'ForOfStatement') {
        const arrays = evaluate(loop.right, seen);
        return arrays && union(arrays.flat());
      }
      return null;
    }
    if (node.type === 'ConditionalExpression') {
      const key = source.slice(node.test.start, node.test.end).replace(/\s+/g, '');
      if (branchChoices?.has(key))
        return evaluate(branchChoices.get(key) ? node.consequent : node.alternate, seen);
      discovered?.add(key);
      const left = evaluate(node.consequent, seen),
        right = evaluate(node.alternate, seen);
      return left && right && union([...left, ...right]);
    }
    if (node.type === 'LogicalExpression') {
      const left = evaluate(node.left, seen),
        right = evaluate(node.right, seen);
      return left && right && union([...left, ...right]);
    }
    if (node.type === 'BinaryExpression' && node.operator === '+')
      return combine(evaluate(node.left, seen), evaluate(node.right, seen), (a, b) => a + b);
    if (node.type === 'TemplateLiteral') {
      let variants = [node.quasis[0].value.cooked];
      for (let index = 0; index < node.expressions.length; index++) {
        variants = combine(
          variants,
          evaluate(node.expressions[index], seen),
          (a, b) => a + b + node.quasis[index + 1].value.cooked,
        );
        if (!variants) return null;
      }
      return variants;
    }
    if (node.type === 'ArrayExpression') {
      let variants = [[]];
      for (const element of node.elements) {
        const values = evaluate(element, seen);
        if (!values || values.length * variants.length > 128) return null;
        variants = variants.flatMap((array) => values.map((value) => [...array, value]));
      }
      return variants;
    }
    if (node.type === 'MemberExpression' && node.computed) {
      const arrays = evaluate(node.object, seen),
        keys = evaluate(node.property, seen);
      return arrays && keys && combine(arrays, keys, (array, key) => array?.[key]);
    }
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.property.name === 'join'
    ) {
      const arrays = evaluate(node.callee.object, seen),
        delimiters = node.arguments.length ? evaluate(node.arguments[0], seen) : [','];
      return (
        arrays &&
        arrays.every(Array.isArray) &&
        combine(arrays, delimiters, (array, delimiter) => array.join(delimiter))
      );
    }
    return null;
  }
  function resolve(node) {
    rootExpression = node;
    branchChoices = null;
    discovered = new Set();
    memo = new Map();
    evaluations = 0;
    const initial = evaluate(node),
      keys = [...discovered];
    if (!keys.length) return initial;
    if (keys.length > 7) return null;
    const result = [];
    for (let variant = 0; variant < 2 ** keys.length; variant++) {
      branchChoices = new Map(keys.map((key, index) => [key, !Boolean(variant & (1 << index))]));
      memo = new Map();
      const values = evaluate(node);
      if (!values) {
        branchChoices = null;
        return null;
      }
      result.push(...values);
      if (result.length > 512) {
        branchChoices = null;
        return null;
      }
    }
    branchChoices = null;
    return union(result);
  }
  return { tree, parents, evaluate: resolve };
}
function nodes(tree, callback) {
  if (!tree || typeof tree.type !== 'string') return;
  callback(tree);
  for (const [key, value] of Object.entries(tree)) {
    if (['loc', 'start', 'end'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => nodes(child, callback));
    else if (value && typeof value.type === 'string') nodes(value, callback);
  }
}
module.exports = { sourceModel, nodes };
