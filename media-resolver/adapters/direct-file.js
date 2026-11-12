'use strict';

async function resolve(url, { parseSourceUrl, probe }) {
  const source = parseSourceUrl(url instanceof URL ? url.href : url);
  const metadata = await probe(source);
  return {
    status: 'available',
    platform: 'direct-file',
    source,
    metadata
  };
}

module.exports = { resolve };
