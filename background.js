const DEFAULT_TARGET_LANGUAGE = "zh-CN";
const DEFAULT_ACTION_TITLE = "DeepSeek Translator";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const REQUEST_TIMEOUT_MS = 45000;
const MAX_BATCH_BLOCKS = 8;
const MAX_BATCH_CHARS = 4500;
const TRANSLATION_BATCH_CONCURRENCY = 4;
const TRANSLATION_CACHE_LIMIT = 1500;
const DEEPSEEK_CONTENT_RISK_MESSAGE = "DeepSeek 拒绝了该段内容，已跳过";

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

const translationCache = new Map();

chrome.runtime.onInstalled.addListener(() => {
  initializeExtension().catch((error) => {
    console.error("初始化扩展失败：", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus().catch((error) => {
    console.error("创建右键菜单失败：", error);
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleContextMenuClick(info, tab).catch((error) => {
    console.error("右键菜单处理失败：", error);
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleRuntimeMessage(request, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error("消息处理失败：", error);
      sendResponse({ success: false, error: toUserMessage(error) });
    });

  return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && changes.targetLanguage) {
    updateLanguageMenuChecks(changes.targetLanguage.newValue || DEFAULT_TARGET_LANGUAGE);
  }

  if (areaName === "sync" && changes.autoSourceLanguages) {
    updateSourceLanguageMenuChecks(normalizeSourceLanguages(changes.autoSourceLanguages.newValue));
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    clearTranslatedBadge(tabId);
  }
});

async function initializeExtension() {
  await migrateApiKeyToLocalStorage();
  await createContextMenus();
}

async function migrateApiKeyToLocalStorage() {
  const localData = await storageLocalGet(["apiKey", "apiKeyMigrated"]);
  if (localData.apiKey || localData.apiKeyMigrated) {
    return;
  }

  const syncData = await storageSyncGet(["apiKey"]);
  if (syncData.apiKey) {
    await storageLocalSet({
      apiKey: syncData.apiKey,
      apiKeyMigrated: true
    });
  } else {
    await storageLocalSet({ apiKeyMigrated: true });
  }
}

async function createContextMenus() {
  await contextMenusRemoveAll();
  const { targetLanguage = DEFAULT_TARGET_LANGUAGE } = await storageSyncGet({
    targetLanguage: DEFAULT_TARGET_LANGUAGE
  });
  const { autoSourceLanguages = [] } = await storageSyncGet({ autoSourceLanguages: [] });
  const enabledSourceLanguages = normalizeSourceLanguages(autoSourceLanguages);

  await contextMenusCreate({
    id: "translateText",
    title: "DeepSeek 翻译选中文本",
    contexts: ["selection"]
  });

  await contextMenusCreate({
    id: "translatePage",
    title: "翻译当前页",
    contexts: ["page"]
  });

  await contextMenusCreate({
    id: "restorePage",
    title: "恢复当前页原文",
    contexts: ["page"]
  });

  await contextMenusCreate({
    id: "targetLanguageRoot",
    title: "目标语言",
    contexts: ["all"]
  });

  for (const language of LANGUAGES) {
    await contextMenusCreate({
      id: `language:${language.id}`,
      parentId: "targetLanguageRoot",
      title: language.label,
      contexts: ["all"],
      type: "radio",
      checked: language.id === targetLanguage
    });
  }

  await contextMenusCreate({
    id: "sourceLanguageRoot",
    title: "自动翻译原文语言",
    contexts: ["all"]
  });

  for (const language of SOURCE_LANGUAGES) {
    await contextMenusCreate({
      id: `sourceLanguage:${language.id}`,
      parentId: "sourceLanguageRoot",
      title: language.label,
      contexts: ["all"],
      type: "checkbox",
      checked: enabledSourceLanguages.includes(language.id)
    });
  }
}

async function handleContextMenuClick(info, tab) {
  if (info.menuItemId.startsWith("language:")) {
    const targetLanguage = info.menuItemId.replace("language:", "");
    await setTargetLanguage(targetLanguage);

    if (tab?.id && isSupportedTabUrl(tab.url)) {
      await sendMessageToTab(tab, {
        action: "translatePage",
        targetLanguage,
        forceRetranslate: true
      });
    }
    return;
  }

  if (info.menuItemId.startsWith("sourceLanguage:")) {
    const languageId = info.menuItemId.replace("sourceLanguage:", "");
    const enabled = Boolean(info.checked);
    await setAutoSourceLanguage(languageId, enabled);
    if (tab?.id && isSupportedTabUrl(tab.url)) {
      await applyAutoSourceRulesToTab(tab);
    }
    return;
  }

  if (info.menuItemId === "translateText" && info.selectionText) {
    await translateSelection(info.selectionText, tab);
    return;
  }

  if (info.menuItemId === "translatePage" && tab?.id) {
    const targetLanguage = await getTargetLanguage();
    await sendMessageToTab(tab, {
      action: "translatePage",
      targetLanguage,
      forceRetranslate: true
    });
    return;
  }

  if (info.menuItemId === "restorePage" && tab?.id) {
    await sendMessageToTab(tab, { action: "restorePage" });
  }
}

async function handleRuntimeMessage(request, sender) {
  if (!request || typeof request.action !== "string") {
    return { success: false, error: "无效请求" };
  }

  if (request.action === "translateBatch") {
    const targetLanguage = request.targetLanguage || await getTargetLanguage();
    const translations = await translateBatch(request.blocks || [], targetLanguage);
    return { success: true, translations, targetLanguage };
  }

  if (request.action === "translateText") {
    const targetLanguage = request.targetLanguage || await getTargetLanguage();
    const translation = await translateText(request.text || "", targetLanguage);
    return { success: true, translation, targetLanguage };
  }

  if (request.action === "getLanguages") {
    return {
      success: true,
      languages: LANGUAGES,
      sourceLanguages: SOURCE_LANGUAGES,
      targetLanguage: await getTargetLanguage()
    };
  }

  if (request.action === "setPageTranslatedBadge") {
    if (sender?.tab?.id) {
      await setTranslatedBadge(sender.tab.id, Boolean(request.translated));
    }
    return { success: true };
  }

  return { success: false, error: `未知请求：${request.action}` };
}

async function translateSelection(text, tab) {
  const targetLanguage = await getTargetLanguage();

  if (tab?.id && chrome.sidePanel?.open) {
    await sidePanelOpen(tab.id);
  }

  await saveSidebarState({
    sourceText: text,
    translation: "正在翻译...",
    targetLanguage,
    status: "loading",
    updatedAt: Date.now()
  });

  try {
    const translation = await translateText(text, targetLanguage);
    await saveSidebarState({
      sourceText: text,
      translation,
      targetLanguage,
      status: "done",
      updatedAt: Date.now()
    });
  } catch (error) {
    await saveSidebarState({
      sourceText: text,
      translation: toUserMessage(error),
      targetLanguage,
      status: "error",
      updatedAt: Date.now()
    });
  }
}

async function saveSidebarState(state) {
  await storageLocalSet({ lastSelectionTranslation: state });
  chrome.runtime.sendMessage({
    action: "showTranslation",
    ...state
  }, () => {
    // The side panel may not be loaded yet. It also reads the saved state.
    void chrome.runtime.lastError;
  });
}

async function translateBatch(blocks, targetLanguage) {
  const normalizedBlocks = normalizeBlocks(blocks);
  if (!normalizedBlocks.length) {
    return [];
  }

  const cachedTranslations = [];
  const missingBlocks = [];
  for (const block of normalizedBlocks) {
    const cachedTranslation = getCachedTranslation(block.text, targetLanguage);
    if (cachedTranslation) {
      cachedTranslations.push({
        id: block.id,
        translation: cachedTranslation
      });
    } else {
      missingBlocks.push(block);
    }
  }

  if (!missingBlocks.length) {
    return cachedTranslations;
  }

  const apiKey = await getApiKey();
  const chunks = splitBlocksIntoChunks(missingBlocks);
  const chunkResults = await mapWithConcurrency(chunks, TRANSLATION_BATCH_CONCURRENCY, (chunk) => {
    return translateBatchChunk(apiKey, chunk, targetLanguage);
  });
  const newTranslations = chunkResults.flat();

  for (const item of newTranslations) {
    const block = missingBlocks.find((candidate) => candidate.id === item.id);
    if (block && item.translation) {
      setCachedTranslation(block.text, targetLanguage, item.translation);
    }
  }

  const translationMap = new Map();
  for (const item of cachedTranslations.concat(newTranslations)) {
    if (item?.id && item.translation) {
      translationMap.set(item.id, item.translation);
    }
  }

  return normalizedBlocks
    .filter((block) => translationMap.has(block.id))
    .map((block) => ({
      id: block.id,
      translation: translationMap.get(block.id)
    }));
}

async function translateBatchChunk(apiKey, blocks, targetLanguage) {
  const languageLabel = getLanguageLabel(targetLanguage);
  const prompt = [
    `你是网页双语翻译引擎。请把输入 JSON 数组中每一项的 text 翻译成${languageLabel}。`,
    "要求：",
    "1. 必须保留每一项的 id。",
    "2. 只输出 JSON 数组，不要输出 Markdown、解释或额外文字。",
    "3. 输出格式必须是 [{\"id\":\"...\",\"translation\":\"...\"}]。",
    "4. 保留原文中的专有名词、代码片段、URL 和数字。",
    "",
    "输入 JSON：",
    JSON.stringify(blocks.map(({ id, text }) => ({ id, text })))
  ].join("\n");

  let content = "";
  try {
    content = await callDeepSeek(apiKey, prompt, 6000);
  } catch (error) {
    if (isDeepSeekContentRiskError(error)) {
      console.warn(`DeepSeek 风控拒绝了 ${blocks.length} 段内容，已跳过该批次。`);
      return [];
    }
    throw error;
  }

  try {
    const parsed = parseJsonArray(content);
    const translationMap = new Map();
    for (const item of parsed) {
      if (item && typeof item.id === "string" && typeof item.translation === "string") {
        translationMap.set(item.id, item.translation.trim());
      }
    }

    const missing = blocks.filter((block) => !translationMap.get(block.id));
    if (missing.length === 0) {
      return blocks.map((block) => ({
        id: block.id,
        translation: translationMap.get(block.id)
      }));
    }
  } catch (error) {
    console.warn("批量 JSON 解析失败，降级为逐段翻译：", error);
  }

  return translateBlocksIndividually(apiKey, blocks, targetLanguage);
}

async function translateBlocksIndividually(apiKey, blocks, targetLanguage) {
  const fallbackTranslations = [];
  for (const block of blocks) {
    fallbackTranslations.push({
      id: block.id,
      translation: await translateTextWithApiKey(apiKey, block.text, targetLanguage)
    });
  }
  return fallbackTranslations;
}

async function translateText(text, targetLanguage) {
  const apiKey = await getApiKey();
  return translateTextWithApiKey(apiKey, text, targetLanguage);
}

async function translateTextWithApiKey(apiKey, text, targetLanguage) {
  const trimmedText = String(text || "").trim();
  if (!trimmedText) {
    throw new Error("没有可翻译的文本");
  }

  const languageLabel = getLanguageLabel(targetLanguage);
  const prompt = [
    `请将以下内容翻译成${languageLabel}。`,
    "只输出译文，不要输出解释。",
    "",
    trimmedText
  ].join("\n");

  return callDeepSeek(apiKey, prompt, Math.min(4000, Math.max(1000, trimmedText.length * 2)));
}

async function callDeepSeek(apiKey, prompt, maxTokens) {
  if (!apiKey) {
    throw new Error("API Key 未设置");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: maxTokens
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw makeDeepSeekHttpError(response.status, bodyText);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("DeepSeek 返回空结果");
    }
    return content;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("DeepSeek 请求超时");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function makeDeepSeekHttpError(status, bodyText) {
  const message = `DeepSeek 请求失败：HTTP ${status}${bodyText ? ` ${bodyText.slice(0, 180)}` : ""}`;
  const error = new Error(message);
  error.status = status;
  error.bodyText = bodyText || "";
  if (isDeepSeekContentRiskResponse(status, bodyText)) {
    error.name = "DeepSeekContentRiskError";
  }
  return error;
}

function isDeepSeekContentRiskResponse(status, bodyText) {
  const text = String(bodyText || "");
  return status === 400 &&
    (text.includes("Content Exists Risk") || text.includes("invalid_request_error"));
}

function isDeepSeekContentRiskError(error) {
  return error?.name === "DeepSeekContentRiskError" ||
    isDeepSeekContentRiskResponse(error?.status, error?.bodyText || error?.message);
}

function normalizeBlocks(blocks) {
  return blocks
    .filter((block) => block && typeof block.id === "string" && typeof block.text === "string")
    .map((block) => ({
      id: block.id,
      text: block.text.trim()
    }))
    .filter((block) => block.text.length > 0);
}

function splitBlocksIntoChunks(blocks) {
  const chunks = [];
  let currentChunk = [];
  let currentChars = 0;

  for (const block of blocks) {
    const blockLength = block.text.length;
    const shouldFlush = currentChunk.length >= MAX_BATCH_BLOCKS ||
      (currentChunk.length > 0 && currentChars + blockLength > MAX_BATCH_CHARS);

    if (shouldFlush) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentChars = 0;
    }

    currentChunk.push(block);
    currentChars += blockLength;
  }

  if (currentChunk.length) {
    chunks.push(currentChunk);
  }

  return chunks;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

function getCachedTranslation(text, targetLanguage) {
  const key = makeTranslationCacheKey(text, targetLanguage);
  const cached = translationCache.get(key);
  if (!cached) {
    return "";
  }

  translationCache.delete(key);
  translationCache.set(key, cached);
  return cached;
}

function setCachedTranslation(text, targetLanguage, translation) {
  const key = makeTranslationCacheKey(text, targetLanguage);
  translationCache.set(key, translation);

  while (translationCache.size > TRANSLATION_CACHE_LIMIT) {
    const oldestKey = translationCache.keys().next().value;
    translationCache.delete(oldestKey);
  }
}

function makeTranslationCacheKey(text, targetLanguage) {
  return `${targetLanguage}\u0000${String(text || "").trim()}`;
}

function parseJsonArray(content) {
  const cleaned = content
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("没有找到 JSON 数组");
  }

  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed)) {
    throw new Error("返回内容不是 JSON 数组");
  }
  return parsed;
}

async function getApiKey() {
  const { apiKey } = await storageLocalGet(["apiKey"]);
  if (apiKey) {
    return apiKey;
  }

  const syncData = await storageSyncGet(["apiKey"]);
  if (syncData.apiKey) {
    await storageLocalSet({ apiKey: syncData.apiKey, apiKeyMigrated: true });
    return syncData.apiKey;
  }

  throw new Error("API Key 未设置");
}

async function getTargetLanguage() {
  const { targetLanguage = DEFAULT_TARGET_LANGUAGE } = await storageSyncGet({
    targetLanguage: DEFAULT_TARGET_LANGUAGE
  });
  return isKnownLanguage(targetLanguage) ? targetLanguage : DEFAULT_TARGET_LANGUAGE;
}

async function setTargetLanguage(targetLanguage) {
  const safeLanguage = isKnownLanguage(targetLanguage) ? targetLanguage : DEFAULT_TARGET_LANGUAGE;
  await storageSyncSet({ targetLanguage: safeLanguage });
  await updateLanguageMenuChecks(safeLanguage);
}

async function setAutoSourceLanguage(languageId, enabled) {
  if (!isKnownSourceLanguage(languageId)) {
    return;
  }

  const { autoSourceLanguages = [] } = await storageSyncGet({ autoSourceLanguages: [] });
  const nextLanguages = new Set(normalizeSourceLanguages(autoSourceLanguages));
  if (enabled) {
    nextLanguages.add(languageId);
  } else {
    nextLanguages.delete(languageId);
  }

  const nextValue = Array.from(nextLanguages);
  await storageSyncSet({ autoSourceLanguages: nextValue });
  await updateSourceLanguageMenuChecks(nextValue);
}

async function applyAutoSourceRulesToTab(tab) {
  const pageState = await sendMessageToTab(tab, { action: "getPageState" });
  if (!pageState?.success) {
    return;
  }

  if (pageState.autoTranslateBySource) {
    await sendMessageToTab(tab, {
      action: "translatePage",
      targetLanguage: pageState.targetLanguage || await getTargetLanguage(),
      forceRetranslate: true
    });
    return;
  }

  if (pageState.translatedCount > 0 && !pageState.siteAutoTranslate) {
    await sendMessageToTab(tab, { action: "restorePage" });
  }
}

function getLanguageLabel(targetLanguage) {
  return LANGUAGES.find((language) => language.id === targetLanguage)?.label || "简体中文";
}

function isKnownLanguage(targetLanguage) {
  return LANGUAGES.some((language) => language.id === targetLanguage);
}

function isKnownSourceLanguage(languageId) {
  return SOURCE_LANGUAGES.some((language) => language.id === languageId);
}

function normalizeSourceLanguages(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(value.filter(isKnownSourceLanguage)));
}

async function updateLanguageMenuChecks(targetLanguage) {
  for (const language of LANGUAGES) {
    await contextMenusUpdate(`language:${language.id}`, {
      checked: language.id === targetLanguage
    });
  }
}

async function updateSourceLanguageMenuChecks(autoSourceLanguages) {
  const enabledLanguages = normalizeSourceLanguages(autoSourceLanguages);
  for (const language of SOURCE_LANGUAGES) {
    await contextMenusUpdate(`sourceLanguage:${language.id}`, {
      checked: enabledLanguages.includes(language.id)
    });
  }
}

async function setTranslatedBadge(tabId, translated) {
  if (!tabId) {
    return;
  }

  if (translated) {
    await actionSetBadgeText(tabId, "●");
    await actionSetBadgeBackgroundColor(tabId, "#d93025");
    await actionSetTitle(tabId, `${DEFAULT_ACTION_TITLE} - 当前页已翻译`);
    return;
  }

  await clearTranslatedBadge(tabId);
}

async function clearTranslatedBadge(tabId) {
  if (!tabId) {
    return;
  }

  await actionSetBadgeText(tabId, "");
  await actionSetTitle(tabId, DEFAULT_ACTION_TITLE);
}

async function sendMessageToTab(tab, message) {
  if (!tab?.id) {
    return { success: false, error: "没有可用标签页" };
  }

  if (!isSupportedTabUrl(tab.url)) {
    return { success: false, error: "当前页面不支持内容脚本" };
  }

  try {
    return await tabsSendMessage(tab.id, message);
  } catch (firstError) {
    try {
      await scriptingExecuteScript(tab.id, "content.js");
      return await tabsSendMessage(tab.id, message);
    } catch (secondError) {
      console.warn("发送标签页消息失败：", firstError, secondError);
      return { success: false, error: toUserMessage(secondError) };
    }
  }
}

function isSupportedTabUrl(url) {
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

function toUserMessage(error) {
  if (!error) {
    return "未知错误";
  }
  if (isDeepSeekContentRiskError(error)) {
    return DEEPSEEK_CONTENT_RISK_MESSAGE;
  }
  if (typeof error === "string") {
    return error;
  }
  return error.message || "未知错误";
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

function contextMenusRemoveAll() {
  return new Promise((resolve) => chrome.contextMenus.removeAll(resolve));
}

function contextMenusCreate(properties) {
  return new Promise((resolve) => {
    chrome.contextMenus.create(properties, () => {
      if (chrome.runtime.lastError) {
        console.warn("创建右键菜单项失败：", properties.id, chrome.runtime.lastError.message);
      }
      resolve();
    });
  });
}

function contextMenusUpdate(id, properties) {
  return new Promise((resolve) => {
    chrome.contextMenus.update(id, properties, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function actionSetBadgeText(tabId, text) {
  return new Promise((resolve) => {
    chrome.action.setBadgeText({ tabId, text }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function actionSetBadgeBackgroundColor(tabId, color) {
  return new Promise((resolve) => {
    chrome.action.setBadgeBackgroundColor({ tabId, color }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function actionSetTitle(tabId, title) {
  return new Promise((resolve) => {
    chrome.action.setTitle({ tabId, title }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
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

function sidePanelOpen(tabId) {
  return Promise.resolve(chrome.sidePanel.open({ tabId })).catch(() => undefined);
}
