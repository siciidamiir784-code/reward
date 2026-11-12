'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const ffmpegPath = require('ffmpeg-static');
const { cleanupPreparedMedia, transcodeToCompatibleMp4 } = require('./media-compatibility');
const { createServer, prepareCompatibleMedia } = require('./server');

async function createIncompatibleSample(directory) {
  const sourcePath = path.join(directory, 'source.avi');
  const generate = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100',
    '-t', '0.5',
    '-c:v', 'mpeg4',
    '-c:a', 'libmp3lame',
    sourcePath
  ], { encoding: 'utf8' });
  assert.equal(generate.status, 0, generate.stderr);
  return fs.promises.readFile(sourcePath);
}

test('converts source video and audio into a broadly compatible H.264/AAC MP4', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clipnest-compatible-test-'));
  t.after(async () => fs.promises.rm(directory, { recursive: true, force: true }));
  const source = await createIncompatibleSample(directory);
  const converted = await transcodeToCompatibleMp4(Readable.from([source]), {
    maxInputBytes: 1024 * 1024,
    maxOutputBytes: 1024 * 1024
  });
  t.after(() => cleanupPreparedMedia(converted.directory));

  assert.equal(path.extname(converted.path), '.mp4');
  assert.ok(converted.size > 0 && converted.size < 1024 * 1024);
  const inspect = spawnSync(ffmpegPath, [
    '-hide_banner', '-i', converted.path, '-f', 'null', '-'
  ], { encoding: 'utf8' });
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(inspect.stderr, /Video: h264/);
  assert.match(inspect.stderr, /Audio: aac/);
});

test('converts a supported YouTube source before preview and device download', async t => {
  const fixtureDirectory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'clipnest-compatible-fixture-')
  );
  t.after(async () => fs.promises.rm(fixtureDirectory, { recursive: true, force: true }));
  const source = await createIncompatibleSample(fixtureDirectory);
  const sourceUrl = new URL('https://cdn.example.org/source.mp4');
  const responseHeaders = {
    'content-type': 'video/mp4',
    'content-length': String(source.length)
  };
  const requestMedia = async (_url, method, headers = {}) => {
    if (method === 'HEAD') {
      return Object.assign(Readable.from([]), {
        statusCode: 200,
        headers: responseHeaders,
        finalUrl: sourceUrl
      });
    }
    if (headers.Range) {
      const start = 0;
      const end = Math.min(511, source.length - 1);
      return Object.assign(Readable.from([source.subarray(start, end + 1)]), {
        statusCode: 206,
        headers: {
          ...responseHeaders,
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${source.length}`
        },
        finalUrl: sourceUrl
      });
    }
    return Object.assign(Readable.from([source]), {
      statusCode: 200,
      headers: responseHeaders,
      finalUrl: sourceUrl
    });
  };
  let outputDirectory;
  const server = createServer({
    requestMedia,
    saveApiKey: 'server-only-test-key',
    prepareMedia: async (...args) => {
      const prepared = await prepareCompatibleMedia(...args);
      outputDirectory = prepared.directory;
      return prepared;
    },
    requestYouTubeApi: async () => ({
      success: true,
      platform: 'youtube',
      mode: 'video',
      ext: 'mp4',
      url: sourceUrl.href,
      expires: Math.floor(Date.now() / 1000) + 60
    })
  });
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
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      permissionConfirmed: true
    })
  });
  assert.equal(resolveResponse.status, 200);
  const video = await resolveResponse.json();
  assert.equal(video.compatible, true);
  assert.equal(video.contentType, 'video/mp4');
  assert.equal(video.filename, 'source-compatible.mp4');

  const outputPath = path.join(outputDirectory, 'compatible.mp4');
  const preview = await fetch(`${baseUrl}/api/preview/${video.token}`, {
    headers: { Range: 'bytes=0-31', Connection: 'close' }
  });
  assert.equal(preview.status, 206);
  assert.equal(preview.headers.get('content-type'), 'video/mp4');

  const download = await fetch(`${baseUrl}/api/download/${video.token}`, {
    headers: { Connection: 'close' }
  });
  assert.equal(download.status, 200);
  const downloadedBytes = Buffer.from(await download.arrayBuffer());
  const downloadedPath = path.join(fixtureDirectory, 'downloaded.mp4');
  await fs.promises.writeFile(downloadedPath, downloadedBytes);
  const inspect = spawnSync(ffmpegPath, [
    '-hide_banner', '-i', downloadedPath, '-f', 'null', '-'
  ], { encoding: 'utf8' });
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(inspect.stderr, /Video: h264/);
  assert.match(inspect.stderr, /Audio: aac/);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.promises.access(outputPath);
      await new Promise(resolve => setTimeout(resolve, 25));
    } catch {
      return;
    }
  }
  assert.fail('The temporary compatible video was not removed after download.');
});
