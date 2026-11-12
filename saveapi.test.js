'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectVideoUrl } = require('./media-resolver/adapters/saveapi');
const { requestSaveApi, requestYouTubeApi } = require('./server');

test('selects the recommended video format, never an audio format', () => {
  const response = {
    success: true,
    recommended_format: 'hd',
    formats: [
      { type: 'audio', format: 'mp3', url: 'https://cdn.example.org/audio.mp3' },
      { type: 'video', format: 'nowm', url: 'https://cdn.example.org/standard.mp4' },
      { type: 'video', format: 'hd', url: 'https://cdn.example.org/hd.mp4' }
    ],
    medias: [{ type: 'video', url: 'https://cdn.example.org/fallback.mp4' }]
  };
  assert.equal(selectVideoUrl(response), 'https://cdn.example.org/hd.mp4');
});

test('falls back to the first video media and ignores malformed or non-video entries', () => {
  assert.equal(selectVideoUrl({
    success: true,
    formats: [null, { type: 'audio', url: 'https://cdn.example.org/audio.mp3' }],
    medias: [
      null,
      { type: 'image', url: 'https://cdn.example.org/image.jpg' },
      { url: 'https://www.youtube.com/watch?v=abcdefghijk' },
      { type: 'video', url: 'https://cdn.example.org/video.mp4' }
    ]
  }), 'https://cdn.example.org/video.mp4');
  assert.equal(selectVideoUrl({ success: false, medias: [] }), null);
  assert.equal(selectVideoUrl({
    success: true,
    medias: [
      { type: 'image', url: 'https://cdn.example.org/thumbnail.jpg' },
      { url: 'https://www.youtube.com/watch?v=abcdefghijk' }
    ]
  }), null);
});

test('requires a returned media URL to pass the real video probe before it is available', async () => {
  const parseSourceUrl = value => new URL(value);
  let probeCalls = 0;
  await assert.rejects(
    require('./media-resolver/adapters/saveapi').resolve(
      'https://www.youtube.com/watch?v=abcdefghijk',
      {
        apiKey: 'server-test-key',
        requestSaveApi: async () => ({
          success: true,
          platform: 'youtube',
          medias: [{ type: 'video', url: 'https://www.youtube.com/watch?v=abcdefghijk' }]
        }),
        parseSourceUrl,
        probe: async source => {
          probeCalls += 1;
          assert.equal(source.href, 'https://www.youtube.com/watch?v=abcdefghijk');
          throw new Error('The URL returned a web page, not a video file.');
        }
      }
    ),
    /web page, not a video file/
  );
  assert.equal(probeCalls, 1);
});

test('sends the SaveAPI credential as a server-side bearer header', async () => {
  const postUrl = 'https://www.tiktok.com/@creator/video/123';
  let request;
  const apiKey = 'server-test-key';
  const response = await requestSaveApi(postUrl, apiKey, async (url, options) => {
    request = { url: new URL(url), options };
    return { ok: true, json: async () => ({ success: true }) };
  });

  assert.equal(response.success, true);
  assert.equal(request.url.origin, 'https://api.saveapi.org');
  assert.equal(request.url.pathname, '/v1/download');
  assert.equal(request.url.searchParams.get('url'), postUrl);
  assert.equal(request.options.headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(request.options.headers.Accept, 'application/json');
  assert.equal(request.options.redirect, 'error');
});

test('requests YouTube MP4 downloads from the documented endpoint with server-side auth', async () => {
  let request;
  const apiKey = 'server-test-key';
  const response = await requestYouTubeApi(
    'https://www.youtube.com/watch?v=abcdefghijk',
    apiKey,
    '720p',
    async (url, options) => {
      request = { url: new URL(url), options };
      return { ok: true, json: async () => ({ success: true, platform: 'youtube' }) };
    }
  );

  assert.equal(response.success, true);
  assert.equal(request.url.origin, 'https://api.saveapi.org');
  assert.equal(request.url.pathname, '/v1/youtube/create');
  assert.equal(request.url.searchParams.get('url'), 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(request.url.searchParams.get('quality'), '720p');
  assert.equal(request.options.headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(request.options.redirect, 'error');
});

test('maps provider authentication failures without exposing the key', async () => {
  await assert.rejects(
    requestSaveApi('https://www.tiktok.com/@creator/video/123', 'server-test-key', async () => ({
      ok: false,
      status: 401,
      json: async () => ({ success: false, error: { code: 'INVALID_API_KEY' } })
    })),
    error => {
      assert.match(error.message, /SAVEAPI_KEY/);
      assert.doesNotMatch(error.message, /server-test-key/);
      assert.equal(error.status, 503);
      return true;
    }
  );
});

test('reports private provider media as unavailable instead of a key failure', async () => {
  await assert.rejects(
    requestSaveApi('https://www.instagram.com/reel/example/', 'server-test-key', async () => ({
      ok: false,
      status: 403,
      json: async () => ({ success: false, error: { code: 'PRIVATE_CONTENT' } })
    })),
    error => {
      assert.match(error.message, /private, unavailable, or unsupported/i);
      assert.equal(error.status, 422);
      return true;
    }
  );
});
