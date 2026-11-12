// Decode in a separate, time-bounded process; never pass untrusted paths to sharp.
const sharp = require('sharp');
const { configurePhotoDecoder } = require('./decoder-policy.cjs');
configurePhotoDecoder(sharp);
sharp.cache(false);
sharp.concurrency(1);
const parts = [];
let length = 0;
process.stdin.on('data', (chunk) => {
  length += chunk.length;
  if (length > 10 * 1024 * 1024) process.exit(1);
  parts.push(chunk);
});
process.stdin.on('end', async () => {
  try {
    const bytes = Buffer.concat(parts);
    const decoder = sharp(bytes, {
      limitInputPixels: 40000000,
      failOn: 'warning',
      animated: false,
    }).timeout({ seconds: 5 });
    const meta = await decoder.metadata();
    if (
      !['jpeg', 'png', 'webp'].includes(meta.format) ||
      meta.format !== process.argv[2] ||
      (meta.pages || 1) !== 1
    )
      throw Error();
    // Force full pixel decoding before resizing or encoding; strip all original metadata.
    const raw = await decoder.rotate().raw().toBuffer({ resolveWithObject: true });
    const image = sharp(raw.data, {
      raw: { width: raw.info.width, height: raw.info.height, channels: raw.info.channels },
    })
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .timeout({ seconds: 5 });
    const output = await image
      .toFormat(
        meta.format,
        meta.format === 'jpeg' ? { quality: 90 } : meta.format === 'webp' ? { lossless: true } : {},
      )
      .toBuffer();
    if (output.length > 10 * 1024 * 1024) throw Error();
    process.stdout.write(output);
  } catch {
    process.exitCode = 1;
  }
});
