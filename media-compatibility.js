'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ffmpegPath = require('ffmpeg-static');

const TEMP_DIRECTORY_PREFIX = 'clipnest-compatible-';

async function cleanupPreparedMedia(directory) {
  if (!directory || path.basename(directory).startsWith(TEMP_DIRECTORY_PREFIX) === false) return;
  await fs.promises.rm(directory, { recursive: true, force: true });
}

async function transcodeToCompatibleMp4(input, {
  maxInputBytes,
  maxOutputBytes,
  timeoutMs = 10 * 60 * 1000
}) {
  if (!ffmpegPath) throw new Error('The bundled FFmpeg executable is unavailable.');
  if (!input || typeof input.pipe !== 'function' || typeof input.on !== 'function') {
    throw new TypeError('FFmpeg input must be a readable stream.');
  }

  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), TEMP_DIRECTORY_PREFIX));
  const outputPath = path.join(directory, 'compatible.mp4');
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn',
    '-dn',
    '-vf', "fps=30,scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-profile:v', 'baseline',
    '-level:v', '3.1',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ac', '2',
    '-ar', '44100',
    '-movflags', '+faststart',
    '-fs', String(maxOutputBytes),
    '-f', 'mp4',
    outputPath
  ];

  try {
    const result = await new Promise((resolve, reject) => {
      const process = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let inputBytes = 0;
      let inputError = null;
      let stderr = '';
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value);
      };
      const timeout = setTimeout(() => {
        inputError = new Error('Video conversion timed out.');
        input.destroy();
        process.kill();
      }, timeoutMs);

      process.stderr.on('data', chunk => {
        if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length);
      });
      process.once('error', error => finish(error));
      process.once('close', code => {
        if (inputError) {
          finish(inputError);
        } else if (code !== 0) {
          finish(new Error(stderr || 'FFmpeg could not convert this video.'));
        } else {
          finish(null);
        }
      });
      process.stdin.once('error', () => {});

      input.on('data', chunk => {
        inputBytes += chunk.length;
        if (inputBytes > maxInputBytes && !inputError) {
          inputError = new Error('The source video is larger than ClipNest’s 250 MiB limit.');
          input.destroy();
          process.kill();
        }
      });
      input.once('error', error => {
        if (!inputError) inputError = error;
        if (process.exitCode === null && process.signalCode === null) process.kill();
      });
      input.pipe(process.stdin);
    });

    const stats = await fs.promises.stat(outputPath);
    if (!stats.isFile() || stats.size <= 0 || stats.size >= maxOutputBytes) {
      throw new Error('The compatible video exceeded ClipNest’s output limit or was empty.');
    }
    return { directory, path: outputPath, size: stats.size };
  } catch (error) {
    await cleanupPreparedMedia(directory);
    throw error;
  }
}

module.exports = { cleanupPreparedMedia, transcodeToCompatibleMp4 };
