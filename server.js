'use strict';

const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { cleanupPreparedMedia, transcodeToCompatibleMp4 } = require('./media-compatibility');
const { isSocialHost, isSocialUrl, resolveMedia } = require('./media-resolver');
const saveApiAdapter = require('./media-resolver/adapters/saveapi');
const youtubeAdapter = require('./media-resolver/adapters/youtube');

const ROOT = __dirname;

function loadEnvironmentFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;

  const contents = fs.readFileSync(file, 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;

    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[match[1]] = value;
  }
}

loadEnvironmentFile();

const MAX_BYTES = 250 * 1024 * 1024;
const TOKEN_TTL_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 30;
const MAX_ACTIVE_DOWNLOADS = 8;
const MAX_ACTIVE_CONVERSIONS = 2;
let activeDownloads = 0;
let activeConversions = 0;
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://bellnewyork.org 'sha256-KkFxhVf2bEkh3tZzXqX87xs761dxz3mvLvHZY3vV2mc='; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' https://bellnewyork.org; frame-src 'self' https://bellnewyork.org; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
};
const supportedFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/script.js', ['script.js', 'text/javascript; charset=utf-8']],
  ['/privacy.html', ['privacy.html', 'text/html; charset=utf-8']],
  ['/terms.html', ['terms.html', 'text/html; charset=utf-8']],
  ['/sitemap.xml', ['sitemap.xml', 'application/xml; charset=utf-8']],
  ['/robots.txt', ['robots.txt', 'text/plain; charset=utf-8']]
]);
const videoExtensions = new Set([
  '.3gp', '.avi', '.flv', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg',
  '.ogv', '.ts', '.webm'
]);
const nonVideoExtensions = new Set([
  '.avif', '.css', '.gif', '.htm', '.html', '.jpeg', '.jpg', '.js',
  '.json', '.png', '.svg', '.txt', '.webp', '.xml'
]);
const videoMimeByExtension = new Map([
  ['.3gp', 'video/3gpp'], ['.avi', 'video/x-msvideo'], ['.flv', 'video/x-flv'],
  ['.m4v', 'video/mp4'], ['.mkv', 'video/x-matroska'],
  ['.mov', 'video/quicktime'], ['.mp4', 'video/mp4'],
  ['.mpeg', 'video/mpeg'], ['.mpg', 'video/mpeg'],
  ['.ogv', 'video/ogg'], ['.ts', 'video/mp2t'], ['.webm', 'video/webm']
]);
const videoExtensionByMime = new Map(
  [...videoMimeByExtension].map(([extension, mime]) => [mime, extension])
);
const tokens = new Map();

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    const value = parts.reduce((number, part) => (number * 256) + part, 0);
    const blocked = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
      ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
      ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
      ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4]
    ];
    return !blocked.some(([network, prefix]) => {
      const base = network.split('.').map(Number)
        .reduce((number, part) => (number * 256) + part, 0);
      const mask = (0xffffffff << (32 - prefix)) >>> 0;
      return (value & mask) === (base & mask);
    });
  }

  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return first >= 0x2000 && first <= 0x3fff &&
    !normalized.startsWith('2001:db8:') &&
    !normalized.startsWith('2001:10:') &&
    !normalized.startsWith('2001:2:') &&
    !normalized.startsWith('2001:0000:') &&
    !normalized.startsWith('2002:');
}

function hostForLookup(hostname) {
  return hostname.replace(/^\[|\]$/g, '');
}

function parseSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) {
    throw new RequestError(400, 'Enter a valid direct video-file URL.');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RequestError(400, 'Enter a valid direct video-file URL.');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new RequestError(400, 'Only public HTTP or HTTPS video URLs are supported.');
  }
  if ((url.protocol === 'http:' && url.port && url.port !== '80') ||
      (url.protocol === 'https:' && url.port && url.port !== '443')) {
    throw new RequestError(400, 'Only standard HTTP and HTTPS ports are supported.');
  }
  if (isSocialUrl(url)) {
    throw new RequestError(422, 'Social post links are not direct files. Use the platform’s official save options or an authorized direct video-file URL.');
  }
  return url;
}

async function lookupPublic(hostname) {
  const host = hostForLookup(hostname);
  const literalFamily = net.isIP(host);
  const addresses = literalFamily
    ? [{ address: host, family: literalFamily }]
    : await dns.lookup(host, { all: true, verbatim: true });

  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) {
    throw new RequestError(400, 'That host is not a publicly routable video source.');
  }
  return addresses[0];
}

async function remoteRequest(url, method, headers = {}, redirects = 0) {
  if (redirects > 4) throw new RequestError(502, 'The video source redirected too many times.');
  const address = await lookupPublic(url.hostname);
  const client = url.protocol === 'https:' ? https : http;
  const host = hostForLookup(url.hostname);
  const requestOptions = {
    protocol: url.protocol,
    hostname: host,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method,
    headers: { 'User-Agent': 'ClipNest/1.0 (authorized direct-media fetch)', ...headers },
    lookup: (_hostname, options, callback) => {
      if (options && options.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    }
  };
  if (!net.isIP(host)) requestOptions.servername = host;

  return new Promise((resolve, reject) => {
    const request = client.request(requestOptions, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        response.resume();
        if (isSocialHost(url.hostname) &&
            !videoExtensions.has(path.extname(url.pathname).toLowerCase())) {
          reject(new RequestError(422, 'Social post links cannot be resolved through redirects. Use the platform’s official save options or a direct authorized file URL.'));
          return;
        }
        if (!location) {
          reject(new RequestError(502, 'The video source returned an invalid redirect.'));
          return;
        }
        let next;
        try {
          next = parseSourceUrl(new URL(location, url).href);
        } catch (error) {
          reject(error);
          return;
        }
        if (url.protocol === 'https:' && next.protocol !== 'https:') {
          reject(new RequestError(400, 'Insecure redirects are not allowed.'));
          return;
        }
        remoteRequest(next, method, headers, redirects + 1).then(resolve, reject);
        return;
      }
      response.finalUrl = url;
      resolve(response);
    });
    request.setTimeout(20_000, () => request.destroy(new Error('The video source timed out.')));
    request.once('error', reject);
    request.end();
  });
}

function isVideoResponse(contentType, url, headers = {}) {
  const mime = (contentType || '').split(';')[0].trim().toLowerCase();
  const disposition = headers['content-disposition'] || '';
  const filename = disposition.match(/filename\*?=(?:UTF-8''|")?([^;"]+)/i);
  const dispositionExtension = filename
    ? path.extname(filename[1].trim().replace(/^"|"$/g, '').split("'").pop()).toLowerCase()
    : '';
  const urlExtension = path.extname(url.pathname).toLowerCase();
  if (mime.startsWith('video/')) return true;
  if (mime !== 'application/octet-stream') return false;
  if (videoExtensions.has(urlExtension) || videoExtensions.has(dispositionExtension)) return true;
  return !nonVideoExtensions.has(urlExtension || dispositionExtension);
}

function safeFilename(value) {
  let name = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 180);
  if (!name || name === '.' || name === '..') name = 'clipnest-video.mp4';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

function filenameFromResponse(url, headers) {
  const disposition = headers['content-disposition'] || '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const regular = disposition.match(/filename="?([^";]+)"?/i);
  let name;
  if (encoded) {
    try {
      name = decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ''));
    } catch {
      name = regular && regular[1];
    }
  } else if (regular) {
    name = regular[1];
  } else {
    name = path.posix.basename(url.pathname) || 'clipnest-video.mp4';
    try {
      name = decodeURIComponent(name);
    } catch {
      name = 'clipnest-video.mp4';
    }
  }
  const contentType = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const extension = videoExtensionByMime.get(contentType);
  if (extension && !path.extname(name)) name += extension;
  return safeFilename(name);
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, char =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function mediaContentType(contentType, url, headers) {
  const mime = (contentType || '').split(';')[0].trim().toLowerCase();
  if (mime.startsWith('video/')) return mime;
  const filename = filenameFromResponse(url, headers);
  return videoMimeByExtension.get(path.extname(filename).toLowerCase()) ||
    videoMimeByExtension.get(path.extname(url.pathname).toLowerCase()) ||
    mime || 'application/octet-stream';
}

function mediaDetailsForTransfer(contentType, url, headers, metadata) {
  if (metadata.isMp4) {
    return { contentType: 'video/mp4', filename: metadata.filename };
  }
  return {
    contentType: mediaContentType(contentType, url, headers),
    filename: filenameFromResponse(url, headers)
  };
}

function isIsoBmffSignature(bytes) {
  if (bytes.length < 12) return false;
  const text = bytes.toString('ascii');
  const brand = text.slice(8, 12);
  return text.slice(4, 8) === 'ftyp' &&
    /^(isom|iso[2-9]|mp4[12v]|avc1|M4V |M4VP|qt  |3gp[4-9]|3g2[ab]|dash|MSNV)$/.test(brand);
}

function isMp4Signature(bytes) {
  if (!isIsoBmffSignature(bytes)) return false;
  const brand = bytes.toString('ascii', 8, 12);
  return /^(isom|iso[2-9]|mp4[12v]|avc1|M4V |M4VP|dash|MSNV)$/.test(brand);
}

function hasVideoSignature(bytes) {
  if (isIsoBmffSignature(bytes)) return true;
  if (bytes.length >= 12) {
    const text = bytes.toString('ascii');
    if (text.slice(0, 4) === 'RIFF' && text.slice(8, 12) === 'AVI ') return true;
    if (text.slice(0, 4) === 'OggS' || text.slice(0, 3) === 'FLV') return true;
    if (bytes[0] === 0x30 && bytes[1] === 0x26 && bytes[2] === 0xb2 && bytes[3] === 0x75 &&
        bytes[4] === 0x8e && bytes[5] === 0x66 && bytes[6] === 0xcf && bytes[7] === 0x11) {
      return true;
    }
    if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 &&
        (bytes[3] === 0xba || bytes[3] === 0xb3)) return true;
  }
  if (bytes.length >= 4 &&
      bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return true;
  }
  return bytes.length >= 377 &&
    bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47;
}

function parseSize(value) {
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function readPrefix(response, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, length));
    };

    response.on('data', chunk => {
      const part = chunk.subarray(0, limit - length);
      chunks.push(part);
      length += part.length;
      if (length >= limit) {
        finish();
        response.destroy();
      }
    });
    response.once('end', finish);
    response.once('error', error => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    response.once('aborted', () => {
      if (!settled) {
        settled = true;
        reject(new Error('The video source ended before its file signature could be checked.'));
      }
    });
    response.resume();
  });
}

function readStreamPrefix(response, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const cleanup = () => {
      response.removeListener('readable', read);
      response.removeListener('end', read);
      response.removeListener('error', fail);
      response.removeListener('aborted', abort);
    };
    const finish = () => {
      cleanup();
      const prefix = Buffer.concat(chunks, length);
      resolve(prefix);
    };
    const fail = error => {
      cleanup();
      reject(error);
    };
    const abort = () => fail(new Error('The video source ended before its file signature could be checked.'));
    const read = () => {
      let chunk;
      while (length < limit && (chunk = response.read(limit - length)) !== null) {
        chunks.push(chunk);
        length += chunk.length;
      }
      if (length >= limit || response.readableEnded) finish();
    };

    response.on('readable', read);
    response.once('end', read);
    response.once('error', fail);
    response.once('aborted', abort);
    read();
  });
}

function expectedByteRange(value, size) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || size === null) return null;
  const startValue = match[1];
  const endValue = match[2];
  if (!startValue && !endValue) return null;

  if (!startValue) {
    const suffixLength = Number(endValue);
    if (!suffixLength || !size) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(startValue);
  const end = endValue ? Number(endValue) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

async function probe(url, requestMedia = remoteRequest) {
  let response = await requestMedia(url, 'HEAD');
  let headResponse = true;
  if ([405, 501].includes(response.statusCode)) {
    response.on('error', () => {});
    response.destroy();
    response = await requestMedia(url, 'GET', { Range: 'bytes=0-511' });
    headResponse = false;
  }

  let status = response.statusCode || 0;
  let type = response.headers['content-type'] || '';
  let headers = response.headers;
  let sizeFromRange = (response.headers['content-range'] || '').match(/\/(\d+)$/);
  let size = sizeFromRange
    ? parseSize(sizeFromRange[1])
    : status === 206 ? null : parseSize(response.headers['content-length']);
  let validStatus = status === 200 || status === 206;
  let validType = isVideoResponse(type, url, response.headers);

  if (headResponse && (!validStatus || !validType)) {
    response.on('error', () => {});
    response.destroy();
    response = await requestMedia(url, 'GET', { Range: 'bytes=0-511' });
    headResponse = false;
    status = response.statusCode || 0;
    type = response.headers['content-type'] || '';
    headers = response.headers;
    sizeFromRange = (response.headers['content-range'] || '').match(/\/(\d+)$/);
    size = sizeFromRange
      ? parseSize(sizeFromRange[1])
      : status === 206 ? null : parseSize(response.headers['content-length']);
    validStatus = status === 200 || status === 206;
    validType = isVideoResponse(type, url, response.headers);
  }

  if (!validStatus || !validType) {
    response.destroy();
    throw new RequestError(422, 'That URL did not provide a recognized video file. Use a direct video-file URL, not a post or webpage.');
  }
  if (size !== null && size > MAX_BYTES) {
    response.destroy();
    throw new RequestError(413, 'This file is larger than ClipNest’s 250 MiB limit.');
  }

  let sampleResponse = response;
  if (headResponse) {
    response.on('error', () => {});
    response.destroy();
    sampleResponse = await requestMedia(url, 'GET', { Range: 'bytes=0-511' });
  }
  const sampleStatus = sampleResponse.statusCode || 0;
  const sampleHeaders = { ...headers, ...sampleResponse.headers };
  const sampleType = sampleResponse.headers['content-type'] || type;
  if (![200, 206].includes(sampleStatus) ||
      !isVideoResponse(sampleType, url, sampleHeaders)) {
    sampleResponse.destroy();
    throw new RequestError(422, 'The source did not provide a direct video file. Use a valid video URL, not a post or error page.');
  }
  const prefix = await readPrefix(sampleResponse, 512);
  if (!hasVideoSignature(prefix)) {
    throw new RequestError(422, 'The source response is not a recognizable video file. Check the URL or use an authorized direct video link.');
  }
  const isMp4 = isMp4Signature(prefix);
  const sampleRangeSize = (sampleHeaders['content-range'] || '').match(/\/(\d+)$/);
  if (size === null && sampleRangeSize) size = parseSize(sampleRangeSize[1]);
  if (size !== null && size > MAX_BYTES) {
    throw new RequestError(413, 'This file is larger than ClipNest’s 250 MiB limit.');
  }

  const filename = filenameFromResponse(
    sampleResponse.finalUrl || url,
    isMp4 ? { ...sampleHeaders, 'content-type': 'video/mp4' } : sampleHeaders
  );
  return {
    contentType: isMp4 && !sampleType.toLowerCase().startsWith('video/')
      ? 'video/mp4'
      : mediaContentType(sampleType, sampleResponse.finalUrl || url, sampleHeaders),
    size,
    filename: isMp4 && path.extname(filename).toLowerCase() !== '.mp4'
      ? safeFilename(`${path.parse(filename).name || 'clip'}.mp4`)
      : filename,
    isMp4
  };
}

function consumeJson(request, maxLength = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on('data', chunk => {
      length += chunk.length;
      if (length > maxLength) {
        reject(new RequestError(413, 'Request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new RequestError(400, 'Expected a JSON request body.'));
      }
    });
    request.on('error', reject);
  });
}

function rateLimited(request, rateCounts) {
  const now = Date.now();
  const key = request.socket.remoteAddress || 'unknown';
  let entry = rateCounts.get(key);
  if (!entry || entry.expiresAt <= now) {
    entry = { count: 0, expiresAt: now + RATE_WINDOW_MS };
  }
  entry.count += 1;
  rateCounts.set(key, entry);
  if (rateCounts.size > 10_000) {
    for (const [address, limit] of rateCounts) {
      if (limit.expiresAt <= now) rateCounts.delete(address);
    }
  }
  return entry.count > RATE_LIMIT;
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    ...securityHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(value));
}

function cleanupToken(token, record) {
  tokens.delete(token);
  if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
  if (record.preparedMedia) {
    cleanupPreparedMedia(record.preparedMedia.directory).catch(error => {
      console.error('ClipNest temporary media cleanup failed:', error.name);
    });
  }
}

async function prepareCompatibleMedia(source, metadata, requestMedia) {
  if (activeConversions >= MAX_ACTIVE_CONVERSIONS) {
    throw new RequestError(503, 'ClipNest is preparing other videos. Please try again shortly.');
  }
  activeConversions += 1;
  let sourceResponse;
  try {
    sourceResponse = await requestMedia(source, 'GET');
    const status = sourceResponse.statusCode || 0;
    const contentType = sourceResponse.headers['content-type'] || '';
    if (status !== 200 || !isVideoResponse(contentType, source, sourceResponse.headers)) {
      sourceResponse.destroy();
      throw new RequestError(422, 'The source video is no longer available for device-compatible conversion.');
    }

    const sourceSize = parseSize(sourceResponse.headers['content-length']);
    if (sourceSize !== null && sourceSize > MAX_BYTES) {
      sourceResponse.destroy();
      throw new RequestError(413, 'This file is larger than ClipNest’s 250 MiB limit.');
    }

    const prefix = await readStreamPrefix(sourceResponse, 512);
    if (!hasVideoSignature(prefix)) {
      sourceResponse.destroy();
      throw new RequestError(422, 'The source is not a recognizable video file and cannot be converted.');
    }
    sourceResponse.unshift(prefix);

    let preparedMedia;
    try {
      preparedMedia = await transcodeToCompatibleMp4(sourceResponse, {
        maxInputBytes: MAX_BYTES,
        maxOutputBytes: MAX_BYTES
      });
    } catch (error) {
      sourceResponse.destroy();
      if (error.message.includes('larger than ClipNest')) {
        throw new RequestError(413, error.message);
      }
      throw new RequestError(422, 'ClipNest could not convert this source into a device-compatible MP4. Try another permitted video.');
    }

    const basename = path.parse(metadata.filename).name || 'clipnest-video';
    return {
      ...preparedMedia,
      metadata: {
        filename: safeFilename(`${basename}-compatible.mp4`),
        contentType: 'video/mp4',
        size: preparedMedia.size
      }
    };
  } finally {
    activeConversions -= 1;
  }
}

function streamPreparedFile(request, response, token, record, download, releaseSlot) {
  const size = record.metadata.size;
  const range = request.headers.range;
  const rangeInfo = range ? expectedByteRange(range, size) : null;
  if ((range && !/^bytes=\d*-\d*$/.test(range)) || (range && !rangeInfo)) {
    response.writeHead(416, {
      ...securityHeaders,
      'Content-Range': `bytes */${size}`,
      'Cache-Control': 'no-store'
    });
    response.end();
    record.inProgress = false;
    releaseSlot();
    return;
  }

  const partial = Boolean(rangeInfo);
  const start = partial ? rangeInfo.start : 0;
  const end = partial ? rangeInfo.end : size - 1;
  const headers = {
    ...securityHeaders,
    'Content-Type': 'video/mp4',
    'Content-Disposition': download
      ? contentDisposition(record.metadata.filename)
      : contentDisposition(record.metadata.filename).replace(/^attachment;/, 'inline;'),
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  };
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  response.writeHead(partial ? 206 : 200, headers);

  const fileStream = fs.createReadStream(record.preparedMedia.path, { start, end });
  let responseFinished = false;
  let fileClosed = false;
  let released = false;
  const complete = () => {
    if (released || !fileClosed) return;
    if (responseFinished) {
      if (download && !partial) cleanupToken(token, record);
      else if (download) record.inProgress = false;
    } else {
      record.inProgress = false;
    }
    released = true;
    releaseSlot();
  };
  fileStream.once('error', () => {
    record.inProgress = false;
    releaseSlot();
    response.destroy();
  });
  fileStream.once('close', () => {
    fileClosed = true;
    complete();
  });
  response.once('finish', () => {
    responseFinished = true;
    complete();
  });
  response.once('close', () => {
    if (!response.writableFinished) fileStream.destroy();
    complete();
  });
  fileStream.pipe(response);
}

async function handleResolve(request, response, requestMedia, rateCounts, {
  requestSaveApi: resolveSaveApi,
  requestYouTubeApi: resolveYouTubeApi,
  prepareMedia: prepareSocialMedia,
  saveApiKey
}) {
  if (rateLimited(request, rateCounts)) {
    sendJson(response, 429, { error: 'Too many requests. Please wait a minute and try again.' });
    return;
  }
  const body = await consumeJson(request);
  if (!body || !body.permissionConfirmed) {
    throw new RequestError(400, 'Confirm that the rights holder permits this download and that it is allowed by the platform.');
  }
  let resolution = await resolveMedia(body.url, {
    parseSourceUrl,
    probe: source => probe(source, requestMedia)
  });
  if (resolution.status === 'unsupported' && resolution.platform !== 'saveapi') {
    if (!saveApiKey) {
      sendJson(response, 422, {
        ...resolution,
        error: `${resolution.error} Configure SAVEAPI_KEY on the server to enable supported social links.`
      });
      return;
    }
    const isYoutubeLink = Boolean(youtubeAdapter.getVideoId(body.url));
    try {
      resolution = isYoutubeLink
        ? await youtubeAdapter.resolveDownload(body.url, {
          apiKey: saveApiKey,
          requestYouTubeApi: resolveYouTubeApi,
          parseSourceUrl,
          probe: source => probe(source, requestMedia)
        })
        : await saveApiAdapter.resolve(body.url, {
          apiKey: saveApiKey,
          requestSaveApi: resolveSaveApi,
          parseSourceUrl,
          probe: source => probe(source, requestMedia)
        });
    } catch (error) {
      if (isYoutubeLink && error instanceof RequestError && error.status === 422) {
        throw new RequestError(422, 'SaveAPI did not provide a downloadable YouTube video file. The video may be unavailable or unsupported; ClipNest will not download a thumbnail, watch page, or embedded stream.');
      }
      throw error;
    }
  }
  if (resolution.status === 'unsupported') {
    if (youtubeAdapter.getVideoId(body.url)) {
      sendJson(response, 422, {
        status: 'unsupported',
        platform: 'youtube',
        error: 'SaveAPI did not return a downloadable YouTube video file. The video may be unavailable or unsupported; ClipNest will not download a thumbnail, watch page, or embedded stream.'
      });
      return;
    }
    sendJson(response, 422, resolution);
    return;
  }
  for (const [key, record] of tokens) {
    if (record.expiresAt <= Date.now()) cleanupToken(key, record);
  }
  if (tokens.size >= 10_000) {
    throw new RequestError(503, 'ClipNest is busy. Please try again shortly.');
  }
  const { source, metadata } = resolution;
  const canStreamProviderMp4 = ['youtube', 'tiktok'].includes(resolution.platform) &&
    metadata.isMp4;
  const preparedMedia = resolution.platform === 'direct-file' || canStreamProviderMp4
    ? null
    : await prepareSocialMedia(source, metadata, requestMedia);
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = preparedMedia
    ? Date.now() + TOKEN_TTL_MS
    : Number.isFinite(resolution.expiresAt)
    ? Math.min(Date.now() + TOKEN_TTL_MS, resolution.expiresAt)
    : Date.now() + TOKEN_TTL_MS;
  if (expiresAt <= Date.now()) {
    throw new RequestError(422, 'The temporary video download link expired before it could be prepared. Please try again.');
  }
  const record = {
    source: preparedMedia ? null : source,
    metadata: preparedMedia ? preparedMedia.metadata : metadata,
    preparedMedia,
    expiresAt
  };
  if (preparedMedia) {
    record.cleanupTimer = setTimeout(() => cleanupToken(token, record), TOKEN_TTL_MS);
    record.cleanupTimer.unref();
  }
  tokens.set(token, record);
  sendJson(response, 200, {
    token,
    filename: record.metadata.filename,
    contentType: record.metadata.contentType,
    size: record.metadata.size,
    compatible: Boolean(preparedMedia),
    quality: preparedMedia
      ? 'Compatible MP4 · H.264 video + AAC audio · up to 720p'
      : resolution.quality || 'Original (as provided by the source)'
  });
}

async function requestSaveApiEndpoint(pathname, parameters, apiKey, fetchImpl = fetch) {
  const endpoint = new URL(`https://api.saveapi.org${pathname}`);
  for (const [key, value] of Object.entries(parameters)) {
    endpoint.searchParams.set(key, value);
  }

  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000)
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new RequestError(504, 'SaveAPI took too long to resolve this link. Please try again.');
    }
    throw new RequestError(502, 'Could not reach SaveAPI. Please try again later.');
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new RequestError(502, 'SaveAPI returned an invalid response.');
  }

  if (!response.ok) {
    const code = payload && payload.error && payload.error.code;
    if (response.status === 429 && code === 'QUOTA_EXCEEDED') {
      throw new RequestError(429, 'SaveAPI credits are exhausted. Check the balance in your SaveAPI dashboard.');
    }
    if (response.status === 429) {
      throw new RequestError(429, 'SaveAPI is rate-limiting requests. Please wait and try again.');
    }
    if (code === 'PRIVATE_CONTENT' || code === 'MEDIA_NOT_FOUND' ||
        code === 'UNSUPPORTED_PLATFORM' || code === 'INVALID_URL') {
      throw new RequestError(422, 'SaveAPI could not resolve this link. It may be private, unavailable, or unsupported.');
    }
    if (code === 'PLATFORM_NOT_ALLOWED') {
      throw new RequestError(422, 'This platform is not included in the configured SaveAPI plan.');
    }
    if (response.status === 401 || response.status === 403) {
      throw new RequestError(503, 'SaveAPI rejected the server key or account. Check SAVEAPI_KEY and your SaveAPI plan.');
    }
    if (response.status === 504) {
      throw new RequestError(504, 'The source platform took too long to respond. Please try again.');
    }
    throw new RequestError(502, 'SaveAPI could not resolve this link. Please try again later.');
  }

  return payload;
}

async function requestSaveApi(sourceUrl, apiKey, fetchImpl = fetch) {
  return requestSaveApiEndpoint('/v1/download', { url: sourceUrl }, apiKey, fetchImpl);
}

async function requestYouTubeApi(sourceUrl, apiKey, quality = '720p', fetchImpl = fetch) {
  return requestSaveApiEndpoint(
    '/v1/youtube/create',
    { url: sourceUrl, quality },
    apiKey,
    fetchImpl
  );
}

async function handleDownload(request, response, token, requestMedia, rateCounts) {
  const record = tokens.get(token);
  if (!record || record.expiresAt <= Date.now()) {
    if (record) cleanupToken(token, record);
    throw new RequestError(404, 'This download link expired. Check the URL again.');
  }
  if (rateLimited(request, rateCounts)) {
    throw new RequestError(429, 'Too many requests. Please wait a minute and try again.');
  }
  if (activeDownloads >= MAX_ACTIVE_DOWNLOADS) {
    throw new RequestError(503, 'ClipNest has reached its active download limit. Please try again shortly.');
  }
  if (record.inProgress) {
    throw new RequestError(409, 'This download is already in progress.');
  }
  record.inProgress = true;
  activeDownloads += 1;
  let slotReleased = false;
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    activeDownloads -= 1;
  };

  try {
    if (record.preparedMedia) {
      streamPreparedFile(request, response, token, record, true, releaseSlot);
      return;
    }
    const sourceResponse = await requestMedia(record.source, 'GET');
    const type = sourceResponse.headers['content-type'] || '';
    const status = sourceResponse.statusCode || 0;
    if (status < 200 || status >= 300 || !isVideoResponse(type, record.source, sourceResponse.headers)) {
      sourceResponse.destroy();
      throw new RequestError(502, 'The video source is no longer available as a video file.');
    }

    const size = parseSize(sourceResponse.headers['content-length']);
    if (size !== null && size > MAX_BYTES) {
      sourceResponse.destroy();
      throw new RequestError(413, 'This file is larger than ClipNest’s 250 MiB limit.');
    }
    const prefix = await readStreamPrefix(sourceResponse, 512);
    if (!hasVideoSignature(prefix)) {
      sourceResponse.destroy();
      throw new RequestError(502, 'The video source no longer returns a recognizable video file.');
    }
    const finalUrl = sourceResponse.finalUrl || record.source;
    const { contentType, filename } = mediaDetailsForTransfer(
      type,
      finalUrl,
      sourceResponse.headers,
      record.metadata
    );
    const downloadHeaders = {
      ...securityHeaders,
      'Content-Type': contentType,
      'Content-Disposition': contentDisposition(filename),
      'Cache-Control': 'no-store'
    };
    if (size !== null) downloadHeaders['Content-Length'] = size;
    response.writeHead(200, downloadHeaders);
    response.write(prefix);

    let received = 0;
    sourceResponse.on('data', chunk => {
      received += chunk.length;
      if (received > MAX_BYTES) {
        cleanupToken(token, record);
        sourceResponse.destroy(new Error('The video source exceeded ClipNest’s 250 MiB limit.'));
        response.destroy();
      }
    });
    sourceResponse.once('error', () => {
      record.inProgress = false;
      releaseSlot();
      response.destroy();
    });
    sourceResponse.once('aborted', () => {
      record.inProgress = false;
      releaseSlot();
      response.destroy();
    });
    response.once('finish', () => {
      cleanupToken(token, record);
      releaseSlot();
    });
    response.once('close', () => {
      if (!response.writableFinished && tokens.has(token)) record.inProgress = false;
      releaseSlot();
      if (!response.writableFinished) sourceResponse.destroy();
    });
    sourceResponse.pipe(response);
  } catch (error) {
    record.inProgress = false;
    releaseSlot();
    throw error;
  }
}

async function handlePreview(request, response, token, requestMedia, rateCounts) {
  const record = tokens.get(token);
  if (!record || record.expiresAt <= Date.now()) {
    if (record) cleanupToken(token, record);
    throw new RequestError(404, 'This preview link expired. Check the video URL again.');
  }
  if (rateLimited(request, rateCounts)) {
    throw new RequestError(429, 'Too many requests. Please wait a minute and try again.');
  }
  if (activeDownloads >= MAX_ACTIVE_DOWNLOADS) {
    throw new RequestError(503, 'ClipNest has reached its active stream limit. Please try again shortly.');
  }

  const range = request.headers.range;
  if (range && !/^bytes=\d*-\d*$/.test(range)) {
    throw new RequestError(416, 'The requested video preview range is not supported.');
  }

  activeDownloads += 1;
  let slotReleased = false;
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    activeDownloads -= 1;
  };

  try {
    if (record.preparedMedia) {
      streamPreparedFile(request, response, token, record, false, releaseSlot);
      return;
    }
    const sourceResponse = await requestMedia(record.source, 'GET', range ? { Range: range } : {});
    const type = sourceResponse.headers['content-type'] || '';
    const status = sourceResponse.statusCode || 0;
    if (![200, 206].includes(status) || !isVideoResponse(type, record.source, sourceResponse.headers)) {
      sourceResponse.destroy();
      throw new RequestError(502, 'The source is no longer available as a video file.');
    }

    const contentRange = sourceResponse.headers['content-range'];
    const rangeMatch = contentRange && contentRange.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    const totalSize = rangeMatch ? parseSize(rangeMatch[3]) : parseSize(sourceResponse.headers['content-length']);
    if (totalSize !== null && totalSize > MAX_BYTES) {
      sourceResponse.destroy();
      throw new RequestError(413, 'This file is larger than ClipNest’s 250 MiB limit.');
    }
    if (status === 206 && !rangeMatch) {
      sourceResponse.destroy();
      throw new RequestError(502, 'The video source returned an invalid byte range.');
    }
    if (status === 206) {
      const expectedRange = expectedByteRange(range, totalSize);
      if (!range || !expectedRange ||
          Number(rangeMatch[1]) !== expectedRange.start ||
          Number(rangeMatch[2]) !== expectedRange.end ||
          Number(rangeMatch[2]) >= totalSize) {
        sourceResponse.destroy();
        throw new RequestError(502, 'The video source returned a mismatched byte range.');
      }
    }
    const rangeStart = rangeMatch ? Number(rangeMatch[1]) : 0;
    if (rangeStart === 0) {
      const prefix = await readStreamPrefix(sourceResponse, 512);
      if (!hasVideoSignature(prefix)) {
        sourceResponse.destroy();
        throw new RequestError(502, 'The video source no longer returns a recognizable video file.');
      }
      sourceResponse.previewPrefix = prefix;
    }

    const finalUrl = sourceResponse.finalUrl || record.source;
    const { contentType, filename } = mediaDetailsForTransfer(
      type,
      finalUrl,
      sourceResponse.headers,
      record.metadata
    );
    const previewHeaders = {
      ...securityHeaders,
      'Content-Type': contentType,
      'Content-Disposition': contentDisposition(filename).replace(/^attachment;/, 'inline;'),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    };
    const contentLength = parseSize(sourceResponse.headers['content-length']);
    if (contentLength !== null) previewHeaders['Content-Length'] = contentLength;
    if (rangeMatch) previewHeaders['Content-Range'] = contentRange;
    response.writeHead(status, previewHeaders);
    if (sourceResponse.previewPrefix) response.write(sourceResponse.previewPrefix);

    let received = 0;
    sourceResponse.on('data', chunk => {
      received += chunk.length;
      if (received > MAX_BYTES) {
        sourceResponse.destroy(new Error('The preview stream exceeded ClipNest’s 250 MiB limit.'));
        response.destroy();
      }
    });
    sourceResponse.once('error', () => {
      releaseSlot();
      response.destroy();
    });
    sourceResponse.once('aborted', () => {
      releaseSlot();
      response.destroy();
    });
    sourceResponse.once('end', releaseSlot);
    response.once('close', () => {
      releaseSlot();
      if (!response.writableFinished) sourceResponse.destroy();
    });
    sourceResponse.pipe(response);
  } catch (error) {
    releaseSlot();
    throw error;
  }
}

function createServer({
  requestMedia = remoteRequest,
  requestSaveApi: resolveSaveApi = requestSaveApi,
  requestYouTubeApi: resolveYouTubeApi = requestYouTubeApi,
  prepareMedia = prepareCompatibleMedia,
  saveApiKey = process.env.SAVEAPI_KEY
} = {}) {
  const rateCounts = new Map();
  return http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, 'http://clipnest.local');
      if (requestUrl.pathname === '/healthz' && request.method === 'GET') {
        response.writeHead(200, {
          ...securityHeaders,
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        response.end('{"status":"ok"}');
        return;
      }
      if (requestUrl.pathname === '/api/resolve' && request.method === 'POST') {
        await handleResolve(request, response, requestMedia, rateCounts, {
          requestSaveApi: resolveSaveApi,
          requestYouTubeApi: resolveYouTubeApi,
          prepareMedia,
          saveApiKey
        });
        return;
      }
      const previewMatch = requestUrl.pathname.match(/^\/api\/preview\/([a-f0-9]{48})$/);
      if (previewMatch && request.method === 'GET') {
        await handlePreview(request, response, previewMatch[1], requestMedia, rateCounts);
        return;
      }
      const downloadMatch = requestUrl.pathname.match(/^\/api\/download\/([a-f0-9]{48})$/);
      if (downloadMatch && request.method === 'GET') {
        await handleDownload(request, response, downloadMatch[1], requestMedia, rateCounts);
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { error: 'Method not allowed.' });
        return;
      }
      const staticFile = supportedFiles.get(requestUrl.pathname);
      if (!staticFile) {
        sendJson(response, 404, { error: 'Not found.' });
        return;
      }
      const [filename, contentType] = staticFile;
      const file = path.join(ROOT, filename);
      response.writeHead(200, {
        ...securityHeaders,
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
      });
      if (request.method === 'HEAD') response.end();
      else fs.createReadStream(file).pipe(response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (!(error instanceof RequestError)) {
        console.error('ClipNest request failed:', error.name);
      }
      const status = error instanceof RequestError ? error.status : 502;
      sendJson(response, status, {
        error: error instanceof RequestError ? error.message : 'Could not reach the authorized video source.'
      });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer between 1 and 65535.');
    process.exitCode = 1;
  } else {
    createServer().listen(port, host, () => {
      console.log(`ClipNest listening on http://${host}:${port}`);
    });
  }
}

module.exports = {
  MAX_BYTES,
  contentDisposition,
  createServer,
  filenameFromResponse,
  hasVideoSignature,
  isPublicAddress,
  mediaContentType,
  isVideoResponse,
  parseSourceUrl,
  prepareCompatibleMedia,
  requestSaveApi,
  requestYouTubeApi,
  safeFilename
};
