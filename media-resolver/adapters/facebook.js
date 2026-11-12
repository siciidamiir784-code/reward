'use strict';

const createSocialPlatformAdapter = require('./social-platform');

module.exports = createSocialPlatformAdapter({
  id: 'facebook',
  name: 'Facebook',
  hosts: ['facebook.com', 'fb.watch'],
  shortLinkHosts: ['fb.watch'],
  postPath: /^\/(watch|reel|videos|share|story\.php|photo\.php)(\/|$)/,
  saveInstructions: 'Facebook’s own download controls are available only for some content; in-app Save can bookmark a post instead of downloading a file.'
});
