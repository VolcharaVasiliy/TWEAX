// The offscreen document owns the whole download pipeline. A service worker
// can neither fetch+assemble large media comfortably nor run ffmpeg.wasm's
// workers, nor create blob URLs — a hidden page can do all three.
//
// Pipeline for a job {url, audioUrl?, name?}:
//   1. assemble(playlist) — master→best variant, bounded-concurrency segment
//      fetch with retries, AES-128 decryption (WebCrypto), fMP4/TS concat;
//   2. when audioUrl is present (X splits avc1/mp4a): assemble both tracks and
//      mux them with stream-copy ffmpeg.wasm into one mp4;
//   3. hand the blob URL to the background for chrome.downloads.

import { FFmpeg } from "../ffmpeg/ffmpeg-esm/index.js";


const FETCH_TIMEOUT_MS = 60_000;
const SEGMENT_CONCURRENCY = 4;
const SEGMENT_RETRIES = 3;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;

let ffmpeg = null;
let ffmpegLoading = null;

const report = (payload) => {
  try {
    chrome.runtime.sendMessage({ ...payload }).catch(() => {});
  } catch {}
};

function requestTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${ms}ms`)), ms);
  return controller.signal;
}

async function fetchBuffer(url, maxBytes, signal = null) {
  const response = await fetch(url, { signal: signal ?? requestTimeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`empty response body for ${url}`);
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error(`response exceeded the ${maxBytes}-byte cap: ${url}`);
    }
    chunks.push(value);
  }
  return { buf: concat(chunks), type: response.headers.get("content-type") };
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function fetchText(url) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { buf } = await fetchBuffer(url, MAX_PLAYLIST_BYTES);
      // Uint8Array.toString() ignores encodings (that is a Buffer API) —
      // decode explicitly or the parser sees comma-separated byte numbers.
      return new TextDecoder().decode(buf);
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------- HLS

function parseMaster(text, baseUrl) {
  if (!text.includes("#EXT-X-STREAM-INF")) return null;
  const lines = text.split(/\r?\n/);
  const variants = [];
  let pending = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#EXT-X-STREAM-INF:")) {
      const raw = t.slice("#EXT-X-STREAM-INF:".length);
      pending = {
        bandwidth: Number(/BANDWIDTH=(\d+)/.exec(raw)?.[1] ?? 0),
        resolution: /RESOLUTION=([0-9x]+)/.exec(raw)?.[1] ?? null,
        uri: "",
      };
      continue;
    }
    if (t.startsWith("#")) continue;
    if (pending) {
      try { pending.uri = new URL(t, baseUrl).toString(); } catch { pending.uri = t; }
      variants.push(pending);
      pending = null;
    }
  }
  return variants;
}

function parseMedia(text, baseUrl) {
  if (!text.includes("#EXTM3U")) {
    throw new Error(`not an M3U8 playlist (missing #EXTM3U); got: ${text.slice(0, 80).replace(/\s+/g, " ") || "(empty)"}`);
  }
  const resolveUrl = (u) => { try { return new URL(u, baseUrl).toString(); } catch { return u; } };
  const segments = [];
  let initSegment = null;
  let key = null;
  let mediaSequence = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = Number(t.split(":")[1]) || 0;
    } else if (t.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttrs(t.slice("#EXT-X-MAP:".length));
      if (attrs.URI) initSegment = resolveUrl(attrs.URI);
    } else if (t.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttrs(t.slice("#EXT-X-KEY:".length));
      const method = attrs.METHOD ?? "NONE";
      if (method !== "NONE" && method !== "AES-128") {
        throw new Error(`unsupported HLS encryption method: ${method}`);
      }
      if (method === "AES-128" && attrs.URI) {
        key = { uri: resolveUrl(attrs.URI), iv: attrs.IV ?? null };
      }
    } else if (!t.startsWith("#")) {
      segments.push(resolveUrl(t));
    }
  }
  // A playlist with an init segment but zero segments (an LL-HLS window
  // snapshot, say) would assemble into an unplayable stub — fail loudly.
  if (!segments.length) throw new Error("the playlist contains no segments");
  return { segments, initSegment, key, mediaSequence };
}

function parseAttrs(raw) {
  const out = {};
  for (const part of raw.match(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g) ?? []) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return out;
}

const ivFromSequence = (seq) => {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setBigUint64(8, BigInt(seq));
  return iv;
};

async function fetchKeyBytes(url) {
  const { buf } = await fetchBuffer(url, 1024 * 1024);
  if (buf.length !== 16) throw new Error(`AES-128 key has ${buf.length} bytes, expected 16`);
  return buf;
}

/** Assemble one media playlist into a single Uint8Array (fMP4 or TS). */
async function assemble(playlistUrl, reportProgress) {
  let text = await fetchText(playlistUrl);
  const variants = parseMaster(text, playlistUrl);
  if (variants) {
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    playlistUrl = variants[0].uri;
    text = await fetchText(playlistUrl);
  }
  const playlist = parseMedia(text, playlistUrl);

  const parts = [];
  if (playlist.initSegment) parts.push({ uri: playlist.initSegment, isInit: true });
  playlist.segments.forEach((uri, i) =>
    parts.push({ uri, isInit: false, seq: playlist.mediaSequence + i })
  );

  const buffers = new Array(parts.length).fill(null);
  let keyBytes = null;
  if (playlist.key) keyBytes = await fetchKeyBytes(playlist.key.uri);

  let next = 0;
  let done = 0;
  let failure = null;
  const workers = Array.from({ length: Math.min(SEGMENT_CONCURRENCY, parts.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= parts.length || failure) return;
      const part = parts[index];
      for (let attempt = 0; attempt <= SEGMENT_RETRIES; attempt++) {
        try {
          const { buf } = await fetchBuffer(part.uri, MAX_FILE_BYTES);
          let data = buf;
          if (playlist.key && keyBytes && !part.isInit) {
            // The IV is the segment's own media sequence — the init segment
            // (EXT-X-MAP) occupies slots in parts[] but not in the sequence.
            const ivBytes = playlist.key.iv
              ? hexToBytes(playlist.key.iv.replace(/^0x/, ""))
              : ivFromSequence(part.seq);
            data = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBytes }, keyBytes, buf));
          }
          buffers[index] = data;
          done++;
          reportProgress?.({ phase: "segments", done, total: parts.length });
          break;
        } catch (err) {
          if (attempt === SEGMENT_RETRIES) {
            failure = new Error(`segment ${index + 1}/${parts.length} failed: ${err.message ?? err}`);
          } else {
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          }
        }
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;

  const body = concat(buffers);
  const isMp4 = looksLikeMp4(body) || /\.(mp4|m4s|cmf)(\?|$)/i.test(parts[0]?.uri ?? "");
  return { body, container: isMp4 ? "mp4" : "ts" };
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------------------------------------------------------------- zip

function imageExt(url, type) {
  try {
    const f = new URL(url).searchParams.get("format");
    if (f) return f.toLowerCase();
  } catch {}
  const m = /^image\/(jpe?g|png|webp|gif)/i.exec(type ?? "");
  if (m) return m[1] === "jpeg" ? "jpg" : m[1];
  const u = /\.([a-z0-9]{2,5})(\?|$)/i.exec(url);
  return u ? u[1].toLowerCase() : "jpg";
}

function crc32(buf) {
  if (!crc32.t) {
    crc32.t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.t[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crc32.t[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer: stored entries (no compression — X images are already
 * compressed), UTF-8 names, one central directory + EOCD. */
function buildZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = new Uint8Array(30 + name.length);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, f.data.length, true);
    dv.setUint32(22, f.data.length, true);
    dv.setUint16(26, name.length, true);
    head.set(name, 30);
    chunks.push(head, f.data);
    const c = new Uint8Array(46 + name.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    c.set(name, 46);
    central.push(c);
    offset += head.length + f.data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return concat([...chunks, ...central, eocd]);
}

function looksLikeMp4(buf) {
  if (buf.length < 12) return false;
  const box = String.fromCharCode(...buf.slice(4, 8));
  return box === "ftyp" || box === "styp" || box === "sidx" || box === "moof";
}

// ---------------------------------------------------------------- ffmpeg.wasm

async function ensureFfmpeg() {
  if (ffmpeg?.loaded) return ffmpeg;
  if (!ffmpegLoading) {
    ffmpegLoading = (async () => {
      const instance = new FFmpeg();
      await instance.load({
        coreURL: chrome.runtime.getURL("ffmpeg/core-esm/ffmpeg-core.js"),
        wasmURL: chrome.runtime.getURL("ffmpeg/core-esm/ffmpeg-core.wasm"),
      });
      return instance;
    })().finally(() => {
      ffmpegLoading = null;
    });
  }
  ffmpeg = await ffmpegLoading;
  return ffmpeg;
}

/** Stream-copy mux of separate video/audio tracks into one mp4. */
async function muxTracks(video, audio, name) {
  const ffmpeg = await ensureFfmpeg();
  await ffmpeg.writeFile("v.mp4", video);
  await ffmpeg.writeFile("a.m4a", audio);
  const logs = [];
  const onLog = ({ message }) => logs.push(message);
  ffmpeg.on("log", onLog);
  let ok = false;
  try {
    const code = await ffmpeg.exec(["-i", "v.mp4", "-i", "a.m4a", "-c", "copy", "-movflags", "+faststart", "out.mp4"]);
    ok = code === 0;
  } finally {
    ffmpeg.off("log", onLog);
  }
  if (!ok) {
    await ffmpeg.deleteFile("v.mp4").catch(() => {});
    await ffmpeg.deleteFile("a.m4a").catch(() => {});
    throw new Error(`ffmpeg exited non-zero: ${logs.slice(-3).join(" | ").slice(0, 300)}`);
  }
  const out = await ffmpeg.readFile("out.mp4");
  for (const f of ["v.mp4", "a.m4a", "out.mp4"]) await ffmpeg.deleteFile(f).catch(() => {});
  return { data: out, streams: streamsFromLogs(logs) };
}

/** X stores GIFs as silent looping mp4s — turn one back into an actual .gif
 * (bounded fps/size, palettegen/paletteuse for clean colors). */
async function toGif(input) {
  const ffmpeg = await ensureFfmpeg();
  await ffmpeg.writeFile("g.mp4", input);
  const logs = [];
  const onLog = ({ message }) => logs.push(message);
  ffmpeg.on("log", onLog);
  let ok = false;
  try {
    const code = await ffmpeg.exec([
      "-i",
      "g.mp4",
      "-vf",
      "fps=12,scale='min(512,iw)':-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
      "-loop",
      "0",
      "out.gif",
    ]);
    ok = code === 0;
  } finally {
    ffmpeg.off("log", onLog);
  }
  if (!ok) {
    await ffmpeg.deleteFile("g.mp4").catch(() => {});
    throw new Error(`gif conversion failed: ${logs.slice(-3).join(" | ").slice(0, 300)}`);
  }
  const out = await ffmpeg.readFile("out.gif");
  await ffmpeg.deleteFile("g.mp4").catch(() => {});
  await ffmpeg.deleteFile("out.gif").catch(() => {});
  return out;
}

/** "-i out.mp4"-style log lines say what actually ended up in the file. */
function streamsFromLogs(logs) {
  return logs
    .map((l) => (/Stream #0:\d+.*?: (Video|Audio): ([^,]+)/.exec(l) ? { kind: RegExp.$1, codec: RegExp.$2.trim() } : null))
    .filter(Boolean)
    .filter((s, i, arr) => arr.findIndex((x) => x.kind === s.kind) === i);
}

// ---------------------------------------------------------------- jobs

// The job message can be delivered twice while the fresh offscreen document
// is starting up (observed on Edge: one send, two listener calls 1 ms apart).
// A job id runs exactly once.
const ranJobs = new Set();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Readiness probe from the background worker (which may restart freely).
  if (msg?.kind === "tweax:ping") {
    sendResponse({ ok: true });
    return;
  }
  if (msg?.kind !== "tweax:job" || !(msg.job?.url || msg.job?.zipUrls)) return;
  // Ack by id BEFORE running: the sender retries until this arrives.
  sendResponse({ ack: msg.job.jobId });
  if (ranJobs.has(msg.job.jobId)) return;
  ranJobs.add(msg.job.jobId);
  void runJob(msg.job);
});

async function runJob(job) {
  const { jobId, url } = job;
  const name = sanitize(job.name || defaultName(url));
  const progress = (p) => report({ kind: "tweax:progress", jobId, url, ...p });
  try {
    progress({ phase: "playlist", pct: 0 });

    // Media set of one tweet: fetch each file, pack a stored (uncompressed)
    // zip — X images and progressive mp4s need no repacking. Entries flagged
    // in zipGifs are X gifs (silent mp4s) that the job wants as real .gif
    // files; a failed conversion falls back to the source mp4.
    if (job.zipUrls?.length) {
      const files = [];
      for (const [i, u] of job.zipUrls.entries()) {
        const { buf, type } = await fetchBuffer(u, MAX_FILE_BYTES);
        let data = buf;
        let ext = imageExt(u, type);
        if (job.zipGifs?.[i]) {
          progress({ phase: "gif", pct: Math.round(((i + 0.5) / job.zipUrls.length) * 95) });
          try {
            data = await toGif(buf);
            ext = "gif";
          } catch {
            report({
              kind: "tweax:progress",
              jobId,
              phase: "gif-fallback",
              pct: Math.round(((i + 1) / job.zipUrls.length) * 95),
            });
          }
        }
        files.push({ name: `${i + 1}.${ext}`, data });
        progress({ phase: "zip", pct: Math.round(((i + 1) / job.zipUrls.length) * 95) });
      }
      const blob = new Blob([buildZip(files)], { type: "application/zip" });
      finish(jobId, blob, `${job.name ?? "x-media"}.zip`, { container: "zip", muxed: false }, null);
      return;
    }

    // Direct media file (no playlist): stream it in and save as-is.
    if (!/\.m3u8(\?|#|$)/i.test(url)) {
      const { buf, type } = await fetchBuffer(url, MAX_FILE_BYTES);
      const ext =
        (type ?? "").split(";")[0].trim().toLowerCase().startsWith("video/") ||
        (type ?? "").startsWith("audio/")
          ? extFromMime(type)
          : (url.match(/\.(mp4|webm|mp3|m4a|mov|mkv|ogg|opus|wav|ts)(\?|$)/i)?.[1] ?? "bin");
      if (job.gif && ext === "mp4") {
        progress({ phase: "gif", pct: 40 });
        try {
          const gif = await toGif(buf);
          finish(jobId, new Blob([gif], { type: "image/gif" }), `${name}.gif`, { container: "gif", muxed: false }, url);
          return;
        } catch (err) {
          // Conversion failed — deliver the source mp4 rather than nothing.
          report({ kind: "tweax:progress", jobId, phase: "gif-fallback", pct: 90 });
        }
      }
      const blob = new Blob([buf], { type: type ?? "application/octet-stream" });
      finish(jobId, blob, `${name}.${ext}`, { container: ext, muxed: false, direct: true }, url);
      return;
    }

    if (job.audioUrl) {
      progress({ phase: "video-segments", pct: 5 });
      const video = await assemble(url, (p) =>
        progress({ phase: "video-segments", pct: 5 + Math.round((p.done / p.total) * 55) })
      );
      progress({ phase: "audio-segments", pct: 62 });
      const audio = await assemble(job.audioUrl, (p) =>
        progress({ phase: "audio-segments", pct: 62 + Math.round((p.done / p.total) * 18) })
      );
      progress({ phase: "mux", pct: 82 });
      const muxed = await muxTracks(video.body, audio.body, name);
      const blob = new Blob([muxed.data], { type: "video/mp4" });
      finish(jobId, blob, `${name}.mp4`, { streams: muxed.streams, muxed: true }, url);
      return;
    }

    const assembled = await assemble(url, (p) =>
      progress({ phase: "segments", pct: 5 + Math.round((p.done / p.total) * 90) })
    );
    const ext = assembled.container === "mp4" ? "mp4" : "ts";
    const blob = new Blob([assembled.body], { type: ext === "mp4" ? "video/mp4" : "video/mp2t" });
    finish(jobId, blob, `${name}.${ext}`, { container: ext, muxed: false }, url);
  } catch (err) {
    report({
      kind: "tweax:done",
      jobId,
      url,
      ok: false,
      error: String(err?.message ?? err).slice(0, 400),
    });
  }
}

const MIME_EXT = {
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  "video/x-matroska": "mkv", "audio/mp4": "m4a", "audio/mpeg": "mp3",
  "audio/aac": "aac", "audio/ogg": "ogg", "audio/opus": "opus", "audio/wav": "wav",
};

function extFromMime(type) {
  return MIME_EXT[(type ?? "").split(";")[0].trim().toLowerCase()] ?? "bin";
}

function finish(jobId, blob, filename, detail, url) {
  const blobUrl = URL.createObjectURL(blob);
  chrome.runtime.sendMessage({ kind: "tweax:save", jobId, blobUrl, filename }).then(
    (res) => {
      report({
        kind: "tweax:done",
        jobId,
        url,
        ok: !!res?.ok,
        filename,
        bytes: blob.size,
        downloadId: res?.downloadId ?? null,
        error: res?.ok ? null : res?.error ?? "save failed",
        ...detail,
      });
      scheduleRevoke(blobUrl);
    },
    (err) => {
      report({ kind: "tweax:done", jobId, url, ok: false, error: String(err).slice(0, 300) });
      scheduleRevoke(blobUrl);
    }
  );
}

function scheduleRevoke(blobUrl) {
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10 * 60_000);
}

function sanitize(name) {
  return (name || "video").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "video";
}

function defaultName(url) {
  try {
    const u = new URL(url);
    const id = /\/(?:amplify_video|ext_tw_video|vid|tweet_video)\/(\d+)\//.exec(url)?.[1];
    if (id) return `x-${id}`;
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "video";
    const stripped = last.replace(/\.m3u8$/i, "").replace(/\.[a-z0-9]{1,5}$/i, "");
    const host = u.hostname.replace(/^www\./, "").split(".")[0];
    return `${host}-${stripped || "video"}`.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 100);
  } catch {
    return "video";
  }
}
