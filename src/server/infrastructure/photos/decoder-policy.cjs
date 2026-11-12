// Apply before reading metadata: MIME labels do not constrain libvips autodetection.
// This policy is process-wide, so use it only in the isolated photo worker.
function configurePhotoDecoder(sharp) {
  sharp.block({ operation: ['VipsForeignLoad'] });
  sharp.unblock({
    operation: [
      'VipsForeignLoadJpegBuffer',
      'VipsForeignLoadPngBuffer',
      'VipsForeignLoadWebpBuffer',
    ],
  });
}
module.exports = { configurePhotoDecoder };
