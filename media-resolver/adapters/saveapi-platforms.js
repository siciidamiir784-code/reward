'use strict';

const createSocialPlatformAdapter = require('./social-platform');

const platformDefinitions = [
  { id: 'x', name: 'X', hosts: ['x.com', 'twitter.com'], shortLinkHosts: ['t.co'] },
  { id: 'pinterest', name: 'Pinterest', hosts: ['pinterest.com'], shortLinkHosts: ['pin.it'] },
  { id: 'likee', name: 'Likee', hosts: ['likee.video'] },
  { id: 'snapchat', name: 'Snapchat', hosts: ['snapchat.com'], shortLinkHosts: ['t.snapchat.com'] },
  { id: 'threads', name: 'Threads', hosts: ['threads.net'] },
  { id: 'vk', name: 'VK', hosts: ['vk.com', 'vk.ru'], shortLinkHosts: ['vk.cc'] },
  { id: '9gag', name: '9GAG', hosts: ['9gag.com'] },
  { id: 'twitch', name: 'Twitch', hosts: ['twitch.tv'] },
  { id: 'rutube', name: 'Rutube', hosts: ['rutube.ru', 'rutube.com'] }
];

module.exports = platformDefinitions.map(definition =>
  createSocialPlatformAdapter({
    ...definition,
    postPath: /^\/.+/,
    saveInstructions: `${definition.name} links can be resolved through SaveAPI when the server key is configured.`
  })
);
