# ClipNest

ClipNest is a responsive website with a small, dependency-free Node.js backend for authorized direct video-file URLs and supported public social posts.

## Social platform links

ClipNest can resolve a public post URL through [SaveAPI](https://saveapi.org/en/docs) when `SAVEAPI_KEY` is configured on the server. The integration recognizes TikTok, Facebook, Instagram, YouTube, X, Pinterest, Likee, Snapchat, Threads, VK, 9GAG, Twitch, and Rutube URLs; availability depends on SaveAPI's supported platforms, account entitlements and credits, platform rules, and the specific post. SaveAPI's [official JavaScript SDK](https://github.com/akhroruz/saveapi-sdk/tree/main/js) documents YouTube `youtubeInfo()` and `youtubeCreate(url, quality)` methods; creating a YouTube download link costs 10 credits and the returned link is short-lived. ClipNest requests the documented 720p H.264 MP4 link server-side and streams it directly after validating the returned public URL and actual video bytes; it avoids re-encoding an already compatible YouTube file. Other supported social videos are converted to H.264/AAC MP4 for broader device playback. Conversion uses bundled FFmpeg and temporarily stores only the converted output on the server until it is downloaded or its 10-minute token expires; direct video-file and YouTube downloads remain unchanged. This documents the integration contract, not live verification of a particular YouTube post or the configured SaveAPI plan. If SaveAPI does not return a video file or ClipNest cannot validate or convert it, ClipNest shows an error; it never falls back to a thumbnail, watch page, or embedded stream. Other unsupported/unavailable posts also return an explicit error. No private posts, sign-in flow, or DRM are supported. Users must confirm the rights holder permits the download and that platform/provider terms allow it.

The browser sends the post URL only to ClipNest. ClipNest sends it to SaveAPI using a server-side bearer key, selects a returned video URL, then validates and streams the media through the existing DNS-pinned, MIME/signature-checked download flow. The key is never sent to or embedded in the browser. SaveAPI may charge credits for lookups; check its current pricing and credit balance. Its documentation currently says free signup credits do not expire, while purchased credits expire 30 days after purchase. API keys do not expire by default but can be revoked; confirm current terms in the provider dashboard.

### Resolver adapters and platform limits

The backend resolver identifies supported social hosts using adapters under `media-resolver/adapters/`. Social URLs are sent to SaveAPI only after the user confirms that the rights holder and platform permit the download, and only when a server key is configured. Generic provider responses must include an explicitly video-typed entry. YouTube uses SaveAPI's documented `/v1/youtube/create` endpoint (720p H.264 MP4); its returned URL must pass the same public HTTP(S), DNS-pinned, MIME, video-signature, and 250 MiB checks as a direct file. Since that provider endpoint already returns a compatible MP4, ClipNest streams the validated YouTube file without a second, unnecessary encode. Other supported social video sources are piped through FFmpeg and converted to H.264 Baseline, yuv420p, AAC-LC MP4, capped at 720p, then validated and offered for preview or download. Only converted output is temporarily written to a unique server temp directory; it is deleted after a completed download or when its 10-minute token expires. A missing YouTube file, unsupported plan, watch page, thumbnail, or embed results in an explicit error and never a download token. Direct video-file URLs continue to use the original validated streaming flow without conversion or SaveAPI.

SaveAPI and social platforms may change supported hosts, access rules, formats, and pricing. Unsupported or unavailable posts return an explicit error; use a platform's official save options where available. ClipNest does not request social-account passwords or cookies and does not attempt to access private content.

## Run locally

Install Node.js 18 or newer, then open a terminal in this folder:

```powershell
npm.cmd start
```

Open `http://127.0.0.1:3000`. Do not open `index.html` directly or use Live Server for the downloader: the page and API must be served from the same Node process. Run `npm.cmd install` once to install the bundled FFmpeg binary. This FFmpeg build includes GPL components such as libx264; review its license obligations before distributing the application or binary. Direct-file downloads work without an API key; social post downloads require a SaveAPI key and available provider/platform credits.

To set up SaveAPI locally, copy the example file, open `.env` in VS Code, and replace the example value with your key from the SaveAPI dashboard:

```powershell
Copy-Item .env.example .env
code .env
```

Save `.env`, then start the site:

```powershell
npm.cmd start
```

The server reads `.env` at startup. `.env` is ignored by Git; do not share or commit it. Never put the key in `script.js`, HTML, or another browser-visible file. For production, add `SAVEAPI_KEY` as a secret environment variable in the hosting provider's settings. If a key has been exposed, revoke it in the SaveAPI dashboard and replace it.

Run the unit and HTTP-flow tests with:

```powershell
npm.cmd test
```

If the page is opened as `file:///.../index.html`, or served by a static-only preview such as Live Server, the relative `/api/resolve` and `/api/download/...` requests do not reach this backend. Use the URL printed by `npm start` (`http://127.0.0.1:3000`) instead. The checker displays this setup guidance when it detects a `file:` page.

For local development, the server binds to localhost by default. To bind to another interface or port, set `HOST` and/or `PORT` before starting the process.

## Download flow and limits

1. The browser sends the submitted URL and the user's permission confirmation to `POST /api/resolve`.
2. The resolver dispatches recognized public social-platform links to SaveAPI when `SAVEAPI_KEY` is configured. Other URLs go to the direct-file adapter, which accepts only HTTP(S) on standard ports, checks DNS/IP addresses against private and special-use ranges, pins the checked address for each request, and revalidates every redirect.
3. The backend probes the URL, requires a video content type or treats an opaque `application/octet-stream` response as a candidate, checks the file's initial container signature (including signed CDN URLs with unknown extensions), and rejects files over 250 MiB. Known image and text file extensions and unrecognized file contents are rejected.
4. Direct files and provider-created YouTube MP4s keep their original bytes. Other social-provider media is transcoded to a device-compatible H.264/AAC MP4 (maximum 720p), and only that converted output is temporarily stored until download or token expiry. ClipNest returns a short-lived token, filename, size, and conversion details.
5. After a successful check, the page previews the validated media through `GET /api/preview/:token`. The preview endpoint rechecks the video response, streams the source inline, enforces the size cap, and forwards byte-range requests so the browser's video controls can seek without loading the complete file into page memory.
6. On download, the **Download video** link navigates directly to `GET /api/download/:token` in the user's click gesture. The backend streams the video with `Content-Type: video/*`, `Content-Disposition: attachment`, a sanitized filename, and its content length when known, allowing the browser's native download/save UI to handle the file and show transfer progress without buffering up to 250 MiB in page memory. Mobile browsers may save to Downloads or offer a save sheet depending on browser and operating system. A token permits one completed download and is removed when that transfer finishes; an interrupted transfer can be retried while the token is valid.

Download tokens and source URLs are kept in process memory for at most 10 minutes. Direct-file bytes are streamed without server-side storage. Social-provider source bytes are piped to FFmpeg without saving the source; the converted MP4 is stored in a unique temporary directory and removed after a completed download or within 10 minutes. A process or machine crash can leave temporary output behind for the host to clean up. The application does not intentionally log submitted URLs or persist them. Hosting providers, reverse proxies, or network infrastructure may keep their own access logs, so disable URL logging in the deployment and review host retention settings. Redirected direct-file URLs are checked at each hop, and the final media URL is used when the source does not supply a filename. Some mobile browsers save through their Downloads folder or share sheet instead of honoring a filename directly.

The backend fetches media sources itself, so source-server CORS headers are not needed. The source must still be public, valid, and accessible to the server; private/authenticated URLs, expired links, non-video pages, oversized files, and unsupported redirects fail clearly. Do not configure cookies or user passwords to access protected sources. Social post URLs recognized by an adapter are submitted to SaveAPI only after the user confirms their rights and only when `SAVEAPI_KEY` is configured.

## Public deployment

The Node server hosts both the existing frontend and `/api/*`, so deploy them as one same-origin Node web service. This avoids browser CORS configuration and keeps the media API on the same origin. Use a managed Node host or container platform that supports long-lived streamed responses and outbound HTTPS to public video sources.

### Google Search

The canonical site address is `https://clipnest.autos/`. The Node server serves:

- `https://clipnest.autos/robots.txt`
- `https://clipnest.autos/sitemap.xml`

The XML sitemap lists the homepage, privacy policy, and terms page; `robots.txt` allows public-page crawling and disallows `/api/`. These URLs become available only after the Node app is deployed on a host with HTTPS and the domain points to it.

After launch:

1. In Google Search Console, add a **Domain** property for `clipnest.autos`.
2. Copy Google's TXT verification value into the domain's DNS records at the registrar, using the exact host/name and value Google provides. Keep the token private; do not put it in this repository.
3. Wait for DNS to publish, click **Verify** in Search Console, then open **Sitemaps** and submit `sitemap.xml`.
4. Use Search Console's URL Inspection for `https://clipnest.autos/` if you also want to request indexing.

Submitting a sitemap tells Google where pages are; it does not guarantee crawling, indexing, or a particular search ranking.

### Render preview deployment

This repository includes a Render Blueprint in `render.yaml` for the **Free** plan the owner selected for a preview. Connect the GitHub repository in Render, create the Blueprint web service, and provide `SAVEAPI_KEY` as a secret environment variable when prompted (optional for direct-file downloads; required for SaveAPI social-post resolution). Never commit `.env` or paste an API key into source files.

Render's Free web services can sleep after 15 minutes without traffic, may take about a minute to wake, have limited monthly compute hours and bandwidth, and use an ephemeral filesystem. Render documents Free as for testing/hobby projects rather than production; bandwidth overages can incur charges depending on account billing settings. Monitor the Render billing/usage dashboard and do not treat this preview as a reliable always-on public service.

After the first successful deploy, add `clipnest.autos` in the Render service's **Settings → Custom Domains** and use the exact DNS records Render displays. The current Spaceship parking-page DNS records must be replaced with Render's records; remove conflicting `AAAA` records. For a root domain, Render currently documents `A @` to `216.24.57.1` when no `ANAME`/`ALIAS` is available; use the live Render instructions as authoritative. Add `www.clipnest.autos` only if you want Render to redirect it to the canonical root-domain URL. Wait for Render's managed HTTPS certificate before submitting the sitemap in Search Console.

### Single-instance launch

1. Deploy this project folder from your Git repository to a Node.js host. Use Node.js 20 or newer.
2. Set the start command to `npm start`. There is no build step or npm dependency install required.
3. Set `NODE_ENV=production`. The server binds to `0.0.0.0` in production and uses the platform's `PORT` environment variable.
4. Configure the platform health check to `GET /healthz`.
5. Attach a domain and HTTPS certificate, then open the HTTPS site. Do not expose the Node service directly without TLS; terminate TLS at the host's trusted reverse proxy/load balancer.
6. If using a CDN, serve normal site pages normally, but bypass cache for `/api/*` (especially downloads); preserve streaming responses, do not buffer large responses, and configure idle/request timeouts for the maximum expected transfer duration.

The `HOST` environment variable can override the bind address; `PORT` must be between 1 and 65535. Keep one app instance initially: download tokens and request-rate state are in process memory. Load-balancing a resolve request and its later download request to different instances will fail because the second instance has no token. Before scaling horizontally, move tokens to shared short-lived storage and rate limits/quotas to a shared store or trusted edge service.

### Public-service safeguards

The backend validates public HTTP(S) sources, pins DNS lookups to checked addresses, rechecks each redirect, limits redirects and transfer size, validates video signatures, and caps simultaneous outbound downloads at eight and conversions at two per process. Direct-file bytes are not written to disk; social conversion output is temporary as described above. It also sets restrictive browser security headers and a health endpoint.

This is still an anonymous bandwidth relay: the permission checkbox is a user assertion, not authentication. Before opening public signup-free access, put the service behind abuse controls: authentication or per-account quotas where appropriate, edge/WAF rate limits keyed to the real client IP, per-user bandwidth limits, monitoring/alerts, and a process/container egress policy that allows only required public outbound traffic. The built-in 30-request/minute limiter is per process and uses the TCP peer address; behind one reverse proxy that may be the proxy address for all users. Do not trust arbitrary `X-Forwarded-For` headers in the app; configure client-IP extraction and rate limiting at the trusted proxy. Set provider-level egress/bandwidth budgets and scale only after observing real transfer load.

The service supports public direct files and public social posts successfully resolved by SaveAPI, subject to provider and platform availability. Do not promise support for every platform or post. Review the privacy policy, terms, copyright handling, abuse reporting/takedown process, retention obligations, and regional legal requirements before launch.

## Included

- Existing responsive ClipNest design and platform help cards
- Same-origin Node.js HTTP server with static site hosting
- Direct video URL validation, source-size and MIME checks, safe filenames, and streamed downloads
- Native browser download link with streamed transfer, safe filename, and browser-managed progress/save UI
- HTTP-flow tests for URL validation, metadata resolution, response headers, and transferred video bytes using a mocked authorized source
- Permission confirmation, unsupported platform guidance, FAQ, and policy templates

Review the privacy policy and terms for your deployment before launch. Users must have the rights required to download and save each video.
