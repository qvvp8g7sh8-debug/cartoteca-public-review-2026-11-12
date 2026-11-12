// Only scheduling concurrency may change during an exact-step retry. Test
// workers, source, plan, impact selection and every runtime version stay pinned.
const POLICY = 'sealed-steps-v1';

function retryIdentity(identity) {
  if (identity.reusePolicy !== POLICY) return identity;
  const { jobs, ...settings } = identity.settings || {};
  return { ...identity, settings };
}

function retryEnvironment(environment, policy) {
  if (!environment || policy !== POLICY) return environment;
  const { jobs, ...runtime } = environment;
  return runtime;
}

module.exports = { POLICY, retryIdentity, retryEnvironment };
