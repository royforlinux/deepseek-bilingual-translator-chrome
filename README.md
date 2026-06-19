# DeepSeek Bilingual Translator for Chrome

[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![DeepSeek](https://img.shields.io/badge/AI-DeepSeek-2563eb)](https://www.deepseek.com/)
[![License](https://img.shields.io/badge/license-Apache--2.0-green.svg)](LICENSE.txt)

English | [中文](#中文)

An open-source Chrome extension for bilingual webpage translation powered by the DeepSeek API. It supports selected-text translation, full-page bilingual translation, per-site auto translation, source-language auto rules, layout-preserving insertion, and performance-focused batching.

If you want a transparent bilingual translation extension that keeps your API key local and stays easy to modify, this project is built for that.

## Highlights

- **Bilingual webpage reading**: insert translations under the original text so context stays visible.
- **Layout-aware insertion**: reuse the original tag, class, typography, line height, spacing, and alignment where possible.
- **Auto translation rules**: enable auto translation by site or by detected source language.
- **Fast enough for daily reading**: prioritize article content and viewport text, skip navigation/sidebar noise, translate in concurrent batches, and insert each batch as soon as it returns.
- **Local API key storage**: your DeepSeek API key is stored in local Chrome extension storage, not in this repository.
- **No build step required**: plain Chrome MV3 extension files, easy to inspect, fork, and customize.

## Features

- Translate selected text from the right-click menu and show the result in the Chrome side panel.
- Translate the current webpage and insert bilingual text below the original blocks.
- Restore the original page by removing inserted translation nodes.
- Remember per-host auto-translation rules.
- Enable global source-language auto translation for English, Japanese, Korean, French, German, Spanish, Russian, and Chinese.
- Choose target language from Simplified Chinese, Traditional Chinese, English, Japanese, Korean, French, German, Spanish, and Russian.
- Show a red badge on the extension icon after the current page has been translated.
- Incrementally translate dynamically loaded SPA content while avoiding duplicate insertion.

## Install

1. Clone or download this repository.
2. Open `chrome://extensions/` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this repository folder.
6. Open the extension popup and save your DeepSeek API key.

## Usage

### Translate Selected Text

Select text on any webpage, right-click, and choose **DeepSeek translate selected text**. The translation result appears in the Chrome side panel.

### Translate Current Page

Open the extension popup and click **Translate current page**. Translations are inserted below the original text blocks.

### Auto Translate English, Japanese, or Korean Pages

Open the extension popup and enable the desired source languages under **Source language auto translation**. For example, enabling English makes Reddit, GitHub, and English documentation pages translate automatically into your target language.

### Always Translate a Specific Site

Open the extension popup on a site and enable **Always auto translate this site**. The hostname is remembered and future pages on that site will be translated automatically.

## Privacy

- The API key is stored in `chrome.storage.local.apiKey`.
- Older `chrome.storage.sync.apiKey` values are migrated to local storage on first run.
- No real API key, cookie, browser profile, screenshot, or local config file is included in this repository.
- Translation requests are sent only to `https://api.deepseek.com/chat/completions`.
- Page text is sent to DeepSeek only when you manually translate or when your auto-translation rules match.

## How It Works

- `background.js`
  - DeepSeek API requests
  - context menus
  - language menus
  - translation cache
  - extension badge state
- `content.js`
  - text block collection
  - page language detection
  - article and viewport prioritization
  - translation node insertion
  - restore original page
  - dynamic content translation
- `popup.js`
  - API key setup
  - target language selection
  - source-language auto rules
  - site-level auto translation switch
- `sidebar.js`
  - selected-text translation display

## Performance Strategy

- Skip low-value areas such as navigation, headers, footers, sidebars, buttons, inputs, and code blocks.
- Prefer article roots such as `main`, `article`, `[role=main]`, Reddit posts, and Reddit comments.
- Prioritize text near the current viewport.
- Request translations in concurrent batches.
- Insert each translated batch immediately instead of waiting for the whole page.
- Reuse session-memory cache for repeated source text and target language pairs.

## Limitations

- DeepSeek is an LLM API and can be slower than classic machine translation services.
- Very long pages are capped at 200 text blocks or about 30000 characters by default.
- Browser internal pages such as `chrome://` and Chrome Web Store cannot run content scripts.
- PDF translation, subtitle translation, glossary support, TTS, and advanced style customization are not implemented yet.

## Roadmap

- Optional fast translation engines such as Microsoft, Google, or DeepL.
- Persistent local translation cache.
- Viewport-only reading mode.
- More precise site rules and blacklist rules.
- PDF and subtitle translation.
- GitHub Actions release packaging.

## Credits

This project is based on [royforlinux/deepseek-translator-chrome-plugin](https://github.com/royforlinux/deepseek-translator-chrome-plugin) and keeps the Apache License 2.0 license.

If this project helps you, a Star, Fork, or Issue would be appreciated.

## License

Apache License 2.0. See [LICENSE.txt](LICENSE.txt).

---

# 中文

[English](#deepseek-bilingual-translator-for-chrome) | 中文

一个基于 DeepSeek API 的开源 Chrome 双语网页翻译扩展。它支持选中文本翻译、整页双语翻译、按站点自动翻译、按原文语言自动翻译、尽量保持原网页排版，并针对日常网页阅读做了批量并发和正文优先优化。

如果你想要一个透明、可改造、API Key 只保存在本机的双语翻译插件，这个项目就是为此准备的。

## 亮点

- **双语网页阅读**：译文插入在原文下方，阅读时保留上下文。
- **尽量保持排版**：译文尽量复用原文标签、class、字体、行高、间距和对齐方式。
- **自动翻译规则**：可按网站开启，也可按检测到的原文语言开启。
- **面向阅读速度优化**：优先正文和可视区域，跳过导航和侧栏，并发批量请求，单批返回后立即显示。
- **API Key 本地保存**：DeepSeek API Key 只保存在 Chrome 扩展本地存储中，不写入源码仓库。
- **无需构建步骤**：纯 Chrome MV3 扩展文件，容易查看、Fork 和二次开发。

## 功能

- 右键翻译选中文本，结果显示在 Chrome 侧边栏。
- 手动翻译当前页，把译文插入到原文下方。
- 恢复原文，一键移除插件插入的译文节点。
- 按 hostname 记忆“本站始终自动翻译”。
- 全局设置“原文语言自动翻译”，支持英文、日文、韩文、法文、德文、西班牙文、俄文和中文。
- 目标语言支持简体中文、繁体中文、英文、日文、韩文、法文、德文、西班牙文和俄文。
- 当前页完成翻译后，扩展图标显示红点 badge。
- 对 SPA 或动态加载页面做增量翻译，避免重复插入。

## 安装

1. 下载或克隆本仓库。
2. 打开 Chrome，进入 `chrome://extensions/`。
3. 打开右上角“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择本仓库目录。
6. 点击工具栏中的扩展图标，保存你的 DeepSeek API Key。

## 使用

### 翻译选中文本

选中网页文本，右键点击“DeepSeek 翻译选中文本”，侧边栏会显示翻译结果。

### 翻译当前页

点击扩展图标，然后点击“翻译当前页”。译文会插入到原文下方，并尽量保持原网页排版。

### 自动翻译英文、日文、韩文页面

在扩展 popup 中勾选“原文语言自动翻译”里的语言。例如勾选“英文”后，Reddit、GitHub、英文文档等页面会自动翻译为你的目标语言。

### 按网站开启自动翻译

在某个网站打开扩展 popup，开启“本站始终自动翻译”。该 hostname 会被记住，之后刷新页面会自动翻译。

## 隐私与安全

- API Key 保存在 `chrome.storage.local.apiKey`。
- 旧版 `chrome.storage.sync.apiKey` 会在首次运行时迁移到本地存储。
- 本仓库不包含真实 API Key、cookie、浏览器 profile、截图或本地配置文件。
- 翻译请求只发往 `https://api.deepseek.com/chat/completions`。
- 页面内容只会在你手动翻译或命中自动翻译规则时发送给 DeepSeek。

## 技术实现

- `background.js`：DeepSeek 请求、右键菜单、语言菜单、翻译缓存、扩展图标 badge。
- `content.js`：文本块收集、页面语言检测、正文和可视区优先排序、译文插入、恢复原文、动态页面增量翻译。
- `popup.js`：API Key 保存、目标语言选择、原文语言自动翻译设置、站点自动翻译开关。
- `sidebar.js`：选中文本翻译结果展示。

## 性能策略

- 跳过 `nav`、`header`、`footer`、`aside`、按钮、输入框、代码块等低价值区域。
- 优先从 `main`、`article`、`[role=main]`、Reddit 帖子和评论等正文根节点提取文本。
- 当前视口附近内容优先翻译。
- 页面端按小批次并发请求，单批返回后立即插入译文。
- 后台按批次并发请求 DeepSeek。
- 同一浏览器会话内，相同原文和目标语言命中内存缓存。

## 限制

- DeepSeek 是大模型 API，速度通常慢于传统机器翻译服务。
- 超长页面默认最多翻译 200 个文本块或约 30000 字符。
- `chrome://`、Chrome Web Store 等浏览器内部页面不能注入内容脚本。
- 暂不支持 PDF 翻译、字幕翻译、术语库、TTS 朗读和复杂样式配置。

## Roadmap

- 可选极速翻译引擎：Microsoft、Google、DeepL。
- 本地持久化译文缓存。
- 只翻译当前可视区域的阅读模式。
- 更精细的站点规则和黑名单。
- PDF 和字幕翻译支持。
- GitHub Actions 自动打包 release zip。

## 致谢

本项目基于 [royforlinux/deepseek-translator-chrome-plugin](https://github.com/royforlinux/deepseek-translator-chrome-plugin) 改造，保留 Apache License 2.0。

如果这个项目对你有帮助，欢迎 Star、Fork 和提 Issue。

## License

Apache License 2.0。详见 [LICENSE.txt](LICENSE.txt)。
