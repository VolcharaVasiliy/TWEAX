# TWEAX for Firefox (Manifest V3)

Firefox build of TWEAX, ported from the Chrome/Edge MV3 version. Same
features: HLS video+audio assembly with AES-128, ffmpeg.wasm stream-copy
muxing into one MP4, MP4→GIF conversion, photo downloads (single + zip),
auto-unmute with volume lock, NSFW auto-reveal, filename templates.

## What differs from the Chrome build

| Area | Chrome MV3 | Firefox MV3 (this build) |
| --- | --- | --- |
| Background | Service worker (ESM) | Event page (ESM, `background.scripts` + `"type": "module"`) |
| Heavy pipeline (HLS assembly, ffmpeg.wasm, blob URLs) | Separate `chrome.offscreen` document | Runs **in the background page itself** (`background/offscreen-pipeline.js`): Firefox has no `offscreen` API, but its background page is a full DOM page that can run wasm workers and create blob URLs |
| Job delivery | `runtime.sendMessage` broadcast + ack retries | Direct synchronous call into the pipeline handler (`__tweaxOffscreenHandler`); cannot be lost in transit |
| Pipeline reports (`tweax:save/progress/done`) | Messages from the offscreen document | Routed through `__tweaxToBackground` into the same message handler |
| Event-page suspension | n/a (offscreen page never sleeps) | Keepalive interval while a job runs or a blob download is in flight |
| MAIN-world content script | `world: "MAIN"` | Same (Firefox 128+) |
| Manifest extras | `minimum_chrome_version`, `offscreen` permission | `browser_specific_settings.gecko` (id, `strict_min_version: 128`, `data_collection_permissions: none`) |

Content scripts, popup and the ffmpeg bundle are byte-identical to the
Chrome build.

**Bug fixed on the way:** the AES-128 path in the original offscreen code
passed a raw `Uint8Array` to `crypto.subtle.decrypt` where a `CryptoKey`
is required — every engine throws `Argument 2 does not implement interface
CryptoKey`, so AES-protected HLS could never download (in the Chrome build
too). The key is now imported via `crypto.subtle.importKey("raw", …)`.

## Firefox-specific notes

- Firefox 128+ required (`world: "MAIN"` content script). Tested on Firefox 156.
- `host_permissions: <all_urls>` is **optional** in Firefox MV3: after a
  regular install, open about:addons → TWEAX → Permissions and enable
  "Access your data for all websites", or downloads from x.com CDNs will be
  blocked by CORS. (Temporary/self-installed copies get it without a prompt.)
- The `chrome.*` namespace returns Promises in Firefox, so the Chrome code
  style (`await chrome.storage…`) works unmodified.
- `downloads.download()` with `data:` URLs is rejected by Firefox — the
  extension itself only ever downloads `blob:`/http URLs, so this does not
  affect it.

## Install (temporary, unsigned)

1. `web-ext run --source-dir . --firefox "<path to firefox.exe>"`, or
2. about:debugging → This Firefox → Load Temporary Add-on → `manifest.json`.

## Install (permanent)

Package the folder as a zip (without `test/`) and submit to
addons.mozilla.org — signing is required for permanent installs.
`web-ext lint` passes with 0 errors.

## Self-test

`test/harness.html` (open it from about:debugging, or run with
`web-ext run --start-url moz-extension://<uuid>/test/harness.html`) drives
the real message API against a local HLS fixture server and reports over
HTTP. Verified cases: muxed HLS (AES-128, explicit + sequence-derived IV),
combined A/V playlist, fMP4 assembly, direct MP4, GIF conversion, photo zip,
downloads API round-trip, content-script bridge injection, live x.com
injection check (`test/xcom-check.html`).
