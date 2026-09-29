// Live x.com check: opens x.com, then probes the tweax bridge content script
// in that tab with tabs.sendMessage. No listener => the promise rejects
// (script not injected); a response proves the bridge is live on x.com under
// Firefox MV3 host-permission rules. Reports and closes.
(async () => {
  const out = document.getElementById("out");
  const say = (s) => (out.textContent += s + "\n");
  const BASE = "http://127.0.0.1:8123";
  const report = (name, payload) =>
    fetch(`${BASE}/report/${name}`, { method: "POST", body: JSON.stringify(payload) }).catch(() => {});

  const tab = await chrome.tabs.create({ url: "https://x.com/", active: false });
  await new Promise((r) => setTimeout(r, 15000)); // let the SPA settle
  const info = await chrome.tabs.get(tab.id).catch(() => null);

  let bridge = null;
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { kind: "tweax:collect-request" });
    bridge = { injected: true, entries: resp?.entries?.length ?? null };
  } catch (err) {
    bridge = { injected: false, error: String(err).slice(0, 160) };
  }

  const payload = {
    finalUrl: info?.url ?? null,
    title: info?.title ?? null,
    bridge,
  };
  say(JSON.stringify(payload, null, 2));
  await report("xcom-check", payload);
  await chrome.tabs.remove(tab.id).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  window.close();
})();
