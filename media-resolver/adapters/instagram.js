'use strict';

const createSocialPlatformAdapter = require('./social-platform');

module.exports = createSocialPlatformAdapter({
  id: 'instagram',
  name: 'Instagram',
  hosts: ['instagram.com'],
  postPath: /^\/(p|reel|tv|stories)(\/|$)/,
  saveInstructions: 'Instagram may offer a native Reel download for eligible posts; Save may only bookmark content in the app.'
});
