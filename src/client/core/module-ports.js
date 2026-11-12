// The composition root owns the registry. A feature receives only its declared ports.
// Getters deliberately resolve late: factories may call each other after composition.
function createModulePorts(registry, names) {
  const ports = {};
  for (const name of names) {
    Object.defineProperty(ports, name, {
      enumerable: true,
      get() {
        const action = registry[name];
        if (typeof action !== 'function') throw new Error('Unbound module port: ' + name);
        return action;
      },
    });
  }
  return Object.freeze(ports);
}
