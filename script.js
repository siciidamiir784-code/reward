const form = document.querySelector('#link-form');
const input = document.querySelector('#video-url');
const button = document.querySelector('#download-button');
const result = document.querySelector('#result');

document.querySelector('#year').textContent = new Date().getFullYear();

const serverRequiredMessage = 'ClipNest’s download API is not available from a file opened directly. Start the Node.js server in VS Code with `npm start`, then open http://127.0.0.1:3000.';

if (!['http:', 'https:'].includes(window.location.protocol)) {
  result.hidden = false;
  result.textContent = serverRequiredMessage;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return 'Size provided by source when available';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  result.hidden = false;
  result.replaceChildren();
  result.textContent = 'Checking the source and preparing a compatible video if needed. Larger videos can take a few minutes; please keep this page open.';
  button.disabled = true;
  const controller = new AbortController();
  const requestTimeout = setTimeout(() => controller.abort(), 11 * 60 * 1000);
  const progressMessages = [
    'Still checking the source… larger files can take a little while.',
    'Preparing a compatible video when needed… keep this page open while it finishes.'
  ];
  let progressIndex = 0;
  const progressTimer = setInterval(() => {
    result.textContent = progressMessages[progressIndex];
    progressIndex = (progressIndex + 1) % progressMessages.length;
  }, 10_000);

  try {
    const url = new URL(input.value.trim());
    if (!['https:', 'http:'].includes(url.protocol)) {
      throw new Error('Please use a direct http or https video-file URL.');
    }

    if (!['http:', 'https:'].includes(window.location.protocol)) {
      throw new Error(serverRequiredMessage);
    }
    if (!document.querySelector('#permission-confirmation').checked) {
      throw new Error('Confirm that the rights holder permits this download and that it is allowed by the platform.');
    }

    const response = await fetch('/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url.href, permissionConfirmed: true }),
      signal: controller.signal
    });
    const video = await response.json().catch(() => null);
    if (!response.ok) {
      if (!video) throw new Error(serverRequiredMessage);
      throw new Error(video.error || `Could not check the video link (HTTP ${response.status}).`);
    }
    if (!video) throw new Error(serverRequiredMessage);

    const detail = document.createElement('p');
    detail.className = 'preview-note';
    detail.textContent = `${video.quality} · ${video.filename} · ${video.contentType} · ${formatSize(video.size)}`;
    const preview = document.createElement('video');
    preview.className = 'media-preview';
    preview.controls = true;
    preview.preload = 'metadata';
    preview.playsInline = true;
    preview.setAttribute('aria-label', `Video preview: ${video.filename}`);
    preview.src = `/api/preview/${encodeURIComponent(video.token)}`;
    const downloadLink = document.createElement('a');
    downloadLink.href = `/api/download/${encodeURIComponent(video.token)}`;
    downloadLink.download = video.filename;
    downloadLink.className = 'save-link';
    downloadLink.textContent = video.compatible ? 'Download compatible video' : 'Download video';
    const note = document.createElement('p');
    note.className = 'preview-note';
    note.textContent = video.compatible
      ? 'This social video is converted to an H.264/AAC MP4 for broader device playback. The temporary server copy is removed after download or within 10 minutes.'
      : 'Preview the video above, then choose Download video to save the original file to your browser’s downloads.';
    result.replaceChildren(detail, preview, downloadLink, note);
  } catch (error) {
    result.textContent = error.message === serverRequiredMessage
      ? serverRequiredMessage
      : error.name === 'AbortError'
      ? 'This video took too long to prepare. Check the link or try a smaller video.'
      : error instanceof TypeError && error.message !== 'Invalid URL'
      ? 'Could not reach ClipNest. Start the Node.js server and open the site from its address.'
      : error.message;
  } finally {
    clearTimeout(requestTimeout);
    clearInterval(progressTimer);
    button.disabled = false;
  }
});
