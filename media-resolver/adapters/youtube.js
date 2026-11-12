'use strict';

const createSocialPlatformAdapter = require('./social-platform');

const adapter = createSocialPlatformAdapter({
  id: 'youtube',
  name: 'YouTube',
  hosts: ['youtube.com', 'youtu.be'],
  shortLinkHosts: ['youtu.be'],
  postPath: /^\/(watch|shorts|live|embed)(\/|$)/,
  saveInstructions: 'YouTube downloads require a SaveAPI plan that supports its YouTube download endpoint.'
});

function getVideoId(value) {
  let url;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    return null;
  }
  if (!adapter.matchesUrl(url)) return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let videoId;
  if (host === 'youtu.be') {
    videoId = url.pathname.split('/')[1];
  } else if (url.pathname.toLowerCase() === '/watch') {
    videoId = url.searchParams.get('v');
  } else {
    videoId = url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/i)?.[1];
  }
  return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId) ? videoId : null;
}

async function resolveDownload(value, { apiKey, requestYouTubeApi, parseSourceUrl, probe }) {
  const videoId = getVideoId(value);
  if (!videoId) {
    return {
      status: 'unsupported',
      platform: 'youtube',
      error: 'Enter a valid public YouTube video, Shorts, or livestream URL.'
    };
  }

  const response = await requestYouTubeApi(value, apiKey, '720p');
  if (!response || response.success !== true || response.platform !== 'youtube' ||
      response.mode !== 'video' || typeof response.url !== 'string' ||
      typeof response.ext !== 'string' || response.ext.toLowerCase() !== 'mp4') {
    return {
      status: 'unsupported',
      platform: 'youtube',
      error: 'SaveAPI did not return a downloadable YouTube MP4 video file. ClipNest will not download a thumbnail, watch page, or audio file.'
    };
  }

  const source = parseSourceUrl(response.url);
  const metadata = await probe(source);
  const expiry = Number(response.expires);
  const expiresAt = Number.isFinite(expiry) && expiry > 0
    ? (expiry < 1_000_000_000_000 ? expiry * 1000 : expiry)
    : undefined;
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    return {
      status: 'unsupported',
      platform: 'youtube',
      error: 'SaveAPI returned an expired YouTube download link. Please try again.'
    };
  }

  return {
    status: 'available',
    platform: 'youtube',
    source,
    metadata,
    expiresAt,
    quality: response.quality
  };
}

module.exports = Object.freeze({ ...adapter, getVideoId, resolveDownload });
