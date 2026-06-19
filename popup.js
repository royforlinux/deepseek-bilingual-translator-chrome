const DEFAULT_TARGET_LANGUAGE = "zh-CN";

const LANGUAGES = [
  { id: "zh-CN", label: "简体中文" },
  { id: "zh-TW", label: "繁体中文" },
  { id: "en", label: "英文" },
  { id: "ja", label: "日文" },
  { id: "ko", label: "韩文" },
  { id: "fr", label: "法文" },
  { id: "de", label: "德文" },
  { id: "es", label: "西班牙文" },
  { id: "ru", label: "俄文" }
];

const SOURCE_LANGUAGES = [
  { id: "en", label: "英文" },
  { id: "ja", label: "日文" },
  { id: "ko", label: "韩文" },
  { id: "fr", label: "法文" },
  { id: "de", label: "德文" },
  { id: "es", label: "西班牙文" },
  { id: "ru", label: "俄文" },
  { id: "zh", label: "中文" }
];

let activeTab = null;
let activeSiteKey = null;
let activeSiteLabel = null;

document.addEventListener("DOMContentLoaded", async () => {
  fillLanguageOptions();
  fillSourceLanguageOptions();
  bindEvents();
  await loadActiveTab();
  await loadSettings();
});

function bindEvents() {
  document.getElementById("save-key").addEventListener("click", saveApiKey);
  document.getElementById("target-language").addEventListener("change", changeTargetLanguage);
  document.getElementById("source-language-list").addEventListener("change", changeAutoSourceLanguages);
  document.getElementById("auto-translate").addEventListener("change", changeAutoTranslate);
  document.getElementById("translate-page").addEventListener("click", translateCurrentPage);
  document.getElementById("restore-page").addEventListener("click", restoreCurrentPage);
}

function fillLanguageOptions() {
  const select = document.getElementById("target-language");
  for (const language of LANGUAGES) {
    const option = document.createElement("option");
    option.value = language.id;
    option.textContent = language.label;
    select.appendChild(option);
  }
}

function fillSourceLanguageOptions() {
  const container = document.getElementById("source-language-list");
  for (const language of SOURCE_LANGUAGES) {
    const label = document.createElement("label");
    label.className = "checkbox-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "auto-source-language";
    checkbox.value = language.id;

    const text = document.createElement("span");
    text.textContent = language.label;

    label.appendChild(checkbox);
    label.appendChild(text);
    container.appendChild(label);
  }
}

async function loadActiveTab() {
  const tabs = await tabsQuery({ active: true, currentWindow: true });
  activeTab = tabs[0] || null;

  if (!activeTab || !isSupportedUrl(activeTab.url)) {
    activeSiteKey = null;
    activeSiteLabel = "当前页面不支持";
    document.getElementById("current-site").textContent = activeSiteLabel;
    setPageControlsEnabled(false);
    return;
  }

  const url = new URL(activeTab.url);
  activeSiteKey = getSiteKey(url);
  activeSiteLabel = url.hostname || "本地文件";
  document.getElementById("current-site").textContent = activeSiteLabel;
  setPageControlsEnabled(true);
}

async function loadSettings() {
  const localData = await storageLocalGet(["apiKey"]);
  let apiKey = localData.apiKey || "";

  if (!apiKey) {
    const syncData = await storageSyncGet(["apiKey"]);
    if (syncData.apiKey) {
      apiKey = syncData.apiKey;
      await storageLocalSet({ apiKey, apiKeyMigrated: true });
    }
  }

  document.getElementById("api-key").value = apiKey;

  const syncData = await storageSyncGet({
    targetLanguage: DEFAULT_TARGET_LANGUAGE,
    siteRules: {},
    autoSourceLanguages: []
  });

  document.getElementById("target-language").value = syncData.targetLanguage || DEFAULT_TARGET_LANGUAGE;
  setAutoSourceLanguageControls(syncData.autoSourceLanguages || []);

  const siteRule = activeSiteKey ? syncData.siteRules?.[activeSiteKey] : null;
  document.getElementById("auto-translate").checked = Boolean(siteRule?.autoTranslate);
  await refreshPageState();
}

async function saveApiKey() {
  const apiKey = document.getElementById("api-key").value.trim();
  if (!apiKey) {
    setStatus("API Key 不能为空", "error");
    return;
  }

  await storageLocalSet({ apiKey, apiKeyMigrated: true });
  await storageSyncRemove("apiKey");
  setStatus("API Key 已保存", "ok");
}

async function changeTargetLanguage() {
  const targetLanguage = document.getElementById("target-language").value;
  await storageSyncSet({ targetLanguage });

  if (activeTab && activeSiteKey) {
    setStatus("正在按新语言重新翻译...", "loading");
    const response = await sendPageCommand({
      action: "translatePage",
      targetLanguage,
      forceRetranslate: true
    });
    showCommandResult(response, "目标语言已更新");
  } else {
    setStatus("目标语言已更新", "ok");
  }
}

async function changeAutoSourceLanguages(event) {
  if (event.target?.name !== "auto-source-language") {
    return;
  }

  const autoSourceLanguages = getSelectedAutoSourceLanguages();
  await storageSyncSet({ autoSourceLanguages });

  if (!activeTab || !activeSiteKey) {
    setStatus("原文语言规则已更新", "ok");
    return;
  }

  const pageState = await getCurrentPageState();
  updateDetectedLanguageLabel(pageState);

  const targetLanguage = document.getElementById("target-language").value;
  const detectedLanguage = pageState?.detectedSourceLanguage;
  const shouldTranslate = autoSourceLanguages.includes(detectedLanguage) &&
    !isSameLanguage(detectedLanguage, targetLanguage);

  if (shouldTranslate) {
    setStatus("当前页符合原文语言规则，正在翻译...", "loading");
    const response = await sendPageCommand({
      action: "translatePage",
      targetLanguage,
      forceRetranslate: true
    });
    showCommandResult(response, "原文语言规则已更新");
    return;
  }

  if (pageState?.translatedCount > 0 && !pageState?.siteAutoTranslate) {
    const response = await sendPageCommand({ action: "restorePage" });
    showCommandResult(response, "原文语言规则已更新");
    return;
  }

  setStatus("原文语言规则已更新", "ok");
}

async function changeAutoTranslate() {
  if (!activeSiteKey) {
    setStatus("当前页面不支持本站规则", "error");
    return;
  }

  const enabled = document.getElementById("auto-translate").checked;
  const { siteRules = {} } = await storageSyncGet({ siteRules: {} });
  const nextRules = {
    ...siteRules,
    [activeSiteKey]: {
      ...(siteRules[activeSiteKey] || {}),
      autoTranslate: enabled
    }
  };

  await storageSyncSet({ siteRules: nextRules });

  if (enabled) {
    const targetLanguage = document.getElementById("target-language").value;
    setStatus("正在翻译本站页面...", "loading");
    const response = await sendPageCommand({
      action: "translatePage",
      targetLanguage,
      forceRetranslate: true
    });
    showCommandResult(response, "本站自动翻译已开启");
  } else {
    const response = await sendPageCommand({ action: "restorePage" });
    showCommandResult(response, "本站自动翻译已关闭");
  }
}

async function translateCurrentPage() {
  const targetLanguage = document.getElementById("target-language").value;
  setStatus("正在翻译当前页...", "loading");
  const response = await sendPageCommand({
    action: "translatePage",
    targetLanguage,
    forceRetranslate: true
  });
  showCommandResult(response, "当前页已翻译");
}

async function restoreCurrentPage() {
  setStatus("正在恢复原文...", "loading");
  const response = await sendPageCommand({ action: "restorePage" });
  showCommandResult(response, "已恢复原文");
}

async function sendPageCommand(message) {
  if (!activeTab?.id || !isSupportedUrl(activeTab.url)) {
    return { success: false, error: "当前页面不支持内容脚本" };
  }

  try {
    return await tabsSendMessage(activeTab.id, message);
  } catch {
    try {
      await scriptingExecuteScript(activeTab.id, "content.js");
      return await tabsSendMessage(activeTab.id, message);
    } catch (error) {
      return { success: false, error: error.message || "无法连接当前页面" };
    }
  }
}

function showCommandResult(response, successMessage) {
  if (response?.success) {
    const countText = typeof response.count === "number" ? `，${response.count} 段` : "";
    const truncatedText = response.truncated ? "，页面较长已截断" : "";
    setStatus(`${successMessage}${countText}${truncatedText}`, "ok");
    return;
  }

  setStatus(response?.error || "操作失败", "error");
}

function setPageControlsEnabled(enabled) {
  for (const id of ["auto-translate", "translate-page", "restore-page"]) {
    document.getElementById(id).disabled = !enabled;
  }
}

async function refreshPageState() {
  if (!activeTab || !activeSiteKey) {
    updateDetectedLanguageLabel(null);
    return;
  }

  const pageState = await getCurrentPageState();
  updateDetectedLanguageLabel(pageState);
  if (pageState?.success) {
    document.getElementById("auto-translate").checked = Boolean(pageState.siteAutoTranslate);
  }
}

async function getCurrentPageState() {
  const response = await sendPageCommand({ action: "getPageState" });
  return response?.success ? response : null;
}

function setAutoSourceLanguageControls(autoSourceLanguages) {
  const selected = new Set(normalizeSourceLanguages(autoSourceLanguages));
  document.querySelectorAll("input[name='auto-source-language']").forEach((checkbox) => {
    checkbox.checked = selected.has(checkbox.value);
  });
}

function getSelectedAutoSourceLanguages() {
  return Array.from(document.querySelectorAll("input[name='auto-source-language']:checked"))
    .map((checkbox) => checkbox.value)
    .filter(isKnownSourceLanguage);
}

function normalizeSourceLanguages(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(value.filter(isKnownSourceLanguage)));
}

function isKnownSourceLanguage(languageId) {
  return SOURCE_LANGUAGES.some((language) => language.id === languageId);
}

function updateDetectedLanguageLabel(pageState) {
  const element = document.getElementById("detected-language");
  if (!activeSiteKey) {
    element.textContent = "当前页：不支持";
    return;
  }

  const language = pageState?.detectedSourceLanguage || "unknown";
  element.textContent = `当前页：${getSourceLanguageLabel(language)}`;
}

function getSourceLanguageLabel(languageId) {
  if (languageId === "unknown") {
    return "未知";
  }
  return SOURCE_LANGUAGES.find((language) => language.id === languageId)?.label || languageId;
}

function isSameLanguage(sourceLanguage, targetLanguage) {
  if (!sourceLanguage || !targetLanguage) {
    return false;
  }

  if (sourceLanguage === "zh") {
    return targetLanguage === "zh-CN" || targetLanguage === "zh-TW" || targetLanguage === "zh";
  }

  return targetLanguage.toLowerCase().startsWith(sourceLanguage.toLowerCase());
}

function setStatus(message, type = "") {
  const status = document.getElementById("status");
  status.textContent = message;
  status.className = `status ${type}`.trim();
}

function getSiteKey(url) {
  if (url.protocol === "file:") {
    return "file://local";
  }
  return url.hostname;
}

function isSupportedUrl(url) {
  if (!url) {
    return false;
  }

  try {
    const parsedUrl = new URL(url);
    return ["http:", "https:", "file:"].includes(parsedUrl.protocol);
  } catch {
    return false;
  }
}

function storageLocalGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageLocalSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function storageSyncGet(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
}

function storageSyncSet(values) {
  return new Promise((resolve) => chrome.storage.sync.set(values, resolve));
}

function storageSyncRemove(key) {
  return new Promise((resolve) => chrome.storage.sync.remove(key, resolve));
}

function tabsQuery(queryInfo) {
  return new Promise((resolve) => chrome.tabs.query(queryInfo, resolve));
}

function tabsSendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function scriptingExecuteScript(tabId, file) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, files: [file] }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}
