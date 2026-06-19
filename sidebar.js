const LANGUAGE_LABELS = {
  "zh-CN": "简体中文",
  "zh-TW": "繁体中文",
  "en": "英文",
  "ja": "日文",
  "ko": "韩文",
  "fr": "法文",
  "de": "德文",
  "es": "西班牙文",
  "ru": "俄文"
};

document.addEventListener("DOMContentLoaded", loadLastTranslation);

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === "showTranslation") {
    renderTranslation(request);
  }
});

async function loadLastTranslation() {
  const data = await storageLocalGet(["lastSelectionTranslation"]);
  if (data.lastSelectionTranslation) {
    renderTranslation(data.lastSelectionTranslation);
  }
}

function renderTranslation(state) {
  document.getElementById("source-text").textContent = state.sourceText || "暂无选中文本";
  document.getElementById("translation").textContent = state.translation || "";

  const languageLabel = LANGUAGE_LABELS[state.targetLanguage] || "译文";
  const statusSuffix = state.status === "loading" ? "（翻译中）" : state.status === "error" ? "（失败）" : "";
  document.getElementById("translation-title").textContent = `${languageLabel}${statusSuffix}`;
}

function storageLocalGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
