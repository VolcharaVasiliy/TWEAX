// Background event page (Firefox MV3). Owns the media index and hosts the
// whole download pipeline in-page: Firefox has no chrome.offscreen API, but
// its background page — unlike a Chrome service worker — is a full DOM page
// that can run ffmpeg.wasm's workers and create blob URLs, so the offscreen
// document's job is done here directly (see ./offscreen-pipeline.js, whose
// handler is imported for its side effect and called synchronously).

import { harvestPageMedia, installMediaIndex, latestMediaPair, mediaForTab } from "./media-index.js";
import "./offscreen-pipeline.js";

installMediaIndex();

/** Active download jobs the popup is watching: jobId -> {at} */
const jobs = new Map();
/** jobId -> tabId that started the job. runtime broadcasts never reach
 * content scripts, so done/progress must be forwarded via tabs.sendMessage. */
const jobTabs = new Map();
/** blob downloads in flight: downloadId -> blobUrl */
const pendingBlobDownloads = new Map();

// The MV3 event page is suspended when idle; a long mux or a pending blob
// download must look busy, or the page (and the job with it) dies mid-flight.
let keepaliveTimer = null;

function updateKeepalive() {
  const needed = jobs.size > 0 || pendingBlobDownloads.size > 0;
  if (needed && keepaliveTimer == null) {
    keepaliveTimer = setInterval(() => {
      try {
        void chrome.runtime.getPlatformInfo();
      } catch {}
    }, 15_000);
  } else if (!needed && keepaliveTimer != null) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
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
  const id =
    /\/(?:amplify_video|ext_tw_video|tweet_video)\/([A-Za-z0-9_-]+)/.exec(spec.url ?? "")?.[1] ??
    /\/vid\/(\d+)\//.exec(spec.url ?? "")?.[1];
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

/** Queue one download and hand the job to the in-page pipeline. A duplicate
 * of a very recent job (double click, popup plus button) returns the original
 * job id — one pipeline, one file. All startJob calls go through one chain:
 * two concurrent callers would both miss the dedupe map otherwise. */
let jobChain = Promise.resolve();

function startJob(spec, tabId) {
  const run = jobChain.then(() => startJobNow(spec, tabId));
  jobChain = run.catch(() => {});
  return run;
}

async function startJobNow(spec, tabId) {
  const handler = globalThis.__tweaxOffscreenHandler;
  if (typeof handler !== "function") throw new Error("the download pipeline is not loaded");
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
    zipNames: Array.isArray(spec.zipNames) ? spec.zipNames : null,
  };
  recentJobs.set(key, { jobId: job.jobId, at: Date.now() });
  jobs.set(job.jobId, { at: Date.now() });
  if (tabId != null) jobTabs.set(job.jobId, tabId);
  updateKeepalive();

  // In-page delivery cannot be lost in transit: one synchronous ack.
  const ack = await new Promise((resolve) => {
    const sync = handler({ kind: "tweax:job", job }, { tab: null }, resolve);
    if (sync !== true) resolve(undefined);
  });
  if (ack?.ack !== job.jobId) {
    jobs.delete(job.jobId);
    jobTabs.delete(job.jobId);
    updateKeepalive();
    throw new Error("the download pipeline did not accept the job");
  }
  return job;
}

function onMessage(msg, sender, sendResponse) {
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
        } catch (err) {
          sendResponse({ ok: false, error: String(err) });
        }
      })();
      return true;
    }

    // From the in-feed button: save each photo of the tweet at original size,
    // one file per image, named by the content script's filename template
    // (or x-<statusId>-N when no template names arrive).
    case "tweax:download-photos": {
      void (async () => {
        try {
          const urls = (Array.isArray(msg.urls) ? msg.urls : []).slice(0, 4);
          if (!urls.length) throw new Error("no image urls");
          const names = Array.isArray(msg.names) ? msg.names : [];
          const base = msg.statusId ? `x-${msg.statusId}` : `x-${Date.now().toString(36)}`;
          const start = Number(msg.start ?? 0) || 0;
          let count = 0;
          for (const [i, url] of urls.entries()) {
            await chrome.downloads.download({
              url,
              filename: `${String(names[i] ?? `${base}-${start + i + 1}`)}.${photoExt(url)}`,
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

    // Liveness probe (the popup, the harness — anyone may ask).
    case "tweax:ping":
      sendResponse({ ok: true });
      return;

    // From the pipeline: muxed/assembled blob is ready to save.
    case "tweax:save": {
      void (async () => {
        const blobUrl = msg.blobUrl;
        const filename = msg.filename ?? "video.mp4";
        try {
          const downloadId = await chrome.downloads.download({ url: blobUrl, filename });
          if (blobUrl?.startsWith("blob:")) pendingBlobDownloads.set(downloadId, blobUrl);
          updateKeepalive();
          sendResponse({ ok: true, downloadId });
        } catch (err) {
          sendResponse({ ok: false, error: String(err) });
        }
      })();
      return true;
    }

    // From the pipeline: stream job progress to the tab that started it —
    // runtime broadcasts do not reach content scripts.
    case "tweax:progress": {
      const tabId = msg.jobId ? jobTabs.get(msg.jobId) : null;
      if (tabId != null) chrome.tabs.sendMessage(tabId, msg).catch(() => {});
      return;
    }

    // From the pipeline: finished (ok or failed).
    case "tweax:done": {
      if (msg.jobId) {
        jobs.delete(msg.jobId);
        const tabId = jobTabs.get(msg.jobId);
        if (tabId != null) {
          jobTabs.delete(msg.jobId);
          chrome.tabs.sendMessage(tabId, msg).catch(() => {});
        }
      }
      updateKeepalive();
      sendResponse({ ok: true });
      return;
    }

    default:
      return;
  }
}

chrome.runtime.onMessage.addListener(onMessage);

// The pipeline module reports progress/save/done through here. On Chrome
// those arrive as runtime messages from the offscreen document; in this
// merged build they are direct calls into the same handler, wrapped so the
// async sendResponse callers (tweax:save) still get a Promise answer.
globalThis.__tweaxToBackground = (msg) =>
  new Promise((resolve) => {
    let settled = false;
    const sync = onMessage(msg, { tab: null }, (resp) => {
      settled = true;
      resolve(resp);
    });
    if (sync !== true && !settled) {
      queueMicrotask(() => {
        if (!settled) resolve(undefined);
      });
    }
  });

// Popups are transient; re-broadcast progress so an open popup can render it.
chrome.downloads.onChanged.addListener((delta) => {
  if (!pendingBlobDownloads.has(delta.id)) return;
  const state = delta.state?.current;
  if (state === "complete" || state === "interrupted") {
    pendingBlobDownloads.delete(delta.id);
    updateKeepalive();
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
