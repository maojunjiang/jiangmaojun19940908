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
const copyPromptButton = document.querySelector("#copy-prompt-button");
const resultImagePrompt = document.querySelector("#result-image-prompt");
const copyImagePromptButton = document.querySelector("#copy-image-prompt-button");

const FALLBACK_IMAGE =
  "https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=1200&q=80";
const MAX_REFERENCE_MEDIA = 14;
const DEFAULT_SUBMIT_BUTTON_TEXT = "开始解析";
const HISTORY_STORAGE_KEY = "note-parser:url-history";
const HISTORY_LIMIT = 12;

const SAMPLE_TAGS = ["内容解析", "链接抓取", "笔记结构化"];

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
let imagePromptRequestSerial = 0;
let urlHistory = loadUrlHistory();
const imagePromptAnalysisCache = new Map();
const mediaLinkState = {
  activeTab: "images",
  images: [],
  videos: [],
};

warnIfOpenedFromFile();
renderUrlHistory();
setSubmitButtonState("idle");

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

async function requestAiPrompts(result) {
  const payload = {
    result: {
      title: result?.title || "",
      body: result?.body || "",
      tags: Array.isArray(result?.tags) ? result.tags : [],
      image: typeof result?.image === "string" ? toSourceImageUrl(result.image) : "",
      images: collectMediaLinks(result).images,
    },
  };

  const response = await fetch("/api/prompts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(parsed?.error || "AI prompt request failed.");
  }

  return {
    rewritePrompt: typeof parsed?.rewritePrompt === "string" ? parsed.rewritePrompt.trim() : "",
    imagePrompt: typeof parsed?.imagePrompt === "string" ? parsed.imagePrompt.trim() : "",
  };
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
  emptyState.classList.add("hidden");
  resultCard.classList.remove("hidden");

  carouselState.images = normalizeImages(result);
  carouselState.index = 0;
  updateCarouselImage();
  renderCarouselDots();
  syncCarouselChrome();

  resultTitle.textContent = result.title || "-";
  resultBody.textContent = result.body || "-";
  resultPrompt.value = "正在调用 AI 生成仿写提示词，请稍候...";
  resultImagePrompt.value = "正在调用 AI 分析参考图，请稍候...";
  resetCopyButton();
  resetImagePromptButton();
  resetAllImagesButton();
  syncMediaLinks(result);
  void hydratePromptOutputs(result);

  resultTags.innerHTML = "";
  const safeTags = Array.isArray(result.tags) ? result.tags : [];
  safeTags.forEach((tagText) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `#${tagText}`;
    resultTags.appendChild(tag);
  });
}

async function hydratePromptOutputs(result) {
  const requestId = ++imagePromptRequestSerial;

  try {
    const aiPrompts = await requestAiPrompts(result);
    if (requestId !== imagePromptRequestSerial) {
      return;
    }

    resultPrompt.value = aiPrompts.rewritePrompt || buildRewritePrompt(result);
    resultImagePrompt.value = aiPrompts.imagePrompt || (await buildImageGenerationPrompt(result));
  } catch (error) {
    if (requestId !== imagePromptRequestSerial) {
      return;
    }

    resultPrompt.value = buildRewritePrompt(result);
    resultImagePrompt.value = buildImagePromptFallback(result);
    void hydrateImageGenerationPromptFallback(result, requestId);
  }
}

async function hydrateImageGenerationPromptFallback(result, requestId) {
  try {
    const promptText = await buildImageGenerationPrompt(result);
    if (requestId !== imagePromptRequestSerial) {
      return;
    }

    resultImagePrompt.value = promptText;
  } catch (error) {
    if (requestId !== imagePromptRequestSerial) {
      return;
    }

    resultImagePrompt.value = buildImagePromptFallback(result);
  }
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

function buildRewritePrompt(result) {
  const profile = analyzeNoteProfile(result);

  return [
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
  ].join("\n");
}

async function buildImageGenerationPrompt(result) {
  const profile = analyzeNoteProfile(result);
  const imageUrls = collectPromptAnalysisImageUrls(result);

  if (!imageUrls.length) {
    return buildImagePromptFallback(result);
  }

  const scenes = await Promise.all(
    imageUrls.map((imageUrl, index) => analyzePromptImage(imageUrl, result, profile, index))
  );

  const imageSections = scenes
    .map((scene, index) => {
      const serial = toChineseIndex(index + 1);
      return [
        `图${serial}`,
        `风格：${scene.style}`,
        `构图：${scene.composition}`,
        `景别与机位：${scene.camera}`,
        `背景：${scene.background}`,
        `光线：${scene.light}`,
        `色彩：${scene.color}`,
        `材质与质感：${scene.material}`,
        `主体与道具细节：${scene.details}`,
        `文字与版式（如有）：${scene.typography}`,
        `氛围关键词：${scene.mood}`,
        "产品主体保持要求：保留你上传产品图的外形、比例、品牌与文字信息，只迁移本图的场景、构图、机位、光线和色彩。",
        `复刻 prompt（产品融合版）：${scene.prompt}`,
        `负面提示：${scene.negative}`,
        `参数建议：${scene.params}`,
      ].join("\n");
    })
    .join("\n\n---\n\n");

  return [
    "以下内容为基于解析图片逐张完成的视觉分析结果。",
    "每一段都对应原帖中的单独一张图，可直接配合你上传的产品图使用。",
    "",
    imageSections,
  ].join("\n");
}

function collectPromptAnalysisImageUrls(result) {
  return collectRenderableImageUrls(result);
}

function buildImagePromptFallback(result) {
  const profile = analyzeNoteProfile(result);
  return [
    "当前未能完成逐张视觉分析，已切换为保守兜底提示词。",
    `内容主题：${profile.topicPosition}`,
    `主体类型：${profile.subjectFocus}`,
    "复刻 prompt（产品融合版）：保留你上传产品图的外形、比例、品牌与文字信息，仅迁移参考图的构图、背景层次、光线、色彩和氛围，生成真实自然的高质量实拍效果。",
  ].join("\n");
}

async function analyzePromptImage(imageUrl, result, profile, index) {
  try {
    const visual = await getCachedPromptImageAnalysis(imageUrl);
    return buildSceneProfileFromVisual(result, profile, visual, index);
  } catch (error) {
    return buildSceneProfileFallback(result, profile, index);
  }
}

function getCachedPromptImageAnalysis(imageUrl) {
  const cacheKey = buildImageDedupKey(imageUrl);

  if (!imagePromptAnalysisCache.has(cacheKey)) {
    const analysisPromise = analyzeImageVisualMetrics(imageUrl).catch((error) => {
      imagePromptAnalysisCache.delete(cacheKey);
      throw error;
    });
    imagePromptAnalysisCache.set(cacheKey, analysisPromise);
  }

  return imagePromptAnalysisCache.get(cacheKey);
}

async function analyzeImageVisualMetrics(imageUrl) {
  const image = await loadImageForPromptAnalysis(imageUrl);
  const metrics = sampleImageVisualMetrics(image);
  return {
    ...metrics,
    aspectRatio: image.naturalWidth / Math.max(image.naturalHeight, 1),
  };
}

function loadImageForPromptAnalysis(imageUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Image load failed: ${imageUrl}`));
    image.src = imageUrl;
  });
}

function sampleImageVisualMetrics(image) {
  const maxSide = 160;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height, 1));
  const width = Math.max(32, Math.round((image.naturalWidth || image.width || maxSide) * scale));
  const height = Math.max(32, Math.round((image.naturalHeight || image.height || maxSide) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas context unavailable");
  }

  context.drawImage(image, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  const grayscale = new Float32Array(width * height);
  const colorCounts = new Map();

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumLum = 0;
  let sumLumSq = 0;
  let sumSat = 0;
  let topLum = 0;
  let bottomLum = 0;
  let topCount = 0;
  let bottomCount = 0;
  let topBlueHits = 0;
  let greenHits = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const offset = pixelIndex * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const [hue, saturation, lightness] = rgbToHsl(r, g, b);

      grayscale[pixelIndex] = lum;
      sumR += r;
      sumG += g;
      sumB += b;
      sumLum += lum;
      sumLumSq += lum * lum;
      sumSat += saturation;

      if (y < height / 3) {
        topLum += lum;
        topCount += 1;
        if (hue >= 180 && hue <= 250 && saturation >= 0.16 && lightness >= 0.45) {
          topBlueHits += 1;
        }
      }

      if (y >= (height * 2) / 3) {
        bottomLum += lum;
        bottomCount += 1;
      }

      if (hue >= 70 && hue <= 165 && saturation >= 0.15 && lightness >= 0.22) {
        greenHits += 1;
      }

      const colorName = describeColorName(hue, saturation, lightness);
      colorCounts.set(colorName, (colorCounts.get(colorName) || 0) + 1);
    }
  }

  let edgeSum = 0;
  let edgeWeightSum = 0;
  let weightedX = 0;
  let weightedY = 0;
  let weightedXX = 0;
  let weightedYY = 0;
  let edgeDensity = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const pixelIndex = y * width + x;
      const gx = grayscale[pixelIndex + 1] - grayscale[pixelIndex - 1];
      const gy = grayscale[pixelIndex + width] - grayscale[pixelIndex - width];
      const edge = Math.abs(gx) + Math.abs(gy);
      const weight = edge + 1;

      edgeSum += edge;
      edgeWeightSum += weight;
      weightedX += weight * x;
      weightedY += weight * y;
      weightedXX += weight * x * x;
      weightedYY += weight * y * y;

      if (edge >= 30) {
        edgeDensity += 1;
      }
    }
  }

  const sampleCount = Math.max((width - 2) * (height - 2), 1);
  const avgLum = sumLum / Math.max(width * height, 1);
  const contrast = Math.sqrt(Math.max(sumLumSq / Math.max(width * height, 1) - avgLum * avgLum, 0));
  const avgSat = sumSat / Math.max(width * height, 1);
  const centerX = edgeWeightSum ? weightedX / edgeWeightSum / Math.max(width - 1, 1) : 0.5;
  const centerY = edgeWeightSum ? weightedY / edgeWeightSum / Math.max(height - 1, 1) : 0.5;
  const spreadX = edgeWeightSum
    ? Math.sqrt(Math.max(weightedXX / edgeWeightSum - (weightedX / edgeWeightSum) ** 2, 0)) / Math.max(width, 1)
    : 0.25;
  const spreadY = edgeWeightSum
    ? Math.sqrt(Math.max(weightedYY / edgeWeightSum - (weightedY / edgeWeightSum) ** 2, 0)) / Math.max(height, 1)
    : 0.25;
  const focusRadiusX = Math.max(6, Math.floor(width * 0.18));
  const focusRadiusY = Math.max(6, Math.floor(height * 0.18));
  const focusCenterX = Math.round(centerX * (width - 1));
  const focusCenterY = Math.round(centerY * (height - 1));

  let focusSharpness = 0;
  let focusSharpnessCount = 0;
  let backgroundSharpness = 0;
  let backgroundSharpnessCount = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const pixelIndex = y * width + x;
      const edge =
        Math.abs(grayscale[pixelIndex + 1] - grayscale[pixelIndex - 1]) +
        Math.abs(grayscale[pixelIndex + width] - grayscale[pixelIndex - width]);

      const inFocusPatch =
        Math.abs(x - focusCenterX) <= focusRadiusX &&
        Math.abs(y - focusCenterY) <= focusRadiusY;

      if (inFocusPatch) {
        focusSharpness += edge;
        focusSharpnessCount += 1;
      } else {
        backgroundSharpness += edge;
        backgroundSharpnessCount += 1;
      }
    }
  }

  const dominantColors = [...colorCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([name]) => name)
    .filter((name, index, list) => list.indexOf(name) === index)
    .slice(0, 3);

  const averageR = sumR / Math.max(width * height, 1);
  const averageB = sumB / Math.max(width * height, 1);
  const topBlueRatio = topBlueHits / Math.max(topCount, 1);
  const greenRatio = greenHits / Math.max(width * height, 1);
  const topBrightness = topLum / Math.max(topCount, 1);
  const bottomBrightness = bottomLum / Math.max(bottomCount, 1);
  const focusSharpnessMean = focusSharpness / Math.max(focusSharpnessCount, 1);
  const backgroundSharpnessMean = backgroundSharpness / Math.max(backgroundSharpnessCount, 1);

  return {
    width,
    height,
    averageBrightness: avgLum,
    contrast,
    averageSaturation: avgSat,
    averageWarmth: averageR - averageB,
    dominantColors,
    centerX,
    centerY,
    spreadX,
    spreadY,
    edgeDensity: edgeDensity / sampleCount,
    sharpness: edgeSum / sampleCount,
    focusSharpness: focusSharpnessMean,
    backgroundSharpness: backgroundSharpnessMean,
    depthContrast: focusSharpnessMean / Math.max(backgroundSharpnessMean, 1),
    topBlueRatio,
    greenRatio,
    topBrightness,
    bottomBrightness,
    isOutdoor:
      topBlueRatio >= 0.09 ||
      greenRatio >= 0.12 ||
      (topBrightness >= 150 && avgLum >= 118 && averageR < averageB + 8),
    isNight: avgLum <= 105 && contrast >= 32,
    hasStructuredLines: edgeDensity >= 0.22 && avgSat <= 0.28,
    isCleanBackground: edgeDensity <= 0.14 && avgSat <= 0.3,
  };
}

function buildSceneProfileFromVisual(result, profile, visual, index) {
  const style = describeVisualStyle(visual);
  const composition = describeVisualComposition(visual);
  const camera = describeVisualCamera(visual);
  const background = describeVisualBackground(result, profile, visual);
  const light = describeVisualLighting(visual);
  const color = describeVisualColor(visual);
  const material = describeVisualMaterial(profile, visual);
  const details = describeVisualDetails(profile, visual);
  const typography = "若产品本身带品牌或文字信息，保持原样并确保清晰可读，不改字不乱码。";
  const mood = describeVisualMood(visual);
  const prompt = buildVisualReplicaPrompt({
    composition,
    camera,
    background,
    light,
    color,
    material,
    details,
    mood,
    profile,
  });

  return {
    style,
    composition,
    camera,
    background,
    light,
    color,
    material,
    details,
    typography,
    mood,
    prompt,
    negative: buildVisualNegativePrompt(visual),
    params: buildVisualParamHint(visual),
    index,
  };
}

function buildSceneProfileFallback(result, profile) {
  const fallbackStyle = inferImageStyleHint(result, profile);
  const fallbackComposition = inferImageCompositionHint(result, profile);
  const fallbackColor = inferImageColorHint(result, profile);
  const fallbackLight = inferImageLightingHint(result, profile);
  const fallbackMaterial = inferImageMaterialHint(result, profile);
  const fallbackMood = inferImageAtmosphereHint(result, profile);

  return {
    style: fallbackStyle,
    composition: fallbackComposition,
    camera: "中近景平视机位，主体清晰，背景轻微虚化",
    background: `围绕“${profile.topicPosition}”的真实生活场景`,
    light: fallbackLight,
    color: fallbackColor,
    material: fallbackMaterial,
    details: "保留产品主体边缘、比例、品牌与文字信息，确保结构清楚不变形。",
    typography: "若产品带有品牌或文字信息，保持原样并确保清晰可读。",
    mood: fallbackMood,
    prompt:
      "以你上传的产品为唯一主体，保留原有外形、比例、品牌与文字信息，只迁移参考图的场景、构图、机位、光线与色彩关系，生成真实自然的高质量实拍成片。",
    negative:
      "不要替换产品主体，不要改变产品外形比例，不要篡改品牌logo或文字，不要塑料感CG，不要过度磨皮，不要文字乱码。",
    params: "画幅 3:4，写实强度中高，清晰度优先，细节优先。",
  };
}

function describeVisualStyle(visual) {
  if (visual.isNight) {
    return visual.depthContrast >= 1.18 ? "夜间氛围实拍，浅景深纪实感" : "夜间纪实实拍，环境氛围明显";
  }

  if (visual.isOutdoor) {
    return visual.contrast >= 55 ? "户外纪实抓拍，生活感和现场感都比较强" : "清透自然的户外生活方式实拍";
  }

  if (visual.isCleanBackground) {
    return "克制简洁的静物/产品实拍，画面干净";
  }

  if (visual.hasStructuredLines) {
    return "空间线条感明显的生活方式实拍";
  }

  return "真实生活方式实拍，保留内容感和自然环境信息";
}

function describeVisualComposition(visual) {
  const horizontal = visual.centerX <= 0.38 ? "偏左" : visual.centerX >= 0.62 ? "偏右" : "居中";
  const vertical = visual.centerY <= 0.38 ? "偏上" : visual.centerY >= 0.62 ? "偏下" : "居中";
  const placement =
    horizontal === "居中" && vertical === "居中"
      ? "主体位于画面中心"
      : horizontal === "居中"
        ? `主体居中${vertical}`
        : vertical === "居中"
          ? `主体${horizontal}`
          : `主体${horizontal}${vertical}`;
  const focusScale =
    (visual.spreadX + visual.spreadY) / 2 <= 0.18
      ? "主体占比高，视觉焦点集中"
      : (visual.spreadX + visual.spreadY) / 2 <= 0.28
        ? "主体与环境比例平衡"
        : "保留较多环境信息，主体和场景共同成画";

  return `${placement}，${focusScale}`;
}

function describeVisualCamera(visual) {
  const spreadAverage = (visual.spreadX + visual.spreadY) / 2;
  const shotScale = spreadAverage <= 0.18 ? "近景特写" : spreadAverage <= 0.28 ? "中近景" : "中景";
  const angle = visual.centerY <= 0.38 ? "略仰视机位" : visual.centerY >= 0.62 ? "略俯视机位" : "平视机位";
  const depth = visual.depthContrast >= 1.18 ? "主体清晰，背景轻虚化" : "整体清晰，景深偏深";
  return `${shotScale}，${angle}，${depth}`;
}

function describeVisualBackground(result, profile, visual) {
  const analysisText = buildAnalysisText(result);

  if (visual.isNight) {
    return "夜间环境背景，常见门店灯光、街景光斑或暗部层次";
  }

  if (visual.isOutdoor) {
    if (visual.greenRatio >= 0.12 && visual.topBlueRatio >= 0.09) {
      return "户外街景或自然环境背景，带天空、绿植或道路空间信息";
    }

    return "户外街景或道路背景，环境信息保留得比较明显";
  }

  if (visual.hasStructuredLines) {
    return "室内空间背景，带明显建筑线条、柜台、楼梯或结构透视";
  }

  if (visual.isCleanBackground) {
    return "简洁室内或桌面背景，干扰元素少，主体更突出";
  }

  if (/(探店|门店|餐厅|咖啡馆|吧台)/.test(analysisText)) {
    return "门店或吧台类背景，保留轻微环境信息和空间层次";
  }

  return `围绕“${profile.topicPosition}”形成的真实生活场景背景`;
}

function describeVisualLighting(visual) {
  if (visual.isNight) {
    return visual.averageWarmth >= 10 ? "夜间暖色人工光与环境杂光混合，亮部有氛围高光" : "夜间冷色环境光为主，暗部保留细节";
  }

  if (visual.isOutdoor) {
    return visual.contrast >= 55 ? "自然日光更直接，亮部清楚，阴影关系明确" : "自然散射光为主，整体柔和通透";
  }

  if (visual.averageWarmth >= 12) {
    return "室内偏暖环境光，亮部柔和，主体边缘有自然高光";
  }

  if (visual.averageWarmth <= -12) {
    return "室内偏冷环境光，整体干净克制，明暗关系清楚";
  }

  return "室内环境光与柔和补光混合，亮部不过曝，暗部不发闷";
}

function describeVisualColor(visual) {
  const palette = visual.dominantColors.length ? visual.dominantColors.join("、") : "中性色";
  const temperature = visual.averageWarmth >= 12 ? "整体偏暖" : visual.averageWarmth <= -12 ? "整体偏冷" : "整体偏中性";
  const saturation = visual.averageSaturation >= 0.36 ? "颜色存在明显主次对比" : visual.averageSaturation <= 0.2 ? "饱和度克制" : "饱和度适中";
  return `以${palette}为主，${temperature}，${saturation}`;
}

function describeVisualMaterial(profile, visual) {
  if (/(饮品|美食)/.test(profile.subjectFocus)) {
    return "透明外壁、液体层次、表面高光和包装边缘要清楚，保留真实通透感";
  }

  if (/(穿搭单品)/.test(profile.subjectFocus)) {
    return "产品表面纹理、折痕、边缘反光和材质触感要真实";
  }

  if (/(人物)/.test(profile.subjectFocus)) {
    return "产品主体的包装、边缘、反光与接触阴影要真实，避免悬浮感";
  }

  return visual.averageSaturation <= 0.22
    ? "产品表面纹理、包装边缘和反光层次要清楚，整体质感克制真实"
    : "产品主体的反光、纹理、边缘和材质层次要清楚，保留真实触感";
}

function describeVisualDetails(profile, visual) {
  if (visual.depthContrast >= 1.18) {
    return "保留参考图的焦点位置与背景虚化层次，让主体边缘清晰、背景退后。";
  }

  if (visual.hasStructuredLines) {
    return "保留环境中的线条透视、结构层次和空间纵深，不要把背景做平。";
  }

  if (visual.isCleanBackground) {
    return "减少无关道具，让主体轮廓、品牌与文字信息更醒目。";
  }

  return `保留${profile.subjectFocus}场景里常见的环境辅助元素，但不要喧宾夺主。`;
}

function describeVisualMood(visual) {
  if (visual.isNight) {
    return "夜间、氛围感、真实、有情绪张力";
  }

  if (visual.isOutdoor) {
    return visual.averageSaturation >= 0.34 ? "清透、轻松、在场感强" : "自然、日常、松弛";
  }

  if (visual.isCleanBackground) {
    return "克制、干净、可信赖";
  }

  if (visual.hasStructuredLines) {
    return "现代、清爽、空间感明确";
  }

  return "真实、自然、内容感强";
}

function buildVisualReplicaPrompt(scene) {
  return [
    "以你上传的产品为唯一主体，放在参考图主体所在的视觉焦点位置，",
    `${scene.composition}，${scene.camera}，`,
    `背景为${scene.background}，`,
    `光线表现为${scene.light}，`,
    `整体色彩${scene.color}，`,
    "保留产品原有外形、比例、品牌与文字信息，",
    `重点呈现${scene.material}，`,
    `${scene.details}`,
    `整体氛围${scene.mood}，`,
    "输出真实自然、可直接用于社交媒体内容的高质量实拍成片。",
  ].join("");
}

function buildVisualNegativePrompt(visual) {
  const parts = [
    "不要替换产品主体",
    "不要改变产品外形比例",
    "不要篡改品牌logo或文字",
    "不要文字乱码",
    "不要塑料感CG",
    "不要过度磨皮",
  ];

  if (visual.isNight) {
    parts.push("不要把夜景压成死黑");
    parts.push("不要出现脏噪点");
  }

  if (visual.isOutdoor) {
    parts.push("不要做成纯棚拍背景");
  }

  if (visual.depthContrast >= 1.18) {
    parts.push("不要让背景比主体还清晰");
  } else {
    parts.push("不要把背景虚化过度");
  }

  return parts.join("，");
}

function buildVisualParamHint(visual) {
  const ratio = inferAspectRatioLabel(visual.aspectRatio);
  const depth = visual.depthContrast >= 1.18 ? "浅到中景深" : "中等景深";
  const lightProtection = visual.isNight ? "暗部细节优先" : "高光保护优先";
  return `画幅 ${ratio}，写实强度中高，${depth}，${lightProtection}，清晰度优先。`;
}

function inferAspectRatioLabel(aspectRatio) {
  if (aspectRatio <= 0.78) {
    return "3:4 竖版";
  }

  if (aspectRatio >= 1.2) {
    return "4:3 横版";
  }

  return "接近 1:1";
}

function rgbToHsl(r, g, b) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;

  if (max === min) {
    return [0, 0, lightness];
  }

  const delta = max - min;
  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / Math.max(max + min, 0.00001);

  let hue = 0;
  if (max === red) {
    hue = (green - blue) / delta + (green < blue ? 6 : 0);
  } else if (max === green) {
    hue = (blue - red) / delta + 2;
  } else {
    hue = (red - green) / delta + 4;
  }

  return [Math.round(hue * 60), saturation, lightness];
}

function describeColorName(hue, saturation, lightness) {
  if (lightness <= 0.12) {
    return "深黑";
  }

  if (saturation <= 0.08) {
    if (lightness >= 0.85) {
      return "米白";
    }

    if (lightness >= 0.62) {
      return "浅灰";
    }

    return "深灰";
  }

  if (hue < 15 || hue >= 345) {
    return lightness >= 0.62 ? "浅红" : "红色";
  }

  if (hue < 40) {
    return lightness >= 0.62 ? "浅橙" : "橙色";
  }

  if (hue < 65) {
    return lightness >= 0.62 ? "浅黄" : "黄色";
  }

  if (hue < 170) {
    return lightness >= 0.62 ? "浅绿" : "绿色";
  }

  if (hue < 200) {
    return lightness >= 0.62 ? "浅青" : "青色";
  }

  if (hue < 255) {
    return lightness >= 0.62 ? "浅蓝" : "蓝色";
  }

  if (hue < 320) {
    return lightness >= 0.62 ? "浅紫" : "紫色";
  }

  return lightness >= 0.62 ? "浅粉" : "粉色";
}

function toChineseIndex(value) {
  const labels = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  if (value >= 1 && value <= labels.length) {
    return labels[value - 1];
  }

  return String(value);
}

function collectImageReferenceUrls(result) {
  const rawImages = Array.isArray(result?.images) ? result.images : [];
  return dedupeMediaUrls(rawImages.map((url) => toSourceImageUrl(url)).filter(Boolean).filter((url) => !isVideoUrl(url)));
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
    return "真实职场感的人像或场景图，偏自然纪实，干净明亮，像高质量生活方式内容配图";
  }

  if (/(教程|步骤|技巧|干货|攻略)/.test(combined)) {
    return "信息感较强的生活方式视觉，画面清晰克制，重点明确，有轻微 editorial 感";
  }

  if (/(穿搭|妆容|护肤|单品)/.test(combined)) {
    return "精致但不过度修饰的生活方式审美，保留真实皮肤和材质质感";
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
    return "以单主体为核心的中近景或半身构图，主体清晰，背景简洁，有明确视觉焦点";
  }

  if (/(产品|单品|物品|护肤品|彩妆|包包|鞋子)/.test(combined)) {
    return "主体居中偏前景，搭配少量辅助道具，层次清楚，留出适度呼吸感";
  }

  if (imageCount >= 3) {
    return "参考组图里常见的封面式取景，优先选择稳定、清楚、易读的主画面构图";
  }

  return `围绕${profile.subjectFocus}建立单一主视觉，保持主次分明、构图稳定、画面干净`;
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
    return "主色明确，背景色干净，主体颜色和材质被突出，整体偏审美向";
  }

  return `围绕“${profile.topicPosition}”形成统一而清楚的色彩组织，主次分明，不过度堆色`;
}

function inferImageLayoutHint(result, profile) {
  const combined = buildAnalysisText(result);

  if (/(教程|步骤|方法|攻略|清单|干货)/.test(combined)) {
    return "信息组织清楚，画面像内容封面或信息型配图，视觉重点明确，适合承载标题感";
  }

  if (/(职场|经验分享|面试|工作)/.test(combined)) {
    return "整体偏内容封面逻辑，主体与背景关系清楚，有明显视觉中心，适合社媒首图";
  }

  if (/(产品|单品|护肤|彩妆|穿搭)/.test(combined)) {
    return "版面偏审美陈列式，主体摆位有节奏，留白和细节辅助共同建立高级感";
  }

  return `围绕${profile.subjectFocus}形成稳定的视觉层级，让主体、环境和辅助元素各自有清晰位置`;
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
    return "更接近真实生活方式实拍摄影，可保留轻微 editorial 感，但主体应自然可信";
  }

  return `优先判断为与“${profile.topicPosition}”匹配的真实摄影或轻设计化视觉，不建议直接做重渲染风格`;
}

function inferImageLightingHint(result, profile) {
  const combined = buildAnalysisText(result);

  if (/(职场|办公室|通勤|人物|面试)/.test(combined)) {
    return "自然光或柔和环境光为主，面部与主体轮廓清楚，避免过硬补光和影楼感";
  }

  if (/(产品|护肤|彩妆|单品)/.test(combined)) {
    return "受控柔光，亮部干净，阴影克制，重点突出主体材质和轮廓";
  }

  if (/(餐厅|咖啡|探店|甜品|饮品)/.test(combined)) {
    return "生活方式场景光，整体柔和，有局部高光和空间氛围，不要死白平光";
  }

  return `围绕${profile.subjectFocus}建立清楚、自然、可读的光线关系，亮部不过曝，暗部不糊成一片`;
}

function inferImageMaterialHint(result, profile) {
  const combined = buildAnalysisText(result);

  if (/(人物|女生|男生|博主|朋友)/.test(combined)) {
    return "皮肤、发丝、服装面料与道具材质要真实可感，保留细节，不做塑料质感处理";
  }

  if (/(产品|护肤|彩妆|单品|包包|鞋子)/.test(combined)) {
    return "重点呈现产品表面、边缘、反光、纹理和材质层次，让主体具备商业级质感";
  }

  if (/(甜品|饮品|美食|料理)/.test(combined)) {
    return "食物纹理、液体透明感、器皿质地和桌面材质都要清楚，避免糊成一片";
  }

  return `突出${profile.subjectFocus}相关的真实材质与细节层次，让画面既清楚又有触感`;
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
    return "达到高质量社交媒体实拍封面图水准，人物比例自然，细节完整，画面干净，像成熟博主真实拍摄成片";
  }

  if (/(产品|护肤|彩妆|单品)/.test(combined)) {
    return "达到商业级产品图或品牌社媒图水准，边缘锐利，材质准确，构图稳定，精致但不假";
  }

  if (/(美食|甜品|饮品|探店)/.test(combined)) {
    return "达到优质生活方式内容图水准，食物与环境都有真实质感，颜色诱人但不过饱和";
  }

  return `整体质量要对齐高质量${profile.topicPosition}内容图：主体明确、细节充分、观感成熟、真实自然`;
}

function inferPromptDirectionHint(result, profile) {
  return [
    `保留${profile.subjectFocus}的主体定位`,
    `沿用${profile.topicPosition}对应的视觉语境`,
    "复用风格、构图、用色、光线、材质和媒介属性的方法论，而不是复制原图细节",
    "让不同帖子都能套用成同风格方向的高质量文生图模板"
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
