// Isolated world bridge. Two jobs:
//   1. read the popup's tweak config from chrome.storage and forward it to the
//      MAIN-world enforcer (storage is invisible there);
//   2. report the page's media URLs (from the Resource Timing buffer) to the
//      background. webRequest cannot wake a sleeping MV3 worker, so entries a
//      page fetched earlier are recovered from here — the performance buffer
//      remembers them.

(() => {
  const FLAG = "__tweax_tweaks_bridge__";
  if (window[FLAG]) return;
  Object.defineProperty(window, FLAG, { value: true, enumerable: false });

  const api = typeof browser !== "undefined" ? browser : chrome;
  const KEY = "tweax.settings";

  // ------------------------------------------------------------ tweak config

  const post = (tweaks) => {
    try {
      window.postMessage({ __tweax: true, kind: "config", tweaks: tweaks ?? {} }, "*");
    } catch {}
  };

  const read = () => {
    try {
      api.storage.local.get(KEY).then((s) => post(s?.[KEY]?.tweaks)).catch(() => {});
    } catch {}
  };

  try {
    api.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[KEY]) post(changes[KEY].newValue?.tweaks);
    });
  } catch {}

  read();

  // ------------------------------------------------------------ media harvest

  const MEDIA_URL_RE = /(\.m3u8(\?|#|$))|(\.mpd(\?|$))|(\.(mp4|webm|mkv|mp3|m4a|aac|ogg|opus|wav)(\?|$))|(video\.twimg\.com)/i;

  function collectMedia() {
    try {
      const seen = new Set();
      const entries = [];
      for (const e of performance.getEntriesByType("resource")) {
        if (!MEDIA_URL_RE.test(e.name) || seen.has(e.name)) continue;
        seen.add(e.name);
        entries.push({ url: e.name, initiator: e.initiatorType ?? null });
      }
      return entries;
    } catch {
      return [];
    }
  }

  if (performance.setResourceTimingBufferSize) {
    try { performance.setResourceTimingBufferSize(2000); } catch {}
  }

  window.addEventListener("load", () => setTimeout(collectMedia, 500));
  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // The background harvests this page synchronously when the popup asks
    // for the media list; reply with everything this document has fetched.
    if (msg?.kind === "tweax:collect-request") {
      sendResponse({ entries: collectMedia() });
    }
    return;
  });
})();
