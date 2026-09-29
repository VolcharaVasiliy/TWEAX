// TWEAX Firefox MV3 self-test. Opened as a tab inside the extension; drives
// the REAL message API (tweax:download jobs) against fixtures served by the
// local fixture server, watches chrome.downloads for the artifacts, and posts
// everything to the server's /report endpoint. Artifact bytes are validated
// afterwards on disk with ffprobe / python zipfile.
(() => {
  const BASE = "http://127.0.0.1:8123";
  const out = document.getElementById("out");
  const lines = [];
  const say = (s) => {
    lines.push(s);
    out.textContent = lines.join("\n");
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function report(name, payload) {
    say(`${name}: ${JSON.stringify(payload)}`);
    try {
      await fetch(`${BASE}/report/${name}`, { method: "POST", body: JSON.stringify(payload) });
    } catch {}
  }

  async function pingBackground(tries = 40) {
    for (let i = 0; i < tries; i++) {
      try {
        const res = await chrome.runtime.sendMessage({ kind: "tweax:ping" });
        if (res?.ok === true) return true;
      } catch {}
      await wait(500);
    }
    return false;
  }

  // Watches downloads for one finishing with the expected file name.
  function waitDownload(namePart, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(finish, timeoutMs);
      async function check(delta) {
        if (delta.state?.current !== "complete" && delta.state?.current !== "interrupted") return;
        const [d] = await chrome.downloads.search({ id: delta.id }).catch(() => [null]);
        if (d && d.filename.replaceAll("\\", "/").includes(namePart)) finish(d, delta.state.current);
      }
      function finish(d, state) {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(check);
        resolve(d ? { ok: state === "complete", state, file: d.filename, bytes: d.fileSize, mime: d.mime, id: d.id } : null);
      }
      chrome.downloads.onChanged.addListener(check);
    });
  }

  // progress/done only route back when the job's tab is known — best effort.
  function watchMessages() {
    const seen = { progress: [], done: [] };
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.kind === "tweax:progress") seen.progress.push({ phase: msg.phase, pct: msg.pct });
      if (msg?.kind === "tweax:done") seen.done.push({ ok: msg.ok, error: msg.error ?? null, filename: msg.filename ?? null, bytes: msg.bytes ?? null, streams: msg.streams ?? null, muxed: msg.muxed ?? null });
    });
    return seen;
  }

  async function runCase(id, job, namePart, timeoutMs = 90_000) {
    const seen = watchMessages();
    const dl = waitDownload(namePart, timeoutMs);
    let sent = null;
    try {
      sent = await chrome.runtime.sendMessage({ kind: "tweax:download", job });
    } catch (err) {
      await report(`case-${id}`, { sent: null, error: String(err) });
      return;
    }
    const done = await dl;
    await wait(300); // let late done/progress messages land
    await report(`case-${id}`, {
      sent,
      download: done,
      progressPhases: [...new Set(seen.progress.map((p) => p.phase))],
      doneMessages: seen.done,
    });
  }

  async function main() {
    const t0 = Date.now();
    const bg = await pingBackground();
    await report("harness-env", {
      pingBackground: bg,
      chromeStoragePromise: typeof (chrome.storage.local.get("x") ?? {}).then === "function",
      userAgent: navigator.userAgent,
    });
    if (!bg) {
      await report("harness-final", { fatal: "background did not answer ping" });
      return;
    }

    // Content-script bridge injection + Resource Timing harvest, on a local
    // page (matches <all_urls>): proves content scripts run under MV3 host
    // permission rules and the collect round-trip works.
    try {
      const tab = await chrome.tabs.create({ url: `${BASE}/fixtures/testpage.html`, active: false });
      await wait(2500);
      const listed = await chrome.runtime.sendMessage({ kind: "tweax:media-list", tabId: tab.id });
      await report("harness-bridge", {
        tabId: tab.id,
        mediaCount: listed?.media?.length ?? null,
        media: (listed?.media ?? []).slice(0, 5).map((m) => ({ url: m.url.split("/").pop(), kind: m.kind })),
      });
      await chrome.tabs.remove(tab.id).catch(() => {});
    } catch (err) {
      await report("harness-bridge", { error: String(err) });
    }

    await runCase("mux-z", { url: `${BASE}/fixtures/muxz.m3u8`, audioUrl: `${BASE}/fixtures/audio.m3u8`, name: "tweax-mux-z" }, "tweax-mux-z.mp4");
    await runCase("mux-x", { url: `${BASE}/fixtures/muxx.m3u8`, audioUrl: `${BASE}/fixtures/audio.m3u8`, name: "tweax-mux-x" }, "tweax-mux-x.mp4");
    await runCase("noiv", { url: `${BASE}/fixtures/noiv.m3u8`, name: "tweax-noiv" }, "tweax-noiv.ts");
    await runCase("av", { url: `${BASE}/fixtures/av.m3u8`, name: "tweax-av" }, "tweax-av.ts");
    await runCase("fmp4", { url: `${BASE}/fixtures/video-fmp4.m3u8`, name: "tweax-fmp4" }, "tweax-fmp4.mp4");
    await runCase("direct", { url: `${BASE}/fixtures/direct.mp4`, name: "tweax-direct" }, "tweax-direct.mp4");
    await runCase("gif", { url: `${BASE}/fixtures/gif-src.mp4`, gif: true, name: "tweax-gif" }, "tweax-gif.gif");
    await runCase("zip", { zipUrls: [`${BASE}/fixtures/img1.png`, `${BASE}/fixtures/img2.jpg`, `${BASE}/fixtures/img3.png`], zipNames: ["one", "two", "three"], name: "tweax-zip" }, "tweax-zip.zip");

    await report("harness-final", { ok: true, seconds: ((Date.now() - t0) / 1000).toFixed(1) });
    say("ALL CASES DONE — closing soon");
    await wait(2500);
    window.close();
  }

  void main();
})();
