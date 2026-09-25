// In-feed download button for x.com. Clones the bookmark button's own cell so
// the styling matches the native action bar, and inserts it to the left of
// Bookmark/Share. Clicking downloads the tweet's video with sound in one file.
// The video is identified first from the tweet's own React data inside the
// article (video_info variants — deterministic, button-in-its-own-post), with
// the page's Resource Timing ledger, the article's playback binding and the
// player's rendition size as fallbacks; the background muxes the pair via
// ffmpeg.wasm.
//
// X's React re-renders wipe injected nodes, so a MutationObserver re-seats the
// button; per-article video ids are remembered the moment the video plays.

(() => {
  const FLAG = "__tweax_x_button__";
  if (window[FLAG]) return;
  if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(location.hostname)) return;
  Object.defineProperty(window, FLAG, { value: true, enumerable: false });

  const api = chrome;
  const BTN_TESTID = "tweax-download";
  /** article element -> video id of the source mounted into its player */
  const articleVideoId = new WeakMap();
  /** video element -> media id stamped at its loadedmetadata */
  const videoElMedia = new WeakMap();
  const busy = new Map(); // jobId -> button element

  const SETTINGS_KEY = "tweax.settings";
  /** Download toggles from the popup; absent keys stay enabled. */
  let prefs = { video: true, gif: true, photo: true, reveal: true, pattern: "" };
  /** statusIds whose API-declared media type is disabled right now. */
  const typeHidden = new Set();
  /** statusIds the API map confirms have media (inject may run pre-DOM). */
  const knownMedia = new Set();

  /** container element -> our injected overlay/button. X's re-renders wipe
   * injected nodes; the observer re-seats them immediately (before paint), so
   * nothing blinks. */
  const overlayRegistry = new Map();

  function removeOverlayEl(el) {
    for (const [box, e] of overlayRegistry) if (e === el) overlayRegistry.delete(box);
    el.remove();
  }

  function reseatOverlays() {
    for (const [box, el] of overlayRegistry) {
      if (!box.isConnected) {
        overlayRegistry.delete(box);
        continue;
      }
      if (!el.isConnected) {
        if (getComputedStyle(box).position === "static") box.style.position = "relative";
        box.appendChild(el);
      }
    }
  }

  function readPrefs(settings) {
    const t = settings?.tweaks ?? {};
    return {
      video: t.videoDownloads !== false,
      gif: t.gifDownloads !== false,
      photo: t.photoDownloads !== false,
      reveal: t.revealSensitive !== false,
      pattern: typeof t.filenamePattern === "string" ? t.filenamePattern.trim() : "",
    };
  }

  function loadPrefs() {
    try {
      chrome.storage.local.get(SETTINGS_KEY).then((s) => {
        prefs = readPrefs(s?.[SETTINGS_KEY]);
        scheduleScan();
      }).catch(() => {});
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes[SETTINGS_KEY]) return;
        prefs = readPrefs(changes[SETTINGS_KEY].newValue);
        typeHidden.clear();
        applyPrefs();
      });
    } catch {}
  }

  /** Drop injected buttons for media kinds the popup turned off. */
  function applyPrefs() {
    for (const el of document.querySelectorAll(`[data-testid="${BTN_TESTID}"]`)) {
      const art = el.closest("article");
      if (!art) continue;
      const hasVideo = !!art.querySelector("video");
      if (hasVideo && !prefs.video && !prefs.gif) removeOverlayEl(el);
      else if (!hasVideo && !prefs.photo) removeOverlayEl(el);
    }
    for (const el of document.querySelectorAll("[data-tweax-overlay='photo']")) {
      if (!prefs.photo) removeOverlayEl(el);
    }
    scheduleScan();
  }

  const ICON_DOWNLOAD =
    '<path d="M12 16.5 6.5 11l1.42-1.41L11 12.67V4h2v8.67l2.58-2.58L17 11l-5 5.5zM5 20v-2h14v2H5z"/>';
  const ICON_IMAGE =
    '<path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>';

  const VIDEO_ID_RE = /\/(?:amplify_video|ext_tw_video|vid|tweet_video)\/(\d+)\//;
  const PLAYLIST_RE = /\.m3u8(\?|#|$)/i;
  // Rendition paths: video codecs carry a resolution (748x560), audio a
  // bitrate (128000). Generic over codecs (avc1/av01/hevc/mp4a/…).
  const CODEC_RE = /\/(?:pl|vid)\/(avc1|av01|hvc1|hev1|h264|hevc|vp09|vp9|mp4a|aac|mp3|opus|ac-3|ec-3)\//i;

  function videoIdOf(url) {
    return VIDEO_ID_RE.exec(url)?.[1] ?? null;
  }

  function renditionInfo(url) {
    const codecMatch = CODEC_RE.exec(url);
    if (!codecMatch) return null;
    const codec = codecMatch[1].toLowerCase();
    const tail = url.slice(codecMatch.index);
    if (["mp4a", "aac", "mp3", "opus", "ac-3", "ec-3"].includes(codec)) {
      return { type: "audio", bitrate: Number(/\/(?:pl|vid)\/[^/]+\/(\d+)\//i.exec(tail)?.[1] ?? 0) };
    }
    const res = /(\d+)x(\d+)/.exec(tail);
    return { type: "video", area: res ? Number(res[1]) * Number(res[2]) : 0 };
  }

  /** Every tweet video this document has touched, with its best renditions.
   * The Resource Timing buffer has a hard cap (the bridge raises it to 2000)
   * and silently drops new entries once full — on an endless SPA that happens
   * within minutes of scrolling, after which the "newest video" stays frozen
   * at whatever played before the cap. So entries are merged into this
   * page-lifetime ledger on every read, and the buffer is drained before it
   * overflows; startTime is monotonic, so recency survives the drain. */
  const ledger = new Map(); // videoId -> { videos: [], audios: [], direct: null, last: 0 }
  const BUFFER_DRAIN_AT = 1200;

  function ingestResource(url, at) {
    const id = videoIdOf(url);
    if (!id) return;
    const cur = ledger.get(id) ?? { videos: [], audios: [], direct: null, last: 0 };
    if (PLAYLIST_RE.test(url)) {
      const info = renditionInfo(url);
      if (info?.type === "video") {
        if (!cur.videos.includes(url)) cur.videos.push(url);
        cur.last = Math.max(cur.last, at);
      } else if (info?.type === "audio") {
        if (!cur.audios.includes(url)) cur.audios.push(url);
        cur.last = Math.max(cur.last, at);
      }
    } else if (
      /\.mp4(\?|$)/i.test(url) &&
      // Only codec-free progressive files may become the direct download:
      // rendition/segment paths carry a codec directory, and saving a lone
      // fMP4 segment as-is produces an unplayable ~1s stub (styp/moof, no
      // init/moov). init.mp4 alone is equally useless.
      !CODEC_RE.test(url) &&
      !/init\.mp4/i.test(url) &&
      !cur.direct
    ) {
      // Progressive mp4 variant (short clips) — already muxed.
      cur.direct = url;
      cur.last = Math.max(cur.last, at);
    }
    ledger.set(id, cur);
  }

  function collectPlaylists() {
    const entries = performance.getEntriesByType("resource");
    for (const e of entries) ingestResource(e.name, e.startTime);
    if (entries.length > BUFFER_DRAIN_AT) {
      try { performance.clearResourceTimings(); } catch {}
    }
    return ledger;
  }

  // An overflow between two reads would drop entries silently — merge and
  // drain immediately.
  performance.onresourcetimingbufferfull = () => collectPlaylists();

  /** Best download spec for a video id: muxed pair, else direct, else video. */
  function pickFor(collected, id) {
    const cur = collected.get(id);
    if (!cur) return null;
    if (cur.videos.length) {
      // Sort copies: the ledger is persistent, its arrays must keep order.
      const bestVideo = [...cur.videos].sort((a, b) => {
        const area = (u) => Number(/(\d+)x(\d+)/.exec(u)?.[1] ?? 0) * Number(/(\d+)x(\d+)/.exec(u)?.[2] ?? 0);
        return area(b) - area(a);
      })[0];
      const bestAudio = [...cur.audios].sort((a, b) =>
        (Number(/\/(?:pl|vid)\/[^/]+\/(\d+)\//i.exec(b)?.[1] ?? 0) - Number(/\/(?:pl|vid)\/[^/]+\/(\d+)\//i.exec(a)?.[1] ?? 0))
      )[0];
      return { url: bestVideo, audioUrl: bestAudio ?? null };
    }
    if (cur.direct) return { url: cur.direct, audioUrl: null };
    return null;
  }

  // Bind each article to its video the moment the player mounts a source into
  // it. X fetches a video's variant playlists right before its mount, and
  // prefetches the NEXT tweet's playlists only later, during playback — so at
  // loadedmetadata "newest playlist fetch" is exact, while at playing (which
  // also re-fires on every buffering resume) it lands on the neighbor.
  const STAMP_WINDOW_MS = 5000;
  document.addEventListener(
    "loadedmetadata",
    (event) => {
      const video = event.target;
      if (!(video instanceof HTMLVideoElement)) return;
      const collected = collectPlaylists();
      // Resolution first: two players can mount within the stamping window,
      // and "newest playlist" would stamp both with the same (newer) id.
      let id = null;
      if (video.videoWidth) {
        id = idByResolution(collected, video.videoWidth, video.videoHeight, STAMP_WINDOW_MS);
      }
      if (!id) id = newestPlaylistId(collected, STAMP_WINDOW_MS);
      if (!id) return;
      // Per-element stamp: the player shell knows its own media even when it
      // sits inside a quote card with no status links of its own.
      videoElMedia.set(video, id);
      const article = video.closest("article");
      if (article) articleVideoId.set(article, id);
    },
    true
  );

  /** Newest video id whose variant playlists were fetched, optionally within
   * a freshness window (playlists only — a mount always fetches them). */
  function newestPlaylistId(collected, withinMs = Infinity) {
    const floor = performance.now() - withinMs;
    let best = null;
    let bestAt = -1;
    for (const [id, cur] of collected) {
      if (!cur.videos.length || cur.last < floor) continue;
      if (cur.last > bestAt) {
        best = id;
        bestAt = cur.last;
      }
    }
    return best;
  }

  // The main-world script (tweaks-main) captures every GraphQL response and
  // maps statusId -> video_info variants. Asking by the tweet's permalink id
  // is the deterministic binding: variants are that tweet's own media.
  const pendingVariants = new Map(); // nonce -> resolve

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__tweax !== true || d.kind !== "variants-reply") return;
    pendingVariants.get(d.nonce)?.({ media: d.media ?? null, sid: d.sid ?? null });
    pendingVariants.delete(d.nonce);
  });

  function statusIdOf(scope) {
    // Prefer the timestamp link (authoritative); some views render none, so
    // fall back to the first status link in DOM order (the tweet's own header
    // link comes before any quoted content).
    const t = scope?.querySelector('a[href*="/status/"] time')?.closest("a")?.getAttribute("href") ?? "";
    return /\/status\/(\d+)/.exec(t)?.[1] ?? statusIdsIn(scope)[0] ?? null;
  }

  function variantsFor(statusId) {
    if (!statusId) return Promise.resolve(null);
    return queryVariants({ statusId });
  }

  function queryVariants(query) {
    const nonce = `v${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      pendingVariants.set(nonce, resolve);
      window.postMessage({ __tweax: true, kind: "variants", nonce, ...query }, "*");
      setTimeout(() => {
        if (pendingVariants.delete(nonce)) resolve(null);
      }, 250);
    });
  }

  /** The API's mp4 variants are full transcodes with sound — highest bitrate
   * wins. m3u8 master as the fallback (the mux pipeline pairs audio there). */
  function bestVariantSpec(media) {
    const variants = media?.variants ?? [];
    if (!variants.length) return null;
    const mp4s = variants.filter((v) => (v.content_type ?? "").startsWith("video/mp4"));
    if (mp4s.length) {
      const best = mp4s.reduce((a, b) => (Number(b.bitrate ?? 0) > Number(a.bitrate ?? 0) ? b : a));
      return { url: best.url, audioUrl: null };
    }
    const master = variants.find((v) => /\.m3u8(\?|$)/i.test(v.url ?? ""));
    return master ? { url: master.url, audioUrl: null } : null;
  }

  /** Photos at original size: X's size suffix only downscales. */
  function origPhotoUrl(url) {
    try {
      const u = new URL(url);
      u.searchParams.set("name", "orig");
      return u.toString();
    } catch {
      return url;
    }
  }

  /** Fallback when the API map missed: the tweet's own <img> media. */
  function domPhotos(article) {
    const out = [];
    for (const img of article?.querySelectorAll('[data-testid="tweetPhoto"] img') ?? []) {
      const src = img.getAttribute("src") ?? "";
      if (src.includes("pbs.twimg.com/media/")) out.push(origPhotoUrl(src));
    }
    return [...new Set(out)];
  }

  // ------------------------------------------------------- filename template

  const DEFAULT_PATTERN = "{account}_{tweetId}_{serial}";

  /** Everything the pattern tokens need: the author handle and the tweet's
   * timestamp come from the article's own DOM, the media id from the file's
   * CDN url. */
  function nameCtxFor(article, statusId, serial, url) {
    return {
      account: authorOf(article),
      tweetId: statusId,
      serial,
      date: tweetDateOf(article),
      mediaId: mediaIdOf(url),
    };
  }

  /** Build a download file name from the user's pattern: known tokens are
   * substituted, everything else stays literally, and filename-illegal
   * characters are replaced so even a hostile pattern yields a valid name. */
  function renderPattern(pattern, ctx) {
    const d = ctx.date ?? new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const map = {
      "{account}": ctx.account || "x",
      "{tweetId}": ctx.tweetId ?? "",
      "{mediaId}": ctx.mediaId ?? "",
      "{serial}": String(ctx.serial ?? 1),
      "{date}": date,
      "{datetime}": `${date}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    };
    let out = pattern?.trim() || DEFAULT_PATTERN;
    for (const [token, value] of Object.entries(map)) out = out.split(token).join(value);
    out = out.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
    return out || "x";
  }

  /** The author handle: the tweet's own permalink path (the timestamp link is
   * authoritative, same source statusIdOf trusts). */
  function authorOf(scope) {
    const href =
      scope?.querySelector('a[href*="/status/"] time')?.closest("a")?.getAttribute("href") ??
      scope?.querySelector('a[href*="/status/"]')?.getAttribute("href") ??
      "";
    const seg = /^\/([^/]+)/.exec(href)?.[1];
    return seg && seg !== "i" ? seg : "x";
  }

  /** The tweet's own timestamp; a missing/invalid one falls back to "now" —
   * the template still renders, just with the download moment. */
  function tweetDateOf(scope) {
    const iso = scope?.querySelector('a[href*="/status/"] time')?.getAttribute("datetime");
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? d : new Date();
  }

  /** The media file's id on X's CDN (video variants carry a numeric id, photo
   * urls a /media/<id> segment). */
  function mediaIdOf(url) {
    return (
      /\/(?:amplify_video|ext_tw_video|vid|tweet_video)\/(\d+)\//.exec(url ?? "")?.[1] ??
      /\/media\/([A-Za-z0-9_-]+)/.exec(url ?? "")?.[1] ??
      ""
    );
  }

  // ---------------------------------------------------------------- click

  /** Shared per-article download flow: the action-bar button and the media
   * overlays both land here, so tweets without an action bar (thread
   * ancestors) still download through their overlay. `btn` is the action-bar
   * button or null (overlay clicks report via the downloads list). */
  async function downloadArticleMedia(article, btn, sidOverride, midOverride) {
    // Resolve the tweet whose media we want: an explicit sid/mediaId from the
    // overlay binding, otherwise the scope's status links in DOM order — the
    // first one the API map actually has media for wins.
    let statusId = sidOverride ?? null;
    let media = statusId ? (await variantsFor(statusId))?.media ?? null : null;
    if (!media && midOverride) {
      const res = await mediaForMediaId(midOverride);
      if (res?.media) {
        statusId = res.sid ?? statusId;
        media = res.media;
      }
    }
    if (!media) {
      for (const id of statusIdsIn(article)) {
        const res = await variantsFor(id);
        if (res?.media?.type || res?.media?.photos?.length) {
          statusId = id;
          media = res.media;
          break;
        }
      }
      if (!media && statusId) media = (await variantsFor(statusId))?.media ?? null;
    }

    // Photos: single image downloads directly; multi-image posts zip all
    // images into one archive (the container overlays grab singles).
    const photoUrls = media?.photos?.length ? media.photos.map(origPhotoUrl) : domPhotos(article);
    const isMedia = media?.type === "video" || media?.type === "animated_gif";
    if (photoUrls.length && !isMedia) {
      if (!prefs.photo) {
        flash(btn, "Photo downloads are off");
        return;
      }
      if (photoUrls.length > 1) {
        const job = {
          zipUrls: photoUrls,
          zipNames: photoUrls.map((u, i) => renderPattern(prefs.pattern, nameCtxFor(article, statusId, i + 1, u))),
          name: renderPattern(prefs.pattern, nameCtxFor(article, statusId, 1, null)),
        };
        const res = await api.runtime
          .sendMessage({ kind: "tweax:download", job })
          .catch((err) => ({ ok: false, error: String(err) }));
        if (res?.ok) {
          if (btn) watchJob(res.jobId, btn);
        } else flash(btn, res?.error ?? "download failed");
        return;
      }
      const res = await api.runtime
        .sendMessage({
          kind: "tweax:download-photos",
          urls: photoUrls,
          statusId,
          names: photoUrls.map((u, i) => renderPattern(prefs.pattern, nameCtxFor(article, statusId, i + 1, u))),
        })
        .catch((err) => ({ ok: false, error: String(err) }));
      if (res?.ok) {
        if (btn) {
          btn.dataset.tweaxBusy = "";
          btn.style.opacity = "";
          btn.setAttribute("aria-label", "Saved image");
          setTimeout(() => btn.setAttribute("aria-label", btn.dataset.tweaxLabel ?? "Download"), 2000);
        }
      } else flash(btn, res?.error ?? "download failed");
      return;
    }

    // Multi-video/gif posts (X packs up to four entities into one tweet):
    // every media entity of the tweet goes into one zip, like multi-photo
    // posts do. API variants are direct mp4s with sound, so no muxing is
    // needed; gif entities become real .gif files when the GIF toggle is on.
    const videoItems = media?.videos?.length
      ? media.videos
      : media?.type === "video" || media?.type === "animated_gif"
        ? [media]
        : [];
    if (videoItems.length > 1) {
      const specs = videoItems.map((it) => bestVariantSpec(it));
      if (specs.every((s) => s?.url && !/\.m3u8(\?|$)/i.test(s.url))) {
        const allGif = videoItems.every((it) => it.type === "animated_gif");
        const allVideo = videoItems.every((it) => it.type === "video");
        if (allGif && !prefs.gif) {
          flash(btn, "GIF downloads are off");
          return;
        }
        if (allVideo && !prefs.video) {
          flash(btn, "Video downloads are off");
          return;
        }
        const job = {
          zipUrls: specs.map((s) => s.url),
          zipGifs: videoItems.map((it) => it.type === "animated_gif" && prefs.gif),
          zipNames: specs.map((s, i) => renderPattern(prefs.pattern, nameCtxFor(article, statusId, i + 1, s.url))),
          name: renderPattern(prefs.pattern, nameCtxFor(article, statusId, 1, null)),
        };
        const res = await api.runtime
          .sendMessage({ kind: "tweax:download", job })
          .catch((err) => ({ ok: false, error: String(err) }));
        if (res?.ok) {
          if (btn) watchJob(res.jobId, btn);
        } else flash(btn, res?.error ?? "download failed");
        return;
      }
      // A master-only entity cannot join a zip — fall through to the
      // single-item pipeline rather than packing an unassemblable playlist.
    }

    // Video / GIF: the tweet's API variants are deterministic; fiber, the
    // playback binding and the rendition size back them up.
      const collected = collectPlaylists();
      let spec = null;
      if (media?.type === "video" || media?.type === "animated_gif") {
        spec = bestVariantSpec(media);
      } else {
        const fiber = article ? fiberMedia(article) : new Map();
        const videoEl = article?.querySelector("video");
        const stampedId = article ? articleVideoId.get(article) : null;
        const resId = videoEl?.videoWidth
          ? idByResolution(collected, videoEl.videoWidth, videoEl.videoHeight)
          : null;
        const id =
          pickFiberId(fiber, collected, stampedId, resId) ||
          stampedId ||
          resId ||
          newestVideoId(collected) ||
          midOverride;
        spec = id ? (pickFor(collected, id) ?? pickFromFiber(fiber, id)) : null;
      }
    if (spec) {
      spec.gif = media?.type === "animated_gif";
      if (statusId) spec.name = renderPattern(prefs.pattern, nameCtxFor(article, statusId, 1, spec.url));
    }
    if (spec?.gif && !prefs.gif) {
      flash(btn, "GIF downloads are off");
      return;
    }
    if (spec && !spec.gif && media?.type === "video" && !prefs.video) {
      flash(btn, "Video downloads are off");
      return;
    }

    if (!spec && !article?.querySelector("video")) {
      flash(btn, "no media found");
      return;
    }

    if (spec?.url && btn) inflight.set(spec.url, btn);

    const message = spec
      ? api.runtime.sendMessage({ kind: "tweax:download", job: spec })
      : api.runtime.sendMessage({ kind: "tweax:download-latest" });

    message
      .then((res) => {
        if (res?.ok) {
          // A tiny job can finish before this response lands — tweax:done
          // already restored the button via its media url.
          if (doneIds.has(res.jobId)) {
            if (spec?.url) inflight.delete(spec.url);
            return;
          }
          if (btn) watchJob(res.jobId, btn);
        } else {
          if (spec?.url) inflight.delete(spec.url);
          flash(btn, res?.error ?? "download failed");
        }
      })
      .catch((err) => {
        if (spec?.url) inflight.delete(spec.url);
        flash(btn, String(err));
      });
  }

  /** Media overlays on multi-media posts: each downloads its own item — a
   * photo directly, a GIF/video as that position's media entity (the box
   * holds a <video>, so the two are told apart locally). */
  document.addEventListener(
    "click",
    async (event) => {
      const overlay = event.target?.closest?.('[data-tweax-overlay="photo"]');
      if (!overlay) return;
      event.preventDefault();
      event.stopPropagation();
      if (overlay.dataset.tweaxBusy === "1") return;
      overlay.dataset.tweaxBusy = "1";
      try {
        const article = overlay.closest("article");
        const statusId = overlay.dataset.tweaxSid || statusIdOf(article);
        const idx = Number(overlay.dataset.tweaxIndex ?? 0);
        const media = (await variantsFor(statusId))?.media ?? null;

        // GIF/video item: download the entity at this position, converted to
        // a real .gif when it is one and the GIF toggle is on.
        if (overlay.parentElement?.querySelector("video")) {
          const items = media?.videos?.length
            ? media.videos
            : media && (media.type === "video" || media.type === "animated_gif")
              ? [media]
              : [];
          const item = items[idx] ?? null;
          const spec = item ? bestVariantSpec(item) : null;
          if (!spec?.url || /\.m3u8(\?|$)/i.test(spec.url)) return;
          const gif = item.type === "animated_gif";
          if (gif && !prefs.gif) return;
          if (!gif && !prefs.video) return;
          await api.runtime
            .sendMessage({
              kind: "tweax:download",
              job: {
                url: spec.url,
                gif: gif && prefs.gif,
                name: renderPattern(prefs.pattern, nameCtxFor(article, statusId, idx + 1, spec.url)),
              },
            })
            .catch(() => {});
          return;
        }

        if (!prefs.photo) return;
        const urls = media?.photos?.length ? media.photos.map(origPhotoUrl) : domPhotos(article);
        const url = urls[idx] ?? urls[0];
        if (!url) return;
        await api.runtime
          .sendMessage({
            kind: "tweax:download-photos",
            urls: [url],
            statusId,
            start: idx,
            names: [renderPattern(prefs.pattern, nameCtxFor(article, statusId, idx + 1, url))],
          })
          .catch(() => {});
      } catch {
        // An overlay failure must never surface as a console error.
      } finally {
        overlay.dataset.tweaxBusy = "";
      }
    },
    true
  );

  document.addEventListener(
    "click",
    async (event) => {
      const btn = event.target?.closest?.(`[data-testid="${BTN_TESTID}"]`);
      if (!btn) return;
      event.preventDefault();
      event.stopPropagation();
      if (btn.dataset.tweaxBusy === "1") return;

      btn.dataset.tweaxBusy = "1";
      btn.setAttribute("aria-label", "Downloading…");
      btn.style.opacity = "0.45";

      try {
        await downloadArticleMedia(btn.closest("article"), btn);
      } catch {
        // Keep the button usable no matter what happens inside.
        btn.dataset.tweaxBusy = "";
        btn.style.opacity = "";
        btn.setAttribute("aria-label", btn.dataset.tweaxLabel ?? "Download");
      }
    },
    true
  );

  // ------------------------------------------------- share menu: copy link

  // X's Share dropdown is portal-rendered into #layers right after the Share
  // button is clicked. That click opens a short binding window: a menu that
  // appears inside it gets one extra menuitem — a clone of the native
  // "Copy link" row (X's own classes, icon and spacing), swapping the post URL
  // for the tweet's direct media URL(s). Menus opened any other way (the
  // post's "…" menu, keyboard without a Share click) stay untouched.

  const SHARE_WINDOW_MS = 1500;
  const LINK_LABEL = "Copy media link";
  // The page's own UI stack (tooltip/toast text renders in this, like X's).
  const UI_FONT = '"TwitterChirp", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  let lastShare = null; // { article, sid } — the Share click being served

  document.addEventListener(
    "click",
    (event) => {
      const btn = event.target?.closest?.('button[aria-haspopup="menu"]');
      if (!btn) return;
      if (!/^share/i.test(btn.getAttribute("aria-label") ?? "")) return;
      const article = btn.closest("article");
      lastShare = { article, sid: article ? statusIdOf(article) : null };
      lastShare.at = Date.now();
    },
    true
  );

  /** Direct media URLs of the bound tweet: original photos (one per image)
   * or the best mp4 variant per video/GIF entity — X serves GIFs as mp4, so
   * the mp4 link IS the gif's direct link. Same resolution order as the
   * download flow: the tweet's API variants first, ledger and React data as
   * fallbacks. */
  async function mediaLinksFor(article, sid) {
    const media = (await variantsFor(sid))?.media ?? null;
    const isVideo = media?.type === "video" || media?.type === "animated_gif";
    if (!isVideo) {
      const photos = media?.photos?.length ? media.photos.map(origPhotoUrl) : domPhotos(article);
      if (photos.length) return photos;
    }
    // Multi-video/gif posts yield one direct link per media entity.
    const videoItems = media?.videos?.length
      ? media.videos
      : media && (media.type === "video" || media.type === "animated_gif")
        ? [media]
        : [];
    const videoUrls = videoItems.map((it) => bestVariantSpec(it)?.url).filter(Boolean);
    if (videoUrls.length) return videoUrls;
    const collected = collectPlaylists();
    const videoEl = article?.querySelector("video");
    const stampedId = article ? articleVideoId.get(article) : null;
    const resId = videoEl?.videoWidth
      ? idByResolution(collected, videoEl.videoWidth, videoEl.videoHeight)
      : null;
    const fiber = article ? fiberMedia(article) : new Map();
    const ledgerSid =
      sid && (collected.get(sid)?.videos.length || collected.get(sid)?.direct) ? sid : null;
    const id =
      ledgerSid ||
      pickFiberId(fiber, collected, stampedId, resId) ||
      stampedId ||
      resId ||
      newestVideoId(collected);
    const spec =
      (ledgerSid ? pickFor(collected, ledgerSid) : null) ??
      (id ? pickFor(collected, id) ?? pickFromFiber(fiber, id) : null);
    return spec?.url ? [spec.url] : null;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;";
      (document.body ?? document.documentElement).appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  // TWEAX's own "media link" glyph: a video frame with a play triangle,
  // chained to a link ring at its corner. Drawn in X's outline language
  // (24-box, rounded ~2px strokes, currentcolor) so it sits quietly among the
  // native rows while staying unmistakably ours.
  const ICON_MEDIA_LINK =
    '<rect x="3" y="5.5" width="12.5" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="M7.6 9.6v4.8l4.2-2.4z" fill="currentColor" stroke="none"/>' +
    '<rect x="15.4" y="15.4" width="5.4" height="5.4" rx="2.7" transform="rotate(45 18.1 18.1)" fill="none" stroke="currentColor" stroke-width="1.8"/>';

  function tryInjectShareItem() {
    if (!lastShare || Date.now() - lastShare.at > SHARE_WINDOW_MS) return;
    for (const menu of document.querySelectorAll('[role="menu"]')) {
      if (menu.querySelector("[data-tweax-menuitem]")) continue;
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      if (!items.length) continue;
      const src =
        items.find((it) => (it.textContent ?? "").trim() === "Copy link") ?? items[items.length - 1];
      // Live X wraps every menu row in its own container; climb to the row
      // itself so the clone lands as a sibling row, not inside the native
      // row's wrapper.
      let row = src;
      for (let up = src.parentElement; up && up !== menu; up = up.parentElement) {
        if (up.querySelectorAll('[role="menuitem"]').length > 1) break;
        row = up;
      }
      const item = row.cloneNode(true);
      item.dataset.tweaxMenuitem = "1";
      const span = item.querySelector("span");
      if (span) span.textContent = LINK_LABEL;
      // Our own glyph, not a copy of any native row's icon.
      const svg = item.querySelector("svg");
      if (svg) svg.innerHTML = ICON_MEDIA_LINK;
      const binding = { article: lastShare.article, sid: lastShare.sid };
      // Resolve the URLs while the menu is still opening, so the pointer press
      // itself only writes the clipboard — inside the freshest user gesture.
      const urlsReady = mediaLinksFor(binding.article, binding.sid).catch(() => null);
      let done = false;
      const act = async () => {
        if (done) return;
        done = true;
        const menu = item.closest('[role="menu"]');
        const urls = await urlsReady;
        const btn = binding.article?.querySelector(`[data-testid="${BTN_TESTID}"]`);
        if (!urls?.length) {
          if (btn) flash(btn, "no media found");
          else flashItem(item, "No media");
          if (!closeViaNativeRow(item, menu)) dismissMenu(menu);
          return;
        }
        const ok = await copyText(urls.join("\n"));
        // Only X's own rows ever close this menu — synthetic Escape and
        // outside presses are ignored — and the native "Copy link" row's own
        // toast says exactly what our action did. So its click supplies the
        // close and the toast; it re-copies the post link though, and the
        // media link is restored once that write has settled.
        if (ok && closeViaNativeRow(item, menu)) {
          setTimeout(() => void copyText(urls.join("\n")), 250);
          return;
        }
        if (ok) showToast("Copied to clipboard");
        else if (btn) flash(btn, "copy failed");
        else flashItem(item, "Copy failed");
        dismissMenu(menu);
      };
      // X's own menus activate (and often unmount) on pointerdown — a click
      // listener would then never fire, so the pointerdown is the primary
      // signal and the click only backs it up if the menu survives.
      item.addEventListener("pointerdown", act, true);
      item.addEventListener("click", act, true);
      row.parentElement.insertBefore(item, row.nextSibling);
    }
  }

  /** Feedback when the tweet's action-bar button is out of reach: say it on
   * the menu item itself (matters only if the menu survived the press). */
  function flashItem(item, text) {
    const span = item.querySelector("span");
    if (!span) return;
    const prev = span.textContent;
    span.textContent = text;
    setTimeout(() => {
      span.textContent = prev;
    }, 1500);
  }

  /** The menu only ever closes through X's own row activation — a click on
   * one of ITS rows. The native "Copy link" row is clicked for that side
   * effect; never any other row (they start real actions like DMs). */
  function closeViaNativeRow(item, menu) {
    if (!menu) return false;
    const rows = [...menu.querySelectorAll('[role="menuitem"]')].filter(
      (r) => r !== item && !r.dataset.tweaxMenuitem
    );
    const native = rows.find((r) => (r.textContent ?? "").trim() === "Copy link");
    if (!native) return false;
    native.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  }

  /** X's own snackbar replica, used only when no native row could be clicked:
   * blue bar, bottom center, white 15px text, 4px corners, 170ms fade. */
  function showToast(text) {
    document.querySelector("[data-tweax-toast]")?.remove();
    const host = document.createElement("div");
    host.dataset.tweaxToast = "1";
    host.style.cssText =
      "position:fixed;left:0;right:0;bottom:32px;display:flex;justify-content:center;pointer-events:none;z-index:2000;";
    const toast = document.createElement("div");
    toast.setAttribute("role", "alert");
    toast.style.cssText =
      "background:rgba(29,155,240,1.00);color:rgb(255,255,255);" +
      `font-family:${UI_FONT};font-size:15px;font-weight:400;line-height:20px;` +
      "padding:12px;border-radius:4px;width:fit-content;max-width:600px;box-sizing:border-box;" +
      "opacity:0;transition:opacity 170ms cubic-bezier(0,0,1,1);pointer-events:auto;";
    toast.textContent = text;
    host.appendChild(toast);
    (document.body ?? document.documentElement).appendChild(host);
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
    });
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => host.remove(), 250);
    }, 2500);
  }

  /** Native rows close the menu through X's own handlers, which a foreign row
   * never reaches — so after our action the menu is dismissed the way X's
   * keyboard flow does (Escape), with an outside-press fallback for menus
   * that ignore it. */
  function dismissMenu(menu) {
    if (!menu) return;
    const escape = () => {
      for (const type of ["keydown", "keyup"]) {
        document.dispatchEvent(
          new KeyboardEvent(type, { key: "Escape", code: "Escape", bubbles: true, cancelable: true })
        );
      }
    };
    escape();
    setTimeout(() => {
      if (!menu.isConnected) return;
      const target = document.body ?? document.documentElement;
      const x = 4;
      const y = Math.max(4, (target.clientHeight ?? 900) - 8);
      for (const [type, EventCtor, buttons] of [
        ["pointerdown", PointerEvent, 1],
        ["mousedown", MouseEvent, 1],
        ["pointerup", PointerEvent, 0],
        ["mouseup", MouseEvent, 0],
      ]) {
        target.dispatchEvent(
          new EventCtor(type, {
            bubbles: true, cancelable: true, clientX: x, clientY: y,
            pointerId: 1, pointerType: "mouse", isPrimary: true, buttons, button: 0,
          })
        );
      }
      escape();
    }, 60);
  }

  function newestVideoId(collected) {
    let best = null;
    let bestAt = -1;
    for (const [id, cur] of collected) {
      if (cur.last > bestAt && (cur.videos.length || cur.direct)) {
        best = id;
        bestAt = cur.last;
      }
    }
    return best;
  }

  /** The video element reports the resolution it is actually playing; X
   * rendition URLs carry that same WxH, so the match pins the tweet's video
   * even when recency alone would point at a neighbor. */
  function idByResolution(collected, w, h, withinMs = Infinity) {
    const want = `/${w}x${h}/`;
    const floor = performance.now() - withinMs;
    let best = null;
    let bestAt = -1;
    for (const [id, cur] of collected) {
      if (!cur.videos.some((u) => u.includes(want))) continue;
      if (cur.last < floor) continue;
      if (cur.last > bestAt) {
        best = id;
        bestAt = cur.last;
      }
    }
    return best;
  }

  // ------------------------------------------------------- tweet's own data

  /** Media URLs named by the tweet's own React data (fiber props hold the
   * video_info variants). The button lives inside one tweet's subtree, so
   * everything found here belongs to it — no timing heuristics. Bounded scan:
   * fibers down the article (the root's siblings are OTHER tweets and are
   * skipped), then a few ancestors' own props (the timeline cell above). */
  function fiberMedia(article) {
    const out = new Map(); // id -> { videos: Set, audios: Set, files: Set }
    const fiberKey = Object.keys(article).find(
      (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
    );
    if (!fiberKey) return out;
    const state = { nodes: 50000, seen: new Set() };
    const visit = (fiber, depth, noSiblings) => {
      if (!fiber || depth > 200 || state.nodes <= 0) return;
      if (fiber.memoizedProps) scanValue(fiber.memoizedProps, out, state);
      visit(fiber.child, depth + 1, false);
      if (!noSiblings) visit(fiber.sibling, depth + 1, false);
    };
    visit(article[fiberKey], 0, true);
    for (let up = article[fiberKey].return, i = 0; i < 6 && up && state.nodes > 0 && !out.size; i++) {
      if (up.memoizedProps) scanValue(up.memoizedProps, out, state);
      up = up.return;
    }
    // An ancestor yielding SEVERAL ids is a container above the tweet — its
    // neighbors would win on prefetch recency. Trust single-id cells only.
    if (out.size > 1) out.clear();
    return out;
  }

  function scanValue(value, out, state) {
    if (state.nodes <= 0) return;
    state.nodes--;
    if (typeof value === "string") {
      const hit = /https:\/\/video\.twimg\.com\/[^\s"'<>\\]+/.exec(value);
      if (hit) noteFiberUrl(hit[0], out);
      return;
    }
    if (!value || typeof value !== "object" || state.seen.has(value)) return;
    state.seen.add(value);
    for (const v of Array.isArray(value) ? value : Object.values(value)) {
      scanValue(v, out, state);
      if (state.nodes <= 0) return;
    }
  }

  function noteFiberUrl(url, out) {
    const id = videoIdOf(url);
    if (!id) return;
    const cur = out.get(id) ?? { videos: new Set(), audios: new Set(), files: new Set() };
    if (PLAYLIST_RE.test(url)) {
      if (renditionInfo(url)?.type === "audio") cur.audios.add(url);
      else cur.videos.add(url);
    } else if (/\.mp4(\?|$)/i.test(url) && !CODEC_RE.test(url) && !/init\.mp4/i.test(url)) {
      cur.files.add(url);
    }
    out.set(id, cur);
  }

  /** The tweet's own data decides; the network ledger only breaks ties inside
   * it (main video vs a quoted one). Ledger dominance across tweets would let
   * a PREFETCHED neighbor win whenever the clicked tweet was never played. */
  function pickFiberId(fiber, collected, stampedId, resId) {
    const ids = [...fiber.keys()];
    if (!ids.length) return null;
    if (ids.length === 1) return ids[0];
    if (stampedId && fiber.has(stampedId)) return stampedId;
    if (resId && fiber.has(resId)) return resId;
    let best = null;
    let bestScore = -Infinity;
    for (const id of ids) {
      const net = collected.get(id);
      const score = (net?.videos.length ? 1e12 : 0) + (net?.last ?? 0) + fiberMaxArea(fiber.get(id));
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  /** Build a spec purely from the tweet's data (used when the ledger has
   * nothing for this id — the player was never touched this session). */
  function pickFromFiber(fiber, id) {
    const cur = fiber.get(id);
    if (!cur) return null;
    if (cur.videos.size) {
      const bestVideo = [...cur.videos].sort((a, b) => fiberArea(b) - fiberArea(a))[0];
      const bestAudio = [...cur.audios].sort(
        (a, b) =>
          Number(/\/(?:pl|vid)\/[^/]+\/(\d+)\//i.exec(b)?.[1] ?? 0) -
          Number(/\/(?:pl|vid)\/[^/]+\/(\d+)\//i.exec(a)?.[1] ?? 0)
      )[0];
      return { url: bestVideo, audioUrl: bestAudio ?? null };
    }
    if (cur.files.size) {
      return { url: [...cur.files].sort((a, b) => fiberArea(b) - fiberArea(a))[0], audioUrl: null };
    }
    return null;
  }

  function fiberArea(url) {
    const res = /(\d+)x(\d+)/.exec(url);
    return res ? Number(res[1]) * Number(res[2]) : 0;
  }

  function fiberMaxArea(cur) {
    let area = 0;
    for (const u of cur.videos) area = Math.max(area, fiberArea(u));
    for (const u of cur.files) area = Math.max(area, fiberArea(u));
    return area;
  }

  const inflight = new Map(); // media url -> button whose job response is in flight
  const doneIds = new Set(); // jobIds already finished (their response lands late)

  api.runtime.onMessage.addListener((msg) => {
    if (msg?.kind !== "tweax:progress" && msg?.kind !== "tweax:done") return;
    // A tiny job can finish before its click response lands — route by the
    // media url first, the job id second.
    let btn = busy.get(msg.jobId);
    if (!btn && msg.url) btn = inflight.get(msg.url);
    if (!btn) return;
    if (msg.kind === "tweax:progress") {
      if (msg.pct != null) btn.setAttribute("aria-label", `Downloading ${msg.pct}%`);
      return;
    }

    // The job is over: release the button and announce the outcome.
    doneIds.add(msg.jobId);
    if (doneIds.size > 200) doneIds.clear();
    busy.delete(msg.jobId);
    if (msg.url) inflight.delete(msg.url);
    btn.dataset.tweaxBusy = "";
    btn.style.opacity = msg.ok ? "" : "0.45";
    btn.setAttribute(
      "aria-label",
      msg.ok ? "Downloaded" : `Failed: ${(msg.error ?? "").slice(0, 100)}`
    );
    setTimeout(() => btn.setAttribute("aria-label", btn.dataset.tweaxLabel ?? "Download"), msg.ok ? 1500 : 2500);
  });

  function flash(btn, message) {
    if (!btn) return;
    btn.dataset.tweaxBusy = "";
    btn.style.opacity = "";
    btn.setAttribute("aria-label", String(message).slice(0, 120));
    setTimeout(() => btn.setAttribute("aria-label", btn.dataset.tweaxLabel ?? "Download"), 2500);
  }

  // ---------------------------------------------------------------- injection

  // The native buttons get their blue hover from React class swaps that a
  // cloned node has no handlers for — one CSS rule reproduces it. #1d9bf0 is
  // X's own hover blue for Bookmark/Share.
  const HOVER_CSS = `
    [data-testid="${BTN_TESTID}"] { cursor: pointer; position: relative; }
    [data-testid="${BTN_TESTID}"]:hover svg,
    [data-testid="${BTN_TESTID}"]:hover span { color: #1d9bf0; }
    [data-testid="${BTN_TESTID}"] svg { display: block; }
    [data-tweax-overlay] {
      position: absolute !important; top: 10px !important; right: 10px !important; left: auto !important; bottom: auto !important;
      width: 28px !important; height: 28px !important; min-width: 0 !important; min-height: 0 !important; max-width: none !important;
      padding: 0 !important; margin: 0 !important; border: 0 !important; border-radius: 8px !important;
      background: rgba(0,0,0,.5) !important; cursor: pointer !important;
      display: flex !important; align-items: center !important; justify-content: center !important;
      opacity: .3 !important; transition: opacity 120ms ease, background 120ms ease, box-shadow 120ms ease !important;
      z-index: 40 !important; flex: 0 0 auto !important; overflow: hidden !important;
    }
    [data-tweax-overlay]:hover { opacity: 0.55 !important; background: rgba(0,0,0,.85) !important; box-shadow: 0 2px 10px rgba(0,0,0,.45) !important; }
    [data-tweax-overlay][data-tweax-busy="1"] { opacity: 0.55 !important; }
    [data-tweax-overlay] svg { width: 16px; height: 16px; fill: #fff; display: block; pointer-events: none; }
    [data-tweax-menuitem] { transition-duration: 0.2s; transition-property: background-color; }
    [data-tweax-menuitem]:hover { background-color: rgba(255, 255, 255, 0.03); }
  `;

  // The button's own pseudo-element tooltip gets clipped by the article's
  // overflow:hidden — X renders tooltips in a top layer instead. One shared
  // fixed-position tip follows whichever button is hovered and tracks its
  // aria-label while visible, so progress states show up live.
  const tipEl = document.createElement("div");
  tipEl.dataset.tweaxTip = "1";
  tipEl.style.cssText =
    "position:fixed;top:0;left:0;z-index:2200;background:rgba(70,70,70,0.9);color:#fff;" +
    `font-family:${UI_FONT};font-size:11px;font-weight:400;line-height:12px;` +
    "padding:4px 8px;border-radius:16px;white-space:nowrap;max-width:280px;overflow:hidden;" +
    "text-overflow:ellipsis;pointer-events:none;opacity:0;transform:translateX(-50%);";
  let tipBtn = null;
  let tipSync = 0;

  function hideTip() {
    if (!tipBtn) return;
    tipBtn = null;
    clearInterval(tipSync);
    tipEl.style.transition = "opacity 100ms ease";
    tipEl.style.opacity = "0";
  }

  function showTipFor(btn) {
    const wasHidden = !tipBtn;
    tipBtn = btn;
    tipEl.textContent = btn.getAttribute("aria-label") ?? "";
    if (!tipEl.isConnected) (document.body ?? document.documentElement).appendChild(tipEl);
    const r = btn.getBoundingClientRect();
    const half = tipEl.offsetWidth / 2;
    tipEl.style.left = Math.min(Math.max(r.left + r.width / 2, half + 8), innerWidth - half - 8) + "px";
    tipEl.style.top = r.bottom + 6 + "px";
    if (wasHidden) {
      tipEl.style.transition = "opacity 100ms ease 400ms";
      tipEl.style.opacity = "1";
      clearInterval(tipSync);
      tipSync = setInterval(() => {
        if (!tipBtn) return clearInterval(tipSync);
        if (!tipBtn.isConnected) return hideTip();
        tipEl.textContent = tipBtn.getAttribute("aria-label") ?? "";
      }, 300);
    }
  }

  document.addEventListener(
    "mouseover",
    (event) => {
      const btn = event.target?.closest?.(`[data-testid="${BTN_TESTID}"]`);
      if (btn) showTipFor(btn);
      else hideTip();
    },
    true
  );
  document.addEventListener(
    "mouseout",
    (event) => {
      const btn = event.target?.closest?.(`[data-testid="${BTN_TESTID}"]`);
      if (btn && event.relatedTarget && btn.contains(event.relatedTarget)) return;
      hideTip();
    },
    true
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (tipBtn && !tipBtn.contains(event.target)) hideTip();
    },
    true
  );
  document.addEventListener("scroll", hideTip, true);

  function inject(article) {
    const hasVideo = !!article?.querySelector("video, [data-testid='videoPlayer']");
    const hasPhoto = !!article?.querySelector('[data-testid="tweetPhoto"] img');
    const sid = statusIdOf(article);
    const known = sid && knownMedia.has(sid);
    if (!hasVideo && !hasPhoto && !known) return;
    const isPhoto = !hasVideo;
    if (sid && typeHidden.has(sid)) return;
    if (isPhoto && !prefs.photo && !known) return;
    if (hasVideo && !prefs.video && !prefs.gif) return;
    const group = article.querySelector('div[role="group"]');
    if (!group || group.querySelector(`[data-testid="${BTN_TESTID}"]`)) return;

    const anchor = [
      ...group.querySelectorAll('button[data-testid="bookmark"], button[aria-label*="Bookmark" i], button[aria-label*="Share" i]'),
    ][0];
    let cell = anchor;
    while (cell && cell.parentElement !== group) cell = cell.parentElement;
    if (!cell || cell === group) return;

    const clone = cell.cloneNode(true);
    clone.dataset.tweax = "1";
    const btn = clone.querySelector("button, [role='button']");
    if (!btn) return;
    btn.removeAttribute("data-testid");
    btn.setAttribute("data-testid", BTN_TESTID);
    // The label follows the neighbors' own naming ("Bookmark", "Share post"):
    // one short stable action name; the icon carries the media type.
    btn.dataset.tweaxLabel = "Download";
    btn.setAttribute("aria-label", btn.dataset.tweaxLabel);
    btn.style.opacity = "";
    btn.dataset.tweaxBusy = "";
    // The clone must not show the bookmark's own counter.
    for (const count of clone.querySelectorAll('[data-testid="app-text-transition-container"]')) {
      count.textContent = "";
    }
    const svg = clone.querySelector("svg");
    if (svg) svg.innerHTML = isPhoto ? ICON_IMAGE : ICON_DOWNLOAD;
    group.insertBefore(clone, cell);
    const injectedBtn = clone.querySelector(`[data-testid="${BTN_TESTID}"]`);
    if (injectedBtn) overlayRegistry.set(clone, injectedBtn);
  }

  const OVERLAY_SVG = `<svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:#fff;display:block;pointer-events:none">${ICON_DOWNLOAD}</svg>`;

  /** The tweet that owns a media container: X wraps every video/photo in an
   * anchor to its own status (".../status/<id>" or ".../photo/<n>"). Returns
   * {sid, photoIdx} or null when the container is not wrapped. */
  function wrapSidOf(box, article) {
    const a = box.closest('a[href*="/status/"]');
    if (!a || !article.contains(a)) return null;
    const href = a.getAttribute("href") ?? "";
    const sid = /\/status\/(\d+)/.exec(href)?.[1] ?? null;
    if (!sid) return null;
    const p = /\/photo\/(\d+)/.exec(href);
    return { sid, photoIdx: p ? Number(p[1]) - 1 : null };
  }

  /** All status ids referenced inside a scope, in DOM order. */
  function statusIdsIn(scope) {
    const out = [];
    for (const a of scope?.querySelectorAll('a[href*="/status/"]') ?? []) {
      const id = /\/status\/(\d+)/.exec(a.getAttribute("href") ?? "")?.[1];
      if (id && !out.includes(id)) out.push(id);
    }
    return out;
  }

  /** A job tracked by the action-bar button must always release it: even if
   * its tweax:done never arrives, the button unlocks after two minutes. */
  function watchJob(jobId, btn) {
    busy.set(jobId, btn);
    setTimeout(() => {
      if (busy.get(jobId) !== btn) return;
      busy.delete(jobId);
      btn.dataset.tweaxBusy = "";
      btn.style.opacity = "";
      btn.setAttribute("aria-label", "no result — try again");
      setTimeout(() => btn.setAttribute("aria-label", btn.dataset.tweaxLabel ?? "Download"), 2500);
    }, 75_000);
  }

  /** Per-media overlays on multi-media posts only — the main button
   * downloads everything as one ZIP, the overlays grab single items. X
   * nests the video player inside a photo box, so a single-media post can
   * present two containers: they collapse to their outermost element, and
   * the API map's own item count (photos + video entities) decides anyway,
   * with the collapsed DOM count as fallback. Quoted media boxes answer to
   * their own status and are never pruned here. */
  function syncMediaOverlays(article, media, sid) {
    const all = [...article.querySelectorAll('[data-testid="tweetPhoto"], [data-testid="videoPlayer"]')];
    const boxes = all.filter((box) => !all.some((other) => other !== box && other.contains(box)));
    const known = media?.photos?.length || media?.videos?.length;
    const count = known ? (media.photos?.length ?? 0) + (media.videos?.length ?? 0) : boxes.length;
    for (const box of boxes) {
      const overlay = box.querySelector(":scope > [data-tweax-overlay]");
      const wrap = wrapSidOf(box, article);
      const own = !wrap?.sid || wrap.sid === sid;
      const kind = box.querySelector("video") ? "media" : "photo";
      const wanted = kind === "photo" ? prefs.photo : prefs.gif || prefs.video;
      if (!wanted || (count < 2 && own)) {
        if (overlay) removeOverlayEl(overlay);
        continue;
      }
      if (overlay) continue;
      createMediaOverlay(box, wrap?.sid ?? sid, wrap?.photoIdx ?? boxes.indexOf(box), boxes.length, kind);
    }
  }

  function createMediaOverlay(box, sid, index, total, kind) {
    if (box.querySelector(":scope > [data-tweax-overlay]")) return;
    if (getComputedStyle(box).position === "static") box.style.position = "relative";
    const b = document.createElement("div");
    b.setAttribute("role", "button");
    b.tabIndex = 0;
    b.dataset.tweaxOverlay = "photo";
    b.dataset.tweaxSid = sid ?? "";
    if (index != null) b.dataset.tweaxIndex = String(index);
    const noun = kind === "media" ? "video" : "image";
    b.setAttribute("aria-label", total > 1 ? `Download ${noun} ${index + 1}` : `Download ${noun}`);
    b.innerHTML = OVERLAY_SVG;
    box.appendChild(b);
    overlayRegistry.set(box, b);
  }

  // Auto-reveal NSFW: X gates sensitive media behind a blurred role=button
  // overlay ("Sensitive content" / "Content warning"). One synthetic click
  // reveals it. Clicked gates are tracked in a WeakSet — a real reveal
  // unmounts the gate, so nothing is re-clicked; a re-render that builds a
  // fresh gate retries, which is the desired behavior anyway.
  const revealedGates = new WeakSet();

  function revealSensitive(article) {
    if (!prefs.reveal) return;
    for (const gate of article.querySelectorAll('[role="button"][style*="blur"]')) {
      if (revealedGates.has(gate)) continue;
      revealedGates.add(gate);
      gate.click();
    }
  }

  function scan() {
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      inject(article);
      revealSensitive(article);
      // The API map knows the real media type (video/gif/photo) — sync the
      // button's icon with it and hide the whole thing when that type is off.
      void variantsFor(statusIdOf(article)).then((res) => {
        const media = res?.media ?? null;
        const sid = statusIdOf(article);
        syncMediaOverlays(article, media, sid);
        if (!media) return;
        const mtype = media.type ?? (media.photos?.length ? "photo" : null);
        if (!mtype) return;
        knownMedia.add(sid);
        const btn = article.querySelector(`[data-testid="${BTN_TESTID}"]`);
        if (btn && btn.dataset.tweaxBusy !== "1") {
          const mark = mtype === "photo" ? "photo" : "media";
          if (btn.dataset.tweaxIcon !== mark) {
            btn.dataset.tweaxIcon = mark;
            const svg = btn.querySelector("svg");
            if (svg) svg.innerHTML = mark === "photo" ? ICON_IMAGE : ICON_DOWNLOAD;
            btn.dataset.tweaxLabel = "Download";
            btn.setAttribute("aria-label", btn.dataset.tweaxLabel);
          }
        }
        const off =
          (mtype === "animated_gif" && !prefs.gif) ||
          (mtype === "video" && !prefs.video) ||
          (mtype === "photo" && !prefs.photo);
        if (off && sid) {
          typeHidden.add(sid);
          const stale = article.querySelector(`[data-testid="${BTN_TESTID}"]`);
          if (stale) removeOverlayEl(stale);
        } else if (sid && typeHidden.has(sid)) {
          typeHidden.delete(sid);
          scheduleScan();
        }
      });
    }
  }

  let scanTimer = null;
  const scheduleScan = () => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 250);
  };

  const observer = new MutationObserver(() => {
    tryInjectShareItem();
    reseatOverlays();
    scheduleScan();
  });
  const start = () => {
    try {
      const style = document.createElement("style");
      style.dataset.tweax = "hover";
      style.textContent = HOVER_CSS;
      (document.head ?? document.documentElement).appendChild(style);
    } catch {}
    observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true });
    loadPrefs();
    scheduleScan();
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
