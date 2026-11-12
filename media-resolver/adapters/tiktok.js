'use strict';

const createSocialPlatformAdapter = require('./social-platform');

module.exports = createSocialPlatformAdapter({
  id: 'tiktok',
  name: 'TikTok',
  hosts: ['tiktok.com'],
  shortLinkHosts: ['vm.tiktok.com', 'vt.tiktok.com'],
  postPath: /^\/(@[^/]+\/video\/|t\/)/,
  saveInstructions: 'TikTok can save a post to your device through Share → Save video when the creator allows it.'
});
