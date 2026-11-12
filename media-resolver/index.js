'use strict';

const directFileAdapter = require('./adapters/direct-file');
const facebookAdapter = require('./adapters/facebook');
const instagramAdapter = require('./adapters/instagram');
const tiktokAdapter = require('./adapters/tiktok');
const youtubeAdapter = require('./adapters/youtube');
const saveApiAdapters = require('./adapters/saveapi-platforms');

const socialAdapters = [
  tiktokAdapter,
  facebookAdapter,
  instagramAdapter,
  youtubeAdapter,
  ...saveApiAdapters
];

function isSocialHost(hostname) {
  return socialAdapters.some(adapter => adapter.matchesHost(hostname));
}

function isSocialUrl(url) {
  return socialAdapters.some(adapter => adapter.shouldHandleUrl(url));
}

async function resolveMedia(value, dependencies) {
  let url;
  if (typeof value === 'string' && value.length <= 4096) {
    try {
      url = new URL(value);
    } catch {
      url = null;
    }
  }

  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.protocol === 'http:' && url.port && url.port !== '80') ||
      (url.protocol === 'https:' && url.port && url.port !== '443')) {
    return directFileAdapter.resolve(url || value, dependencies);
  }

  const socialAdapter = socialAdapters.find(adapter => adapter.shouldHandleUrl(url));
  if (socialAdapter) return socialAdapter.resolve(url);
  return directFileAdapter.resolve(url, dependencies);
}

module.exports = {
  adapters: Object.freeze({ ...Object.fromEntries(socialAdapters.map(adapter => [adapter.id, adapter])), directFile: directFileAdapter }),
  isSocialHost,
  isSocialUrl,
  resolveMedia
};
