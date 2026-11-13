'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Readable } = require('node:stream');
const {
  contentDisposition,
  filenameFromResponse,
  hasVideoSignature,
  isPublicAddress,
  mediaContentType,
  isVideoResponse,
  parseSourceUrl,
  safeFilename,
  createServer
} = require('./server');

test('allows public addresses and rejects private or special-use addresses', () => {
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const address of [
    '127.0.0.1', '10.2.3.4', '172.20.1.2', '192.168.1.1',
    '169.254.1.1', '100.64.0.1', '224.0.0.1', '::1',
    '::ffff:127.0.0.1', '2001:db8::1'
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test('accepts standard public HTTP(S) URLs and rejects unsupported inputs', () => {
  assert.equal(parseSourceUrl('https://cdn.example.org/clip.mp4').hostname, 'cdn.example.org');
  assert.equal(parseSourceUrl('http://cdn.example.org/clip.mp4').protocol, 'http:');
  assert.equal(parseSourceUrl('https://video.facebook.com/download/clip.mp4').hostname, 'video.facebook.com');
  for (const value of [
    'file:///clip.mp4', 'ftp://cdn.example.org/clip.mp4',
    'https://user:pass@cdn.example.org/clip.mp4',
    'https://cdn.example.org:8443/clip.mp4',
    'https://youtu.be/example', 'https://www.instagram.com/reel/example/',
    'https://www.tiktok.com/@creator/video/123'
  ]) {
    assert.throws(() => parseSourceUrl(value), Error, value);
  }
});

test('recognizes video content types and rejects ordinary web pages', () => {
  assert.equal(isVideoResponse('video/mp4; charset=binary', new URL('https://cdn.example.org/file')), true);
  assert.equal(isVideoResponse('application/octet-stream', new URL('https://cdn.example.org/file.webm')), true);
  assert.equal(isVideoResponse('application/octet-stream', new URL('https://cdn.example.org/media?id=opaque')), true);
  assert.equal(isVideoResponse('application/octet-stream', new URL('https://cdn.example.org/media.bin?id=opaque')), true);
  assert.equal(mediaContentType('application/octet-stream', new URL('https://cdn.example.org/file.mp4'), {}), 'video/mp4');
  assert.equal(isVideoResponse('application/octet-stream', new URL('https://cdn.example.org/file'), { 'content-disposition': 'attachment; filename="clip.webm"' }), true);
  assert.equal(isVideoResponse('application/octet-stream', new URL('https://cdn.example.org/file'), { 'content-disposition': 'attachment; filename="thumb.jpg"' }), false);
  assert.equal(isVideoResponse('application/octet-stream', new URL('https://cdn.example.org/thumb.jpg')), false);
  assert.equal(isVideoResponse('application/octet-stream', new URL('https://cdn.example.org/file.txt')), false);
  assert.equal(isVideoResponse('text/html', new URL('https://cdn.example.org/file.mp4')), false);
  assert.equal(isVideoResponse('application/octet-stream', new URL('https://cdn.example.org/file.txt')), false);
});

test('requires a recognizable video container signature', () => {
  assert.equal(hasVideoSignature(Buffer.from('000000186674797069736f6d', 'hex')), true);
  assert.equal(hasVideoSignature(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00]),), true);
  assert.equal(hasVideoSignature(Buffer.from('<html>not a video</html>')), false);
  assert.equal(hasVideoSignature(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), false);
});

test('uses safe filenames from the source and handles Unicode download headers', () => {
  const url = new URL('https://cdn.example.org/fallback.mp4');
  assert.equal(filenameFromResponse(url, { 'content-disposition': 'attachment; filename="my video.mp4"' }), 'my video.mp4');
  assert.equal(filenameFromResponse(url, { 'content-disposition': "attachment; filename*=UTF-8''caf%C3%A9.mp4" }), 'café.mp4');
  assert.equal(filenameFromResponse(
    new URL('https://cdn.example.org/opaque-video-id'),
    { 'content-type': 'video/mp4' }
  ), 'opaque-video-id.mp4');
  assert.equal(safeFilename('../../bad:name?.mp4'), '.._.._bad_name_.mp4');
  assert.equal(safeFilename('CON.mp4'), '_CON.mp4');
  assert.match(contentDisposition('café clip.mp4'), /filename\*=UTF-8''caf%C3%A9%20clip\.mp4/);
});

test('resolves and downloads an authorized video from the final source URL', async t => {
  const video = Buffer.from('000000186674797069736f6d00000000', 'hex');
  const finalUrl = new URL('https://media.example.org/assets/clip.mp4');
  const requestMedia = async (_url, method, headers = {}) => {
    const responseHeaders = {
      'content-type': 'video/mp4',
      'content-length': String(video.length)
    };
    if (method === 'HEAD') {
      return Object.assign(Readable.from([]), { statusCode: 200, headers: responseHeaders, finalUrl });
    }
    if (headers.Range) {
      const [, rangeStart, rangeEnd] = headers.Range.match(/^bytes=(\d+)-(\d*)$/);
      const start = Number(rangeStart);
      const end = rangeEnd ? Math.min(Number(rangeEnd), video.length - 1) : video.length - 1;
      const rangeVideo = video.subarray(start, end + 1);
      return Object.assign(Readable.from([rangeVideo]), {
        statusCode: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(rangeVideo.length),
          'content-range': `bytes ${start}-${end}/${video.length}`
        },
        finalUrl
      });
    }
    return Object.assign(Readable.from([video]), {
      statusCode: 200,
      headers: responseHeaders,
      finalUrl
    });
  };
  const server = createServer({ requestMedia });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const resolveResponse = await fetch(`${baseUrl}/api/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({
      url: 'https://cdn.example.org/authorized-download',
      permissionConfirmed: true
    })
  });
  assert.equal(resolveResponse.status, 200);
  const resolved = await resolveResponse.json();
  assert.equal(resolved.filename, 'clip.mp4');
  assert.equal(resolved.contentType, 'video/mp4');
  assert.equal(resolved.size, video.length);
  assert.equal(resolved.quality, 'Original (as provided by the source)');

  const previewResponse = await fetch(`${baseUrl}/api/preview/${resolved.token}`, {
    headers: { Range: 'bytes=0-15', Connection: 'close' }
  });
  assert.equal(previewResponse.status, 206);
  assert.equal(previewResponse.headers.get('content-type'), 'video/mp4');
  assert.match(previewResponse.headers.get('content-disposition'), /^inline;/);
  assert.equal(previewResponse.headers.get('content-range'), `bytes 0-15/${video.length}`);
  assert.equal(previewResponse.headers.get('content-length'), '16');
  assert.deepEqual(Buffer.from(await previewResponse.arrayBuffer()), video);

  const seekResponse = await fetch(`${baseUrl}/api/preview/${resolved.token}`, {
    headers: { Range: 'bytes=8-15', Connection: 'close' }
  });
  assert.equal(seekResponse.status, 206);
  assert.equal(seekResponse.headers.get('content-range'), `bytes 8-15/${video.length}`);
  assert.deepEqual(Buffer.from(await seekResponse.arrayBuffer()), video.subarray(8, 16));

  const downloadResponse = await fetch(`${baseUrl}/api/download/${resolved.token}`, {
    headers: { Connection: 'close' }
  });
  assert.equal(downloadResponse.status, 200);
  assert.match(downloadResponse.headers.get('content-disposition'), /filename="clip\.mp4"/);
  assert.equal(downloadResponse.headers.get('content-type'), 'video/mp4');
  assert.equal(downloadResponse.headers.get('content-length'), String(video.length));
  assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), video);
});

test('falls back to a byte-range GET when a video source rejects HEAD', async t => {
  const video = Buffer.from('000000186674797069736f6d00000000', 'hex');
  const methods = [];
  const requestMedia = async (_url, method, headers = {}) => {
    methods.push({ method, headers });
    if (method === 'HEAD') {
      return Object.assign(Readable.from([]), {
        statusCode: 403,
        headers: { 'content-type': 'text/html' }
      });
    }
    assert.deepEqual(headers, { Range: 'bytes=0-511' });
    return Object.assign(Readable.from([video]), {
      statusCode: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(video.length),
        'content-range': `bytes 0-${video.length - 1}/${video.length}`
      }
    });
  };
  const server = createServer({ requestMedia });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({
      url: 'https://cdn.example.org/clip.mp4',
      permissionConfirmed: true
    })
  });
  assert.equal(response.status, 200);
  const resolved = await response.json();
  assert.equal(resolved.contentType, 'video/mp4');
  assert.deepEqual(methods.map(({ method }) => method), ['HEAD', 'GET']);
});

test('accepts signed opaque SaveAPI video URLs only after checking their file signature', async t => {
  const video = Buffer.from('000000186674797069736f6d00000000', 'hex');
  const sourceUrl = new URL('https://cdn.example.org/media.bin?id=opaque');

  const requestMedia = async (url, method, headers = {}) => {
    const responseHeaders = {
      'content-type': 'application/octet-stream',
      'content-length': String(video.length)
    };
    if (method === 'HEAD') {
      return Object.assign(Readable.from([]), { statusCode: 200, headers: responseHeaders });
    }
    if (headers.Range) {
      return Object.assign(Readable.from([video]), {
        statusCode: 206,
        headers: {
          ...responseHeaders,
          'content-range': `bytes 0-${video.length - 1}/${video.length}`
        },
        finalUrl: url
      });
    }
    return Object.assign(Readable.from([video]), {
      statusCode: 200,
      headers: responseHeaders,
      finalUrl: url
    });
  };
  const server = createServer({
    saveApiKey: 'server-only-test-key',
    requestSaveApi: async () => ({
      success: true,
      platform: 'tiktok',
      medias: [{ type: 'video', url: sourceUrl.href }]
    }),
    requestMedia,
    prepareMedia: async () => assert.fail('A validated TikTok MP4 should not be re-encoded.')
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({
      url: 'https://www.tiktok.com/@creator/video/123',
      permissionConfirmed: true
    })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.filename, 'media.mp4');
  assert.equal(result.contentType, 'video/mp4');
  assert.equal(result.compatible, false);

  const download = await fetch(
    `http://127.0.0.1:${server.address().port}/api/download/${result.token}`,
    { headers: { Connection: 'close' } }
  );
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /filename="media\.mp4"/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), video);
});

test('rejects opaque application/octet-stream responses without a video signature', async t => {
  const html = Buffer.from('<html>not a video</html>');
  const sourceUrl = new URL('https://cdn.example.org/media.bin?id=opaque');
  const requestMedia = async (_url, method) => {
    const headers = {
      'content-type': 'application/octet-stream',
      'content-length': String(html.length)
    };
    if (method === 'HEAD') {
      return Object.assign(Readable.from([]), { statusCode: 200, headers });
    }
    return Object.assign(Readable.from([html]), {
      statusCode: 206,
      headers: {
        ...headers,
        'content-range': `bytes 0-${html.length - 1}/${html.length}`
      }
    });
  };
  const server = createServer({ requestMedia });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({
      url: sourceUrl.href,
      permissionConfirmed: true
    })
  });
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /recognizable video file/i);
});

test('does not resolve social post URLs or requests without permission', async t => {
  let mediaRequests = 0;
  let saveApiRequests = 0;
  const server = createServer({
    saveApiKey: '',
    requestSaveApi: async () => {
      saveApiRequests += 1;
      throw new Error('SaveAPI should not be called without a configured key.');
    },
    requestMedia: async () => {
      mediaRequests += 1;
      throw new Error('Unsupported request reached the media source.');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const socialUrls = [
    ['tiktok', 'https://www.tiktok.com/@creator/video/123'],
    ['facebook', 'https://www.facebook.com/watch/?v=123'],
    ['instagram', 'https://www.instagram.com/reel/ABC123/']
  ];
  for (const [platform, url] of socialUrls) {
    const socialResponse = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ url, permissionConfirmed: true })
    });
    assert.equal(socialResponse.status, 422);
    const result = await socialResponse.json();
    assert.equal(result.status, 'unsupported');
    assert.equal(result.platform, platform);
    assert.match(result.error, /SAVEAPI_KEY/);
  }

  const youtubeResponse = await fetch(`${baseUrl}/api/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({
      url: 'https://youtu.be/abcdefghijk',
      permissionConfirmed: true
    })
  });
  assert.equal(youtubeResponse.status, 422);
  const youtubeError = await youtubeResponse.json();
  assert.equal(youtubeError.status, 'unsupported');
  assert.equal(youtubeError.platform, 'youtube');
  assert.match(youtubeError.error, /SAVEAPI_KEY/);
  assert.doesNotMatch(JSON.stringify(youtubeError), /thumbnailUrl|watchUrl/);

  const unconfirmedResponse = await fetch(`${baseUrl}/api/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ url: 'https://cdn.example.org/clip.mp4' })
  });
  assert.equal(unconfirmedResponse.status, 400);
  assert.equal(mediaRequests, 0);
  assert.equal(saveApiRequests, 0);
});

test('requires permission confirmation before sending a social post to SaveAPI', async t => {
  let saveApiRequests = 0;
  const server = createServer({
    saveApiKey: 'server-only-test-key',
    requestSaveApi: async () => {
      saveApiRequests += 1;
      return { success: false };
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ url: 'https://www.tiktok.com/@creator/video/123' })
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /rights holder permits.*platform/i);
  assert.equal(saveApiRequests, 0);
});

test('rejects private-network media URLs returned by SaveAPI before fetching them', async t => {
  const server = createServer({
    saveApiKey: 'server-only-test-key',
    requestSaveApi: async () => ({
      success: true,
      platform: 'tiktok',
      medias: [{ type: 'video', url: 'https://127.0.0.1/private.mp4' }]
    })
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({
      url: 'https://www.tiktok.com/@creator/video/123',
      permissionConfirmed: true
    })
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /publicly routable/);
});

test('returns a clear error when SaveAPI has no downloadable YouTube video', async t => {
  const server = createServer({
    saveApiKey: 'server-only-test-key',
    requestYouTubeApi: async () => ({ success: false, platform: 'youtube' }),
    requestMedia: async () => {
      assert.fail('A YouTube page must not be fetched as a direct video file.');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({
      url: 'https://www.youtube.com/shorts/abcdefghijk',
      permissionConfirmed: true
    })
  });

  assert.equal(response.status, 422);
  const result = await response.json();
  assert.equal(result.status, 'unsupported');
  assert.equal(result.platform, 'youtube');
  assert.match(result.error, /did not return a downloadable YouTube video file/i);
  assert.doesNotMatch(JSON.stringify(result), /thumbnailUrl|watchUrl/);
});

test('rejects YouTube thumbnails and watch pages instead of issuing download tokens', async t => {
  const server = createServer({
    saveApiKey: 'server-only-test-key',
    requestYouTubeApi: async () => ({
      success: true,
      platform: 'youtube',
      mode: 'video',
      ext: 'mp4',
      url: 'https://www.youtube.com/watch?v=abcdefghijk'
    }),
    requestMedia: async () => {
      assert.fail('A YouTube watch page must be rejected before fetching it.');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      permissionConfirmed: true
    })
  });

  assert.equal(response.status, 422);
  const result = await response.json();
  assert.match(result.error, /did not provide a downloadable YouTube video file/i);
  assert.doesNotMatch(JSON.stringify(result), /thumbnailUrl|watchUrl|token/);
});

test('rejects YouTube audio, image, and non-MP4 responses without probing them as video', async t => {
  const providerResponses = [
    { success: true, platform: 'youtube', mode: 'audio', ext: 'mp3', url: 'https://cdn.example.org/audio.mp3' },
    { success: true, platform: 'youtube', mode: 'video', ext: 'jpg', url: 'https://cdn.example.org/thumbnail.jpg' },
    { success: true, platform: 'youtube', mode: 'video', ext: 'webm', url: 'https://cdn.example.org/video.webm' },
    { success: true, platform: 'youtube', ext: 'mp4', url: 'https://cdn.example.org/video.mp4' }
  ];
  let responseIndex = 0;
  const server = createServer({
    saveApiKey: 'server-only-test-key',
    requestYouTubeApi: async () => providerResponses[responseIndex++],
    requestMedia: async () => {
      assert.fail('Invalid YouTube media must not be probed as a video.');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (let index = 0; index < providerResponses.length; index += 1) {
    const response = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        permissionConfirmed: true
      })
    });
    assert.equal(response.status, 422);
    const result = await response.json();
    assert.equal(result.status, 'unsupported');
    assert.doesNotMatch(JSON.stringify(result), /token|audio\.mp3/);
  }
});

test('streams video-file SaveAPI responses through download for every supported platform', async t => {
  const video = Buffer.from('000000186674797069736f6d00000000', 'hex');
  const sourceUrl = new URL('https://cdn.example.org/clip.mp4');
  const opaqueSourceUrl = new URL('https://cdn.example.org/signed/clip?token=opaque');
  const sourceRequests = [];
  const apiRequests = [];
  const preparedDirectories = [];
  let prepareMediaCalls = 0;
  const posts = [
    { platform: 'tiktok', url: 'https://www.tiktok.com/@creator/video/123' },
    { platform: 'facebook', url: 'https://www.facebook.com/watch/?v=123' },
    { platform: 'instagram', url: 'https://www.instagram.com/reel/ABC123/' },
    { platform: 'youtube', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
    { platform: 'x', url: 'https://x.com/creator/status/123' },
    { platform: 'pinterest', url: 'https://www.pinterest.com/pin/123/' },
    { platform: 'likee', url: 'https://likee.video/@creator/video/123' },
    { platform: 'snapchat', url: 'https://www.snapchat.com/spotlight/123' },
    { platform: 'threads', url: 'https://www.threads.net/@creator/post/123' },
    { platform: 'vk', url: 'https://vk.com/video-1_2' },
    { platform: '9gag', url: 'https://9gag.com/gag/abc' },
    { platform: 'twitch', url: 'https://www.twitch.tv/creator/clip/Abc' },
    { platform: 'rutube', url: 'https://rutube.ru/video/example/' }
  ];
  const requestMedia = async (url, method, headers = {}) => {
    sourceRequests.push({ url: url.href, method, headers });
    const isOpaqueUrl = url.href === opaqueSourceUrl.href;
    const responseHeaders = {
      'content-type': isOpaqueUrl ? 'application/octet-stream' : 'video/mp4',
      'content-length': String(video.length)
    };
    if (method === 'HEAD') {
      return Object.assign(Readable.from([]), {
        statusCode: 200,
        headers: responseHeaders,
        finalUrl: url
      });
    }
    if (headers.Range) {
      const [, startValue, endValue] = headers.Range.match(/^bytes=(\d+)-(\d*)$/);
      const start = Number(startValue);
      const end = endValue ? Math.min(Number(endValue), video.length - 1) : video.length - 1;
      const rangeVideo = video.subarray(start, end + 1);
      return Object.assign(Readable.from([rangeVideo]), {
        statusCode: 206,
        headers: {
          'content-type': responseHeaders['content-type'],
          'content-length': String(rangeVideo.length),
          'content-range': `bytes ${start}-${end}/${video.length}`
        },
        finalUrl: url
      });
    }
    return Object.assign(Readable.from([video]), {
      statusCode: 200,
      headers: responseHeaders,
      finalUrl: url
    });
  };
  const server = createServer({
    requestMedia,
    saveApiKey: 'server-only-test-key',
    requestSaveApi: async (url, apiKey) => {
      apiRequests.push({ url, apiKey });
      const post = posts.find(candidate => candidate.url === url);
      assert.ok(post, `Unexpected SaveAPI URL: ${url}`);
      assert.notEqual(post.platform, 'youtube', 'YouTube uses its dedicated create endpoint.');
      return {
        success: true,
        platform: post.platform,
        type: 'video',
        medias: [
          { type: 'image', ext: 'jpg', url: 'https://cdn.example.org/thumbnail.jpg' },
          {
            type: 'video',
            ext: 'mp4',
            url: post.platform === 'tiktok' ? opaqueSourceUrl.href : sourceUrl.href
          }
        ],
        music: { type: 'audio', url: 'https://cdn.example.org/audio.mp3' },
        meta: { thumbnail: 'https://cdn.example.org/thumbnail.jpg' }
      };
    },
    requestYouTubeApi: async (url, apiKey, quality) => {
      apiRequests.push({ url, apiKey, quality, endpoint: 'youtube-create' });
      assert.equal(url, posts.find(post => post.platform === 'youtube').url);
      assert.equal(quality, '720p');
      return {
        success: true,
        platform: 'youtube',
        mode: 'video',
        ext: 'mp4',
        url: sourceUrl.href,
        filename: 'clip.mp4',
        quality,
        expires: Math.floor(Date.now() / 1000) + 60
      };
    },
    prepareMedia: async (_source, metadata) => {
      prepareMediaCalls += 1;
      const directory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'clipnest-server-test-')
      );
      preparedDirectories.push(directory);
      const filePath = path.join(directory, 'compatible.mp4');
      await fs.promises.writeFile(filePath, video);
      return {
        directory,
        path: filePath,
        size: video.length,
        metadata: {
          filename: `${path.parse(metadata.filename).name}-compatible.mp4`,
          contentType: 'video/mp4',
          size: video.length
        }
      };
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }).then(() => Promise.all(
    preparedDirectories.map(directory =>
      fs.promises.rm(directory, { recursive: true, force: true })
    )
  )));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const post of posts) {
    const response = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ url: post.url, permissionConfirmed: true })
    });
    assert.equal(response.status, 200, post.platform);
    const resolved = await response.json();
    assert.equal(resolved.contentType, 'video/mp4', post.platform);
    if (['youtube', 'tiktok'].includes(post.platform)) {
      assert.equal(resolved.filename, 'clip.mp4', post.platform);
      assert.equal(resolved.compatible, false, post.platform);
      assert.equal(
        resolved.quality,
        post.platform === 'youtube' ? '720p' : 'Original (as provided by the source)',
        post.platform
      );
    } else {
      assert.equal(resolved.filename, 'clip-compatible.mp4', post.platform);
      assert.equal(resolved.compatible, true, post.platform);
      assert.equal(
        resolved.quality,
        'Compatible MP4 · H.264 video + AAC audio · up to 720p',
        post.platform
      );
    }
    assert.doesNotMatch(JSON.stringify(resolved), /server-only-test-key|thumbnail\.jpg|youtube\.com\/watch/, post.platform);

    if (post === posts[0]) {
      const preview = await fetch(`${baseUrl}/api/preview/${resolved.token}`, {
        headers: { Range: 'bytes=0-15', Connection: 'close' }
      });
      assert.equal(preview.status, 206, `${post.platform} preview`);
      assert.deepEqual(Buffer.from(await preview.arrayBuffer()), video, `${post.platform} preview bytes`);
    }

    const download = await fetch(`${baseUrl}/api/download/${resolved.token}`, {
      headers: { Connection: 'close' }
    });
    assert.equal(download.status, 200, `${post.platform} download`);
    assert.match(
      download.headers.get('content-disposition'),
      ['youtube', 'tiktok'].includes(post.platform)
        ? /filename="clip\.mp4"/
        : /filename="clip-compatible\.mp4"/
    );
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), video, `${post.platform} download bytes`);
  }

  assert.deepEqual(
    apiRequests.map(({ url, apiKey, quality, endpoint }) =>
      ({ url, apiKey, quality, endpoint })),
    posts.map(post => post.platform === 'youtube'
      ? { url: post.url, apiKey: 'server-only-test-key', quality: '720p', endpoint: 'youtube-create' }
      : { url: post.url, apiKey: 'server-only-test-key', quality: undefined, endpoint: undefined })
  );
  assert.equal(sourceRequests.length, posts.length * 2 + 3);
  assert.equal(prepareMediaCalls, posts.length - 2);
  assert.ok(sourceRequests.every(request =>
    [sourceUrl.href, opaqueSourceUrl.href].includes(request.url)
  ));
});

test('rejects a video source that changes to non-video bytes after validation', async t => {
  const validVideo = Buffer.from('000000186674797069736f6d00000000', 'hex');
  const html = Buffer.from('<html>not a video</html>');
  const requestMedia = async (_url, method, headers = {}) => {
    if (method === 'HEAD') {
      return Object.assign(Readable.from([]), {
        statusCode: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(validVideo.length) }
      });
    }
    if (headers.Range) {
      return Object.assign(Readable.from([validVideo]), {
        statusCode: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(validVideo.length),
          'content-range': `bytes 0-${validVideo.length - 1}/${validVideo.length}`
        }
      });
    }
    return Object.assign(Readable.from([html]), {
      statusCode: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': String(html.length) }
    });
  };
  const server = createServer({ requestMedia });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const resolveResponse = await fetch(`${baseUrl}/api/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({
      url: 'https://cdn.example.org/changed-source',
      permissionConfirmed: true
    })
  });
  assert.equal(resolveResponse.status, 200);
  const { token } = await resolveResponse.json();
  const downloadResponse = await fetch(`${baseUrl}/api/download/${token}`, {
    headers: { Connection: 'close' }
  });
  assert.equal(downloadResponse.status, 502);
  assert.match((await downloadResponse.json()).error, /recognizable video file/i);
});

test('exposes an uncached health check with security headers', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`, {
    headers: { Connection: 'close' }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

test('serves the domain sitemap and crawler rules', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const homepage = await fetch(`${baseUrl}/`, {
    headers: { Connection: 'close' }
  });
  assert.equal(homepage.status, 200);
  assert.match(await homepage.text(), /name="google-site-verification" content="[^"]+"/);

  const sitemap = await fetch(`${baseUrl}/sitemap.xml`, {
    headers: { Connection: 'close' }
  });
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get('content-type'), /application\/xml/);
  const sitemapXml = await sitemap.text();
  assert.match(sitemapXml, /https:\/\/clipnest\.autos\//);
  assert.match(sitemapXml, /https:\/\/clipnest\.autos\/privacy\.html/);
  assert.match(sitemapXml, /https:\/\/clipnest\.autos\/terms\.html/);

  const robots = await fetch(`${baseUrl}/robots.txt`, {
    headers: { Connection: 'close' }
  });
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('content-type'), /text\/plain/);
  const robotsText = await robots.text();
  assert.match(robotsText, /Disallow: \/api\//);
  assert.match(robotsText, /Sitemap: https:\/\/clipnest\.autos\/sitemap\.xml/);
});

test('caps simultaneous downloads and returns an explicit busy response', async t => {
  const video = Buffer.from('000000186674797069736f6d00000000', 'hex');
  const streams = [];
  const requestMedia = async (_url, method, headers = {}) => {
    const responseHeaders = {
      'content-type': 'video/mp4',
      'content-length': String(video.length)
    };
    if (method === 'HEAD') {
      return Object.assign(Readable.from([]), { statusCode: 200, headers: responseHeaders });
    }
    if (headers.Range) {
      return Object.assign(Readable.from([video]), {
        statusCode: 206,
        headers: {
          ...responseHeaders,
          'content-range': `bytes 0-${video.length - 1}/${video.length}`
        }
      });
    }
    const stream = new PassThrough();
    streams.push(stream);
    setTimeout(() => stream.end(video), 250);
    return Object.assign(stream, { statusCode: 200, headers: responseHeaders });
  };
  const server = createServer({ requestMedia });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const stream of streams) stream.destroy();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const tokens = [];
  for (let index = 0; index < 9; index += 1) {
    const response = await fetch(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({
        url: `https://cdn.example.org/clip-${index}.mp4`,
        permissionConfirmed: true
      })
    });
    assert.equal(response.status, 200);
    tokens.push((await response.json()).token);
  }

  const activeResponsePromises = tokens.slice(0, 8).map(token =>
    fetch(`${baseUrl}/api/download/${token}`, { headers: { Connection: 'close' } })
  );
  await new Promise(resolve => setTimeout(resolve, 25));

  const limitedResponse = await fetch(`${baseUrl}/api/download/${tokens[8]}`, {
    headers: { Connection: 'close' }
  });
  assert.equal(limitedResponse.status, 503);
  assert.match((await limitedResponse.json()).error, /active download limit/i);
  const activeResponses = await Promise.all(activeResponsePromises);
  assert.ok(activeResponses.every(response => response.status === 200));
  await Promise.all(activeResponses.map(response => response.arrayBuffer()));
});
