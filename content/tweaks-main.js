// Runs in the page's MAIN world. The page's own player (X re-mutes the playing
// video continuously) mutates HTMLMediaElement properties here, so the tweak
// intercepts them at the prototype.
//
// CRITICAL RULE — every write is idempotent: a setter only touches the element
// when the value would actually change, and a page write of `muted = true`
// becomes a silent no-op while the unmute tweak is on. Writing the page's
// value first and then forcing our own would emit two volumechange events per
// write, and X's synchronous re-write would re-enter the setter — an event
// storm that freezes the whole tab. No redundant writes, no storm.
//
// The volume lock keeps one door open for the human: a gesture on the
// player's own volume slider (or a scrub pattern anywhere) is let through,
// and the value is remembered on that element, stamped with its currentSrc,
// as a per-video override. The page can never open that door itself — its
// background volume writes (a fresh video syncing its level on click-to-play)
// stay clamped because they arrive without such a gesture.

(() => {
  const FLAG = "__tweax_tweaks_main__";
  if (window[FLAG]) return;
  Object.defineProperty(window, FLAG, { value: true, enumerable: false });

  const DEFAULTS = { unmuteVideos: true, volumeLock: true, volumeLevel: 1 };
  let tweaks = { ...DEFAULTS };
  let patched = false;
  const native = {};
  const watchedPause = new WeakSet();

  const clampLevel = (v) => Math.min(1, Math.max(0, Number(v) || 0));

  /** Chromium pauses muted-autoplay videos when they get unmuted without user
   * activation. After our own forced unmute of a playing element, one replay
   * attempt brings the sound back; page- or user-initiated pauses are left
   * alone — only our own unmute arms the replay, and only for 800 ms. */
  function watchPause(el) {
    if (watchedPause.has(el)) return;
    watchedPause.add(el);
    el.addEventListener("pause", () => {
      if (!tweaks.unmuteVideos) return;
      const at = Number(el.__tweaxUnmutedAt ?? 0);
      if (!at || el.ended || Date.now() - at > 800) return;
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
    });
  }

  // ------------------------------------------------ per-video volume override

  // The lock yields to the human, not to the page. A gesture window lives
  // from a trusted pointerdown to a pointerup/cancel; a volume write passes
  // only when the window proves it is the user driving the player's volume:
  //   1. the pointer went down on the volume slider itself — X renders it as
  //      role="slider" with the range 0..100 (the seek slider's max is the
  //      duration, so the two never collide, whatever the UI language is) —
  //      every write passes from the very first one, no resistance;
  //   2. otherwise a scrub pattern: the primary button moved and the page
  //      wrote two different values on the same element (a drag scrubs, while
  //      click-piggybacked sync writes repeat one value).
  // The window binds to one element — the slider's own player's video when
  // known, else the first writer — so background syncs of other elements stay
  // clamped. After the release a 350 ms grace keeps the door open for players
  // that commit the value on pointerup rather than during the drag.

  let drag = null;

  /** The override a media element carries, or null when it is stale — it only
   * survives while the element keeps playing the media it was set on. */
  function overrideOf(el) {
    const ov = el.__tweaxVolumeOverride;
    if (!ov) return null;
    if (ov.src !== el.currentSrc) {
      delete el.__tweaxVolumeOverride;
      return null;
    }
    return ov.value;
  }

  const isVolumeSlider = (el) =>
    el instanceof HTMLElement &&
    el.getAttribute("role") === "slider" &&
    el.getAttribute("aria-valuemin") === "0" &&
    el.getAttribute("aria-valuemax") === "100";

  /** The tightest ancestor of the slider that plays a video — the player the
   * slider belongs to (build-independent: old and new X players both nest the
   * slider inside the container that holds the video element). */
  function videoOfSlider(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const v = n.querySelector?.("video");
      if (v) return v;
    }
    return null;
  }

  /** True while a gesture window is open (pointer down, or the post-release
   * grace of a gesture that proved itself) — a write may then ask dragTake. */
  const dragPassable = () => drag !== null && (drag.graceUntil ? Date.now() < drag.graceUntil : true);

  /** Decide at write time whether this write is the human: the bound element
   * only; while the pointer is still down and nothing is proven yet, demand
   * the scrub pattern. Within the post-release grace the gesture has already
   * proven itself (endDrag only arms it then), so take immediately. */
  function dragTake(el, num) {
    if (drag.boundEl == null) drag.boundEl = el;
    if (drag.boundEl !== el) return false;
    if (!drag.took && !drag.onSlider && !drag.graceUntil) {
      if (drag.moves < 1 || drag.lastWrite === null || drag.lastWrite === num) {
        drag.lastWrite = num;
        return false;
      }
    }
    drag.took = true;
    drag.lastWrite = num;
    return true;
  }

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!e.isTrusted) return;
      const slider = e.composedPath().find(isVolumeSlider) ?? null;
      drag = {
        moves: 0,
        onSlider: slider !== null,
        boundEl: slider ? videoOfSlider(slider) : null,
        graceUntil: 0,
        took: false,
        lastWrite: null,
      };
    },
    true
  );
  document.addEventListener(
    "pointermove",
    (e) => {
      if (drag && e.isTrusted && e.buttons & 1) drag.moves++;
    },
    true
  );
  const endDrag = () => {
    if (drag && (drag.took || drag.onSlider || drag.moves >= 3)) drag.graceUntil = Date.now() + 350;
    else drag = null;
  };
  document.addEventListener("pointerup", endDrag, true);
  document.addEventListener("pointercancel", endDrag, true);
  window.addEventListener("blur", () => {
    drag = null;
  });
  // Keyboard on the slider (arrow keys follow the ARIA slider convention):
  // re-arm a short window bound to the slider's video on every key press.
  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.isTrusted || !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) return;
      if (!isVolumeSlider(e.target)) return;
      const v = videoOfSlider(e.target);
      if (!v) return;
      drag = { moves: 3, onSlider: true, boundEl: v, graceUntil: Date.now() + 500, took: false, lastWrite: null };
    },
    true
  );

  function applyTo(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    try {
      if (tweaks.unmuteVideos) {
        if (el.defaultMuted !== false) el.defaultMuted = false;
        if (el.muted !== false) {
          const wasPlaying = !el.paused;
          el.muted = false;
          el.__tweaxUnmutedAt = wasPlaying ? Date.now() : 0;
        }
      }
      if (tweaks.volumeLock) {
        const wanted = clampLevel(tweaks.volumeLevel);
        if (el.volume !== wanted) el.volume = wanted;
      }
      watchPause(el);
    } catch {
      // Detached element or hostile wrapper; the next sweep retries.
    }
  }

  function applyAll() {
    if (!(tweaks.unmuteVideos || tweaks.volumeLock)) return;
    for (const el of document.querySelectorAll("video, audio")) applyTo(el);
  }

  function installPatch() {
    if (patched || typeof HTMLMediaElement === "undefined") return;
    patched = true;
    for (const prop of ["muted", "defaultMuted", "volume"]) {
      native[prop] = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, prop);
    }

    Object.defineProperty(HTMLMediaElement.prototype, "muted", {
      configurable: true,
      enumerable: true,
      get() {
        return native.muted.get.call(this);
      },
      set(value) {
        if (tweaks.unmuteVideos) {
          // A page write of "muted = true" is swallowed entirely: the element
          // is only written when it is currently muted (one event per real
          // transition, none otherwise) — the player has nothing to react to.
          if (native.muted.get.call(this) !== false) native.muted.set.call(this, false);
          return;
        }
        native.muted.set.call(this, value);
      },
    });

    Object.defineProperty(HTMLMediaElement.prototype, "defaultMuted", {
      configurable: true,
      enumerable: true,
      get() {
        return native.defaultMuted.get.call(this);
      },
      set(value) {
        const forced = tweaks.unmuteVideos ? false : value;
        if (native.defaultMuted.get.call(this) !== forced) {
          native.defaultMuted.set.call(this, forced);
        }
      },
    });

    Object.defineProperty(HTMLMediaElement.prototype, "volume", {
      configurable: true,
      enumerable: true,
      get() {
        return native.volume.get.call(this);
      },
      set(value) {
        let target = value;
        if (tweaks.volumeLock) {
          const num = clampLevel(value);
          if (dragPassable() && dragTake(this, num)) {
            // The human is scrubbing this element's volume control: take the
            // value and remember it for as long as this element plays this
            // media — the next video gets the locked level again.
            this.__tweaxVolumeOverride = { value: num, src: this.currentSrc };
            target = num;
          } else {
            target = overrideOf(this) ?? clampLevel(tweaks.volumeLevel);
          }
        }
        if (native.volume.get.call(this) !== target) native.volume.set.call(this, target);
      },
    });
  }

  // Elements the page adds later get the policy immediately; their future
  // writes are already covered by the patched setters themselves.
  const observer = new MutationObserver(() => applyAll());

  function activate() {
    if (!(tweaks.unmuteVideos || tweaks.volumeLock)) return;
    installPatch();
    applyAll();
    try {
      observer.observe(document.documentElement ?? document, { childList: true, subtree: true });
    } catch {}
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__tweax !== true || d.kind !== "config") return;
    tweaks = {
      unmuteVideos: d.tweaks?.unmuteVideos ?? DEFAULTS.unmuteVideos,
      volumeLock: d.tweaks?.volumeLock ?? DEFAULTS.volumeLock,
      volumeLevel: clampLevel(d.tweaks?.volumeLevel ?? DEFAULTS.volumeLevel),
    };
    // A fresh config re-locks everything: no per-video override outlives it.
    for (const el of document.querySelectorAll("video, audio")) {
      delete el.__tweaxVolumeOverride;
    }
    activate();
  });

  // ------------------------------------------------------------ media capture
  // GraphQL responses carry each tweet's video_info variants (direct mp4s and
  // the HLS master) keyed by the tweet's own rest_id. Capturing them gives the
  // download button a deterministic "this tweet -> this video" mapping: the
  // button asks by the tweet's permalink id, no playback/timing heuristics.

  const mediaByStatus = new Map(); // statusId -> { type, variants, photos }
  const MEDIA_MAP_CAP = 600;

  function rememberMedia(statusId, piece) {
    if (!statusId) return;
    const cur = mediaByStatus.get(statusId) ?? { sid: statusId, type: null, variants: [], photos: [], videos: [] };
    cur.sid = statusId;
    if (piece.type) cur.type = piece.type;
    if (piece.variants) {
      cur.variants = piece.variants;
      // Multi-video posts carry several media entities under one status id —
      // keep them all. GraphQL refetches of the same tweet replay the same
      // entities, so entries dedupe on their variant url set.
      const sig = piece.variants.map((v) => v.url).sort().join("|");
      if (!cur.videos.some((e) => e.sig === sig)) {
        cur.videos.push({ sig, type: piece.type, variants: piece.variants, mediaIds: piece.mediaIds ?? [] });
      }
    }
    if (piece.mediaIds?.length) cur.mediaIds = [...new Set([...(cur.mediaIds ?? []), ...piece.mediaIds])];
    if (piece.photos?.length) cur.photos = [...new Set([...cur.photos, ...piece.photos])];
    mediaByStatus.delete(statusId);
    mediaByStatus.set(statusId, cur);
    if (mediaByStatus.size > MEDIA_MAP_CAP) mediaByStatus.delete(mediaByStatus.keys().next().value);
  }

  function harvestMedia(node, tweetId) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const v of node) harvestMedia(v, tweetId);
      return;
    }
    let tid = tweetId;
    if (typeof node.rest_id === "string") tid = node.rest_id;
    else if (typeof node.id_str === "string" && node.__typename === "Tweet") tid = node.id_str;
    if (node.video_info?.variants) {
      // A media entity: node.type is "video" or "animated_gif" here.
      const variants = node.video_info.variants
        .filter((v) => typeof v?.url === "string")
        .map((v) => ({ bitrate: Number(v.bitrate ?? 0), url: v.url, content_type: v.content_type ?? "" }));
      // The twimg media ids carried by the variants let overlays bind to a
      // tweet without any status link in the DOM.
      const mediaIds = [
        ...new Set(
          variants
            .map((v) => /\/(?:amplify_video|ext_tw_video|vid|tweet_video)\/(\d+)\//.exec(v.url)?.[1])
            .filter(Boolean)
        ),
      ];
      rememberMedia(tid, {
        type: node.type === "animated_gif" ? "animated_gif" : "video",
        variants,
        mediaIds,
      });
    } else if (node.type === "photo" && typeof node.media_url_https === "string") {
      rememberMedia(tid, { type: "photo", photos: [node.media_url_https] });
    }
    for (const v of Object.values(node)) harvestMedia(v, tid);
  }

  let harvestBacklog = 0;
  function harvestJson(text) {
    if (harvestBacklog > 8) return;
    harvestBacklog++;
    setTimeout(() => {
      harvestBacklog--;
      try {
        harvestMedia(JSON.parse(text), null);
      } catch {}
    }, 0);
  }

  if (typeof window.fetch === "function") {
    const nativeFetch = window.fetch;
    window.fetch = function (...args) {
      const p = nativeFetch.apply(this, args);
      try {
        const url = typeof args[0] === "string" ? args[0] : (args[0]?.url ?? "");
        if (url.includes("/graphql")) {
          p.then((res) => {
            try {
              if ((res.headers?.get?.("content-type") ?? "").includes("json")) {
                res.clone().text().then(harvestJson).catch(() => {});
              }
            } catch {}
          }).catch(() => {});
        }
      } catch {}
      return p;
    };
  }

  try {
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__tweaxUrl = String(url ?? "");
      return nativeOpen.call(this, method, url, ...rest);
    };
    const nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", () => {
        try {
          if (!this.__tweaxUrl?.includes("/graphql")) return;
          const text =
            this.responseType === "json" ? JSON.stringify(this.response) : this.responseText;
          if (text) harvestJson(text);
        } catch {}
      });
      return nativeSend.apply(this, args);
    };
  } catch {}

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__tweax !== true || d.kind !== "variants") return;
    let hit = d.statusId ? mediaByStatus.get(String(d.statusId)) ?? null : null;
    if (!hit && d.mediaId) {
      for (const entry of mediaByStatus.values()) {
        if (entry.mediaIds?.includes(String(d.mediaId))) {
          hit = entry;
          break;
        }
      }
    }
    if (!hit && d.photoKey) {
      for (const entry of mediaByStatus.values()) {
        if (entry.photos?.some((p) => p.includes(d.photoKey))) {
          hit = entry;
          break;
        }
      }
    }
    window.postMessage(
      { __tweax: true, kind: "variants-reply", nonce: d.nonce, media: hit, sid: hit?.sid ?? null },
      "*"
    );
  });
})();
