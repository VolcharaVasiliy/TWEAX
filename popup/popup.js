// Popup UI: the tweak toggles. Downloads are started from the buttons X pages
// get via the content script; this panel only edits the stored tweaks.

const $ = (id) => document.getElementById(id);

const SETTINGS_KEY = "tweax.settings";
const DEFAULT_TWEAKS = {
  unmuteVideos: true,
  volumeLock: true,
  volumeLevel: 1,
  revealSensitive: true,
  videoDownloads: true,
  gifDownloads: true,
  photoDownloads: true,
  filenamePattern: "{account}_{tweetId}_{serial}",
};

// The filename parts, in the canonical order they appear in the pattern.
// Clicking a tag toggles it in the pattern.
const NAME_TOKENS = [
  { token: "{account}" },
  { token: "{tweetId}" },
  { token: "{mediaId}" },
  { token: "{serial}" },
  { token: "{date}" },
  { token: "{datetime}" },
];
const PATTERN_DEFAULT = "{account}_{tweetId}_{serial}";

const LANG_ORDER = ["en", "ru", "zh", "ja", "es"];
const I18N = {
  en: {
    unmuteTitle: "Sound without clicking",
    unmuteDesc: "unmute videos automatically",
    lockTitle: "Lock volume",
    lockDesc: "pin the volume to the level below",
    revealTitle: "Auto-reveal NSFW",
    revealDesc: "show sensitive media without a click",
    videoDlTitle: "Video downloads",
    videoDlDesc: "show the button on video posts",
    gifDlTitle: "GIF downloads",
    gifDlDesc: "save as a real .gif, not mp4",
    photoDlTitle: "Photo downloads",
    photoDlDesc: "original size, all images of a post",
    volume: "Volume",
    filename: "Filename",
    errorSave: "could not save the tweak",
  },
  ru: {
    unmuteTitle: "Звук без клика",
    unmuteDesc: "автоматически включать звук",
    lockTitle: "Фиксировать громкость",
    lockDesc: "закрепить громкость на уровне ниже",
    revealTitle: "Показывать NSFW",
    revealDesc: "открывать чувствительное медиа без клика",
    videoDlTitle: "Скачивание видео",
    videoDlDesc: "кнопка на постах с видео",
    gifDlTitle: "Скачивание гифок",
    gifDlDesc: "настоящий .gif вместо mp4",
    photoDlTitle: "Скачивание фото",
    photoDlDesc: "оригинальный размер, все фото поста",
    volume: "Громкость",
    filename: "Имя файла",
    errorSave: "не удалось сохранить твинк",
  },
  zh: {
    unmuteTitle: "自动有声播放",
    unmuteDesc: "自动取消视频静音",
    lockTitle: "锁定音量",
    lockDesc: "将音量固定在下方数值",
    revealTitle: "自动显示敏感内容",
    revealDesc: "无需点击自动展开 NSFW",
    videoDlTitle: "下载视频",
    videoDlDesc: "在视频帖子显示按钮",
    gifDlTitle: "下载 GIF",
    gifDlDesc: "保存为真正的 .gif 而非 mp4",
    photoDlTitle: "下载图片",
    photoDlDesc: "原始尺寸，含全部图片",
    volume: "音量",
    filename: "文件名",
    errorSave: "无法保存设置",
  },
  ja: {
    unmuteTitle: "クリックなしで音声再生",
    unmuteDesc: "動画のミュートを自動解除",
    lockTitle: "音量を固定",
    lockDesc: "音量を下のレベルに固定",
    revealTitle: "NSFWを自動表示",
    revealDesc: "センシティブなメディアを自動で開く",
    videoDlTitle: "動画ダウンロード",
    videoDlDesc: "動画投稿にボタンを表示",
    gifDlTitle: "GIFダウンロード",
    gifDlDesc: "mp4ではなく本物の.gifで保存",
    photoDlTitle: "画像ダウンロード",
    photoDlDesc: "オリジナルサイズ、全画像対応",
    volume: "音量",
    filename: "ファイル名",
    errorSave: "設定を保存できませんでした",
  },
  es: {
    unmuteTitle: "Sonido sin clics",
    unmuteDesc: "activar el sonido automáticamente",
    lockTitle: "Fijar volumen",
    lockDesc: "fijar el volumen al nivel de abajo",
    revealTitle: "Mostrar NSFW",
    revealDesc: "mostrar contenido sensible sin clics",
    videoDlTitle: "Descargas de vídeo",
    videoDlDesc: "mostrar el botón en posts con vídeo",
    gifDlTitle: "Descargas de GIF",
    gifDlDesc: "guardar como .gif real, no mp4",
    photoDlTitle: "Descargas de fotos",
    photoDlDesc: "tamaño original, todas las imágenes del post",
    volume: "Volumen",
    filename: "Nombre",
    errorSave: "no se pudo guardar el ajuste",
  },
};

let lang = "en";
let enabledTokens = [];

/** The parts a stored pattern includes. Absent/empty patterns mean "never
 * touched" and show the default set; "none" is the stored all-off value. */
function tokensOf(pattern) {
  if (typeof pattern !== "string" || !pattern.trim()) return [...DEFAULT_ENABLED];
  return NAME_TOKENS.map((t) => t.token).filter((tok) => pattern.includes(tok));
}
const DEFAULT_ENABLED = tokensOf(PATTERN_DEFAULT);

function renderNameExample() {
  const el = $("name-example");
  el.textContent = "";
  for (const t of NAME_TOKENS) {
    const chip = document.createElement("span");
    chip.className = enabledTokens.includes(t.token) ? "chip on" : "chip";
    chip.textContent = t.token;
    chip.addEventListener("click", () => void toggleNameToken(t.token));
    el.append(chip);
  }
}

async function toggleNameToken(token) {
  const set = new Set(enabledTokens);
  if (set.has(token)) set.delete(token);
  else set.add(token);
  // Canonical order regardless of the click order; an empty pattern is
  // stored as "none" so it stays distinguishable from "never touched".
  enabledTokens = NAME_TOKENS.map((t) => t.token).filter((t) => set.has(t));
  renderNameExample();
  await saveTweaks({ filenamePattern: enabledTokens.join("_") || "none" });
}

function t(key) {
  return (I18N[lang] ?? I18N.en)[key] ?? I18N.en[key] ?? key;
}

function applyLang() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  $("lang-toggle").textContent = lang.toUpperCase();
}

function showError(message) {
  const el = $("error");
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function renderTweaks(tweaks) {
  const cfg = { ...DEFAULT_TWEAKS, ...(tweaks ?? {}) };
  $("tweak-unmute").checked = cfg.unmuteVideos === true;
  $("tweak-lock").checked = cfg.volumeLock === true;
  $("tweak-reveal").checked = cfg.revealSensitive === true;
  $("tweak-video").checked = cfg.videoDownloads === true;
  $("tweak-gif").checked = cfg.gifDownloads === true;
  $("tweak-photo").checked = cfg.photoDownloads === true;
  const level = Math.round(Math.min(1, Math.max(0, Number(cfg.volumeLevel) || 0)) * 100);
  $("volume-level").value = String(level);
  $("volume-readout").textContent = `${level}%`;
  $("volume-row").classList.toggle("disabled", cfg.volumeLock !== true);
  enabledTokens = tokensOf(cfg.filenamePattern);
  renderNameExample();
}

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const settings = stored?.[SETTINGS_KEY] ?? {};
    lang = LANG_ORDER.includes(settings.lang) ? settings.lang : "en";
    renderTweaks(settings.tweaks);
  } catch {}
  applyLang();
}

async function saveTweaks(patch) {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const settings = stored?.[SETTINGS_KEY] ?? {};
    const tweaks = { ...DEFAULT_TWEAKS, ...(settings.tweaks ?? {}), ...patch };
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings, tweaks } });
    renderTweaks(tweaks);
  } catch (err) {
    showError(`${t("errorSave")}: ${String(err)}`);
  }
}

$("lang-toggle").addEventListener("click", () => {
  lang = LANG_ORDER[(LANG_ORDER.indexOf(lang) + 1) % LANG_ORDER.length];
  applyLang();
  void (async () => {
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      const settings = stored?.[SETTINGS_KEY] ?? {};
      await chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings, lang } });
    } catch (err) {
      showError(String(err));
    }
  })();
});

$("tweak-unmute").addEventListener("change", (e) => void saveTweaks({ unmuteVideos: e.target.checked }));
$("tweak-lock").addEventListener("change", (e) => void saveTweaks({ volumeLock: e.target.checked }));
$("tweak-reveal").addEventListener("change", (e) => void saveTweaks({ revealSensitive: e.target.checked }));
$("tweak-video").addEventListener("change", (e) => void saveTweaks({ videoDownloads: e.target.checked }));
$("tweak-gif").addEventListener("change", (e) => void saveTweaks({ gifDownloads: e.target.checked }));
$("tweak-photo").addEventListener("change", (e) => void saveTweaks({ photoDownloads: e.target.checked }));
$("volume-level").addEventListener("input", (e) => {
  $("volume-readout").textContent = `${e.target.value}%`;
});
$("volume-level").addEventListener("change", (e) => {
  void saveTweaks({ volumeLevel: Number(e.target.value) / 100 });
});

void loadSettings();
