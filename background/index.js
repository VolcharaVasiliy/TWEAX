// Background service worker. Owns the media index, the offscreen document
// (where HLS assembly + ffmpeg.wasm muxing run — a service worker cannot load
// wasm workers or create blob URLs) and hands the finished blob URL to
// chrome.downloads.

import { harvestPageMedia, installMediaIndex, latestMediaPair, mediaForTab } from "./media-index.js";

installMediaIndex();

const OFFSCREEN_URL = "offscreen/offscreen.html";
let creatingOffscreen = null;

// The offscreen page is "created" before its module code has run, and this
// service worker can die and restart at any moment (losing every in-memory
// flag) — so liveness is verified by pinging the page, never by a flag or by
// getContexts (which must not be trusted to settle on every Edge build).
const READY_TIMEOUT_MS = 20_000;

async function offscreenAlive() {
  try {
    const res = await Promise.race([
      chrome.runtime.sendMessage({ kind: "tweax:ping" }),
      new Promise((r) => setTimeout(() => r(null), 500)),
    ]);
    return res?.ok === true;
  } catch {
    return false;
  }
}

async function ensureOffscreen() {
  if (await offscreenAlive()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: "Assemble HLS segments and mux video+audio with ffmpeg.wasm",
      })
      .then(
        () => {},
        (err) => {
          // "Only a single offscreen document" means one already exists — fine.
          if (!/already exists/i.test(String(err))) throw err;
        }
      )
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

function waitForOffscreenReady() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const tick = async () => {
      if (await offscreenAlive()) return resolve();
      if (Date.now() > deadline) return reject(new Error("the offscreen page never became ready"));
      setTimeout(tick, 200);
    };
    tick();
  });
}

/** Active download jobs the popup is watching: jobId -> {at} */
const jobs = new Map();
/** jobId -> tabId that started the job. runtime broadcasts never reach
 * content scripts, so done/progress must be forwarded via tabs.sendMessage. */
const jobTabs = new Map();
/** blob downloads in flight: downloadId -> blobUrl (offscreen must outlive them) */
const pendingBlobDownloads = new Map();

async function scheduleIdleClose() {
  setTimeout(async () => {
    if (jobs.size > 0 || pendingBlobDownloads.size > 0) return;
    if (await offscreenAlive()) await chrome.offscreen.closeDocument().catch(() => {});
  }, 90_000);
}

/** Duplicate-job guard: a double click (or a click plus the popup) must not
 * download the same media twice. Same media within the window returns the
 * original job id instead of starting a second pipeline. For X the key is the
 * tweet's video id, so different renditions of one video still dedupe. */
const recentJobs = new Map(); // key -> { jobId, at }
const DEDUPE_MS = 30_000;

function dedupeKey(spec) {
  if (Array.isArray(spec.zipUrls) && spec.zipUrls.length) {
    return `zip:${spec.name ?? spec.zipUrls.length + ":" + spec.zipUrls[0]}`;
  }
  const id = /\/(?:amplify_video|ext_tw_video|vid|tweet_video)\/(\d+)\//.exec(spec.url ?? "")?.[1];
  return id ? `xvid:${id}` : `${spec.url}|${spec.audioUrl ?? ""}`;
}

function findRecentJob(spec) {
  const key = dedupeKey(spec);
  const hit = recentJobs.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > DEDUPE_MS) {
    recentJobs.delete(key);
    return null;
  }
  return hit.jobId;
}

/** Queue one download: make sure the offscreen page is up, hand the job over.
 * A duplicate of a very recent job (double click, popup plus button) returns
 * the original job id — one pipeline, one file. All startJob calls go through
 * one chain: two concurrent callers would both miss the dedupe map otherwise
 * (the page harvest + offscreen readiness take longer than a double click). */
let jobChain = Promise.resolve();

function startJob(spec, tabId) {
  const run = jobChain.then(() => startJobNow(spec, tabId));
  jobChain = run.catch(() => {});
  return run;
}

async function startJobNow(spec, tabId) {
  await ensureOffscreen();
  await waitForOffscreenReady();
  const key = dedupeKey(spec);
  const recent = findRecentJob(spec);
  // Return the recent job only while it is still RUNNING — a finished one
  // will never send tweax:done again, and a button waiting on it hangs.
  if (recent && jobs.has(recent)) return { jobId: recent };
  const job = {
    jobId: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    url: spec.url ?? null,
    audioUrl: spec.audioUrl ?? null,
    name: spec.name ?? null,
    gif: spec.gif === true,
    zipUrls: Array.isArray(spec.zipUrls) ? spec.zipUrls : null,
    zipGifs: Array.isArray(spec.zipGifs) ? spec.zipGifs : null,
  };
  recentJobs.set(key, { jobId: job.jobId, at: Date.now() });
  jobs.set(job.jobId, { at: Date.now() });
  if (tabId != null) jobTabs.set(job.jobId, tabId);

  // Deliver with acknowledgement: a broadcast can be lost while the fresh
  // offscreen document is still spinning up, and a lost job means a button
  // stuck on "Downloading…" forever. The offscreen acks by jobId.
  let delivered = false;
  let lastError = null;
  for (let attempt = 0; attempt < 8 && !delivered; attempt++) {
    try {
      const res = await Promise.race([
        chrome.runtime.sendMessage({ kind: "tweax:job", job }),
        new Promise((r) => setTimeout(() => r(null), 700)),
      ]);
      delivered = res?.ack === job.jobId;
      if (!delivered) lastError = res?.error ?? "no ack";
    } catch (err) {
      lastError = String(err);
    }
    if (!delivered) await new Promise((r) => setTimeout(r, 400));
  }
  if (!delivered) throw new Error(`the offscreen page did not accept the job: ${lastError}`);
  return job;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.kind !== "string") return;

  switch (msg.kind) {
    case "tweax:media-list": {
      const tabId = Number(msg.tabId ?? -1);
      // Harvest the page's Resource Timing buffer synchronously, then answer:
      // the first popup paint already knows what the page fetched seconds ago.
      void (async () => {
        await harvestPageMedia(tabId);
        sendResponse({ media: await mediaForTab(tabId) });
      })();
      return true;
    }

    case "tweax:download": {
      void (async () => {
        try {
          const job = await startJob(msg.job ?? {}, sender?.tab?.id);
          sendResponse({ ok: true, jobId: job.jobId });
          chrome.runtime.sendMessage({ kind: "tweax:job", job }).catch(() => {});
        } catch (err) {
          sendResponse({ ok: false, error: String(err) });
        }
      })();
      return true;
    }

    // The in-feed X button: harvest the page, pick the newest video+audio
    // pair (or the article's own remembered one) and start a muxed download.
    case "tweax:download-latest":
    case "tweax:latest-pair": {
      void (async () => {
        try {
          const tabId = sender?.tab?.id;
          if (tabId == null) throw new Error("no tab");
          await harvestPageMedia(tabId);
          const entry = await latestMediaPair(tabId, msg.prefer?.url ?? null);
          if (!entry) {
            sendResponse({ ok: false, error: "no video found on this tab yet" });
            return;
          }
          if (msg.kind === "tweax:latest-pair") {
            sendResponse({ ok: true, entry: { url: entry.url, audioUrl: entry.audioUrl ?? null } });
            return;
          }
          const job = await startJob({ url: entry.url, audioUrl: entry.audioUrl, name: null }, sender?.tab?.id);
          sendResponse({ ok: true, jobId: job.jobId });
          chrome.runtime.sendMessage({ kind: "tweax:job", job }).catch(() => {});
        } catch (err) {
          sendResponse({ ok: false, error: String(err) });
        }
      })();
      return true;
    }

    // From the in-feed button: save each photo of the tweet at original size,
    // one file per image (x-<statusId>-1.jpg, …). Direct browser downloads —
    // no offscreen pipeline needed for plain images.
    case "tweax:download-photos": {
      void (async () => {
        try {
          const urls = (Array.isArray(msg.urls) ? msg.urls : []).slice(0, 4);
          if (!urls.length) throw new Error("no image urls");
          const base = msg.statusId ? `x-${msg.statusId}` : `x-${Date.now().toString(36)}`;
          const start = Number(msg.start ?? 0) || 0;
          let count = 0;
          for (const [i, url] of urls.entries()) {
            await chrome.downloads.download({
              url,
              filename: `${base}-${start + i + 1}.${photoExt(url)}`,
            });
            count++;
          }
          sendResponse({ ok: true, count });
        } catch (err) {
          sendResponse({ ok: false, error: String(err) });
        }
      })();
      return true;
    }

    // From the offscreen document: its code is loaded and listening.
    case "tweax:ping":
      sendResponse({ ok: true });
      return;

    // From the offscreen document: muxed/assembled blob is ready to save.
    case "tweax:save": {
      void (async () => {
        const blobUrl = msg.blobUrl;
        const filename = msg.filename ?? "video.mp4";
        try {
          const downloadId = await chrome.downloads.download({ url: blobUrl, filename });
          if (blobUrl?.startsWith("blob:")) pendingBlobDownloads.set(downloadId, blobUrl);
          sendResponse({ ok: true, downloadId });
        } catch (err) {
          sendResponse({ ok: false, error: String(err) });
        }
      })();
      return true;
    }

    // From the offscreen document: stream job progress to the tab that
    // started it — runtime broadcasts do not reach content scripts.
    case "tweax:progress": {
      const tabId = msg.jobId ? jobTabs.get(msg.jobId) : null;
      if (tabId != null) chrome.tabs.sendMessage(tabId, msg).catch(() => {});
      return;
    }

    // From the offscreen document: pipeline finished (ok or failed).
    case "tweax:done": {
      if (msg.jobId) {
        jobs.delete(msg.jobId);
        const tabId = jobTabs.get(msg.jobId);
        if (tabId != null) {
          jobTabs.delete(msg.jobId);
          chrome.tabs.sendMessage(tabId, msg).catch(() => {});
        }
      }
      void scheduleIdleClose();
      sendResponse({ ok: true });
      return;
    }

    default:
      return;
  }
});

// Popups are transient; re-broadcast progress so an open popup can render it.
chrome.downloads.onChanged.addListener((delta) => {
  if (!pendingBlobDownloads.has(delta.id)) return;
  const state = delta.state?.current;
  if (state === "complete" || state === "interrupted") {
    pendingBlobDownloads.delete(delta.id);
    void scheduleIdleClose();
  }
});

function photoExt(url) {
  try {
    const u = new URL(url);
    const fmt = u.searchParams.get("format");
    if (fmt) return fmt.replace(/[^a-z0-9]/gi, "").toLowerCase() || "jpg";
    const m = /\.(jpe?g|png|webp|gif)(\?|$)/i.exec(u.pathname);
    return m ? m[1].toLowerCase() : "jpg";
  } catch {
    return "jpg";
  }
}
