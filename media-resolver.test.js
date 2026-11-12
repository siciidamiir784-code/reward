'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { adapters, resolveMedia } = require('./media-resolver');

const platformCases = [
  {
    name: 'TikTok',
    adapter: adapters.tiktok,
    url: 'https://www.tiktok.com/@creator/video/123456789'
  },
  {
    name: 'Facebook',
    adapter: adapters.facebook,
    url: 'https://www.facebook.com/watch/?v=123456789'
  },
  {
    name: 'Instagram',
    adapter: adapters.instagram,
    url: 'https://www.instagram.com/reel/ABC123/'
  },
  {
    name: 'YouTube',
    adapter: adapters.youtube,
    url: 'https://youtu.be/abcdefghijk'
  }
];

const saveApiPlatformCases = [
  { name: 'X', adapter: adapters.x, url: 'https://x.com/creator/status/123' },
  { name: 'Pinterest', adapter: adapters.pinterest, url: 'https://www.pinterest.com/pin/123/' },
  { name: 'Likee', adapter: adapters.likee, url: 'https://likee.video/@creator/video/123' },
  { name: 'Snapchat', adapter: adapters.snapchat, url: 'https://www.snapchat.com/spotlight/123' },
  { name: 'Threads', adapter: adapters.threads, url: 'https://www.threads.net/@creator/post/123' },
  { name: 'VK', adapter: adapters.vk, url: 'https://vk.com/video-1_2' },
  { name: '9GAG', adapter: adapters['9gag'], url: 'https://9gag.com/gag/abc' },
  { name: 'Twitch', adapter: adapters.twitch, url: 'https://www.twitch.tv/creator/clip/Abc' },
  { name: 'Rutube', adapter: adapters.rutube, url: 'https://rutube.ru/video/example/' }
];

for (const { name, adapter, url } of platformCases) {
  test(`${name} adapter recognizes public post links and refuses unsupported file resolution`, async () => {
    const parsedUrl = new URL(url);
    assert.equal(adapter.matchesUrl(parsedUrl), true);
    assert.equal(adapter.isPostUrl(parsedUrl), true);
    const resolution = await resolveMedia(url, {
      parseSourceUrl: () => assert.fail('Social links must not enter the direct-file adapter.'),
      probe: () => assert.fail('Social links must not trigger outbound media requests.')
    });
    assert.equal(resolution.status, 'unsupported');
    assert.equal(resolution.platform, adapter.id);
    assert.match(resolution.error, /cannot be downloaded by ClipNest/i);
  });
}

test('YouTube adapter extracts IDs only from supported video links', () => {
  const expectedId = 'abcdefghijk';
  for (const url of [
    `https://www.youtube.com/watch?v=${expectedId}`,
    `https://m.youtube.com/shorts/${expectedId}`,
    `https://www.youtube.com/live/${expectedId}?feature=share`,
    `https://www.youtube.com/embed/${expectedId}`,
    `https://youtu.be/${expectedId}?si=share`
  ]) {
    assert.equal(adapters.youtube.getVideoId(url), expectedId);
  }

  assert.equal(adapters.youtube.getVideoId('https://www.youtube.com/watch?v=too-short'), null);
  assert.equal(adapters.youtube.getVideoId('https://example.org/watch?v=abcdefghijk'), null);
});

for (const { name, adapter, url } of saveApiPlatformCases) {
  test(`${name} SaveAPI adapter recognizes public post links`, async () => {
    const parsedUrl = new URL(url);
    assert.equal(adapter.matchesUrl(parsedUrl), true);
    assert.equal(adapter.isPostUrl(parsedUrl), true);
    const resolution = await resolveMedia(url, {
      parseSourceUrl: () => assert.fail('Social links must not enter the direct-file adapter.'),
      probe: () => assert.fail('Social links must not trigger outbound media requests.')
    });
    assert.equal(resolution.status, 'unsupported');
    assert.equal(resolution.platform, adapter.id);
  });
}

test('direct-file adapter resolves only after the backend validates and probes the source', async () => {
  const source = new URL('https://cdn.example.org/clip.mp4');
  const metadata = { contentType: 'video/mp4', filename: 'clip.mp4', size: 1024 };
  let probeCalls = 0;
  const resolution = await resolveMedia(source.href, {
    parseSourceUrl: value => {
      assert.equal(value, source.href);
      return source;
    },
    probe: async value => {
      assert.equal(value, source);
      probeCalls += 1;
      return metadata;
    }
  });

  assert.equal(probeCalls, 1);
  assert.equal(resolution.status, 'available');
  assert.equal(resolution.platform, 'direct-file');
  assert.equal(resolution.source, source);
  assert.equal(resolution.metadata, metadata);
});
