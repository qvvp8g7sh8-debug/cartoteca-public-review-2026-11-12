const fs = require('node:fs');
const crypto = require('node:crypto');
const { finished } = require('node:stream/promises');
const { plainFile, safeTree } = require('./snapshot.cjs');
const path = require('node:path');
const { signS3 } = require('./s3-signing.cjs');

async function fingerprints(file) {
  safeTree(path.dirname(file));
  plainFile(file);
  const sha = crypto.createHash('sha256'),
    md5 = crypto.createHash('md5');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) {
    bytes += chunk.length;
    sha.update(chunk);
    md5.update(chunk);
  }
  return { sha256: sha.digest('hex'), md5: md5.digest('base64'), bytes };
}
function createS3Storage(
  config,
  { fetchImpl = globalThis.fetch, clock = () => new Date(), timeout = 900000 } = {},
) {
  async function request(method, key, query, headers, payloadHash, body, consume) {
    body?.on('error', () => {});
    const signed = signS3({ config, method, key, query, headers, payloadHash, now: clock() });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref();
    let response;
    try {
      response = await fetchImpl(signed.url, {
        method,
        headers: signed.headers,
        redirect: 'error',
        signal: controller.signal,
        ...(body ? { body, duplex: 'half' } : {}),
      });
      if (!response.ok) throw Error('BACKUP_REMOTE_FAILED');
      return await consume(response);
    } catch (error) {
      if (/^BACKUP_REMOTE_(FAILED|RETENTION|CHECKSUM)$/.test(error.message)) throw error;
      throw Error('BACKUP_REMOTE_FAILED');
    } finally {
      clearTimeout(timer);
      body?.destroy();
      if (body) await finished(body, { cleanup: true }).catch(() => {});
      if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
    }
  }
  async function verify(receipt) {
    if (
      !receipt.versionId ||
      receipt.versionId === 'null' ||
      !Number.isSafeInteger(receipt.bytes) ||
      receipt.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
      !Number.isFinite(Date.parse(receipt.retainUntil))
    )
      throw Error('BACKUP_REMOTE_FAILED');
    await request(
      'GET',
      receipt.key,
      { retention: '', versionId: receipt.versionId },
      {},
      undefined,
      null,
      async (response) => {
        let text = '',
          size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 32768) throw Error('BACKUP_REMOTE_RETENTION');
          text += Buffer.from(chunk).toString('utf8');
        }
        const mode = text.match(/<Mode>\s*(COMPLIANCE|GOVERNANCE)\s*<\/Mode>/)?.[1];
        const until = text.match(/<RetainUntilDate>\s*([^<]+)\s*<\/RetainUntilDate>/)?.[1];
        if (
          /<!|&/.test(text) ||
          mode !== 'COMPLIANCE' ||
          !Number.isFinite(Date.parse(until)) ||
          Date.parse(until) < Date.parse(receipt.retainUntil) - 1000 ||
          Date.parse(until) <= clock().getTime()
        )
          throw Error('BACKUP_REMOTE_RETENTION');
      },
    );
    await request(
      'GET',
      receipt.key,
      { versionId: receipt.versionId },
      {},
      undefined,
      null,
      async (response) => {
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > receipt.bytes) throw Error('BACKUP_REMOTE_CHECKSUM');
          hash.update(chunk);
        }
        if (bytes !== receipt.bytes || hash.digest('hex') !== receipt.sha256)
          throw Error('BACKUP_REMOTE_CHECKSUM');
      },
    );
    return true;
  }
  async function upload(file, jobId) {
    const checksum = await fingerprints(file);
    if (checksum.bytes > 5 * 1024 ** 3) throw Error('BACKUP_SOURCE_TOO_LARGE');
    const now = clock(),
      weekly = now.getUTCDay() === 0;
    const key =
      config.prefix +
      '/' +
      (weekly ? 'weekly' : 'daily') +
      '/' +
      now.toISOString().slice(0, 10) +
      '/' +
      jobId +
      '.enc';
    const retainUntil = new Date(now.getTime() + (weekly ? 56 : 30) * 86400000).toISOString();
    const versionId = await request(
      'PUT',
      key,
      {},
      {
        'content-type': 'application/octet-stream',
        'content-length': checksum.bytes,
        'content-md5': checksum.md5,
        'x-amz-object-lock-mode': 'COMPLIANCE',
        'x-amz-object-lock-retain-until-date': retainUntil,
      },
      checksum.sha256,
      fs.createReadStream(file),
      async (response) => response.headers.get('x-amz-version-id'),
    );
    const receipt = { key, versionId, retainUntil, sha256: checksum.sha256, bytes: checksum.bytes };
    await verify(receipt);
    return receipt;
  }
  // Deliberately no deletion, policy-changing, or retention-bypass operation.
  return { upload, verify };
}
module.exports = { createS3Storage, fingerprints };
