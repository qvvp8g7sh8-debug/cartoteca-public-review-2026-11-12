const operator = require('../src/client/legal/operator.json');
const { PRIVACY_VERSION } = require('../src/shared/privacy-consent.cjs');
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );

function legalTemplate(html) {
  const fields = {
    PRIVACY_VERSION,
    OPERATOR_NAME: operator.name,
    OPERATOR_INN: operator.inn,
    OPERATOR_OGRNIP: operator.ogrnip,
    OPERATOR_LOCATION: operator.location,
    OPERATOR_EMAIL: operator.email,
    WEBSITE: operator.website,
  };
  return html.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(fields, key)) throw Error('Unknown legal template field: ' + key);
    return escape(fields[key]);
  });
}
module.exports = { legalTemplate };
