'use strict';

const path = require('node:path');
const videoExtensions = new Set([
  '.3gp', '.avi', '.flv', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg',
  '.ogv', '.ts', '.webm'
]);

function createSocialPlatformAdapter({ id, name, hosts, shortLinkHosts = [], postPath, saveInstructions }) {
  const matchesHost = hostname => {
    const host = hostname.toLowerCase().replace(/^www\./, '');
    return hosts.some(domain => host === domain || host.endsWith(`.${domain}`));
  };
  const isShortLink = url => shortLinkHosts.includes(url.hostname.toLowerCase().replace(/^www\./, ''));

  return Object.freeze({
    id,
    name,
    matchesHost,
    matchesUrl: url => matchesHost(url.hostname),
    isPostUrl: url => matchesHost(url.hostname) &&
      (postPath.test(url.pathname.toLowerCase()) || (isShortLink(url) && url.pathname !== '/')),
    shouldHandleUrl: url => matchesHost(url.hostname) &&
      (postPath.test(url.pathname.toLowerCase()) ||
       (isShortLink(url) && url.pathname !== '/') ||
       !videoExtensions.has(path.extname(url.pathname).toLowerCase())),
    async resolve() {
      return {
        status: 'unsupported',
        platform: id,
        error: `${name} post links cannot be downloaded by ClipNest right now. ${saveInstructions}`
      };
    }
  });
}

module.exports = createSocialPlatformAdapter;
