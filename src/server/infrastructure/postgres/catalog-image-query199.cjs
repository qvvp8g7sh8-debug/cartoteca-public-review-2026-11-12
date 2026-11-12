const { variants199 } = require('./catalog-image-sql199.cjs');
const { invalid199 } = require('./catalog-image-anchors199.cjs');

// Selection belongs to the verified physical owner, never request metadata.
// The SQL token gate checks this exact component again in the owning snapshot.
function wrapCatalogImageQuery199(builder, capability, variant) {
  if (!capability) return builder;
  if (
    !Object.hasOwn(variants199, variant) ||
    typeof builder !== 'function' ||
    capability.version !== 1 ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(capability.epoch) ||
    !/^[a-f0-9]{64}$/.test(capability.digest) ||
    typeof capability.variants?.[variant] !== 'boolean'
  )
    throw invalid199();
  if (!capability.variants[variant]) return builder;
  const { oldFunction, functionName, argTypes } = variants199[variant];
  const count = argTypes.split(',').length - 2;
  const oldSQL = `SELECT * FROM ${oldFunction}(${Array.from({ length: count }, (_, i) => '$' + (i + 1)).join(',')})`;
  const newSQL = `SELECT * FROM ${functionName}(${Array.from({ length: count + 2 }, (_, i) => '$' + (i + 1)).join(',')})`;
  const { epoch, digest } = capability;
  return (input) => {
    const plan = builder(input);
    if (plan?.unsupported) return plan;
    if (plan?.text !== oldSQL || !Array.isArray(plan.values) || plan.values.length !== count)
      throw invalid199();
    return { ...plan, text: newSQL, values: [...plan.values, epoch, digest] };
  };
}
module.exports = { wrapCatalogImageQuery199 };
