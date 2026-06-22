(() => {
  const CONTENT_SCRIPT_VERSION = "1.3.2";
  if (window.__mlawDeepSeekTranslatorLoaded === CONTENT_SCRIPT_VERSION) {
    return;
  }
  window.__mlawDeepSeekTranslatorLoaded = CONTENT_SCRIPT_VERSION;

  const DEFAULT_TARGET_LANGUAGE = "zh-CN";
  const SUPPORTED_SOURCE_LANGUAGES = ["zh", "en", "ja", "ko", "fr", "de", "es", "ru"];
  const MAX_BLOCKS = 200;
  const MAX_CHARS = 30000;
  const PAGE_BATCH_BLOCKS = 18;
  const PAGE_BATCH_CHARS = 4200;
  const PAGE_TRANSLATE_CONCURRENCY = 4;
  const SOURCE_ID_ATTR = "data-mlaw-source-id";
  const TRANSLATED_ATTR = "data-mlaw-translated";
  const TRANSLATED_CLASS = "mlaw-translated-block";
  const NOTICE_ID = "mlaw-translate-notice";
  const STYLE_ID = "mlaw-translate-style";
  const YOUTUBE_CAPTION_OVERLAY_ID = "mlaw-youtube-caption-overlay";
  const YOUTUBE_CAPTION_DEBOUNCE_MS = 350;
  const DEFAULT_YOUTUBE_CAPTION_POSITION = { x: 50, y: 82 };
  const EXTENSION_CONTEXT_INVALIDATED_MESSAGE = "扩展已重新加载，请刷新当前页面后再试";
  const BASIC_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, figcaption, td, th";
  const CANDIDATE_SELECTOR = `${BASIC_SELECTOR}, article, section`;
  const YOUTUBE_TEXT_SELECTOR = [
    "ytd-watch-metadata #title h1",
    "ytd-watch-metadata #description-inline-expander yt-attributed-string",
    "ytd-watch-metadata ytd-text-inline-expander yt-attributed-string",
    "ytd-comment-thread-renderer #content-text",
    "ytd-comment-view-model #content-text"
  ].join(",");
  const YOUTUBE_DYNAMIC_SELECTOR = [
    "ytd-watch-metadata",
    "ytd-comments",
    "ytd-comment-thread-renderer",
    "ytd-comment-view-model"
  ].join(",");
  const YOUTUBE_CAPTION_SELECTOR = [
    ".ytp-caption-segment",
    ".ytp-caption-window-container",
    ".caption-window"
  ].join(",");
  const EXCLUDED_SELECTOR = [
    "script",
    "style",
    "noscript",
    "template",
    "code",
    "pre",
    "kbd",
    "samp",
    "textarea",
    "input",
    "button",
    "select",
    "option",
    "svg",
    "canvas",
    "video",
    "audio",
    "nav",
    "header",
    "footer",
    "aside",
    "menu",
    "[contenteditable='true']",
    "[role='button']",
    "[role='navigation']",
    "[role='banner']",
    "[role='contentinfo']",
    "[aria-hidden='true']",
    `.${TRANSLATED_CLASS}`,
    `#${NOTICE_ID}`,
    `#${YOUTUBE_CAPTION_OVERLAY_ID}`
  ].join(",");
  const CONTENT_ROOT_SELECTOR = [
    "main",
    "article",
    "[role='main']",
    "shreddit-post",
    "shreddit-comment",
    ".article",
    ".post",
    ".entry-content",
    ".post-content",
    ".article-content",
    ".markdown-body"
  ].join(",");

  const state = {
    autoTranslate: false,
    autoTranslateBySource: false,
    siteAutoTranslate: false,
    autoSourceLanguages: [],
    detectedSourceLanguage: "unknown",
    targetLanguage: DEFAULT_TARGET_LANGUAGE,
    translating: false,
    hasTranslated: false,
    observer: null,
    observerTimer: null,
    youtubeCaptionsEnabled: false,
    youtubeCaptionObserver: null,
    youtubeCaptionTimer: null,
    youtubeCaptionLastText: "",
    youtubeCaptionLastTranslation: "",
    youtubeCaptionRequestId: 0,
    youtubeCaptionHasTranslated: false,
    youtubeCaptionLastErrorAt: 0,
    youtubeCaptionPosition: { ...DEFAULT_YOUTUBE_CAPTION_POSITION },
    lastUrl: location.href,
    extensionContextInvalidated: false
  };

  if (isExtensionContextAvailable()) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      handleMessage(request)
        .then((response) => sendResponse(response))
        .catch((error) => {
          if (isExtensionContextInvalidatedError(error)) {
            markExtensionContextInvalidated();
            sendResponse({ success: false, error: EXTENSION_CONTEXT_INVALIDATED_MESSAGE });
            return;
          }

          console.error("页面翻译处理失败：", error);
          showNotice(error.message || "页面翻译失败", "error", 5000);
          sendResponse({ success: false, error: error.message || "页面翻译失败" });
        });

      return true;
    });
  }

  init().catch((error) => {
    if (isExtensionContextInvalidatedError(error)) {
      markExtensionContextInvalidated();
      return;
    }
    console.error("页面翻译初始化失败：", error);
  });

  async function init() {
    injectStyles();
    startObserver();
    await loadSettings();
    syncYouTubeCaptionTranslation();

    if (state.autoTranslate) {
      setTimeout(() => {
        translatePage({
          targetLanguage: state.targetLanguage,
          forceRetranslate: true
        }).catch((error) => {
          if (isExtensionContextInvalidatedError(error)) {
            markExtensionContextInvalidated();
            return;
          }
          console.error("自动翻译失败：", error);
          showNotice(error.message || "自动翻译失败", "error", 5000);
        });
      }, 350);
    }
  }

  async function loadSettings() {
    const data = await storageSyncGet({
      targetLanguage: DEFAULT_TARGET_LANGUAGE,
      siteRules: {},
      autoSourceLanguages: [],
      youtubeCaptionsEnabled: false,
      youtubeCaptionPosition: DEFAULT_YOUTUBE_CAPTION_POSITION
    });

    const siteKey = getSiteKey();
    state.targetLanguage = data.targetLanguage || DEFAULT_TARGET_LANGUAGE;
    state.siteAutoTranslate = Boolean(data.siteRules?.[siteKey]?.autoTranslate);
    state.autoSourceLanguages = normalizeAutoSourceLanguages(data.autoSourceLanguages);
    state.detectedSourceLanguage = detectPageLanguage();
    state.autoTranslateBySource = shouldAutoTranslateSourceLanguage(
      state.detectedSourceLanguage,
      state.autoSourceLanguages,
      state.targetLanguage
    );
    state.autoTranslate = state.siteAutoTranslate || state.autoTranslateBySource;
    state.youtubeCaptionsEnabled = Boolean(data.youtubeCaptionsEnabled);
    state.youtubeCaptionPosition = normalizeYouTubeCaptionPosition(data.youtubeCaptionPosition);
  }

  async function handleMessage(request) {
    if (!request || typeof request.action !== "string") {
      return { success: false, error: "无效请求" };
    }

    if (request.action === "translatePage") {
      return translatePage({
        targetLanguage: request.targetLanguage || state.targetLanguage,
        forceRetranslate: Boolean(request.forceRetranslate),
        incremental: Boolean(request.incremental)
      });
    }

    if (request.action === "restorePage") {
      restorePage();
      return { success: true, count: 0 };
    }

    if (request.action === "setYouTubeCaptions") {
      await loadSettings();
      state.youtubeCaptionsEnabled = Boolean(request.enabled);
      state.targetLanguage = request.targetLanguage || state.targetLanguage;
      syncYouTubeCaptionTranslation({ notify: true });
      return {
        success: true,
        enabled: state.youtubeCaptionsEnabled && isYouTubeWatchPage(),
        isYouTubeWatchPage: isYouTubeWatchPage()
      };
    }

    if (request.action === "getPageState") {
      await loadSettings();
      return {
        success: true,
        hostname: location.hostname,
        siteKey: getSiteKey(),
        autoTranslate: state.autoTranslate,
        siteAutoTranslate: state.siteAutoTranslate,
        autoTranslateBySource: state.autoTranslateBySource,
        autoSourceLanguages: state.autoSourceLanguages,
        detectedSourceLanguage: state.detectedSourceLanguage,
        targetLanguage: state.targetLanguage,
        translatedCount: getTranslatedCount(),
        isYouTubeWatchPage: isYouTubeWatchPage(),
        youtubeCaptionsEnabled: state.youtubeCaptionsEnabled,
        youtubeCaptionsActive: Boolean(state.youtubeCaptionObserver)
      };
    }

    return { success: false, error: `未知请求：${request.action}` };
  }

  async function translatePage({ targetLanguage, forceRetranslate = false, incremental = false }) {
    if (state.extensionContextInvalidated || !isExtensionContextAvailable()) {
      markExtensionContextInvalidated();
      return { success: false, error: EXTENSION_CONTEXT_INVALIDATED_MESSAGE };
    }

    if (state.translating) {
      return { success: false, error: "页面正在翻译中" };
    }

    await loadSettings();
    state.targetLanguage = targetLanguage || DEFAULT_TARGET_LANGUAGE;

    if (forceRetranslate && !incremental) {
      restorePage({ silent: true, keepYouTubeCaptionSetting: true });
    }
    syncYouTubeCaptionTranslation();

    const { blocks, truncated } = collectTextBlocks();
    if (!blocks.length) {
      syncYouTubeCaptionTranslation();
      showNotice("没有新的可翻译内容", "info", 2500);
      return { success: true, count: 0, truncated };
    }

    state.translating = true;
    showNotice(`正在翻译 ${blocks.length} 段...`, "loading");

    try {
      const { inserted } = await translateAndInsertBatches(blocks, {
        onProgress: (progress) => {
          const truncationText = truncated ? "，页面较长已截断" : "";
          showNotice(
            `正在翻译 ${blocks.length} 段，已完成 ${progress.finishedBlocks} 段，已显示 ${progress.inserted} 段${truncationText}`,
            "loading"
          );
        }
      });

      state.hasTranslated = inserted > 0 || state.hasTranslated;
      if (inserted > 0) {
        updateTranslatedBadge(true);
      }

      const truncationText = truncated ? "，页面较长已截断" : "";
      showNotice(`已翻译 ${inserted} 段${truncationText}`, "ok", 3500);
      syncYouTubeCaptionTranslation();
      return { success: true, count: inserted, truncated };
    } finally {
      state.translating = false;
    }
  }

  async function translateAndInsertBatches(blocks, { onProgress } = {}) {
    const batches = splitBlocksForRequests(blocks);
    let inserted = 0;
    let finishedBlocks = 0;

    await mapWithConcurrency(batches, PAGE_TRANSLATE_CONCURRENCY, async (batch) => {
      const response = await sendRuntimeMessage({
        action: "translateBatch",
        targetLanguage: state.targetLanguage,
        blocks: batch
      });

      if (!response?.success) {
        throw new Error(response?.error || "翻译失败");
      }

      const batchInserted = insertTranslations(batch, response.translations || []);
      inserted += batchInserted;
      finishedBlocks += batch.length;

      if (batchInserted > 0) {
        state.hasTranslated = true;
        updateTranslatedBadge(true);
      }

      if (typeof onProgress === "function") {
        onProgress({
          inserted,
          finishedBlocks
        });
      }
    });

    return { inserted };
  }

  function splitBlocksForRequests(blocks) {
    const batches = [];
    let currentBatch = [];
    let currentChars = 0;

    for (const block of blocks) {
      const blockLength = block.text.length;
      const shouldFlush = currentBatch.length >= PAGE_BATCH_BLOCKS ||
        (currentBatch.length > 0 && currentChars + blockLength > PAGE_BATCH_CHARS);

      if (shouldFlush) {
        batches.push(currentBatch);
        currentBatch = [];
        currentChars = 0;
      }

      currentBatch.push(block);
      currentChars += blockLength;
    }

    if (currentBatch.length) {
      batches.push(currentBatch);
    }

    return batches;
  }

  function collectTextBlocks() {
    const elements = getCandidateElements();
    const blocks = [];
    let totalChars = 0;
    let truncated = false;

    for (const element of elements) {
      if (!isTranslatableElement(element)) {
        continue;
      }

      const text = normalizeText(element.innerText || element.textContent || "");
      if (!isTranslatableText(text)) {
        continue;
      }

      if (blocks.length >= MAX_BLOCKS || totalChars + text.length > MAX_CHARS) {
        truncated = true;
        break;
      }

      const id = element.getAttribute(SOURCE_ID_ATTR) || makeSourceId(blocks.length);
      element.setAttribute(SOURCE_ID_ATTR, id);
      blocks.push({ id, text });
      totalChars += text.length;
    }

    return { blocks, truncated };
  }

  function getCandidateElements() {
    const roots = getContentRoots();
    const elementMap = new Map();

    for (const root of roots) {
      const candidates = root.matches?.(CANDIDATE_SELECTOR)
        ? [root, ...root.querySelectorAll(CANDIDATE_SELECTOR)]
        : Array.from(root.querySelectorAll(CANDIDATE_SELECTOR));

      for (const element of candidates) {
        elementMap.set(element, element);
      }
    }

    if (isYouTubeWatchPage()) {
      for (const element of getYouTubeCandidateElements()) {
        elementMap.set(element, element);
      }
    }

    return Array.from(elementMap.values()).sort(compareElementPriority);
  }

  function getYouTubeCandidateElements() {
    return Array.from(document.querySelectorAll(YOUTUBE_TEXT_SELECTOR))
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => !isNestedYouTubeCandidate(element));
  }

  function isNestedYouTubeCandidate(element) {
    if (element.matches("ytd-watch-metadata #title h1")) {
      return false;
    }

    const title = element.closest("ytd-watch-metadata #title h1");
    return Boolean(title);
  }

  function getContentRoots() {
    const roots = Array.from(document.querySelectorAll(CONTENT_ROOT_SELECTOR))
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => !element.closest(EXCLUDED_SELECTOR))
      .filter(isVisible)
      .filter((element) => normalizeText(element.innerText || element.textContent || "").length >= 80);

    if (roots.length) {
      return roots;
    }

    return [document.body || document.documentElement];
  }

  function compareElementPriority(a, b) {
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    const aViewport = isRectNearViewport(aRect);
    const bViewport = isRectNearViewport(bRect);

    if (aViewport !== bViewport) {
      return aViewport ? -1 : 1;
    }

    const aScore = getElementContentScore(a);
    const bScore = getElementContentScore(b);
    if (aScore !== bScore) {
      return bScore - aScore;
    }

    return aRect.top - bRect.top;
  }

  function isRectNearViewport(rect) {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    return rect.bottom >= -viewportHeight * 0.25 && rect.top <= viewportHeight * 1.5;
  }

  function getElementContentScore(element) {
    let score = 0;
    const tagName = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tagName)) score += 25;
    if (tagName === "p" || tagName === "blockquote") score += 20;
    if (tagName === "article" || tagName === "section") score += 10;

    const textLength = normalizeText(element.innerText || element.textContent || "").length;
    score += Math.min(30, Math.floor(textLength / 80));

    if (element.closest("main, article, [role='main'], shreddit-post, shreddit-comment")) {
      score += 20;
    }

    if (element.closest("ytd-watch-metadata, ytd-comments")) {
      score += 30;
    }

    return score;
  }

  function isTranslatableElement(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.closest(EXCLUDED_SELECTOR)) {
      return false;
    }

    if (element.getAttribute(TRANSLATED_ATTR) === "true") {
      return false;
    }

    if (element.matches("article, section") && element.querySelector(BASIC_SELECTOR)) {
      return false;
    }

    if (element.matches("li") && element.querySelector("p, ul, ol")) {
      return false;
    }

    if (!isVisible(element)) {
      return false;
    }

    return true;
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isTranslatableText(text) {
    if (text.length < 2 || text.length > 1500) {
      return false;
    }

    if (!/\p{L}/u.test(text)) {
      return false;
    }

    const compact = text.replace(/[\s\d.,:;!?()[\]{}"'`~@#$%^&*+=|\\/<>_-]/g, "");
    return compact.length > 0;
  }

  function normalizeAutoSourceLanguages(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    return Array.from(new Set(value.filter((language) => {
      return SUPPORTED_SOURCE_LANGUAGES.includes(language);
    })));
  }

  function shouldAutoTranslateSourceLanguage(sourceLanguage, enabledLanguages, targetLanguage) {
    if (!sourceLanguage || sourceLanguage === "unknown" || !enabledLanguages.includes(sourceLanguage)) {
      return false;
    }

    return !isSameLanguage(sourceLanguage, targetLanguage);
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

  function detectPageLanguage() {
    if (isYouTubeWatchPage()) {
      const youtubeLanguage = detectLanguageFromText(getPageTextSample());
      if (youtubeLanguage !== "unknown") {
        return youtubeLanguage;
      }
    }

    const metadataLanguage = detectLanguageFromMetadata();
    if (metadataLanguage !== "unknown") {
      return metadataLanguage;
    }

    return detectLanguageFromText(getPageTextSample());
  }

  function detectLanguageFromMetadata() {
    const candidates = [
      document.documentElement?.getAttribute("lang"),
      document.body?.getAttribute("lang"),
      document.querySelector("meta[property='og:locale']")?.getAttribute("content"),
      document.querySelector("meta[name='language']")?.getAttribute("content"),
      document.querySelector("meta[http-equiv='content-language']")?.getAttribute("content")
    ];

    for (const candidate of candidates) {
      const normalized = normalizeSourceLanguage(candidate);
      if (normalized !== "unknown") {
        return normalized;
      }
    }

    return "unknown";
  }

  function normalizeSourceLanguage(value) {
    const normalized = String(value || "").trim().replace("_", "-").toLowerCase();
    if (!normalized) {
      return "unknown";
    }

    if (normalized.startsWith("zh")) return "zh";
    if (normalized.startsWith("en")) return "en";
    if (normalized.startsWith("ja") || normalized.startsWith("jp")) return "ja";
    if (normalized.startsWith("ko") || normalized.startsWith("kr")) return "ko";
    if (normalized.startsWith("fr")) return "fr";
    if (normalized.startsWith("de")) return "de";
    if (normalized.startsWith("es")) return "es";
    if (normalized.startsWith("ru")) return "ru";
    return "unknown";
  }

  function getPageTextSample() {
    const elements = Array.from(document.querySelectorAll(CANDIDATE_SELECTOR));
    if (isYouTubeWatchPage()) {
      elements.push(...getYouTubeCandidateElements());
    }

    const parts = [document.title || ""];
    let totalLength = parts[0].length;

    for (const element of elements) {
      if (!(element instanceof HTMLElement) || element.closest(EXCLUDED_SELECTOR) || !isVisible(element)) {
        continue;
      }

      const text = normalizeText(element.innerText || element.textContent || "");
      if (text.length < 2) {
        continue;
      }

      parts.push(text);
      totalLength += text.length;
      if (totalLength >= 6000) {
        break;
      }
    }

    return parts.join(" ").slice(0, 8000);
  }

  function detectLanguageFromText(text) {
    const sample = String(text || "");
    const letters = countMatches(sample, /\p{L}/gu);
    if (letters < 20) {
      return "unknown";
    }

    const hangul = countMatches(sample, /[\uac00-\ud7af]/g);
    const kana = countMatches(sample, /[\u3040-\u30ff]/g);
    const cyrillic = countMatches(sample, /[\u0400-\u04ff]/g);
    const han = countMatches(sample, /\p{Script=Han}/gu);
    const latin = countMatches(sample, /\p{Script=Latin}/gu);

    if (hangul >= 8 && hangul / letters > 0.12) return "ko";
    if (kana >= 5) return "ja";
    if (cyrillic >= 20 && cyrillic / letters > 0.3) return "ru";
    if (han >= 20 && han / letters > 0.35) return "zh";
    if (latin >= 40 && latin / letters > 0.45) return detectLatinLanguage(sample);
    return "unknown";
  }

  function detectLatinLanguage(text) {
    const words = String(text || "").toLowerCase().match(/[a-z\u00c0-\u024f]+/g) || [];
    if (words.length < 8) {
      return "unknown";
    }

    const scores = {
      en: scoreWords(words, ["the", "and", "is", "are", "of", "to", "in", "for", "with", "this", "that", "you", "your", "not"]),
      fr: scoreWords(words, ["le", "la", "les", "des", "une", "est", "avec", "pour", "dans", "que", "pas", "sur", "vous"]),
      de: scoreWords(words, ["der", "die", "das", "und", "ist", "nicht", "mit", "ein", "eine", "für", "auf", "sie"]),
      es: scoreWords(words, ["el", "la", "los", "las", "una", "que", "con", "para", "por", "del", "en", "es", "como"])
    };

    const accentedText = text.toLowerCase();
    scores.fr += countMatches(accentedText, /[àâçéèêëîïôûùüÿœ]/g);
    scores.de += countMatches(accentedText, /[äöüß]/g);
    scores.es += countMatches(accentedText, /[áéíóúñü¿¡]/g);

    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    if (!best || best[1] < 2) {
      return "unknown";
    }

    return best[0];
  }

  function scoreWords(words, dictionary) {
    const dictionarySet = new Set(dictionary);
    return words.reduce((score, word) => score + (dictionarySet.has(word) ? 1 : 0), 0);
  }

  function countMatches(text, pattern) {
    return (text.match(pattern) || []).length;
  }

  async function mapWithConcurrency(items, concurrency, worker) {
    const workerCount = Math.min(Math.max(concurrency, 1), items.length);
    let nextIndex = 0;

    async function runWorker() {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        await worker(items[currentIndex], currentIndex);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, runWorker));
  }

  function insertTranslations(blocks, translations) {
    const translationMap = new Map();
    for (const item of translations) {
      if (item?.id && typeof item.translation === "string") {
        translationMap.set(item.id, item.translation.trim());
      }
    }

    let inserted = 0;
    for (const block of blocks) {
      const translation = translationMap.get(block.id);
      if (!translation) {
        continue;
      }

      const source = document.querySelector(`[${SOURCE_ID_ATTR}="${block.id}"]`);
      if (!source || source.getAttribute(TRANSLATED_ATTR) === "true") {
        continue;
      }

      const translatedNode = createTranslationNode(source, translation);

      if (source.matches("li, td, th")) {
        source.appendChild(translatedNode);
      } else {
        source.insertAdjacentElement("afterend", translatedNode);
      }

      source.setAttribute(TRANSLATED_ATTR, "true");
      inserted += 1;
    }

    return inserted;
  }

  function createTranslationNode(source, translation) {
    const isYouTubeTranslation = isYouTubeTextElement(source);
    const shouldNestInsideSource = !isYouTubeTranslation && source.matches("li, td, th");
    const tagName = shouldNestInsideSource || isYouTubeTranslation ? "div" : source.tagName.toLowerCase();
    const translatedNode = document.createElement(tagName);

    translatedNode.className = buildTranslationClassName(source, shouldNestInsideSource);
    translatedNode.setAttribute("data-mlaw-target-language", state.targetLanguage);
    translatedNode.setAttribute("lang", state.targetLanguage);
    translatedNode.textContent = translation;

    if (!shouldNestInsideSource && !isYouTubeTranslation) {
      copyLayoutAttributes(source, translatedNode);
    }

    copyComputedTextLayout(source, translatedNode, shouldNestInsideSource || isYouTubeTranslation);
    return translatedNode;
  }

  function buildTranslationClassName(source, isNested) {
    const classes = new Set();
    if (!isYouTubeTextElement(source)) {
      for (const className of source.classList || []) {
        if (className !== TRANSLATED_CLASS) {
          classes.add(className);
        }
      }
    }
    classes.add(TRANSLATED_CLASS);
    if (isNested) {
      classes.add("mlaw-translated-inline-block");
    }
    if (isYouTubeTextElement(source)) {
      classes.add("mlaw-youtube-translation");
    }
    return Array.from(classes).join(" ");
  }

  function copyLayoutAttributes(source, target) {
    const inlineStyle = source.getAttribute("style");
    if (inlineStyle) {
      target.setAttribute("style", inlineStyle);
    }

    const direction = source.getAttribute("dir");
    if (direction) {
      target.setAttribute("dir", direction);
    }
  }

  function copyComputedTextLayout(source, target, isNested) {
    const computed = window.getComputedStyle(source);
    const textProperties = [
      "font",
      "fontFamily",
      "fontSize",
      "fontStyle",
      "fontVariant",
      "fontWeight",
      "letterSpacing",
      "lineHeight",
      "textAlign",
      "textDecoration",
      "textIndent",
      "textTransform",
      "whiteSpace",
      "wordBreak",
      "wordSpacing",
      "overflowWrap",
      "direction",
      "writingMode"
    ];

    for (const property of textProperties) {
      target.style[property] = computed[property];
    }

    if (isNested) {
      target.style.display = "block";
      target.style.margin = "0.35em 0 0";
      target.style.padding = "0";
      return;
    }

    const spacingProperties = [
      "marginTop",
      "marginRight",
      "marginBottom",
      "marginLeft",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft"
    ];

    for (const property of spacingProperties) {
      target.style[property] = computed[property];
    }
  }

  function restorePage(options = {}) {
    document.querySelectorAll(`.${TRANSLATED_CLASS}`).forEach((node) => node.remove());
    document.querySelectorAll(`[${SOURCE_ID_ATTR}]`).forEach((node) => {
      node.removeAttribute(SOURCE_ID_ATTR);
      node.removeAttribute(TRANSLATED_ATTR);
    });
    stopYouTubeCaptionTranslation({ keepSetting: Boolean(options.keepYouTubeCaptionSetting) });

    state.hasTranslated = false;
    refreshTranslatedBadge();

    if (!options.silent) {
      showNotice("已恢复原文", "ok", 2500);
    }
  }

  function startObserver() {
    if (state.observer || !document.body) {
      return;
    }

    state.observer = new MutationObserver((mutations) => {
      if (handleUrlChangeIfNeeded()) {
        return;
      }

      if (state.translating) {
        return;
      }

      const shouldTranslateDynamicContent = state.autoTranslate ||
        (isYouTubeWatchPage() && state.hasTranslated);
      if (!shouldTranslateDynamicContent) {
        return;
      }

      const hasPageContentAdded = mutations.some((mutation) => {
        return Array.from(mutation.addedNodes).some((node) => {
          if (!(node instanceof HTMLElement)) {
            return false;
          }
          return hasTranslatableAddedNode(node, shouldTranslateDynamicContent);
        });
      });

      if (!hasPageContentAdded) {
        return;
      }

      clearTimeout(state.observerTimer);
      state.observerTimer = setTimeout(() => {
        translatePage({
          targetLanguage: state.targetLanguage,
          incremental: true
        }).catch((error) => {
          if (isExtensionContextInvalidatedError(error)) {
            markExtensionContextInvalidated();
            return;
          }
          console.error("增量翻译失败：", error);
        });
      }, 900);
    });

    state.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function hasTranslatableAddedNode(node) {
    if (node.closest?.(`.${TRANSLATED_CLASS}, #${NOTICE_ID}, #${YOUTUBE_CAPTION_OVERLAY_ID}`)) {
      return false;
    }

    if (node.matches?.(YOUTUBE_CAPTION_SELECTOR) ||
        node.closest?.(YOUTUBE_CAPTION_SELECTOR) ||
        node.querySelector?.(YOUTUBE_CAPTION_SELECTOR)) {
      return false;
    }

    if (isYouTubeWatchPage() && state.hasTranslated) {
      return node.matches?.(YOUTUBE_DYNAMIC_SELECTOR) ||
        node.matches?.(YOUTUBE_TEXT_SELECTOR) ||
        Boolean(node.querySelector?.(`${YOUTUBE_DYNAMIC_SELECTOR}, ${YOUTUBE_TEXT_SELECTOR}`));
    }

    return state.autoTranslate && Boolean(node.innerText || node.textContent);
  }

  function handleUrlChangeIfNeeded() {
    if (location.href === state.lastUrl) {
      return false;
    }

    state.lastUrl = location.href;
    restorePage({ silent: true, keepYouTubeCaptionSetting: true });
    loadSettings()
      .then(() => {
        syncYouTubeCaptionTranslation();
        if (state.autoTranslate) {
          setTimeout(() => {
            translatePage({
              targetLanguage: state.targetLanguage,
              forceRetranslate: true
            }).catch((error) => {
              if (isExtensionContextInvalidatedError(error)) {
                markExtensionContextInvalidated();
                return;
              }
              console.error("页面跳转后自动翻译失败：", error);
            });
          }, 500);
        }
      })
      .catch((error) => {
        if (isExtensionContextInvalidatedError(error)) {
          markExtensionContextInvalidated();
          return;
        }
        console.error("页面跳转后读取设置失败：", error);
      });
    return true;
  }

  function syncYouTubeCaptionTranslation(options = {}) {
    if (state.youtubeCaptionsEnabled && isYouTubeWatchPage()) {
      startYouTubeCaptionTranslation(options);
      return;
    }

    stopYouTubeCaptionTranslation();
  }

  function startYouTubeCaptionTranslation(options = {}) {
    if (!document.body || state.youtubeCaptionObserver) {
      scheduleYouTubeCaptionTranslation(80);
      return;
    }

    state.youtubeCaptionObserver = new MutationObserver((mutations) => {
      const hasCaptionChange = mutations.some((mutation) => {
        const target = mutation.target;
        if (target instanceof HTMLElement && target.closest(YOUTUBE_CAPTION_SELECTOR)) {
          return true;
        }
        if (target instanceof Text && target.parentElement?.closest(YOUTUBE_CAPTION_SELECTOR)) {
          return true;
        }
        return Array.from(mutation.addedNodes).some((node) => {
          if (!(node instanceof HTMLElement)) {
            return false;
          }
          return node.matches(YOUTUBE_CAPTION_SELECTOR) ||
            Boolean(node.querySelector(YOUTUBE_CAPTION_SELECTOR));
        });
      });

      if (hasCaptionChange) {
        scheduleYouTubeCaptionTranslation();
      }
    });

    state.youtubeCaptionObserver.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true
    });

    if (options.notify) {
      showNotice("YouTube 字幕翻译已开启，等待字幕内容", "ok", 2500);
    }
    scheduleYouTubeCaptionTranslation(80);
  }

  function stopYouTubeCaptionTranslation() {
    clearTimeout(state.youtubeCaptionTimer);
    state.youtubeCaptionTimer = null;

    if (state.youtubeCaptionObserver) {
      state.youtubeCaptionObserver.disconnect();
      state.youtubeCaptionObserver = null;
    }

    const overlay = document.getElementById(YOUTUBE_CAPTION_OVERLAY_ID);
    if (overlay) {
      overlay.remove();
    }

    state.youtubeCaptionLastText = "";
    state.youtubeCaptionLastTranslation = "";
    state.youtubeCaptionRequestId += 1;
    state.youtubeCaptionHasTranslated = false;
    refreshTranslatedBadge();
  }

  function scheduleYouTubeCaptionTranslation(delay = YOUTUBE_CAPTION_DEBOUNCE_MS) {
    clearTimeout(state.youtubeCaptionTimer);
    state.youtubeCaptionTimer = setTimeout(() => {
      translateCurrentYouTubeCaption().catch((error) => {
        if (isExtensionContextInvalidatedError(error)) {
          markExtensionContextInvalidated();
          return;
        }
        console.error("YouTube 字幕翻译失败：", error);
      });
    }, delay);
  }

  async function translateCurrentYouTubeCaption() {
    if (!state.youtubeCaptionsEnabled || !isYouTubeWatchPage()) {
      return;
    }

    const text = getCurrentYouTubeCaptionText();
    if (!text) {
      hideYouTubeCaptionOverlay();
      return;
    }

    if (text === state.youtubeCaptionLastText && state.youtubeCaptionLastTranslation) {
      renderYouTubeCaptionOverlay(state.youtubeCaptionLastTranslation);
      return;
    }

    const requestId = state.youtubeCaptionRequestId + 1;
    state.youtubeCaptionRequestId = requestId;
    state.youtubeCaptionLastText = text;

    try {
      const response = await sendRuntimeMessage({
        action: "translateText",
        targetLanguage: state.targetLanguage,
        text
      });

      if (requestId !== state.youtubeCaptionRequestId) {
        return;
      }

      if (!response?.success || !response.translation) {
        throw new Error(response?.error || "字幕翻译失败");
      }

      state.youtubeCaptionLastTranslation = response.translation.trim();
      state.youtubeCaptionHasTranslated = true;
      renderYouTubeCaptionOverlay(state.youtubeCaptionLastTranslation);
      refreshTranslatedBadge();
    } catch (error) {
      const now = Date.now();
      if (now - state.youtubeCaptionLastErrorAt > 5000) {
        state.youtubeCaptionLastErrorAt = now;
        showNotice(error.message || "YouTube 字幕翻译失败", "error", 3500);
      }
    }
  }

  function getCurrentYouTubeCaptionText() {
    const segments = Array.from(document.querySelectorAll(".ytp-caption-segment"))
      .map((element) => normalizeText(element.innerText || element.textContent || ""))
      .filter(Boolean);
    return normalizeText(segments.join(" "));
  }

  function renderYouTubeCaptionOverlay(translation) {
    if (!translation) {
      hideYouTubeCaptionOverlay();
      return;
    }

    const overlay = ensureYouTubeCaptionOverlay();
    if (!overlay) {
      return;
    }

    overlay.setAttribute("lang", state.targetLanguage);
    overlay.textContent = translation;
    applyYouTubeCaptionPosition(overlay);
    overlay.style.display = "block";
  }

  function hideYouTubeCaptionOverlay() {
    const overlay = document.getElementById(YOUTUBE_CAPTION_OVERLAY_ID);
    if (overlay) {
      overlay.textContent = "";
      overlay.style.display = "none";
    }
  }

  function ensureYouTubeCaptionOverlay() {
    let overlay = document.getElementById(YOUTUBE_CAPTION_OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = YOUTUBE_CAPTION_OVERLAY_ID;
      overlay.setAttribute("lang", state.targetLanguage);
    }
    attachYouTubeCaptionDragHandlers(overlay);

    const host = getYouTubeCaptionHost();
    if (!host) {
      if (overlay.parentElement !== document.documentElement) {
        document.documentElement.appendChild(overlay);
      }
      overlay.dataset.mlawDetached = "true";
      return overlay;
    }

    overlay.dataset.mlawDetached = "false";
    if (window.getComputedStyle(host).position === "static") {
      host.style.position = "relative";
    }

    if (overlay.parentElement !== host) {
      host.appendChild(overlay);
    }

    return overlay;
  }

  function getYouTubeCaptionHost() {
    return document.querySelector("#movie_player, .html5-video-player");
  }

  function applyYouTubeCaptionPosition(overlay) {
    const position = normalizeYouTubeCaptionPosition(state.youtubeCaptionPosition);
    state.youtubeCaptionPosition = position;
    overlay.style.left = `${position.x}%`;
    overlay.style.top = `${position.y}%`;
    overlay.style.bottom = "";
    overlay.style.transform = "translate(-50%, -50%)";
  }

  function attachYouTubeCaptionDragHandlers(overlay) {
    if (overlay.dataset.mlawDragReady === "true") {
      return;
    }

    overlay.dataset.mlawDragReady = "true";
    let dragging = false;

    overlay.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }

      const host = getYouTubeCaptionHost();
      if (!host) {
        return;
      }

      dragging = true;
      overlay.setPointerCapture?.(event.pointerId);
      overlay.classList.add("mlaw-youtube-caption-dragging");
      event.preventDefault();
    });

    overlay.addEventListener("pointermove", (event) => {
      if (!dragging) {
        return;
      }

      const position = getYouTubeCaptionPositionFromPointer(event);
      if (!position) {
        return;
      }

      state.youtubeCaptionPosition = position;
      applyYouTubeCaptionPosition(overlay);
      event.preventDefault();
    });

    overlay.addEventListener("pointerup", (event) => {
      if (!dragging) {
        return;
      }

      dragging = false;
      overlay.releasePointerCapture?.(event.pointerId);
      overlay.classList.remove("mlaw-youtube-caption-dragging");
      saveYouTubeCaptionPosition(state.youtubeCaptionPosition);
      event.preventDefault();
    });

    overlay.addEventListener("pointercancel", (event) => {
      dragging = false;
      overlay.releasePointerCapture?.(event.pointerId);
      overlay.classList.remove("mlaw-youtube-caption-dragging");
    });
  }

  function getYouTubeCaptionPositionFromPointer(event) {
    const host = getYouTubeCaptionHost();
    if (!host) {
      return null;
    }

    const rect = host.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    return normalizeYouTubeCaptionPosition({
      x: ((event.clientX - rect.left) / rect.width) * 100,
      y: ((event.clientY - rect.top) / rect.height) * 100
    });
  }

  function normalizeYouTubeCaptionPosition(value) {
    const x = Number(value?.x);
    const y = Number(value?.y);
    return {
      x: clampNumber(Number.isFinite(x) ? x : DEFAULT_YOUTUBE_CAPTION_POSITION.x, 8, 92),
      y: clampNumber(Number.isFinite(y) ? y : DEFAULT_YOUTUBE_CAPTION_POSITION.y, 12, 90)
    };
  }

  function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function saveYouTubeCaptionPosition(position) {
    storageSyncSet({ youtubeCaptionPosition: normalizeYouTubeCaptionPosition(position) })
      .catch((error) => {
        if (isExtensionContextInvalidatedError(error)) {
          markExtensionContextInvalidated();
        }
      });
  }

  function refreshTranslatedBadge() {
    state.hasTranslated = document.querySelectorAll(`.${TRANSLATED_CLASS}`).length > 0;
    updateTranslatedBadge(getTranslatedCount() > 0);
  }

  function getTranslatedCount() {
    const pageTranslations = document.querySelectorAll(`.${TRANSLATED_CLASS}`).length;
    const captionOverlay = document.getElementById(YOUTUBE_CAPTION_OVERLAY_ID);
    const hasCaptionTranslation = Boolean(
      state.youtubeCaptionHasTranslated &&
      captionOverlay &&
      normalizeText(captionOverlay.textContent || "")
    );
    return pageTranslations + (hasCaptionTranslation ? 1 : 0);
  }

  function isYouTubeWatchPage() {
    const host = location.hostname.toLowerCase();
    const isYouTubeHost = host === "youtube.com" ||
      host === "www.youtube.com" ||
      host === "m.youtube.com";
    return isYouTubeHost && location.pathname === "/watch";
  }

  function isYouTubeTextElement(element) {
    return isYouTubeWatchPage() && Boolean(
      element.matches?.(YOUTUBE_TEXT_SELECTOR) ||
      element.closest?.("ytd-watch-metadata, ytd-comment-thread-renderer, ytd-comment-view-model")
    );
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${TRANSLATED_CLASS} {
        box-sizing: border-box;
        border: 0;
        background: transparent;
        color: inherit;
        white-space: pre-wrap;
      }

      .${TRANSLATED_CLASS}.mlaw-translated-inline-block {
        display: block;
      }

      .${TRANSLATED_CLASS}.mlaw-youtube-translation {
        display: block;
        margin-top: 0.35em;
        opacity: 0.88;
      }

      #${YOUTUBE_CAPTION_OVERLAY_ID} {
        position: absolute;
        z-index: 2147483646;
        left: 50%;
        top: 82%;
        transform: translate(-50%, -50%);
        display: none;
        max-width: min(86%, 980px);
        padding: 5px 10px;
        border-radius: 4px;
        background: rgba(0, 0, 0, 0.66);
        color: #fff;
        font: 600 22px/1.35 Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
        text-align: center;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
        white-space: pre-wrap;
        cursor: move;
        pointer-events: auto;
        touch-action: none;
        user-select: none;
      }

      #${YOUTUBE_CAPTION_OVERLAY_ID}[data-mlaw-detached="true"] {
        position: fixed;
      }

      #${YOUTUBE_CAPTION_OVERLAY_ID}.mlaw-youtube-caption-dragging {
        background: rgba(0, 0, 0, 0.78);
      }

      @media (max-width: 640px) {
        #${YOUTUBE_CAPTION_OVERLAY_ID} {
          max-width: 92%;
          font-size: 16px;
        }
      }

      #${NOTICE_ID} {
        position: fixed;
        z-index: 2147483647;
        top: 14px;
        right: 14px;
        max-width: min(360px, calc(100vw - 28px));
        padding: 10px 12px;
        border: 1px solid rgba(31, 41, 51, 0.14);
        border-radius: 8px;
        box-shadow: 0 10px 24px rgba(15, 23, 42, 0.18);
        background: #ffffff;
        color: #1f2933;
        font: 13px/1.45 Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
      }

      #${NOTICE_ID}[data-type="ok"] {
        border-left: 4px solid #0f7a4f;
      }

      #${NOTICE_ID}[data-type="error"] {
        border-left: 4px solid #b42318;
      }

      #${NOTICE_ID}[data-type="loading"] {
        border-left: 4px solid #2364aa;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function showNotice(message, type = "info", timeout = 0) {
    let notice = document.getElementById(NOTICE_ID);
    if (!notice) {
      notice = document.createElement("div");
      notice.id = NOTICE_ID;
      document.documentElement.appendChild(notice);
    }

    notice.textContent = message;
    notice.dataset.type = type;

    if (timeout > 0) {
      setTimeout(() => {
        if (notice.textContent === message) {
          notice.remove();
        }
      }, timeout);
    }
  }

  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function makeSourceId(index) {
    return `mlaw_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function getSiteKey() {
    if (location.protocol === "file:") {
      return "file://local";
    }
    return location.hostname;
  }

  function markExtensionContextInvalidated() {
    if (state.extensionContextInvalidated) {
      return;
    }

    state.extensionContextInvalidated = true;
    state.translating = false;

    clearTimeout(state.observerTimer);
    clearTimeout(state.youtubeCaptionTimer);
    state.observerTimer = null;
    state.youtubeCaptionTimer = null;

    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }

    if (state.youtubeCaptionObserver) {
      state.youtubeCaptionObserver.disconnect();
      state.youtubeCaptionObserver = null;
    }

    showNotice(EXTENSION_CONTEXT_INVALIDATED_MESSAGE, "error", 5000);
  }

  function isExtensionContextAvailable() {
    try {
      return !state.extensionContextInvalidated &&
        typeof chrome === "object" &&
        Boolean(chrome.runtime?.id) &&
        typeof chrome.runtime?.sendMessage === "function" &&
        typeof chrome.storage?.sync?.get === "function";
    } catch {
      return false;
    }
  }

  function makeExtensionContextInvalidatedError() {
    const error = new Error(EXTENSION_CONTEXT_INVALIDATED_MESSAGE);
    error.name = "ExtensionContextInvalidatedError";
    return error;
  }

  function isExtensionContextInvalidatedError(error) {
    const message = String(error?.message || error || "");
    return error?.name === "ExtensionContextInvalidatedError" ||
      message.includes("Extension context invalidated") ||
      message.includes("Extension context was invalidated") ||
      message.includes(EXTENSION_CONTEXT_INVALIDATED_MESSAGE);
  }

  function normalizeChromeRuntimeError(error) {
    if (isExtensionContextInvalidatedError(error)) {
      return makeExtensionContextInvalidatedError();
    }
    return error instanceof Error ? error : new Error(String(error?.message || error || "扩展消息失败"));
  }

  function storageSyncGet(keys) {
    if (!isExtensionContextAvailable()) {
      return Promise.reject(makeExtensionContextInvalidatedError());
    }

    return new Promise((resolve, reject) => {
      try {
        chrome.storage.sync.get(keys, (result) => {
          try {
            const error = chrome.runtime.lastError;
            if (error) {
              reject(normalizeChromeRuntimeError(error));
              return;
            }
            resolve(result || {});
          } catch (error) {
            reject(normalizeChromeRuntimeError(error));
          }
        });
      } catch (error) {
        reject(normalizeChromeRuntimeError(error));
      }
    });
  }

  function storageSyncSet(values) {
    if (!isExtensionContextAvailable()) {
      return Promise.reject(makeExtensionContextInvalidatedError());
    }

    return new Promise((resolve, reject) => {
      try {
        chrome.storage.sync.set(values, () => {
          try {
            const error = chrome.runtime.lastError;
            if (error) {
              reject(normalizeChromeRuntimeError(error));
              return;
            }
            resolve();
          } catch (error) {
            reject(normalizeChromeRuntimeError(error));
          }
        });
      } catch (error) {
        reject(normalizeChromeRuntimeError(error));
      }
    });
  }

  function sendRuntimeMessage(message) {
    if (!isExtensionContextAvailable()) {
      return Promise.reject(makeExtensionContextInvalidatedError());
    }

    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          try {
            const error = chrome.runtime.lastError;
            if (error) {
              reject(normalizeChromeRuntimeError(error));
              return;
            }
            resolve(response);
          } catch (error) {
            reject(normalizeChromeRuntimeError(error));
          }
        });
      } catch (error) {
        reject(normalizeChromeRuntimeError(error));
      }
    });
  }

  function updateTranslatedBadge(translated) {
    if (!isExtensionContextAvailable()) {
      markExtensionContextInvalidated();
      return;
    }

    try {
      chrome.runtime.sendMessage({
        action: "setPageTranslatedBadge",
        translated
      }, () => {
        try {
          const error = chrome.runtime.lastError;
          if (error && isExtensionContextInvalidatedError(error)) {
            markExtensionContextInvalidated();
          }
        } catch (error) {
          if (isExtensionContextInvalidatedError(error)) {
            markExtensionContextInvalidated();
          }
        }
      });
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        markExtensionContextInvalidated();
      }
    }
  }
})();
