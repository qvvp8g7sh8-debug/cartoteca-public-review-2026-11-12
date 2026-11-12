const assert = require('node:assert/strict');

// Test-owned API clients pin only an explicitly returned login/session DTO.
// No network lookup, cookie decoding or implicit browser-fetch interception.
function authContextHeaders(login) {
  const actor = login?.user || login?.account;
  assert.equal(typeof actor?.id, 'string', 'An explicit login actor is required');
  assert.ok(actor.id, 'An explicit login actor is required');
  const organizationId = Object.hasOwn(actor, 'organizationId')
    ? actor.organizationId
    : login.organizationId;
  assert.ok(organizationId == null || typeof organizationId === 'string');
  return {
    'X-Cartoteca-Account-Id': actor.id,
    'X-Cartoteca-Organization-Id': organizationId || '',
  };
}

function scopedPhotoUrl(canonical, expected) {
  assert.match(canonical, /^\/api\/photos\/[^?]+$/);
  assert.equal(typeof expected?.['X-Cartoteca-Account-Id'], 'string');
  assert.equal(typeof expected?.['X-Cartoteca-Organization-Id'], 'string');
  const query = new URLSearchParams({
    accountContext: expected['X-Cartoteca-Account-Id'],
    organizationContext: expected['X-Cartoteca-Organization-Id'],
  });
  return canonical + '?' + query;
}

module.exports = { authContextHeaders, scopedPhotoUrl };
