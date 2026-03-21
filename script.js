const form = document.querySelector("#parse-form");
const urlInput = document.querySelector("#note-url");
const submitButton = document.querySelector("#submit-button");
const historyButton = document.querySelector("#history-button");
const historyMenu = document.querySelector("#history-menu");
const emptyState = document.querySelector("#empty-state");
const resultCard = document.querySelector("#result-card");
const resultImage = document.querySelector("#result-image");
const carouselOverlay = document.querySelector("#carousel-overlay");
const carouselPrev = document.querySelector("#carousel-prev");
const carouselNext = document.querySelector("#carousel-next");
const carouselCounter = document.querySelector("#carousel-counter");
const carouselDots = document.querySelector("#carousel-dots");
const resultTitle = document.querySelector("#result-title");
const resultBody = document.querySelector("#result-body");
const resultTags = document.querySelector("#result-tags");
const resultImageLinks = document.querySelector("#result-image-links");
const tabImages = document.querySelector("#tab-images");
const tabVideos = document.querySelector("#tab-videos");
const copyAllImagesButton = document.querySelector("#copy-all-images-button");
const resultPrompt = document.querySelector("#result-prompt");
const rewriteMessagesOutput = document.querySelector("#rewrite-messages-output");
const rewriteDirectionInput = document.querySelector("#rewrite-direction-input");
const regeneratePromptButton = document.querySelector("#regenerate-prompt-button");
const copyPromptButton = document.querySelector("#copy-prompt-button");
const resultImagePrompt = document.querySelector("#result-image-prompt");
const imageMessagesOutput = document.querySelector("#image-messages-output");
const imageDirectionInput = document.querySelector("#image-direction-input");
const regenerateImagePromptButton = document.querySelector("#regenerate-image-prompt-button");
const copyImagePromptButton = document.querySelector("#copy-image-prompt-button");

const FALLBACK_IMAGE =
  "https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=1200&q=80";
const MAX_REFERENCE_MEDIA = 14;
const IMAGE_PROMPT_REFERENCE_LIMIT = 8;
const DEFAULT_SUBMIT_BUTTON_TEXT = "开始解析";
const HISTORY_STORAGE_KEY = "note-parser:url-history";
const HISTORY_LIMIT = 12;

const SAMPLE_TAGS = ["内容解析", "链接抓取", "笔记结构化"];
const WORKFLOW_TEMPLATE_VARIABLES = Object.freeze({
  title: "{{ $('解析生成内容').item.json.title }}",
  content: "{{ $('解析生成内容').item.json.content }}",
  imageList: "{{ $('输入参数汇总').item.json['图片信息'] }}",
  productImageList: "{{ $('文案提示词').item.json.image_url_list }}",
  locationContext: "{{ $('输入参数汇总').item.json['用户输入'] }}",
  firstImage: "{{ $('输入参数汇总').item.json['图片信息'][0] }}",
  logoHint: "{{ $('输入参数汇总').item.json['用户输入2'] }}",
  forbiddenLogo: "{{ $('输入参数汇总').item.json['用户输入3'] }}",
});

const carouselState = {
  images: [],
  index: 0,
};

const swipeState = {
  startX: 0,
  deltaX: 0,
};

let copyPromptResetTimer = 0;
let copyAllImagesResetTimer = 0;
let copyImagePromptResetTimer = 0;
let rewritePromptRequestSerial = 0;
let imagePromptRequestSerial = 0;
let urlHistory = loadUrlHistory();
let currentParsedResult = null;
const mediaLinkState = {
  activeTab: "images",
  images: [],
  videos: [],
};

warnIfOpenedFromFile();
renderUrlHistory();
setSubmitButtonState("idle");
setRegenerateButtonState(regeneratePromptButton, false, "重新生成");
setRegenerateButtonState(regenerateImagePromptButton, false, "重新生成");

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const rawUrl = urlInput.value.trim();
  if (!rawUrl) {
    setSubmitButtonState("idle");
    return;
  }

  let noteUrl;

  try {
    noteUrl = normalizeUrl(rawUrl);
  } catch (error) {
    setSubmitButtonState("idle");
    return;
  }

  setSubmitButtonState("loading", "正在解析...");
  currentParsedResult = null;
  setRegenerateButtonState(regeneratePromptButton, false, "重新生成");
  setRegenerateButtonState(regenerateImagePromptButton, false, "重新生成");

  try {
    const result = await parseNoteFromUrl(noteUrl);
    renderResult(result);
    pushUrlHistory(noteUrl);

    const hasFallback = Boolean(result?.meta?.usedFallback);
    setSubmitButtonState(hasFallback ? "idle" : "success", hasFallback ? DEFAULT_SUBMIT_BUTTON_TEXT : "解析完成");
  } catch (error) {
    renderResult(buildFallbackResult(noteUrl, ""));
    setSubmitButtonState("idle");
  } finally {
    if (submitButton.dataset.state !== "disabled-service") {
      submitButton.disabled = false;
    }
  }
});

urlInput.addEventListener("input", () => {
  resetSubmitButtonForNewInput();
});

urlInput.addEventListener("change", () => {
  resetSubmitButtonForNewInput();
});

carouselPrev.addEventListener("click", () => {
  moveCarousel(-1);
});

carouselNext.addEventListener("click", () => {
  moveCarousel(1);
});

historyButton.addEventListener("click", () => {
  toggleHistoryMenu();
});

copyPromptButton.addEventListener("click", async () => {
  const promptText = resultPrompt.value.trim();
  if (!promptText || promptText === "-") {
    flashCopyButton("暂无内容");
    return;
  }

  try {
    await copyText(promptText);
    flashCopyButton("已复制");
  } catch (error) {
    flashCopyButton("复制失败");
  }
});

copyImagePromptButton.addEventListener("click", async () => {
  const promptText = resultImagePrompt.value.trim();
  if (!promptText || promptText === "-") {
    flashImagePromptButton("暂无内容");
    return;
  }

  try {
    await copyText(promptText);
    flashImagePromptButton("已复制");
  } catch (error) {
    flashImagePromptButton("复制失败");
  }
});

regeneratePromptButton.addEventListener("click", async () => {
  await regenerateRewritePrompt();
});

regenerateImagePromptButton.addEventListener("click", async () => {
  await regenerateImagePrompt();
});

copyAllImagesButton.addEventListener("click", async () => {
  const currentUrls = getExportableMediaUrls();
  if (!currentUrls.length) {
    flashAllImagesButton(mediaLinkState.activeTab === "videos" ? "暂无视频" : "暂无图片");
    return;
  }

  try {
    await copyText(JSON.stringify(currentUrls, null, 2));
    flashAllImagesButton("已复制");
  } catch (error) {
    flashAllImagesButton("复制失败");
  }
});

tabImages.addEventListener("click", () => {
  switchMediaTab("images");
});

tabVideos.addEventListener("click", () => {
  switchMediaTab("videos");
});

resultImage.addEventListener("touchstart", (event) => {
  if (carouselState.images.length <= 1) {
    return;
  }

  swipeState.startX = event.touches[0].clientX;
  swipeState.deltaX = 0;
});

resultImage.addEventListener("touchmove", (event) => {
  if (carouselState.images.length <= 1) {
    return;
  }

  swipeState.deltaX = event.touches[0].clientX - swipeState.startX;
});

resultImage.addEventListener("touchend", () => {
  if (carouselState.images.length <= 1) {
    return;
  }

  if (Math.abs(swipeState.deltaX) >= 44) {
    moveCarousel(swipeState.deltaX > 0 ? -1 : 1);
  }

  swipeState.startX = 0;
  swipeState.deltaX = 0;
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeHistoryMenu();
  }

  if (resultCard.classList.contains("hidden") || carouselState.images.length <= 1) {
    return;
  }

  if (event.key === "ArrowLeft") {
    moveCarousel(-1);
  }

  if (event.key === "ArrowRight") {
    moveCarousel(1);
  }
});

document.addEventListener("click", (event) => {
  if (
    historyMenu.classList.contains("hidden") ||
    historyMenu.contains(event.target) ||
    historyButton.contains(event.target)
  ) {
    return;
  }

  closeHistoryMenu();
});

function warnIfOpenedFromFile() {
  if (window.location.protocol !== "file:") {
    return;
  }

  setSubmitButtonState("disabled-service", "请先启动服务");
  urlInput.placeholder = "请先启动本地服务，再在浏览器里访问 http://127.0.0.1:3000/";
}

function loadUrlHistory() {
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, HISTORY_LIMIT);
  } catch (error) {
    return [];
  }
}

function saveUrlHistory() {
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(urlHistory));
  } catch (error) {
    return;
  }
}

function pushUrlHistory(noteUrl) {
  const normalized = String(noteUrl || "").trim();
  if (!normalized) {
    return;
  }

  urlHistory = [normalized, ...urlHistory.filter((item) => item !== normalized)].slice(0, HISTORY_LIMIT);
  saveUrlHistory();
  renderUrlHistory();
}

function renderUrlHistory() {
  historyMenu.innerHTML = "";

  if (!urlHistory.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "还没有历史记录，成功解析过的链接会出现在这里。";
    historyMenu.appendChild(empty);
    return;
  }

  urlHistory.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";
    button.textContent = item;
    button.title = item;
    button.addEventListener("click", () => {
      urlInput.value = item;
      resetSubmitButtonForNewInput();
      closeHistoryMenu();
      urlInput.focus();
    });
    historyMenu.appendChild(button);
  });
}

function toggleHistoryMenu() {
  const isHidden = historyMenu.classList.contains("hidden");
  if (isHidden) {
    openHistoryMenu();
    return;
  }

  closeHistoryMenu();
}

function openHistoryMenu() {
  renderUrlHistory();
  historyMenu.classList.remove("hidden");
  historyButton.classList.add("is-open");
  historyButton.setAttribute("aria-expanded", "true");
}

function closeHistoryMenu() {
  historyMenu.classList.add("hidden");
  historyButton.classList.remove("is-open");
  historyButton.setAttribute("aria-expanded", "false");
}

function resetSubmitButtonForNewInput() {
  if (submitButton.dataset.state === "disabled-service" || submitButton.dataset.state === "loading") {
    return;
  }

  setSubmitButtonState("idle");
}

function normalizeUrl(value) {
  const completed = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return new URL(completed).toString();
}

async function parseNoteFromUrl(noteUrl) {
  const response = await fetch("/api/parse", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: noteUrl }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    if (payload?.fallback) {
      return payload.fallback;
    }

    throw new Error(payload?.error || "本地解析接口调用失败。");
  }

  return response.json();
}

async function buildPromptRequestPayload(result, options = {}) {
  const target = normalizePromptTarget(options.target);
  const includeImages = target === "image" || target === "all";
  const rewriteInstruction =
    typeof options.rewriteInstruction === "string"
      ? options.rewriteInstruction.trim()
      : typeof options.rewriteDirection === "string"
        ? options.rewriteDirection.trim()
        : "";
  const imageInstruction =
    typeof options.imageInstruction === "string"
      ? options.imageInstruction.trim()
      : typeof options.imageDirection === "string"
        ? options.imageDirection.trim()
        : "";

  return {
    result: {
      title: result?.title || "",
      body: result?.body || "",
      tags: Array.isArray(result?.tags) ? result.tags : [],
      image: includeImages && typeof result?.image === "string" ? toSourceImageUrl(result.image) : "",
      images: includeImages ? collectMediaLinks(result).images : [],
    },
    target,
    rewriteInstruction,
    imageInstruction: target === "rewrite" ? "" : imageInstruction,
  };
}

async function requestAiPrompts(result, options = {}) {
  const payload = options.payload ? options.payload : await buildPromptRequestPayload(result, options);

  const response = await fetch("/api/prompts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(parsed?.error || "AI prompt request failed.");
    error.debugMessages = Array.isArray(parsed?.debugMessages) ? parsed.debugMessages : [];
    throw error;
  }

  return {
    rewritePrompt: typeof parsed?.rewritePrompt === "string" ? parsed.rewritePrompt.trim() : "",
    imagePrompt: typeof parsed?.imagePrompt === "string" ? parsed.imagePrompt.trim() : "",
    debugMessages: Array.isArray(parsed?.debugMessages) ? parsed.debugMessages : [],
  };
}

function normalizePromptTarget(target) {
  return target === "rewrite" || target === "image" ? target : "all";
}

function buildFallbackResult(noteUrl, rawText) {
  const title = noteUrlToLabel(noteUrl);
  const body =
    rawText.trim() || "当前未能完整获取内容，以下结果为基于链接信息生成的兜底展示。";

  return {
    image: FALLBACK_IMAGE,
    images: [FALLBACK_IMAGE],
    title,
    body,
    tags: SAMPLE_TAGS,
    meta: {
      usedFallback: true,
    },
  };
}

function renderResult(result) {
  currentParsedResult = result;
  emptyState.classList.add("hidden");
  resultCard.classList.remove("hidden");

  carouselState.images = normalizeImages(result);
  carouselState.index = 0;
  updateCarouselImage();
  renderCarouselDots();
  syncCarouselChrome();

  resultTitle.textContent = result.title || "-";
  resultBody.textContent = result.body || "-";
  setPromptMessagesOutput(rewriteMessagesOutput, []);
  setPromptMessagesOutput(imageMessagesOutput, []);
  resultPrompt.value = "正在调用 AI 生成仿写提示词，请稍候...";
  resultImagePrompt.value = "正在调用 AI 生成可直接用于生图的最终 Prompt，请稍候...";
  setRegenerateButtonState(regeneratePromptButton, true, "重新生成");
  setRegenerateButtonState(regenerateImagePromptButton, true, "重新生成");
  resetCopyButton();
  resetImagePromptButton();
  resetAllImagesButton();
  syncMediaLinks(result);
  void hydratePromptOutputs(result, {
    rewriteInstruction: getRewriteInstructionValue(),
    imageInstruction: getImageInstructionValue(),
  });

  resultTags.innerHTML = "";
  const safeTags = Array.isArray(result.tags) ? result.tags : [];
  safeTags.forEach((tagText) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `#${tagText}`;
    resultTags.appendChild(tag);
  });
}

function setPromptMessagesOutput(output, messages) {
  if (!output) {
    return;
  }

  output.value = Array.isArray(messages) && messages.length ? JSON.stringify(messages, null, 2) : "-";
}

function getPromptNotGeneratedText() {
  return "未通过大模型生成提示词";
}

function formatDirectRewritePromptOutput(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return getPromptNotGeneratedText();
  }

  return normalized;
}

async function hydratePromptOutputs(result, options = {}) {
  const rewriteRequestId = ++rewritePromptRequestSerial;
  const imageRequestId = ++imagePromptRequestSerial;
  const rewriteInstruction =
    typeof options.rewriteInstruction === "string"
      ? options.rewriteInstruction.trim()
      : "";
  const imageInstruction =
    typeof options.imageInstruction === "string"
      ? options.imageInstruction.trim()
      : "";

  void hydrateAiImagePrompt(result, imageRequestId, imageInstruction);

  try {
    const payload = await buildPromptRequestPayload(result, {
      target: "rewrite",
      rewriteInstruction,
      imageInstruction: "",
    });

    const aiPrompts = await requestAiPrompts(result, {
      target: "rewrite",
      rewriteInstruction,
      imageInstruction: "",
      payload,
    });

    if (rewriteRequestId === rewritePromptRequestSerial) {
      setPromptMessagesOutput(rewriteMessagesOutput, aiPrompts.debugMessages);
      resultPrompt.value = formatDirectRewritePromptOutput(aiPrompts.rewritePrompt);
    }
  } catch (error) {
    if (rewriteRequestId === rewritePromptRequestSerial) {
      resultPrompt.value = getPromptNotGeneratedText();
      setPromptMessagesOutput(rewriteMessagesOutput, error?.debugMessages);
    }
  }
}

async function hydrateAiImagePrompt(result, requestId, direction = "") {
  try {
    const payload = await buildPromptRequestPayload(result, {
      target: "image",
      rewriteInstruction: getRewriteInstructionValue(),
      imageInstruction: direction,
    });

    const aiPromptsPromise = requestAiPrompts(result, {
      target: "image",
      rewriteInstruction: getRewriteInstructionValue(),
      imageInstruction: direction,
      payload,
    });

    const aiPrompts = await aiPromptsPromise;
    if (requestId !== imagePromptRequestSerial) {
      return;
    }

    setPromptMessagesOutput(imageMessagesOutput, []);
    resultImagePrompt.value = aiPrompts.imagePrompt || getPromptNotGeneratedText();
  } catch (error) {
    if (requestId !== imagePromptRequestSerial) {
      return;
    }
    resultImagePrompt.value = getPromptNotGeneratedText();
    setPromptMessagesOutput(imageMessagesOutput, []);
  }
}

async function regenerateRewritePrompt() {
  if (!currentParsedResult) {
    return;
  }

  const requestId = ++rewritePromptRequestSerial;
  const rewriteInstruction = getRewriteInstructionValue();
  setRegenerateButtonState(regeneratePromptButton, false, "正在生成...");
  resultPrompt.value = "正在根据你和 AI 的对话要求重新生成，请稍候...";

  try {
    const aiPrompts = await requestAiPrompts(currentParsedResult, {
      target: "rewrite",
      rewriteInstruction,
      imageInstruction: "",
    });

    if (requestId !== rewritePromptRequestSerial) {
      return;
    }

    resultPrompt.value = formatDirectRewritePromptOutput(aiPrompts.rewritePrompt);
  } catch (error) {
    if (requestId !== rewritePromptRequestSerial) {
      return;
    }

    resultPrompt.value = getPromptNotGeneratedText();
  } finally {
    if (requestId === rewritePromptRequestSerial) {
      setRegenerateButtonState(regeneratePromptButton, true, "重新生成");
    }
  }
}

async function regenerateImagePrompt() {
  if (!currentParsedResult) {
    return;
  }

  const requestId = ++imagePromptRequestSerial;
  const imageInstruction = getImageInstructionValue();
  setRegenerateButtonState(regenerateImagePromptButton, false, "正在生成...");
  resultImagePrompt.value = "正在调用 AI 重新生成生图最终 Prompt，请稍候...";

  try {
    const aiPrompts = await requestAiPrompts(currentParsedResult, {
      target: "image",
      rewriteInstruction: getRewriteInstructionValue(),
      imageInstruction,
    });
    if (requestId !== imagePromptRequestSerial) {
      return;
    }

    setPromptMessagesOutput(imageMessagesOutput, []);
      resultImagePrompt.value = aiPrompts.imagePrompt || getPromptNotGeneratedText();
  } catch (error) {
    if (requestId !== imagePromptRequestSerial) {
      return;
    }

    resultImagePrompt.value = getPromptNotGeneratedText();
    setPromptMessagesOutput(imageMessagesOutput, []);
  } finally {
    if (requestId === imagePromptRequestSerial) {
      setRegenerateButtonState(regenerateImagePromptButton, true, "重新生成");
    }
  }
}

function getRewriteInstructionValue() {
  return typeof rewriteDirectionInput?.value === "string" ? rewriteDirectionInput.value.trim() : "";
}

function getImageInstructionValue() {
  return typeof imageDirectionInput?.value === "string" ? imageDirectionInput.value.trim() : "";
}

function inferAutoImageTypeLabel(result) {
  const combined = [
    String(result?.title || "").trim(),
    String(result?.body || "").trim(),
    Array.isArray(result?.tags) ? result.tags.join(" ") : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (/(钙|维生素|保健|营养|胶囊|片剂|补充剂|益生菌)/.test(combined)) return "电商保健品海报/图";
  if (/(咖啡|拿铁|美式|奶茶|果茶|茶饮|饮品|柠檬茶|奶盖)/.test(combined)) return "饮品种草海报/图";
  if (/(护肤|精华|面霜|水乳|彩妆|口红|粉底|香水)/.test(combined)) return "护肤彩妆海报/图";
  if (/(包包|鞋子|穿搭|单品|服装|饰品|配件)/.test(combined)) return "穿搭单品海报/图";
  return "产品海报/图";
}

function setRegenerateButtonState(button, enabled, text) {
  if (!button) {
    return;
  }

  button.disabled = !enabled;
  button.textContent = text;
  button.classList.toggle("is-busy", !enabled);
}

function syncMediaLinks(result) {
  const links = collectMediaLinks(result);
  mediaLinkState.images = links.images;
  mediaLinkState.videos = links.videos;

  if (mediaLinkState.activeTab === "videos" && !mediaLinkState.videos.length && mediaLinkState.images.length) {
    mediaLinkState.activeTab = "images";
  }

  renderMediaTabs();
  renderImageLinks(getActiveMediaUrls());
}

function collectMediaLinks(result) {
  const rawImages = Array.isArray(result?.images) ? result.images : carouselState.images;
  const rawVideos = Array.isArray(result?.videos)
    ? result.videos
    : [result?.video].filter(Boolean);

  const images = dedupeMediaUrls(
    rawImages
      .map((url) => toSourceImageUrl(url))
      .filter(Boolean)
      .filter((url) => !isVideoUrl(url))
  );

  const videos = dedupeMediaUrls(
    rawVideos
      .map((url) => toSourceImageUrl(url))
      .filter(Boolean)
      .filter((url) => isVideoUrl(url))
  );

  return { images, videos };
}

function collectRenderableImageUrls(result) {
  const rawImages = Array.isArray(result?.images) ? result.images : [];
  const primaryImage = typeof result?.image === "string" ? result.image : "";
  const merged = primaryImage ? [primaryImage, ...rawImages] : [...rawImages];
  const uniqueMap = new Map();

  merged.forEach((mediaUrl) => {
    const sourceUrl = toSourceImageUrl(mediaUrl);
    if (!sourceUrl || isVideoUrl(sourceUrl)) {
      return;
    }

    const key = buildImageDedupKey(sourceUrl);
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, mediaUrl);
    }
  });

  return [...uniqueMap.values()];
}

function dedupeMediaUrls(urls) {
  const uniqueMap = new Map();

  urls.forEach((url) => {
    const key = buildImageDedupKey(url);
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, url);
    }
  });

  return [...uniqueMap.values()];
}

function switchMediaTab(tabName) {
  mediaLinkState.activeTab = tabName;
  renderMediaTabs();
  renderImageLinks(getActiveMediaUrls());
  resetAllImagesButton();
}

function renderMediaTabs() {
  const isImages = mediaLinkState.activeTab === "images";
  tabImages.classList.toggle("is-active", isImages);
  tabVideos.classList.toggle("is-active", !isImages);
}

function getActiveMediaUrls() {
  return mediaLinkState.activeTab === "videos" ? mediaLinkState.videos : mediaLinkState.images;
}

function getExportableMediaUrls() {
  return getActiveMediaUrls().slice(0, MAX_REFERENCE_MEDIA);
}

function renderImageLinks(urls) {
  resultImageLinks.innerHTML = "";

  const safeUrls = Array.isArray(urls) ? urls : [];
  if (!safeUrls.length) {
    const empty = document.createElement("p");
    empty.textContent = mediaLinkState.activeTab === "videos" ? "暂无视频链接" : "暂无图片链接";
    resultImageLinks.appendChild(empty);
    return;
  }

  safeUrls.forEach((mediaUrl, index) => {
    const item = document.createElement("div");
    item.className = "image-link-item";

    const label = document.createElement("span");
    label.className = "image-link-index";
    label.textContent = `${mediaLinkState.activeTab === "videos" ? "视频" : "图片"} ${index + 1}`;

    const input = document.createElement("input");
    input.className = "image-link-input";
    input.type = "text";
    input.readOnly = true;
    input.value = mediaUrl;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "image-link-copy";
    button.textContent = "复制";
    button.addEventListener("click", async () => {
      try {
        await copyText(mediaUrl);
        button.textContent = "已复制";
        window.setTimeout(() => {
          button.textContent = "复制";
        }, 1200);
      } catch (error) {
        button.textContent = "失败";
        window.setTimeout(() => {
          button.textContent = "复制";
        }, 1200);
      }
    });

    item.append(label, input, button);
    resultImageLinks.appendChild(item);
  });
}

function buildRewritePromptV2(result, direction = "") {
  const profile = analyzeNoteProfile(result);
  const title = String(result?.title || "").trim() || "未识别标题";
  const body = String(result?.body || "").trim() || "未识别正文";
  const tags = Array.isArray(result?.tags)
    ? result.tags.map((tag) => String(tag || "").trim()).filter(Boolean)
    : [];

  const lines = [
    "请基于下面这条原笔记，输出一份给其他 AI 使用的生文 PROMPT 模板。",
    "先严格拆解原笔记，再基于拆解结果整理最终模板，不要直接写成新笔记。",
    "",
    `原笔记标题：${title}`,
    `原笔记正文：${body}`,
    `原笔记标签：${tags.length ? tags.join("、") : "无"}`,
    "",
    "输出结构固定为：",
    "【笔记拆解】",
    "【1. 标题结构】",
    "【2. 开头钩子前N句】",
    "【3. 正文信息模块】",
    "【4. 高频元素】",
    "【5. 结尾动作】",
    "【最终生文 PROMPT 模板】",
    "",
    "请严格执行以下要求：",
    "1. 必须围绕标题、正文、标签来拆解，不能换成其他分析框架。",
    "2. 【1. 标题结构】必须明确拆出：数字、疑问、情绪、关键词；没有的项写“无”。",
    "3. 【2. 开头钩子前N句】必须分析正文开头前 N 句属于疑问、惊讶、对比、场景代入中的哪类钩子，并引用原句。",
    "4. 【3. 正文信息模块】必须按逻辑分段或模块化方式拆正文，例如场景描述、故事、案例、数据、方法、体验、结论。",
    "5. 【4. 高频元素】必须从标题、正文、标签里提炼数字、对比、避坑、列表、emoji、符号、标签关键词、口头表达等高频元素。",
    "6. 【5. 结尾动作】必须判断结尾是否有点赞、收藏、评论、关注、分享、跳转等动作引导；没有就如实写无。",
    "7. 【最终生文 PROMPT 模板】必须基于前面 5 项拆解结果整理，写成可直接复制给其他 AI 的模板。",
    "8. 最终模板里要明确标题如何写、开头如何下钩子、正文按什么模块展开、哪些高频元素要保留、结尾如何收束、标签如何组织。",
    `9. 内容方向定位参考：${profile.topicPosition}。`,
    `10. 内容主体聚焦参考：${profile.subjectFocus}。`,
    `11. 写作类型定位参考：${profile.categoryLabel}。`,
    `12. 结构节奏参考：${profile.structureHint}。`,
    `13. 语气风格参考：${profile.toneHint}。`,
    `14. 重点信息参考：${profile.focusHint}。`,
    `15. 叙述视角参考：${profile.perspectiveHint}。`,
    `16. 开头方式参考：${profile.openingHint}。`,
    `17. 中段重点参考：${profile.middleHint}。`,
    `18. 结尾方式参考：${profile.endingHint}。`,
    "19. 标签不能只罗列，要说明标签在关键词覆盖、情绪强化、搜索分发或话题归类上的作用。",
    "20. 不要套话、空话、总结腔或行业通稿，要像真实用户亲自写的。",
    "21. 允许模仿写法，但不能照抄原句，也不能编造原文没有的事实、数据、体验、效果或立场。",
    "22. 标题建议不超过18字；正文建议控制在200-600字；标签建议5-8个。",
  ];

  if (direction) {
    lines.push("", `用户补充要求：${direction}`);
    lines.push("执行时把这条内容视为用户当前轮直接补充给 AI 的要求，但不要偏离原始内容主轴。");
  }

  lines.push("", "请直接输出可复制使用的完整结果，先拆解，再输出最终生文 PROMPT 模板。");
  return lines.join("\n");
}

function buildRewritePromptLegacy(result, direction = "") {
  const profile = analyzeNoteProfile(result);

  const lines = [
    "请写一篇可直接发布的小红书笔记。",
    "要求：",
    "1. 新标题控制在18字内。",
    "2. 正文控制在400-600字。",
    "3. 标签输出5-8个。",
    `4. 内容方向定位为：${profile.topicPosition}。`,
    `5. 内容主体聚焦为：${profile.subjectFocus}。`,
    `6. 写作类型定位为：${profile.categoryLabel}。`,
    `7. 成文后的结构安排、段落节奏参考这种风格：${profile.structureHint}。`,
    `8. 整体语气请保持这种感觉：${profile.toneHint}。`,
    "9. 不要套话、空话和模板化表达，句子要自然，有真人表达感。",
    `10. 内容重点请围绕这类主题展开：${profile.focusHint}。`,
    `11. 建议采用这种叙述视角：${profile.perspectiveHint}。`,
    `12. 开头方式参考：${profile.openingHint}。`,
    `13. 中间段落重点参考：${profile.middleHint}。`,
    `14. 结尾方式参考：${profile.endingHint}。`,
    "15. 内容要有清晰的信息层次、具体细节和真实感，不能有AI生成痕迹。",
    "",
    "输出格式：",
    "标题：",
    "正文：",
    "标签：",
  ];

  if (direction) {
    lines.splice(
      15,
      0,
      "",
      "用户补充要求：",
      direction,
      "执行时把这条内容视为用户当前轮直接补充给 AI 的要求，但不能覆盖原始内容主轴。"
    );
  }

  return lines.join("\n");
}

function buildRewritePrompt(result, direction = "") {
  return buildRewritePromptV2(result, direction);
}

function analyzeNoteProfile(result) {
  const category = inferContentCategory(result);

  return {
    categoryLabel: category.label,
    topicPosition: inferTopicPosition(result),
    subjectFocus: inferSubjectFocus(result),
    toneHint: inferToneHint(result),
    structureHint: inferStructureHint(result),
    focusHint: category.focusHint,
    perspectiveHint: inferPerspectiveHint(result, category.key),
    openingHint: inferOpeningHint(category.key),
    middleHint: inferMiddleHint(category.key),
    endingHint: inferEndingHint(category.key),
  };
}

function inferSubjectFocus(result) {
  const combined = buildAnalysisText(result);

  const subjectRules = [
    { pattern: /(奶茶|咖啡|果茶|冰美式|拿铁|饮品|气泡水|茶饮|特调)/, label: "饮品" },
    { pattern: /(蛋糕|甜品|面包|火锅|烤肉|米线|烧烤|小吃|早餐|午餐|晚餐|菜品|美食|料理)/, label: "美食" },
    { pattern: /(医生|博主|店员|老板|男生|女生|阿姨|孩子|朋友|情侣|主理人|人物)/, label: "人物" },
    { pattern: /(风景|日落|日出|海边|山里|街景|湖景|雪景|夜景|景色|拍照地)/, label: "景色" },
    { pattern: /(门店|小店|餐厅|咖啡馆|酒馆|商场|展览|打卡地|店铺|地点)/, label: "店铺或地点" },
    { pattern: /(包包|鞋子|裙子|裤子|外套|耳环|项链|衣服|穿搭单品)/, label: "穿搭单品" },
    { pattern: /(面膜|精华|面霜|口红|粉底|洗发水|护肤品|彩妆|产品|单品)/, label: "产品或物品" },
    { pattern: /(方子|食谱|茶方|药材|穴位|动作|方法|技巧|步骤)/, label: "方法或知识点" },
  ];

  for (const rule of subjectRules) {
    if (rule.pattern.test(combined)) {
      return rule.label;
    }
  }

  return "具体生活场景中的核心对象";
}

function inferTopicPosition(result) {
  const combined = buildAnalysisText(result);

  const topicRules = [
    {
      pattern: /(探店|门店|餐厅|咖啡馆|火锅|烤肉|甜品|下午茶|酒馆|点单|菜品|本地生活|同城)/,
      label: "本地生活或日常美食分享",
    },
    {
      pattern: /(中医|体质|养生|调理|脾胃|气血|湿气|经络|穴位|食疗|方子|舌苔)/,
      label: "中医知识分析或养生科普",
    },
    {
      pattern: /(护肤|面膜|精华|乳液|面霜|防晒|毛孔|痘痘|敏感肌|干皮|油皮|刷酸|修护)/,
      label: "护肤经验分享",
    },
    {
      pattern: /(化妆|底妆|口红|眼影|腮红|粉底|遮瑕|妆容|彩妆|睫毛|眉毛)/,
      label: "美妆分享或妆容推荐",
    },
    {
      pattern: /(穿搭|上身|显瘦|显高|搭配|裤子|裙子|外套|鞋子|通勤穿搭|look)/,
      label: "穿搭分享或单品推荐",
    },
    {
      pattern: /(减肥|健身|运动|跑步|增肌|燃脂|训练|塑形|体态|热量)/,
      label: "健身运动或身材管理分享",
    },
    {
      pattern: /(备考|学习|复习|笔记方法|考试|上岸|刷题|英语|雅思|考研|面试)/,
      label: "学习方法或备考经验分享",
    },
    {
      pattern: /(旅游|旅行|景点|行程|住宿|酒店|攻略|拍照打卡|出行|城市漫游)/,
      label: "旅行攻略或出行分享",
    },
    {
      pattern: /(母婴|宝宝|孕期|辅食|带娃|育儿|哄睡|亲子)/,
      label: "母婴育儿分享",
    },
    {
      pattern: /(职场|上班|通勤|工作|面试|简历|转行|副业|办公室|汇报)/,
      label: "职场经验或工作日常分享",
    },
    {
      pattern: /(家居|装修|租房|收纳|卧室|客厅|清洁|家务|小家电|软装)/,
      label: "家居生活分享",
    },
  ];

  for (const rule of topicRules) {
    if (rule.pattern.test(combined)) {
      return rule.label;
    }
  }

  return "生活方式经验分享";
}

function inferContentCategory(result) {
  const combined = buildAnalysisText(result);

  if (/(教程|步骤|方法|技巧|攻略|清单|流程|怎么做|保姆级)/.test(combined)) {
    return {
      key: "tutorial",
      label: "教程分享",
      focusHint: "实用步骤、执行方法、关键细节和结果反馈",
    };
  }

  if (/(测评|评测|对比|区别|实测|横评|盘点)/.test(combined)) {
    return {
      key: "review",
      label: "测评对比",
      focusHint: "对比依据、使用感受、优缺点和结论建议",
    };
  }

  if (/(避坑|踩雷|别买|不要买|后悔|劝退|雷品)/.test(combined)) {
    return {
      key: "warning",
      label: "避坑提醒",
      focusHint: "问题触发点、踩雷原因、真实感受和避坑建议",
    };
  }

  if (/(推荐|种草|回购|爱用|宝藏|值得买|无限回购)/.test(combined)) {
    return {
      key: "recommendation",
      label: "种草推荐",
      focusHint: "使用场景、核心亮点、体验细节和推荐理由",
    };
  }

  return {
    key: "experience",
    label: "经验分享",
    focusHint: "真实经历、个人感受、有效做法和实际收获",
  };
}

function inferToneHint(result) {
  const combined = buildAnalysisText(result);

  if (/(避坑|踩雷|别买|千万|后悔|劝退)/.test(combined)) {
    return "真实直接，有提醒感和经验总结感";
  }

  if (/(测评|对比|评测|区别|实测)/.test(combined)) {
    return "理性清晰，像亲测后的总结分享";
  }

  if (/(推荐|回购|爱用|值得买|种草|宝藏)/.test(combined)) {
    return "自然种草，有体验感和安利感";
  }

  if (/(教程|步骤|方法|技巧|干货|攻略)/.test(combined)) {
    return "清楚利落，像在做实用经验分享";
  }

  return "真诚自然，像本人分享体验，不夸张不生硬";
}

function inferImageStyleHint(result, profile) {
  const combined = buildAnalysisText(result);

  if (/(职场|面试|办公室|简历|上班|通勤)/.test(combined)) {
    return "真实职场场景摄影，偏自然纪实，干净明亮，像高质量生活方式内容配图";
  }

  if (/(教程|步骤|技巧|干货|攻略)/.test(combined)) {
    return "信息感较强的生活方式场景视觉，画面清晰克制，重点明确，有轻微 editorial 感";
  }

  if (/(穿搭|妆容|护肤|单品)/.test(combined)) {
    return "精致但不过度修饰的审美场景摄影，保留真实材质和空间质感";
  }

  if (profile.categoryLabel === "经验分享") {
    return "像小红书高质量经验帖配图，真实自然，生活感强，轻微氛围包装";
  }

  return "真实自然的生活方式摄影风格，保留内容感和可读性，不要过度艺术化";
}

function inferImageCompositionHint(result, profile) {
  const combined = buildAnalysisText(result);
  const imageCount = Array.isArray(result.images) ? result.images.length : 1;

  if (/(人物|女生|男生|博主|朋友|主理人)/.test(combined)) {
    return "中近景或半身取景逻辑，视觉焦点明确，背景简洁，让主体产品和人物关系自然成立";
  }

  if (/(产品|单品|物品|护肤品|彩妆|包包|鞋子)/.test(combined)) {
    return "主视觉位于前景或中部，留白适中，层次清楚，主体产品落位明确";
  }

  if (imageCount >= 3) {
    return "参考组图里常见的封面式取景，优先选择稳定、清楚、易读的主画面构图";
  }

  return `构图稳定，主次分明，留出明确视觉焦点与环境空间，适合作为${profile.topicPosition}场景模板`;
}

function inferImageColorHint(result, profile) {
  const combined = buildAnalysisText(result);

  if (/(职场|面试|办公室|工位|电脑|会议室|通勤)/.test(combined)) {
    return "偏中性、克制、干净的都市色系，可加入少量高亮重点色增强信息感";
  }

  if (/(咖啡|餐厅|探店|下午茶|门店|甜品|饮品)/.test(combined)) {
    return "暖调生活方式色彩，低饱和主色配合局部食物或空间点缀色";
  }

  if (/(护肤|彩妆|产品|单品|穿搭)/.test(combined)) {
    return "主色明确，背景色干净，局部重点色被突出，整体偏审美向";
  }

  return `围绕“${profile.topicPosition}”形成统一而清楚的色彩组织，主次分明，不过度堆色`;
}

function inferImageLayoutHint(result, profile) {
  const combined = buildAnalysisText(result);

  if (/(教程|步骤|方法|攻略|清单|干货)/.test(combined)) {
    return "信息组织清楚，画面像内容封面或信息型配图，视觉重点明确，适合承载标题感";
  }

  if (/(职场|经验分享|面试|工作)/.test(combined)) {
    return "整体偏内容封面逻辑，焦点区与背景关系清楚，有明显视觉中心，适合社媒首图";
  }

  if (/(产品|单品|护肤|彩妆|穿搭)/.test(combined)) {
    return "版面偏审美陈列式，主视觉摆位有节奏，留白和细节辅助共同建立高级感";
  }

  return `围绕${profile.topicPosition}形成稳定的视觉层级，让焦点区、环境和辅助元素各自有清晰位置`;
}

function inferImageMediumHint(result, profile) {
  const combined = buildAnalysisText(result);

  if (/(渲染|3d|三维|建模|c4d|海报|kv|插画)/.test(combined)) {
    return "更偏设计渲染或视觉合成方向，可用精修质感处理";
  }

  if (/(产品|单品|护肤|彩妆|包包|鞋子)/.test(combined)) {
    return "大概率接近实拍静物或棚拍产品图，也可允许轻微广告级后期";
  }

  if (/(人物|职场|通勤|面试|生活|经验分享)/.test(combined)) {
    return "更接近真实生活方式实拍摄影，可保留轻微 editorial 感，但主视觉应自然可信";
  }

  return `优先判断为与“${profile.topicPosition}”匹配的真实摄影或轻设计化视觉，不建议直接做重渲染风格`;
}

function inferImageLightingHint(result, profile) {
  const combined = buildAnalysisText(result);

  if (/(职场|办公室|通勤|人物|面试)/.test(combined)) {
    return "自然光或柔和环境光为主，焦点区轮廓清楚，避免过硬补光和影楼感";
  }

  if (/(产品|护肤|彩妆|单品)/.test(combined)) {
    return "受控柔光，亮部干净，阴影克制，重点突出环境材质和轮廓";
  }

  if (/(餐厅|咖啡|探店|甜品|饮品)/.test(combined)) {
    return "生活方式场景光，整体柔和，有局部高光和空间氛围，不要死白平光";
  }

  return `围绕${profile.topicPosition}建立清楚、自然、可读的光线关系，亮部不过曝，暗部不糊成一片`;
}

function inferImageMaterialHint(result, profile) {
  const combined = buildAnalysisText(result);

  if (/(人物|女生|男生|博主|朋友)/.test(combined)) {
    return "服装面料、桌面、墙面与空间材质要真实可感，保留细节，不做塑料质感处理";
  }

  if (/(产品|护肤|彩妆|单品|包包|鞋子)/.test(combined)) {
    return "重点呈现玻璃、金属、纸面、木质等常见表面的反光、纹理和材质层次，让画面具备商业级质感";
  }

  if (/(甜品|饮品|美食|料理)/.test(combined)) {
    return "桌面、液体、陶瓷、玻璃等表面质感都要清楚，避免糊成一片";
  }

  return `突出与${profile.topicPosition}相符的真实材质与细节层次，让画面既清楚又有触感`;
}

function inferImageAtmosphereHint(result, profile) {
  const combined = buildAnalysisText(result);

  if (/(职场|面试|工作|上班)/.test(combined)) {
    return "专业、克制、真实、有内容感，像成熟账号的高质量经验帖配图";
  }

  if (/(推荐|种草|爱用|回购)/.test(combined)) {
    return "轻松自然、有审美感和分享欲，但不过度夸张，不要廉价营销感";
  }

  if (/(教程|步骤|攻略|方法)/.test(combined)) {
    return "清晰利落、重点明确，像高完成度的信息型视觉";
  }

  return `保持${profile.topicPosition}对应的真实内容氛围，让画面既有传播感，也有可信度`;
}

function inferImageQualityHint(result, profile) {
  const combined = buildAnalysisText(result);

  if (/(人物|职场|生活|经验分享|通勤)/.test(combined)) {
    return "达到高质量社交媒体实拍封面图水准，比例自然，细节完整，画面干净，像成熟博主真实拍摄成片";
  }

  if (/(产品|护肤|彩妆|单品)/.test(combined)) {
    return "达到商业级产品图或品牌社媒图水准，边缘锐利，材质准确，构图稳定，精致但不假";
  }

  if (/(美食|甜品|饮品|探店)/.test(combined)) {
    return "达到优质生活方式内容图水准，食物与环境都有真实质感，颜色诱人但不过饱和";
  }

  return `整体质量要对齐高质量${profile.topicPosition}内容图：主次明确、细节充分、观感成熟、真实自然`;
}

function inferPromptDirectionHint(result, profile) {
  return [
    "保留明确的主体落位空间",
    `沿用${profile.topicPosition}对应的视觉语境`,
    "复用风格、构图、用色、光线、材质和媒介属性的方法论，而不是复制原图细节",
    "让不同帖子都能套用成同风格方向的高质量场景迁移模板"
  ].join("；");
}

function formatPromptTags(tags) {
  const safeTags = Array.isArray(tags) ? tags.map((tag) => String(tag || "").trim()).filter(Boolean) : [];
  return safeTags.length ? safeTags.slice(0, 6).join("、") : "真实感、生活方式、内容感、自然构图";
}

function buildAnalysisText(result) {
  const title = String(result.title || "");
  const body = String(result.body || "");
  const tags = Array.isArray(result.tags) ? result.tags.map((tag) => String(tag || "")) : [];
  return `${title} ${body} ${tags.join(" ")}`.toLowerCase();
}

function inferStructureHint(result) {
  const body = String(result.body || "").trim();
  const lineCount = body ? body.split(/\n+/).filter(Boolean).length : 0;

  if (lineCount >= 5) {
    return "分段清楚，按场景或要点逐步展开";
  }

  if (body.length >= 180) {
    return "先抛出结论，再补充细节和感受";
  }

  return "短句开场，快速给出重点，再补充理由和结果";
}

function inferPerspectiveHint(result, categoryKey) {
  const body = String(result.body || "");
  const firstPersonHits = (body.match(/我|自己|觉得|用过|试了|发现/g) || []).length;

  if (firstPersonHits >= 3) {
    return "第一人称真实分享，像本人亲身经历后的表达";
  }

  if (categoryKey === "tutorial") {
    return "像在手把手教人，明确但不要生硬";
  }

  return "以个人体验视角展开，让内容更像真实用户分享";
}

function inferOpeningHint(categoryKey) {
  if (categoryKey === "warning") {
    return "开头先点出问题或踩雷结论，迅速建立阅读动机";
  }

  if (categoryKey === "review") {
    return "开头先抛出对比结论或核心判断，再展开依据";
  }

  if (categoryKey === "tutorial") {
    return "开头先交代场景和目标，再自然进入步骤或方法";
  }

  if (categoryKey === "recommendation") {
    return "开头先抛出推荐结论或使用后的惊喜感受";
  }

  return "开头直接切入主题，用一句话抛出核心观点或体验";
}

function inferMiddleHint(categoryKey) {
  if (categoryKey === "warning") {
    return "中间重点写清问题细节、原因、表现和具体提醒";
  }

  if (categoryKey === "review") {
    return "中间按维度展开对比，写具体体验，不要空泛评价";
  }

  if (categoryKey === "tutorial") {
    return "中间按步骤或要点展开，每段都给出能执行的细节";
  }

  if (categoryKey === "recommendation") {
    return "中间重点写使用场景、亮点细节、前后感受变化";
  }

  return "中间围绕经历、感受和有效做法展开，层次清楚";
}

function inferEndingHint(categoryKey) {
  if (categoryKey === "warning") {
    return "结尾用一句提醒或建议收束，态度明确";
  }

  if (categoryKey === "review") {
    return "结尾给出适合人群、购买建议或最终结论";
  }

  if (categoryKey === "tutorial") {
    return "结尾简短总结方法效果，保持利落";
  }

  if (categoryKey === "recommendation") {
    return "结尾自然回扣推荐理由，再补上适合发布的标签";
  }

  return "结尾回扣核心观点，用自然口吻收束并补标签";
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  resultPrompt.focus();
  resultPrompt.select();
  resultPrompt.setSelectionRange(0, text.length);

  const isCopied = document.execCommand("copy");
  if (!isCopied) {
    throw new Error("Copy command failed");
  }
}

function flashCopyButton(label) {
  copyPromptButton.textContent = label;
  copyPromptButton.classList.toggle("is-copied", label === "已复制");
  window.clearTimeout(copyPromptResetTimer);
  copyPromptResetTimer = window.setTimeout(() => {
    resetCopyButton();
  }, 1500);
}

function resetCopyButton() {
  copyPromptButton.textContent = "一键复制";
  copyPromptButton.classList.remove("is-copied");
}

function flashImagePromptButton(label) {
  copyImagePromptButton.textContent = label;
  copyImagePromptButton.classList.toggle("is-copied", label === "已复制");
  window.clearTimeout(copyImagePromptResetTimer);
  copyImagePromptResetTimer = window.setTimeout(() => {
    resetImagePromptButton();
  }, 1500);
}

function resetImagePromptButton() {
  copyImagePromptButton.textContent = "一键复制";
  copyImagePromptButton.classList.remove("is-copied");
}

function flashAllImagesButton(label) {
  copyAllImagesButton.textContent = label;
  copyAllImagesButton.classList.toggle("is-copied", label === "已复制");
  window.clearTimeout(copyAllImagesResetTimer);
  copyAllImagesResetTimer = window.setTimeout(() => {
    resetAllImagesButton();
  }, 1500);
}

function resetAllImagesButton() {
  copyAllImagesButton.textContent = "复制 JSON";
  copyAllImagesButton.classList.remove("is-copied");
}

function normalizeImages(result) {
  const unique = collectRenderableImageUrls(result);
  return unique.length ? unique : [FALLBACK_IMAGE];
}

function updateCarouselImage() {
  const currentImage = carouselState.images[carouselState.index] || FALLBACK_IMAGE;

  resultImage.onerror = () => {
    resultImage.onerror = null;
    resultImage.src = FALLBACK_IMAGE;
  };

  resultImage.style.opacity = "0.24";
  resultImage.src = currentImage;
  requestAnimationFrame(() => {
    resultImage.style.opacity = "1";
  });
}

function renderCarouselDots() {
  carouselDots.innerHTML = "";

  carouselState.images.forEach((_, index) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "carousel-dot";
    dot.setAttribute("aria-label", `查看第 ${index + 1} 张图片`);
    dot.addEventListener("click", () => {
      carouselState.index = index;
      updateCarouselImage();
      syncCarouselChrome();
    });
    carouselDots.appendChild(dot);
  });
}

function syncCarouselChrome() {
  const total = carouselState.images.length;
  const isMulti = total > 1;

  carouselOverlay.classList.toggle("hidden", !isMulti);
  carouselDots.classList.toggle("hidden", !isMulti);
  carouselCounter.textContent = `${carouselState.index + 1} / ${total}`;

  const dots = carouselDots.querySelectorAll(".carousel-dot");
  dots.forEach((dot, index) => {
    dot.classList.toggle("is-active", index === carouselState.index);
    dot.setAttribute("aria-pressed", index === carouselState.index ? "true" : "false");
  });
}

function moveCarousel(direction) {
  const total = carouselState.images.length;
  if (total <= 1) {
    return;
  }

  carouselState.index = (carouselState.index + direction + total) % total;
  updateCarouselImage();
  syncCarouselChrome();
}

function setSubmitButtonState(state, label = DEFAULT_SUBMIT_BUTTON_TEXT) {
  submitButton.dataset.state = state;
  submitButton.textContent = label;
  submitButton.classList.remove("is-loading", "is-success", "is-disabled-service");

  if (state === "loading") {
    submitButton.disabled = true;
    submitButton.classList.add("is-loading");
    return;
  }

  if (state === "success") {
    submitButton.disabled = false;
    submitButton.classList.add("is-success");
    return;
  }

  if (state === "disabled-service") {
    submitButton.disabled = true;
    submitButton.classList.add("is-disabled-service");
    return;
  }

  submitButton.disabled = false;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function noteUrlToLabel(noteUrl) {
  try {
    const { pathname, hostname } = new URL(noteUrl);
    const segment = pathname
      .split("/")
      .filter(Boolean)
      .pop();

    if (!segment) {
      return hostname;
    }

    return decodeURIComponent(segment).replace(/[-_]/g, " ");
  } catch (error) {
    return noteUrl || "原始链接内容";
  }
}

function toSourceImageUrl(imageUrl) {
  try {
    const parsed = new URL(imageUrl, window.location.origin);
    let sourceUrl = parsed;

    if (parsed.pathname === "/api/image") {
      const rawUrl = parsed.searchParams.get("url");
      if (rawUrl) {
        sourceUrl = new URL(decodeURIComponent(rawUrl));
      }
    }

    return normalizeMediaUrlForList(sourceUrl);
  } catch (error) {
    return imageUrl;
  }
}

function isVideoUrl(url) {
  return /\.(mp4|mov|m4v|webm|m3u8)(\?|#|$)/i.test(url);
}

function normalizeMediaUrlForList(sourceUrl) {
  const cleanUrl = new URL(sourceUrl.toString());

  for (const key of [...cleanUrl.searchParams.keys()]) {
    if (/^(w|h|width|height|quality|q|format|fit|resize|imageview2|x-oss-process|fm|fmt|ext)$/i.test(key)) {
      cleanUrl.searchParams.delete(key);
    }
  }

  cleanUrl.hash = "";
  const query = cleanUrl.searchParams.toString();
  return `${cleanUrl.origin}${cleanUrl.pathname}${query ? `?${query}` : ""}`;
}

function toDownloadableMediaUrl(sourceUrl) {
  const cleanUrl = new URL(sourceUrl.toString());
  const pathname = cleanUrl.pathname;
  const explicitExt = getMediaExtensionFromPath(pathname);
  const inferredExt = explicitExt || inferMediaExtension(cleanUrl);

  for (const key of [...cleanUrl.searchParams.keys()]) {
    if (/^(w|h|width|height|quality|q|format|fit|resize|imageview2|x-oss-process|fm|fmt|ext)$/i.test(key)) {
      cleanUrl.searchParams.delete(key);
    }
  }

  if (explicitExt) {
    cleanUrl.hash = "";
    return `${cleanUrl.origin}${cleanUrl.pathname}`;
  }

  if (inferredExt) {
    cleanUrl.hash = "";
    return `${cleanUrl.origin}${cleanUrl.pathname}.${inferredExt}`;
  }

  return `${cleanUrl.origin}${cleanUrl.pathname}`;
}

function getMediaExtensionFromPath(pathname) {
  const match = pathname.match(/\.(jpg|jpeg|png|webp|gif|bmp|svg|avif|heic|mp4|mov|m4v|webm|m3u8)$/i);
  return match ? match[1].toLowerCase() : "";
}

function inferMediaExtension(url) {
  const directFormat =
    url.searchParams.get("format") ||
    url.searchParams.get("fm") ||
    url.searchParams.get("fmt") ||
    url.searchParams.get("ext");

  if (directFormat && /^(jpg|jpeg|png|webp|gif|bmp|svg|avif|heic|mp4|mov|m4v|webm|m3u8)$/i.test(directFormat)) {
    return directFormat.toLowerCase();
  }

  const processValue = url.searchParams.get("x-oss-process") || "";
  const processMatch = processValue.match(/format,([a-z0-9]+)/i);
  if (processMatch) {
    return processMatch[1].toLowerCase();
  }

  const imageViewMatch = url.toString().match(/\/format\/([a-z0-9]+)(?:\/|$)/i);
  if (imageViewMatch) {
    return imageViewMatch[1].toLowerCase();
  }

  return "";
}

function buildImageDedupKey(imageUrl) {
  try {
    const parsed = new URL(imageUrl, window.location.origin);
    const proxied = parsed.pathname === "/api/image" ? parsed.searchParams.get("url") : "";
    const sourceUrl = proxied ? new URL(decodeURIComponent(proxied)) : parsed;
    const host = sourceUrl.hostname.toLowerCase();
    const pathname = normalizeImagePath(sourceUrl.pathname);

    if (/(xhscdn\.com|sns-webpic|qpic\.cn)/i.test(host)) {
      return `${host}:${buildCdnImageAssetKey(pathname)}`;
    }

    for (const key of [...sourceUrl.searchParams.keys()]) {
      if (/^(w|h|width|height|quality|q|format|fit|resize|imageview2|x-oss-process)$/i.test(key)) {
        sourceUrl.searchParams.delete(key);
      }
    }

    return `${host}${pathname}?${sourceUrl.searchParams.toString()}`;
  } catch (error) {
    return imageUrl;
  }
}

function buildCdnImageAssetKey(pathname) {
  const segments = String(pathname || "")
    .split("/")
    .filter(Boolean);
  const assetSegment = segments.at(-1) || pathname;

  return assetSegment
    .replace(/!\w[\w-]*/g, "")
    .replace(/\.(jpg|jpeg|png|webp|gif|bmp|svg|avif|heic)$/i, "")
    .toLowerCase();
}

function normalizeImagePath(pathname) {
  return pathname
    .replace(/!\w[\w-]*/g, "")
    .replace(/\/(thumbnail|thumb|small|mini|origin|master)\//gi, "/")
    .replace(/\/{2,}/g, "/");
}
