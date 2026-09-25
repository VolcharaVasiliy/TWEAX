// Per-tab media index: the video/audio URLs a tab actually touched. Two
// sources, merged per tab:
//   - webRequest observation while the worker is alive (mime + size);
//   - a synchronous harvest of the page's Resource Timing buffer, requested
//     every time the popup asks for the list — that recovers everything the
//     page fetched while the worker was asleep (webRequest cannot wake it).
//
// X splits video (avc1) and audio (mp4a) renditions of one video into separate
// playlists; those are paired into a single download entry (best resolution ×
// best bitrate), so one button gets a complete video with sound.

const MAX_PER_TAB = 40;
const HLS_RE = /\.m3u8(\?|#|$)/i;
const DASH_RE = /\.mpd(\?|$)/i;
const MEDIA_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|mp3|m4a|aac|ogg|opus|wav|ts)(\?|$)/i;
const MEDIA_MIME_RE = /^(video\/|audio\/|application\/vnd\.apple\.mpegurl|application\/x-mpegurl|application\/dash\+xml)/i;

/** tabId -> Map<url, entry> */
const tabs = new Map();

function kindOf(url, mime) {
  if (HLS_RE.test(url) || /mpegurl/i.test(mime ?? "")) return "hls";
  if (DASH_RE.test(url) || /dash\+xml/i.test(mime ?? "")) return "dash";
  return "file";
}

function noteMedia(tabId, url, mime, bytes, bump = true) {
  if (!url || !/^https?:/i.test(url)) return;
  const mimeClean = (mime ?? "").split(";")[0].trim().toLowerCase();
  const kind = kindOf(url, mimeClean);
  if (kind === "file" && !MEDIA_EXT_RE.test(url) && !MEDIA_MIME_RE.test(mimeClean)) return;

  let byUrl = tabs.get(tabId);
  if (!byUrl) {
    byUrl = new Map();
    tabs.set(tabId, byUrl);
  }
  const existing = byUrl.get(url);
  if (existing) {
    // Only live network events count as "seen again": the periodic page
    // harvest re-reports old entries, and letting them refresh lastSeen would
    // make the stalest video look like the newest one.
    if (bump) {
      existing.count++;
      existing.lastSeen = Date.now();
      if (bytes > existing.bytes) existing.bytes = bytes;
    }
    return;
  }
  byUrl.set(url, {
    id: `media_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    url,
    tabId,
    kind,
    mime: mimeClean || null,
    bytes: bytes || 0,
    count: 1,
    at: Date.now(),
    lastSeen: Date.now(),
  });
  if (byUrl.size > MAX_PER_TAB) {
    const entries = [...byUrl.values()].sort((a, b) => a.lastSeen - b.lastSeen);
    for (const stale of entries.slice(0, Math.ceil(byUrl.size / 2))) byUrl.delete(stale.url);
  }
}

function headerOf(headers, name) {
  const hit = (headers ?? []).find((h) => (h.name ?? "").toLowerCase() === name);
  return hit?.value ?? null;
}

/** Entries harvested from the page's Resource Timing buffer. The harvest
 * re-reports old URLs on every popup poll, so these never bump recency —
 * `at`/`lastSeen` keep meaning "when the video actually played". */
export function notePageMedia(tabId, entries) {
  if (!Array.isArray(entries)) return;
  for (const entry of entries.slice(0, 60)) {
    const url = entry?.url;
    if (!url || !/^https?:/i.test(url)) continue;
    if (HLS_RE.test(url)) noteMedia(tabId, url, "application/vnd.apple.mpegurl", 0, false);
    else if (DASH_RE.test(url)) noteMedia(tabId, url, "application/dash+xml", 0, false);
    else if (MEDIA_EXT_RE.test(url)) noteMedia(tabId, url, "", 0, false);
  }
}

export function installMediaIndex() {
  const filter = { urls: ["<all_urls>"] };
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.tabId < 0) return;
      noteMedia(
        details.tabId,
        details.url,
        headerOf(details.responseHeaders, "content-type"),
        Number(headerOf(details.responseHeaders, "content-length") ?? 0) || 0
      );
    },
    { ...filter, types: ["media", "xmlhttprequest"] },
    ["responseHeaders"]
  );
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (details.tabId < 0) return;
      noteMedia(details.tabId, details.url, details.mimeType ?? null, details.statusCode === 200 ? details.contentLength ?? 0 : 0);
    },
    { ...filter, types: ["media", "xmlhttprequest"] }
  );
  chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));
}

/** The tweet's video id from a video.twimg.com playlist URL. */
function twimgVideoId(url) {
  const match = /\/(?:amplify_video|ext_tw_video|vid|tweet_video)\/(\d+)\//.exec(url);
  return match ? match[1] : null;
}

/** X rendition URLs: legacy "/pl/avc1/1280x720/" and "/pl/mp4a/128000/", and
 * the newer "/vid/avc1/9000/12000/1454x1080/" ("vid/mp4a/64000/") shapes.
 * Video renditions carry a WxH resolution, audio ones a numeric bitrate, and
 * the codec name is explicit — parse by codec, not by position. */
const VIDEO_CODECS = new Set(["avc1", "av01", "hvc1", "hev1", "h264", "hevc", "vp09", "vp9"]);
const AUDIO_CODECS = new Set(["mp4a", "aac", "mp3", "opus", "ac-3", "ec-3"]);

/** A lone fMP4 segment (codec directory + .mp4/.m4s) is not downloadable
 * media: saved as-is it is an unplayable ~1s stub (styp/moof, no init/moov). */
const SEGMENT_LIKE_RE =
  /\/(?:pl|vid)\/(?:avc1|av01|hvc1|hev1|h264|hevc|vp09|vp9|mp4a|aac|mp3|opus|ac-3|ec-3)\/[^?#]*\.(?:mp4|m4s)(?:[?#]|$)/i;

function renditionInfo(url) {
  const codecMatch = /\/(?:pl|vid)\/(avc1|av01|hvc1|hev1|h264|hevc|vp09|vp9|mp4a|aac|mp3|opus|ac-3|ec-3)\//i.exec(url);
  if (!codecMatch) return null;
  const codec = codecMatch[1].toLowerCase();
  if (AUDIO_CODECS.has(codec)) {
    const bitrate = Number(/\/(?:pl|vid)\/[^/]+\/(\d+)\//i.exec(url)?.[1] ?? 0);
    return { type: "audio", bitrate };
  }
  if (VIDEO_CODECS.has(codec)) {
    const res = /(\d+)x(\d+)/.exec(url.slice(codecMatch.index));
    return { type: "video", area: res ? Number(res[1]) * Number(res[2]) : 0 };
  }
  return null;
}

/**
 * Newest-first media list for one tab, X renditions paired. The page is
 * harvested synchronously first — its Resource Timing buffer knows every
 * media URL the page fetched, including while the worker was asleep.
 */
export async function mediaForTab(tabId) {
  const byUrl = tabs.get(tabId);
  if (!byUrl) return [];
  const entries = [...byUrl.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  const out = [];
  const consumed = new Set();
  for (const entry of entries) {
    if (consumed.has(entry.url)) continue;
    const videoId = twimgVideoId(entry.url);
    const selfRendition = renditionInfo(entry.url);
    if (videoId && selfRendition && !SEGMENT_LIKE_RE.test(entry.url)) {
      const siblings = entries.filter(
        (e) => e.kind === "hls" && twimgVideoId(e.url) === videoId && renditionInfo(e.url)
      );
      const videos = siblings.filter((e) => renditionInfo(e.url).type === "video");
      const audios = siblings.filter((e) => renditionInfo(e.url).type === "audio");
      for (const s of siblings) consumed.add(s.url);
      const bestVideo = videos.sort((a, b) => renditionInfo(b.url).area - renditionInfo(a.url).area)[0];
      const bestAudio = audios.sort((a, b) => renditionInfo(b.url).bitrate - renditionInfo(a.url).bitrate)[0];
      out.push({
        id: `x-${videoId}`,
        url: (bestVideo ?? entry).url,
        audioUrl: bestAudio?.url ?? null,
        tabId,
        kind: "hls",
        mime: bestVideo?.mime ?? entry.mime,
        bytes: bestVideo?.bytes ?? 0,
        count: siblings.length,
        at: Math.max(...siblings.map((e) => e.at)),
        lastSeen: Math.max(...siblings.map((e) => e.lastSeen)),
        paired: !!(bestVideo && bestAudio),
      });
      continue;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Newest media entry for one tab, preferring a complete video+audio pair,
 * optionally matching a URL remembered from a specific article's player.
 */
export async function latestMediaPair(tabId, preferUrl) {
  const all = await mediaForTab(tabId);
  // Segment stubs must never win the pick, not even as the last resort.
  const list = all.filter((e) => !SEGMENT_LIKE_RE.test(e.url));
  if (!list.length) return null;
  if (preferUrl) {
    const id = twimgVideoId(preferUrl);
    const hit = id
      ? list.find((e) => e.id === `x-${id}`)
      : list.find((e) => e.url === preferUrl);
    if (hit) return hit;
  }
  return list.find((e) => e.paired) ?? list.find((e) => e.kind === "hls") ?? list[0];
}

/**
 * Ask the page for its media URLs (Resource Timing buffer) and merge them in.
 * Resolves with whatever the page reported; empty when there is no content
 * script or the page never answered.
 */
export function harvestPageMedia(tabId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), 1200);
    try {
      chrome.tabs.sendMessage(tabId, { kind: "tweax:collect-request" }, (resp) => {
        clearTimeout(timer);
        void chrome.runtime.lastError;
        const entries = resp?.entries ?? [];
        notePageMedia(tabId, entries);
        resolve(entries);
      });
    } catch {
      clearTimeout(timer);
      resolve([]);
    }
  });
}
