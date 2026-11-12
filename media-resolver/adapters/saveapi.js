'use strict';

function isVideo(media) {
  return media && typeof media.url === 'string' &&
    typeof media.type === 'string' && media.type.toLowerCase() === 'video';
}

function selectVideoUrl(response) {
  if (!response || response.success !== true) return null;

  const formats = Array.isArray(response.formats) ? response.formats : [];
  const recommended = formats.find(format =>
    format && format.format === response.recommended_format && isVideo(format)
  );
  const format = recommended || formats.find(isVideo);
  if (format) return format.url;

  const medias = Array.isArray(response.medias) ? response.medias : [];
  return medias.find(isVideo)?.url || null;
}

async function resolve(url, { apiKey, requestSaveApi, parseSourceUrl, probe }) {
  const response = await requestSaveApi(url, apiKey);
  const mediaUrl = selectVideoUrl(response);
  if (!mediaUrl) {
    return {
      status: 'unsupported',
      platform: response && typeof response.platform === 'string' ? response.platform : 'saveapi',
      error: 'SaveAPI did not return a downloadable video for this public link. Check that the platform and post are supported.'
    };
  }

  const source = parseSourceUrl(mediaUrl);
  const metadata = await probe(source);
  return {
    status: 'available',
    platform: response.platform || 'saveapi',
    source,
    metadata
  };
}

module.exports = { resolve, selectVideoUrl };
