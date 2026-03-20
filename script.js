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
const imagePromptAnalysisCache = new Map();
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
  const includeImageAnalyses = target === "image" || target === "all";
  return {
    result: {
      title: result?.title || "",
      body: result?.body || "",
      tags: Array.isArray(result?.tags) ? result.tags : [],
      image: includeImageAnalyses && typeof result?.image === "string" ? toSourceImageUrl(result.image) : "",
      images: includeImageAnalyses ? collectMediaLinks(result).images : [],
      imageAnalyses: includeImageAnalyses ? await buildImageAnalysisPayload(result) : [],
    },
    target,
    rewriteDirection: typeof options.rewriteDirection === "string" ? options.rewriteDirection.trim() : "",
    imageDirection:
      target === "rewrite" ? "" : typeof options.imageDirection === "string" ? options.imageDirection.trim() : "",
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

async function buildImageAnalysisPayload(result) {
  const profile = analyzeNoteProfile(result);
  const imageUrls = collectPromptAnalysisImageUrls(result);
  if (!imageUrls.length) {
    return [];
  }

  const scenes = await Promise.all(
    imageUrls.map((imageUrl, index) => analyzePromptImage(imageUrl, result, profile, index))
  );

  return scenes.map((scene, index) => ({
    imageLabel: `图片${index + 1}`,
    style: scene.style || "",
    composition: scene.composition || "",
    camera: scene.camera || "",
    background: scene.background || "",
    light: scene.light || "",
    color: scene.color || "",
    material: scene.material || "",
    details: scene.details || "",
    typography: scene.typography || "",
    mood: scene.mood || "",
    prompt: scene.prompt || "",
    negative: scene.negative || "",
    params: scene.params || "",
    aspectRatio: Number.isFinite(scene.aspectRatio) ? scene.aspectRatio : null,
    spreadX: Number.isFinite(scene.spreadX) ? scene.spreadX : null,
    spreadY: Number.isFinite(scene.spreadY) ? scene.spreadY : null,
  }));
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
  resultImagePrompt.value = "正在调用 AI 提炼场景迁移模板，请稍候...";
  setRegenerateButtonState(regeneratePromptButton, true, "重新生成");
  setRegenerateButtonState(regenerateImagePromptButton, true, "重新生成");
  resetCopyButton();
  resetImagePromptButton();
  resetAllImagesButton();
  syncMediaLinks(result);
  void hydratePromptOutputs(result, {
    rewriteDirection: getRewriteDirectionValue(),
    imageDirection: getImageDirectionValue(),
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

  return [
    "标题不超过18字",
    "正文300-600字",
    "标签5-8个",
    "",
    normalized,
  ].join("\n");
}

async function hydratePromptOutputs(result, options = {}) {
  const rewriteRequestId = ++rewritePromptRequestSerial;
  const imageRequestId = ++imagePromptRequestSerial;
  const rewriteDirection = typeof options.rewriteDirection === "string" ? options.rewriteDirection.trim() : "";
  const imageDirection = typeof options.imageDirection === "string" ? options.imageDirection.trim() : "";

  void hydrateAiImagePrompt(result, imageRequestId, imageDirection);

  try {
    const payload = await buildPromptRequestPayload(result, {
      target: "rewrite",
      rewriteDirection,
      imageDirection: "",
    });

    const aiPrompts = await requestAiPrompts(result, {
      target: "rewrite",
      rewriteDirection,
      imageDirection: "",
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
      rewriteDirection: getRewriteDirectionValue(),
      imageDirection: direction,
    });

    const aiPromptsPromise = requestAiPrompts(result, {
      target: "image",
      rewriteDirection: getRewriteDirectionValue(),
      imageDirection: direction,
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

async function hydrateImageGenerationPromptFallback(result, requestId, direction = "") {
  try {
    const promptText = await buildImageGenerationPrompt(result, direction);
    if (requestId !== imagePromptRequestSerial) {
      return;
    }

    resultImagePrompt.value = promptText;
  } catch (error) {
    if (requestId !== imagePromptRequestSerial) {
      return;
    }

    resultImagePrompt.value = getPromptNotGeneratedText();
  }
}

async function regenerateRewritePrompt() {
  if (!currentParsedResult) {
    return;
  }

  const requestId = ++rewritePromptRequestSerial;
  const rewriteDirection = getRewriteDirectionValue();
  setRegenerateButtonState(regeneratePromptButton, false, "正在生成...");
  resultPrompt.value = "正在根据提示词方向重新生成，请稍候...";

  try {
    const aiPrompts = await requestAiPrompts(currentParsedResult, {
      target: "rewrite",
      rewriteDirection,
      imageDirection: "",
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
  const imageDirection = getImageDirectionValue();
  setRegenerateButtonState(regenerateImagePromptButton, false, "正在生成...");
  resultImagePrompt.value = "正在调用 AI 重新生成生图提示词模板，请稍候...";

  try {
    const aiPrompts = await requestAiPrompts(currentParsedResult, {
      target: "image",
      rewriteDirection: getRewriteDirectionValue(),
      imageDirection,
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

function getRewriteDirectionValue() {
  return typeof rewriteDirectionInput?.value === "string" ? rewriteDirectionInput.value.trim() : "";
}

function getImageDirectionValue() {
  return typeof imageDirectionInput?.value === "string" ? imageDirectionInput.value.trim() : "";
}

function normalizeAiImagePromptTemplate(aiPrompt, result, direction = "") {
  const normalized = typeof aiPrompt === "string" ? aiPrompt.trim() : "";
  if (!normalized) {
    return getPromptNotGeneratedText();
  }

  const profile = analyzeNoteProfile(result);
  const imageUrls = collectPromptAnalysisImageUrls(result);
  const cachedScenes = imageUrls
    .map((imageUrl, index) => {
      const cacheKey = buildImageDedupKey(imageUrl);
      const cached = imagePromptAnalysisCache.get(cacheKey);
      if (!cached || typeof cached.then === "function") {
        return buildSceneProfileFallback(result, profile, index);
      }
      return cached;
    })
    .filter(Boolean);

  const scenes = cachedScenes.length ? cachedScenes : [buildSceneProfileFallback(result, profile, 0)];
  return buildFixedAiImageTemplate(result, scenes, direction);
}


function buildFixedAiImageTemplate(result, scenes, direction = "") {
  const vars = WORKFLOW_TEMPLATE_VARIABLES;
  const safeScenes = Array.isArray(scenes) && scenes.length
    ? scenes.slice(0, IMAGE_PROMPT_REFERENCE_LIMIT)
    : [buildSceneProfileFallback(result, analyzeNoteProfile(result), 0)];
  const styleCount = safeScenes.length;
  const profile = analyzeNoteProfile(result);
  const theme = inferSceneTransferTemplateTheme(result, profile);
  const ratioText = buildDynamicSceneRatioSummary(safeScenes);
  const styleBlocks = safeScenes
    .map((scene, index) => buildDynamicSceneStyleTemplateBlock(scene, index))
    .join("\n\n");

  return [
    "【变量占位（固定保留）】",
    `- 正文内容：${vars.content}`,
    `- 主体产品图/场景图列表：${vars.imageList}`,
    `- 标题：${vars.title}`,
    `- 主体产品图首图：${vars.firstImage}`,
    "",
    "【核心主题】",
    `以标题“${vars.title}”为核心，结合正文“${vars.content}”和产品图“${vars.firstImage}”，产品图“${vars.imageList}”作为依据生成${theme.outputLabel}。`,
    "",
    "【生成参数】",
    `- 生成图片数量：${styleCount} 张，${styleCount}种风格各生成1张`,
    `- 图片比例：${ratioText}`,
    "- 输出要求：每张图独立风格，不混合、不简化，统一视觉调性；**图片中不得出现任何文字、LOGO、标签、贴纸类元素**；**强化真实生活感，弱化AI合成感**",
    `- 产品保持基准：主体产品以“${vars.firstImage}”为唯一依据，不变形、不变色、不增删元素/文字`,
    `- 场景参考输入：主体产品图/场景图列表统一引用“${vars.imageList}”`,
    ...(direction
      ? [`- 额外方向（权重 0.5）：${direction}`, "- 方向吸收规则：只中度影响风格强调和氛围包装，不覆盖产品保持规则与对应分析图风格骨架。"]
      : []),
    "",
    `【${styleCount}种风格精准规范（可复用）】`,
    styleBlocks,
    "",
    "【终极禁用规则（绝对执行）】",
    "1. **严格禁止图片中出现任何文字、LOGO、标签、贴纸、二维码、装饰性文字元素**，背景文字需完全模糊至不可辨认",
    "2. 禁止日期、网址、二维码、乱彩符号、多余装饰文字",
    "3. 产品必须为核心视觉主体，占比≥40%，清晰完整不被遮挡",
    "4. 禁止过度干净或完美的AI质感，必须加入**环境噪点、轻微模糊、动态人物、真实生活细节**强化实拍感",
    "5. 色彩与场景必须严格匹配对应分析图，不得混用其他分析图风格",
    `6. 禁止产品图“${vars.firstImage}”变形、变色、增删元素/文字`,
    "7. 禁止出现乱码、文字不清晰！禁止出现乱码、文字不清晰！禁止出现乱码、文字不清晰！",
  ].join("\n");
}

function buildDynamicSceneStyleTemplateBlock(scene, index) {
  const serial = index + 1;
  const styleName = inferSceneTransferStyleName(scene);
  const ratioLabel = inferSceneAspectRatioLabel(scene?.aspectRatio);
  const productRatio = inferSceneTransferProductRatio(scene);
  const background = String(scene?.background || "根据对应分析图动态填写真实场景空间、前后景关系与环境层次").trim();
  const composition = String(scene?.composition || "根据对应分析图动态填写主体摆放、留白关系与画面重心").trim();
  const camera = String(scene?.camera || "根据对应分析图动态填写景别、机位与视角").trim();
  const light = String(scene?.light || "根据对应分析图动态填写主光方向、亮部控制与阴影关系").trim();
  const color = String(scene?.color || "根据对应分析图动态填写主色调、冷暖关系与颜色层次").trim();
  const material = String(scene?.material || "根据对应分析图动态填写表面材质、纹理、反光和真实细节").trim();
  const details = String(scene?.details || "根据对应分析图动态填写器具、道具、水珠、指纹、边缘与环境痕迹").trim();
  const mood = String(scene?.mood || "根据对应分析图动态填写生活方式氛围与情绪感受").trim();

  return [
    "---",
    `### 风格${serial}：${styleName}`,
    `- 对应分析图：图${serial}`,
    `- 参考比例：${ratioLabel}`,
    "#### 背景层",
    `1. 场景空间：${background}`,
    `2. 道具与环境元素：根据图${serial}动态补充真实可见的桌面、吧台、窗景、植物、餐具、器具、手部、人物或空间陪体，不写具体品牌与logo`,
    "#### 产品层",
    `1. 主体产品：固定使用变量 {{ $('输入参数汇总').item.json['图片信息'][0] }} 与 {{ $('输入参数汇总').item.json['图片信息'] }}，主体占比约${productRatio}，保持原始外形、比例、包装结构和关键细节不变`,
    `2. 构图与镜头：${composition}，${camera}`,
    `3. 光线与色彩：${light}，${color}`,
    `4. 材质细节：${material}，${details}`,
    "#### 氛围强化",
    `- 整体氛围：${mood}`,
    "- 强化真实手机/相机实拍感、自然噪点、真实反光、真实阴影、轻微景深，不要出现AI拼接感",
    `- 画面比例保持${ratioLabel}，整体风格只吸收图${serial}的视觉特征，不与其他分析图混合`,
  ].join("\n");
}

function buildDynamicSceneRatioSummary(scenes) {
  const safeScenes = Array.isArray(scenes) ? scenes.filter(Boolean) : [];
  if (!safeScenes.length) {
    return "按分析图原始比例输出";
  }

  const labels = safeScenes.map((scene, index) => ({
    index,
    label: inferSceneAspectRatioLabel(scene?.aspectRatio),
  }));
  const uniqueLabels = Array.from(new Set(labels.map((item) => item.label)));

  if (uniqueLabels.length === 1) {
    return `${uniqueLabels[0]}（与分析图一致）`;
  }

  return `按分析图原始比例输出（${labels
    .map((item) => `图${item.index + 1}${item.label}`)
    .join("；")}）`;
}

function inferSceneAspectRatioLabel(aspectRatio) {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return "按分析图原始比例";
  }

  if (aspectRatio <= 0.78) {
    return "3:4 竖图";
  }

  if (aspectRatio >= 1.2) {
    return "4:3 横图";
  }

  return "1:1 方图";
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
    "请基于下面这条原笔记，写一份给其他 AI 使用的仿写提示词。",
    "目标是尽量复刻原笔记的内容骨架、语气、节奏和重点信息，而不是只写通用模板。",
    "",
    `原笔记标题：${title}`,
    `原笔记正文：${body}`,
    `原笔记标签：${tags.length ? tags.join("、") : "无"}`,
    "",
    "请在提示词中明确要求：",
    "1. 优先复刻原笔记的标题方式、情绪浓度、口语感和记忆点。",
    "2. 正文要尽量复刻原笔记的叙述顺序、重点信息、细节密度和真实体验感。",
    "3. 保留原文里明确的偏好、判断、对比、感受和个人表达习惯。",
    `4. 内容方向定位为：${profile.topicPosition}。`,
    `5. 内容主体聚焦为：${profile.subjectFocus}。`,
    `6. 写作类型定位为：${profile.categoryLabel}。`,
    `7. 结构节奏尽量贴近原笔记：${profile.structureHint}。`,
    `8. 语气风格尽量贴近原笔记：${profile.toneHint}。`,
    `9. 重点信息锚点参考：${profile.focusHint}。`,
    `10. 建议采用的叙述视角：${profile.perspectiveHint}。`,
    `11. 开头方式参考：${profile.openingHint}。`,
    `12. 中间段落重点参考：${profile.middleHint}。`,
    `13. 结尾方式参考：${profile.endingHint}。`,
    "14. 要分析原笔记的标题和开头钩子类型，例如反差、提问、结果先行、痛点、清单、悬念、劝告、身份背书，并在提示词里明确要求复刻。",
    "15. 要分析原笔记是否使用数字增强表达，例如数量词、步骤编号、时间、价格、频次、比例、区间、排名或对比数字；如果原文没有数字，不要强行添加，但可说明是否适合补充数字增强记忆点。",
    "16. 要分析原笔记的语气与句式：是聊天感、安利感、吐槽感、复盘感、专业建议感还是克制说明型；同时识别短句/长句比例、断句习惯、排比、对比、设问、反问、感叹、括号补充、口头语和强调词。",
    "17. 要分析原笔记的信息组织方式：先结论后展开、先场景后观点、先痛点后方案、先体验后总结、先对比后推荐，还是清单式推进。",
    "18. 关键信息锚点里要明确哪些内容必须保留原貌或同等力度复现，例如核心卖点、场景、个人感受、对比对象、结果反馈、品牌词、产品名、价格和时间信息。",
    "19. 标题字数不超过18字；如含英文，总长度不超过15字。",
    "20. 正文字数控制在200-600字内。",
    "21. 标签数量5-8个，单个标签长度不超过10个字。",
    "22. 不要套话、空话、总结腔或行业通稿，要像真实用户亲自写的。",
    "23. 允许模仿写法，但不能照抄原句，也不能编造原文没有的事实、数据、体验、效果或立场。",
    "24. 输出结构固定为：【标题策略】【正文结构】【语气风格】【关键信息锚点】【标签策略】【写作限制】；并在合适的小项中明确写出“开头钩子”“数字策略”“句式节奏”“叙述视角”“结尾收束”。",
  ];

  if (direction) {
    lines.push("", `附加方向（权重0.5）：${direction}`);
    lines.push("附加方向只作为中度调节项，不要推翻原始内容主轴。");
  }

  lines.push("", "请直接输出可复制使用的仿写提示词正文。");
  return lines.join("\n");
}

function buildImagePromptV2(result, profile, scenes, direction = "") {
  const normalizedScenes = Array.isArray(scenes) && scenes.length
    ? scenes
    : [buildSceneProfileFallback(result, profile, 0)];

  return normalizedScenes
    .map((scene, index) => {
      const analysis = {
        style: String(scene?.style || "真实生活方式风格").trim() || "真实生活方式风格",
        composition: String(scene?.composition || "主体清晰居中").trim() || "主体清晰居中",
        camera: String(scene?.camera || "自然视角").trim() || "自然视角",
        background: String(scene?.background || "真实生活场景背景").trim() || "真实生活场景背景",
        light: String(scene?.light || "自然柔光").trim() || "自然柔光",
        color: String(scene?.color || "干净克制").trim() || "干净克制",
        material: String(scene?.material || "真实可感").trim() || "真实可感",
        mood: String(scene?.mood || "真实自然").trim() || "真实自然",
        prompt: String(scene?.prompt || "").trim(),
        negative: String(scene?.negative || "").trim(),
        params: String(scene?.params || "").trim(),
        details: String(scene?.details || "").trim(),
      };

      const templateLines = [
        `请生成一张写实风格的${profile.subjectFocus}场景图，主体使用变量 ${WORKFLOW_TEMPLATE_VARIABLES.productImageList} 中上传的产品图。`,
        "画面必须强调真实拍摄质感，看起来像手机或相机真实拍摄，不要像AI插画、3D渲染图或过度精修海报。",
        "产品主体必须保持原始外形、比例、包装结构和关键材质细节，不要变形，不要替换主体。",
        "要保留物体边缘轮廓、表面纹理、真实反光、透明度变化，以及水珠、指纹、轻微磨损、接缝等真实细节。",
        `图片概括：${analysis.prompt || `${analysis.composition}；${analysis.background}；${analysis.mood}`}`,
        `构图与视角：${analysis.composition}；${analysis.camera}。`,
        `背景环境：${analysis.background}。`,
        `光线表现：${analysis.light}。`,
        `色彩氛围：${analysis.color}。`,
        `材质质感：${analysis.material}。`,
        `画面细节：${analysis.details || "保留清晰主体落位空间和前中后景层次。"}。`,
        `整体氛围：${analysis.mood}。`,
        "加入真实摄影细节：自然阴影、真实景深、轻微环境噪点、真实高光与反射、不过度完美的生活痕迹。",
        "不要出现可识别品牌标记、logo、可读文字、额外贴纸、无关文案或明显 AI 痕迹。",
        "# 图片比例：3:4竖图。",
        analysis.negative ? `补充约束：${analysis.negative}` : "",
        analysis.params ? `参数提示：${analysis.params}` : "",
        direction ? `额外融入以下方向：${direction}` : "",
      ]
        .filter(Boolean)
        .join(" ");

      return [
        `【图${index + 1}】`,
        "图片风格与元素分析：",
        `- 空间风格：${analysis.style}`,
        `- 核心元素：${analysis.material}${analysis.details ? `；${analysis.details}` : ""}`,
        `- 光线与色彩：${analysis.light}，${analysis.color}`,
        `- 构图与视角：${analysis.composition}，${analysis.camera}`,
        `- 氛围：${analysis.mood}`,
        analysis.prompt ? `- 图片概括：${analysis.prompt}` : "",
        "",
        "可复用 Prompt 模板（支持变量替换）：",
        "```markdown",
        templateLines,
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

function buildSceneFingerprint(scene) {
  const style = String(scene?.style || "").trim() || "真实生活方式风格";
  const composition = String(scene?.composition || "").trim() || "主体清晰居中";
  const camera = String(scene?.camera || "").trim() || "自然视角";
  const background = String(scene?.background || "").trim() || "真实生活场景背景";
  const light = String(scene?.light || "").trim() || "自然柔光";
  const color = String(scene?.color || "").trim() || "干净克制";
  const material = String(scene?.material || "").trim() || "真实质感";
  const mood = String(scene?.mood || "").trim() || "真实自然";
  const spreadX = Number(scene?.spreadX);
  const spreadY = Number(scene?.spreadY);
  const scale =
    Number.isFinite(spreadX) && Number.isFinite(spreadY)
      ? (spreadX + spreadY) / 2 <= 0.18
        ? "近景聚焦"
        : (spreadX + spreadY) / 2 <= 0.28
          ? "中近景"
          : "留白更足"
      : "中近景";

  return [style, composition, camera, background, light, color, material, mood, scale]
    .filter(Boolean)
    .join("；");
}

function buildImagePromptV2(result, profile, scenes, direction = "") {
  const normalizedScenes = Array.isArray(scenes) && scenes.length
    ? scenes
    : [buildSceneProfileFallback(result, profile, 0)];

  return normalizedScenes
    .map((scene, index) => {
      const analysis = {
        style: String(scene?.style || "真实生活方式风格").trim() || "真实生活方式风格",
        composition: String(scene?.composition || "主体清晰居中").trim() || "主体清晰居中",
        camera: String(scene?.camera || "自然视角").trim() || "自然视角",
        background: String(scene?.background || "真实生活场景背景").trim() || "真实生活场景背景",
        light: String(scene?.light || "自然柔光").trim() || "自然柔光",
        color: String(scene?.color || "干净克制").trim() || "干净克制",
        material: String(scene?.material || "真实质感").trim() || "真实质感",
        mood: String(scene?.mood || "真实自然").trim() || "真实自然",
        fingerprint: buildSceneFingerprint(scene),
        prompt: String(scene?.prompt || "").trim(),
        negative: String(scene?.negative || "").trim(),
        params: String(scene?.params || "").trim(),
        details: String(scene?.details || "").trim(),
      };

      const whatItShows = buildSimpleImageDescription(result, profile, scene, index);

      return [
        `【图${index + 1}】`,
        "图片内容：",
        `- ${whatItShows}`,
      ].join("\n");
    })
    .join("\n\n");
}

function buildSimpleImageDescription(result, profile, scene, index) {
  const title = String(result?.title || "").trim();
  const body = String(result?.body || "").trim();
  const sceneText = [
    String(scene?.style || "").trim(),
    String(scene?.composition || "").trim(),
    String(scene?.camera || "").trim(),
    String(scene?.background || "").trim(),
    String(scene?.light || "").trim(),
    String(scene?.color || "").trim(),
    String(scene?.material || "").trim(),
    String(scene?.mood || "").trim(),
  ]
    .filter(Boolean)
    .join("，");

  const details = String(scene?.details || "").trim();
  const prompt = String(scene?.prompt || "").trim();
  const fallback = `第${index + 1}张图，主要是${profile.subjectFocus}相关的真实场景，画面里有${sceneText || "日常生活场景"}。`;

  if (prompt) {
    return `${prompt}。${details ? `细节是${details}。` : ""}`;
  }

  if (sceneText) {
    return `${sceneText}。${details ? `细节是${details}。` : ""}`;
  }

  if (title || body) {
    return `${title || "这张图"}相关的场景图，画面内容是${body || fallback}`;
  }

  return fallback;
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
      "附加提示词方向（权重 0.5）：",
      direction,
      "生成时以 0.5 权重吸收以上方向要求。它用于中度调节标题、语气、结构和重点信息，但不能覆盖原始内容主轴。"
    );
  }

  return lines.join("\n");
}

function buildRewritePrompt(result, direction = "") {
  return buildRewritePromptV2(result, direction);
}

async function buildImageGenerationPrompt(result, direction = "") {
  const profile = analyzeNoteProfile(result);
  const imageUrls = collectPromptAnalysisImageUrls(result);
  if (!imageUrls.length) {
    return buildImagePromptV2(result, profile, [buildSceneProfileFallback(result, profile, 0)], direction);
  }

  const scenes = await Promise.all(
    imageUrls.map((imageUrl, index) => analyzePromptImage(imageUrl, result, profile, index))
  );

  return buildImagePromptV2(result, profile, scenes, direction);
}

function collectPromptAnalysisImageUrls(result) {
  return collectRenderableImageUrls(result).slice(0, IMAGE_PROMPT_REFERENCE_LIMIT);
}

function buildImagePromptFallback(result, direction = "") {
  const profile = analyzeNoteProfile(result);
  const imageCount = Math.max(collectPromptAnalysisImageUrls(result).length, 1);
  const scenes = Array.from({ length: imageCount }, (_, index) => buildSceneProfileFallback(result, profile, index));
  return buildImagePromptV2(result, profile, scenes, direction);
}

function buildSceneTransferTemplate(result, direction = "") {
  const profile = analyzeNoteProfile(result);
  const theme = inferSceneTransferTemplateTheme(result, profile);
  const vars = WORKFLOW_TEMPLATE_VARIABLES;

  return [
    "【变量占位（固定保留）】",
    `- 正文内容：${vars.content}`,
    `- 主体产品图/场景图列表：${vars.imageList}`,
    `- 标题：${vars.title}`,
    `- 主体产品图首图：${vars.firstImage}`,
    `- LOGO参考：${vars.logoHint}`,
    `- 禁用LOGO：${vars.forbiddenLogo}`,
    "",
    "【核心主题】",
    `以标题“${vars.title}”为核心，结合正文“${vars.content}”和产品图“${vars.firstImage}”，LOGO“${vars.logoHint}”作为依据生成${theme.outputLabel}。`,
    "",
    "【生成参数】",
    "- 生成图片数量：7 张，7种风格各生成1张",
    "- 图片比例：9:16 竖图",
    "- 输出要求：每张图独立风格，不混合、不简化，统一视觉调性；**图片中不得出现任何文字、LOGO、标签、贴纸类元素**；**强化真实生活感，弱化AI合成感**",
    `- 产品保持基准：主体产品以“${vars.firstImage}”为唯一依据，不变形、不变色、不增删元素/文字`,
    `- 场景参考输入：主体产品图/场景图列表统一引用“${vars.imageList}”`,
    ...(direction ? [`- 额外方向（权重 0.5）：${direction}`, "- 方向吸收规则：只中度影响风格强调和氛围包装，不覆盖产品保持规则与七种场景骨架。"] : []),
    "",
    "【7种风格精准规范（可复用）】",
    "---",
    "### 风格1：车内随拍生活风（通勤日常·真实手机抓拍）",
    "#### 背景层",
    "1. 底色：**冷调灰蓝到浅灰渐变**，真实汽车内饰纹理，细腻皮革与塑料质感，无反光过度",
    "2. 光线：柔和阴天自然光从侧窗斜射进入，形成柔和明暗过渡，无硬阴影",
    "3. 环境细节：车门扶手、安全带卡扣、副驾位置轻微虚化，窗外街道、树木、车辆呈现自然动态模糊，远处行人轮廓模糊可见，营造真实通勤街景氛围",
    "",
    "#### 产品层",
    `核心主体：${theme.productLabel}，无任何LOGO、贴纸、文字，主体占比45%，表面带自然使用痕迹、轻微水汽或指纹痕迹，质感真实可感`,
    "构图：素人单手自然持握，手臂入镜一半，镜头贴近车窗，轻微倾斜角度，模拟随手抓拍",
    "光影：主体表面呈现柔和反光，无夸张高光，无塑料感",
    "",
    "#### 氛围强化",
    "- 全图加入**轻微胶片颗粒感**，模拟 iPhone 原生相机直出",
    "- 色彩偏冷白、低饱和，无过度磨皮，无AI完美感",
    "- 背景保持自然虚化，人物、车辆、街景均为模糊动态效果",
    "",
    "---",
    "### 风格2：阳光治愈户外风（公园树荫·温柔自然光）",
    "#### 背景层",
    "1. 底色：**浅绿到米白渐变**，真实草地、石板路、树皮纹理自然融合",
    "2. 光线：午后侧逆光，树叶形成**斑驳光影**洒在地面与主体表面，光感温柔通透",
    "3. 环境细节：草丛、落叶、树枝轻微虚化，远处行人、散步身影模糊可见，营造松弛公园氛围",
    "",
    "#### 产品层",
    `核心主体：${theme.productLabel}，无LOGO无贴纸，主体占比45%，表面带自然水珠、反光或细微质感变化`,
    "构图：素人双手轻握，手臂自然入镜，平视微仰角度，松弛不刻意",
    "光影：柔和透光感，主体半透明或高光层次自然，不做硬质广告光",
    "",
    "#### 氛围强化",
    "- 暖调低饱和，轻微柔焦",
    "- 加入真实环境噪点，无AI光滑感",
    "- 背景保持浅景深虚化，突出主体",
    "",
    "---",
    "### 风格3：门店氛围打卡风（商圈店内·真实到店感）",
    "#### 背景层",
    "1. 底色：**暖白到浅灰渐变**，店内大理石台面、木质柜体真实纹理",
    "2. 光线：店内暖光射灯 + 环境漫反射，光线柔和不刺眼",
    "3. 环境细节：模糊的店内顾客身影、店员动作轮廓、远处吧台设备虚化，营造热闹但不杂乱的真实门店氛围",
    "",
    "#### 产品层",
    `核心主体：${theme.productLabel}，无LOGO无贴纸，主体占比45%，主体轮廓完整清晰`,
    "构图：单手持物，手臂自然入镜，轻微仰拍，模拟到店随手拍",
    "光影：柔和店内反光，无夸张高光，质感自然",
    "",
    "#### 氛围强化",
    "- 暖调轻微泛黄，保持真实店内色温",
    "- 轻微颗粒，浅景深虚化",
    "- 背景人物动态模糊，无僵硬AI感",
    "",
    "---",
    "### 风格4：新中式禅意窗景风（庭院窗边·东方静谧感）",
    "#### 背景层",
    "1. 底色：**原木深棕到浅灰渐变**，实木桌面、宣纸、窗棂纹理细腻真实",
    "2. 光线：柔和窗景漫射光，无直射，安静温润",
    "3. 环境细节：窗外庭院绿植、白墙灰瓦轻微虚化，室内花瓶、枯枝、陶瓷器皿简约点缀，营造东方静谧氛围",
    "",
    "#### 产品层",
    `核心主体：${theme.productLabel}，无LOGO无文字，质感温润，占比45%`,
    "构图：桌面平视构图，安静摆放，无手持动作",
    "光影：柔和阴影，层次干净雅致",
    "",
    "#### 氛围强化",
    "- 低饱和、灰调温润色彩",
    "- 轻微胶片颗粒，无锐化过度",
    "- 画面干净、安静、真实不做作",
    "",
    "---",
    "### 风格5：城市街头元气风（斑马线街拍·年轻活力）",
    "#### 背景层",
    "1. 底色：**浅灰到深灰渐变**，真实柏油马路、斑马线纹理清晰自然",
    "2. 光线：晴天正面自然光，明亮清爽",
    "3. 环境细节：街道、建筑、行人、自行车、路灯全部自然虚化，营造城市街头活力氛围",
    "",
    "#### 产品层",
    `核心主体：${theme.productLabel}，无LOGO无贴纸，占比45%，整体清晰完整`,
    "构图：双手持物，街头平视角度，自然松弛",
    "光影：明亮干净，轻微反光，真实塑料、玻璃、纸面或金属质感",
    "",
    "#### 氛围强化",
    "- 高明亮度、低对比、轻微冷调",
    "- 街头随拍颗粒感",
    "- 背景动态模糊，无AI僵硬感",
    "",
    "---",
    "### 风格6：艺术轻奢服务风（店内服务视角·高级简约）",
    "#### 背景层",
    "1. 底色：**深灰到银灰渐变**，金属架、亚克力板、墙面质感高级细腻",
    "2. 光线：顶光 + 环境柔光，明暗层次高级",
    "3. 环境细节：空白纸杯或包装盒堆叠、店员袖口、简约绿植虚化，营造轻奢店内氛围",
    "",
    "#### 产品层",
    `核心主体：${theme.productLabel}，无LOGO无文字，占比40%，主体边缘锐利但不过分精修`,
    "构图：店员递物视角，手部入镜，平视构图",
    "光影：细腻金属反光与表面质感，无夸张特效",
    "",
    "#### 氛围强化",
    "- 低饱和、高级灰调",
    "- 轻微细腻颗粒",
    "- 背景浅景深，突出高级感",
    "",
    "---",
    "### 风格7：新中式清新国风（户外轻国风·温柔干净）",
    "#### 背景层",
    "1. 底色：**米白到浅灰渐变**，干净路面、墙面、植物纹理自然",
    "2. 光线：明亮柔光，无硬阴影",
    "3. 环境细节：素人衣摆、路边花草、远处行人模糊，营造清新国风户外感",
    "",
    "#### 产品层",
    `核心主体：${theme.productLabel}，无LOGO无贴纸，占比45%，画面重心稳定`,
    "构图：双手持握或轻摆放，温柔平视角度",
    "光影：干净通透，柔和自然",
    "",
    "#### 氛围强化",
    "- 清新低饱和，暖调柔和",
    "- 真实手机实拍颗粒",
    "- 背景自然虚化，无AI完美感",
    "",
    "【终极禁用规则（绝对执行）】",
    "1. **严格禁止图片中出现任何文字、LOGO、标签、贴纸、二维码、装饰性文字元素**，背景文字需完全模糊至不可辨认",
    "2. 禁止日期、网址、二维码、乱彩符号、多余装饰文字",
    "3. 产品必须为核心视觉主体，占比≥40%，清晰完整不被遮挡",
    "4. 禁止过度干净或完美的AI质感，必须加入**环境噪点、轻微模糊、动态人物、真实生活细节**强化实拍感",
    "5. 色彩严格匹配场景：车内风=冷灰蓝；户外风=暖绿；门店风=暖白；禅意风=原木灰；街头风=冷灰；轻奢风=深灰；国风=米白浅灰",
    `6. 禁止LOGO「${vars.forbiddenLogo}」在画面中以任何形式展示`,
    `7. 禁止产品图「${vars.firstImage}」变形、变色、增删元素/文字`,
    "8. 禁止出现乱码、文字不清晰！禁止出现乱码、文字不清晰！禁止出现乱码、文字不清晰！",
  ].join("\n");
}

function buildSceneTransferTemplateFromScenes(result, profile, scenes, direction = "", options = {}) {
  const theme = inferSceneTransferTemplateTheme(result, profile);
  const vars = WORKFLOW_TEMPLATE_VARIABLES;
  const normalizedScenes = Array.isArray(scenes) && scenes.length
    ? scenes.map((scene, index) => ({ ...scene, index }))
    : [{ ...buildSceneProfileFallback(result, profile, 0), index: 0 }];
  return normalizedScenes
    .map((scene, index) => buildSceneTransferStyleBlock(scene, index, theme, vars, direction, options))
    .join("\n\n");
}

function buildSceneTransferStyleBlock(scene, index, theme, vars, direction = "", options = {}) {
  const styleName = inferSceneTransferStyleName(scene);
  const productRatio = inferSceneTransferProductRatio(scene);
  const environmentDetails = buildSceneTransferEnvironmentDetail(scene);
  const analysisSummary = buildSceneTransferAnalysisSummary(scene, theme, styleName);
  const spatialStyle = buildSceneTransferSpatialStyle(scene, styleName, environmentDetails);
  const coreElements = buildSceneTransferCoreElements(scene, theme, environmentDetails);
  const atmosphere = buildSceneTransferAtmosphere(scene, options);
  const finalPrompt = buildSceneTransferFinalPrompt(scene, theme, vars, productRatio, direction);
  const params = buildSceneTransferPromptParams(scene);
  const negative = buildSceneTransferPromptNegative(scene);

  return [
    buildSceneTransferImageHeading(index + 1),
    "🌿 图片风格与元素分析",
    `${analysisSummary}`,
    `- 空间风格：${spatialStyle}`,
    `- 核心元素：${coreElements}`,
    `- 光线与色彩：${scene.light}，${scene.color}`,
    `- 构图与视角：${scene.composition}，${scene.camera}`,
    `- 氛围：${atmosphere}`,
    "",
    "✍️ 可复用 Prompt 模板（支持变量替换）",
    "```markdown",
    finalPrompt,
    "```",
    `补充约束：${negative}；${params}`,
  ].join("\n");
}

function buildSceneTransferFinalPrompt(scene, theme, vars, productRatio, direction = "") {
  const directionText = direction ? `，额外融入以下方向：${direction}` : "";

  return [
    `请生成一张写实风格的${theme.productSceneLabel}场景图，主体使用变量 ${vars.productImageList} 中上传的产品图。`,
    "产品主体必须保持原始外形、比例、包装结构和关键材质细节，不要变形，不要替换主体。",
    `构图与视角：${scene.composition}，${scene.camera}。`,
    `背景环境：${scene.background}。`,
    `光线表现：${scene.light}。`,
    `色彩氛围：${scene.color}。`,
    `材质质感：${scene.material}。`,
    `整体氛围：${scene.mood}。`,
    `主体在画面中占比约${productRatio}，整体呈现真实生活方式摄影质感，细节清晰，自然真实。`,
    "不要出现可识别品牌标记、logo、可读文字、额外贴纸、无关文案或明显 AI 痕迹。",
    "# 图片比例：3:4竖图。",
    directionText,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildSceneTransferAnalysisSummary(scene, theme, styleName) {
  const sceneType = describeSceneTypeForAnalysis(scene);
  return `这张图是${styleName}的${sceneType}${theme.productSceneLabel}场景参考图，核心特征如下：`;
}

function describeSceneTypeForAnalysis(scene) {
  if (/夜间/.test(scene.background) || /夜间/.test(scene.light)) {
    return "夜间门店或街景";
  }

  if (/门店|吧台/.test(scene.background)) {
    return "门店吧台";
  }

  if (/户外|街景|道路|自然环境/.test(scene.background)) {
    return "户外生活方式";
  }

  if (/桌面|简洁室内/.test(scene.background)) {
    return "静物桌面";
  }

  return "室内空间";
}

function buildSceneTransferSpatialStyle(scene, styleName, environmentDetails) {
  return `${styleName}，${scene.background}，${environmentDetails}`;
}

function buildSceneTransferCoreElements(scene, theme, environmentDetails) {
  return [
    `${theme.productSceneLabel}主体需要自然落入${scene.background}`,
    `${scene.material}`,
    environmentDetails.replace(/。$/, ""),
  ].join("，");
}

function buildSceneTransferAtmosphere(scene, options = {}) {
  const fallbackText = options.isFallback ? "，当前为结构化兜底分析" : "";
  return `${scene.mood}，${scene.details.replace(/。$/, "")}${fallbackText}`;
}

function buildSceneTransferPromptParams(scene) {
  const normalized = String(scene.params || "")
    .replace(/^画幅\s*[^，]+，?/, "")
    .replace(/。$/, "")
    .trim();

  return normalized || "写实优先，细节优先，真实相机质感优先";
}

function buildSceneTransferPromptNegative(scene) {
  const base = [
    "避免产品主体变形或比例失真",
    "避免出现可识别品牌标记、商标图形或清晰文字",
    "避免光线失真和明显 AI 拼接感",
  ];

  if (/夜间/.test(scene.background) || /夜间/.test(scene.light)) {
    base.push("避免暗部死黑和脏噪点");
  }

  return base.join("、");
}

function mapStyleNameToEnglish(scene) {
  const styleName = inferSceneTransferStyleName(scene);

  if (/夜景/.test(styleName)) {
    return "nighttime lifestyle scene";
  }

  if (/门店/.test(styleName)) {
    return "modern cafe interior scene";
  }

  if (/户外/.test(styleName)) {
    return "outdoor lifestyle scene";
  }

  if (/空间结构/.test(styleName)) {
    return "minimalist architectural interior scene";
  }

  if (/静物/.test(styleName)) {
    return "refined tabletop still-life scene";
  }

  return "lifestyle product scene";
}

function buildBackgroundPromptEnglish(scene) {
  if (/夜间环境背景/.test(scene.background)) {
    return "nighttime storefront setting with ambient shop lights, street bokeh, and layered shadows";
  }

  if (/门店|吧台/.test(scene.background)) {
    return "cafe counter setting with subtle environmental depth and realistic interior context";
  }

  if (/室内空间背景/.test(scene.background)) {
    return "minimalist indoor space with architectural lines, counter area, and visible spatial depth";
  }

  if (/户外街景或自然环境背景/.test(scene.background)) {
    return "outdoor setting with greenery, open air, and natural spatial depth";
  }

  if (/户外街景或道路背景/.test(scene.background)) {
    return "outdoor street-side setting with natural environmental context";
  }

  if (/桌面|简洁室内/.test(scene.background)) {
    return "clean tabletop or pared-back interior setting";
  }

  return "realistic lifestyle environment with layered foreground and background";
}

function buildLightPromptEnglish(scene) {
  if (/夜间暖色人工光/.test(scene.light)) {
    return "warm artificial night lighting with atmospheric highlights";
  }

  if (/夜间冷色环境光/.test(scene.light)) {
    return "cool nighttime ambient light with preserved shadow detail";
  }

  if (/自然散射光/.test(scene.light)) {
    return "soft diffused natural light";
  }

  if (/自然日光更直接/.test(scene.light)) {
    return "clear natural daylight with defined highlights and shadows";
  }

  if (/室内偏暖环境光/.test(scene.light)) {
    return "soft warm indoor light with gentle highlight rolloff";
  }

  if (/室内偏冷环境光/.test(scene.light)) {
    return "clean cool indoor lighting with controlled contrast";
  }

  return "soft ambient interior light with balanced highlights and shadows";
}

function buildColorPromptEnglish(scene) {
  return translateColorDescriptionToEnglish(scene.color);
}

function buildCompositionPromptEnglish(scene) {
  const parts = [];

  if (/画面中心/.test(scene.composition)) {
    parts.push("centered composition");
  } else if (/偏左/.test(scene.composition)) {
    parts.push("left-weighted composition");
  } else if (/偏右/.test(scene.composition)) {
    parts.push("right-weighted composition");
  }

  if (/焦点区与环境比例平衡/.test(scene.composition)) {
    parts.push("balanced subject-to-environment ratio");
  } else if (/保留较多环境信息/.test(scene.composition)) {
    parts.push("wider framing with more environmental context");
  } else if (/焦点区域占比高/.test(scene.composition)) {
    parts.push("subject-forward framing");
  }

  if (/近景特写/.test(scene.camera)) {
    parts.push("close-up shot");
  } else if (/中近景/.test(scene.camera)) {
    parts.push("medium close-up shot");
  } else if (/中景/.test(scene.camera)) {
    parts.push("medium shot");
  }

  if (/平视机位/.test(scene.camera)) {
    parts.push("eye-level view");
  } else if (/略俯视机位/.test(scene.camera)) {
    parts.push("slightly top-down view");
  } else if (/略仰视机位/.test(scene.camera)) {
    parts.push("slightly low-angle view");
  }

  if (/背景轻虚化/.test(scene.camera)) {
    parts.push("soft background blur");
  } else if (/景深偏深/.test(scene.camera)) {
    parts.push("deeper depth of field");
  }

  return parts.join(", ");
}

function buildMaterialPromptEnglish(scene) {
  if (/玻璃、金属、路面或墙面/.test(scene.material)) {
    return "realistic glass and metal reflections with textured surfaces";
  }

  if (/玻璃、金属、木质、织物/.test(scene.material)) {
    return "clear layers of glass, metal, wood, and fabric textures";
  }

  if (/木质、织物、纸面、墙面/.test(scene.material)) {
    return "realistic wood, fabric, paper, and wall textures";
  }

  if (/墙面、路面、绿植/.test(scene.material)) {
    return "natural wall, ground, and greenery textures";
  }

  return "realistic material texture and natural surface detail";
}

function buildMoodPromptEnglish(scene) {
  const translatedMood = translateMoodDescriptionToEnglish(scene.mood);
  return translatedMood ? `${translatedMood} mood` : "calm lifestyle atmosphere";
}

function translateColorDescriptionToEnglish(text) {
  const replacements = [
    ["以", ""],
    ["为主", " palette"],
    ["整体偏暖", "overall warm tone"],
    ["整体偏冷", "overall cool tone"],
    ["整体偏中性", "overall neutral tone"],
    ["饱和度克制", "restrained saturation"],
    ["饱和度适中", "moderate saturation"],
    ["颜色存在明显主次对比", "clear color hierarchy"],
    ["深灰", "deep gray"],
    ["浅灰", "light gray"],
    ["深黑", "charcoal black"],
    ["橙色", "muted orange"],
    ["浅橙", "soft orange"],
    ["黄色", "warm yellow"],
    ["绿色", "green"],
    ["蓝色", "blue"],
    ["米白", "off-white"],
    ["浅绿", "light green"],
    ["深棕", "dark brown"],
    ["，", ", "],
    ["、", ", "],
  ];

  let output = String(text || "");
  replacements.forEach(([from, to]) => {
    output = output.replaceAll(from, to);
  });

  return output.replace(/\s+/g, " ").trim();
}

function translateMoodDescriptionToEnglish(text) {
  const replacements = [
    ["夜间", "nighttime"],
    ["氛围感", "atmospheric"],
    ["真实", "authentic"],
    ["有情绪张力", "emotionally rich"],
    ["现代", "modern"],
    ["清爽", "clean"],
    ["空间感明确", "spacious"],
    ["真实、自然、内容感强", "natural, authentic, editorial"],
    ["自然", "natural"],
    ["日常", "everyday"],
    ["松弛", "relaxed"],
    ["清透", "airy"],
    ["轻松", "light"],
    ["在场感强", "immersive"],
    ["克制", "restrained"],
    ["干净", "clean"],
    ["可信赖", "trustworthy"],
    ["、", ", "],
  ];

  let output = String(text || "");
  replacements.forEach(([from, to]) => {
    output = output.replaceAll(from, to);
  });

  return output.replace(/\s+/g, " ").trim();
}

function buildSceneTransferUnifiedTone(theme, direction = "", options = {}) {
  const baseTone = theme.unifiedTone;
  const directionText = direction ? `，整体中度吸收“${direction}”的表达倾向` : "";
  const fallbackText = options.isFallback ? "，优先保证模板完整和主体产品不被篡改" : "";
  return `${baseTone}${directionText}${fallbackText}`;
}

function buildSceneTransferImageHeading(index) {
  return `图片${index}：\n# 图片比例：3:4竖图\n---`;
}

function numberToChineseText(value) {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

  if (value <= 10) {
    if (value === 10) {
      return "十";
    }

    return digits[value] || String(value);
  }

  if (value < 20) {
    return `十${digits[value % 10]}`;
  }

  const tens = Math.floor(value / 10);
  const units = value % 10;
  return `${digits[tens]}十${units ? digits[units] : ""}`;
}

function buildSceneTransferSubjectDetails(scene, theme, productRatio, environmentDetails) {
  return [
    `以用户上传产品图中的${theme.productSceneLabel}为唯一主体，主体占比建议${productRatio}`,
    `结合${scene.background}的空间关系与${scene.material}`,
    scene.details.replace(/。$/, ""),
    environmentDetails.replace(/。$/, ""),
  ].join("，");
}

function buildSceneTransferTypography(scene) {
  if (typeof scene.typography === "string" && scene.typography.trim()) {
    return "无明显额外版式文字，若场景中原有招牌或海报仅作为弱化背景信息处理，不新增文案贴片";
  }

  return "无";
}

function buildSceneTransferTemplateNegative(scene) {
  const parts = [
    "避免产品主体变形或比例失真",
    "避免品牌与文字信息被改写、错字、缺失或糊掉",
    "避免主体被道具遮挡或喧宾夺主",
    "避免整体画面出现明显 AI 拼接感",
  ];

  if (/夜间/.test(scene.mood) || /夜间/.test(scene.light)) {
    parts.push("避免暗部死黑、脏噪点和高光过曝");
  } else {
    parts.push("避免光线不均、过曝或阴影过重");
  }

  if (/暖/.test(scene.color)) {
    parts.push("避免色彩过黄或过艳");
  } else {
    parts.push("避免色彩发灰、失真或偏色");
  }

  return parts.join("、");
}

function buildSceneTransferTemplateParams(scene) {
  const normalized = String(scene.params || "")
    .replace(/^画幅\s*[^，]+，?/, "")
    .replace(/。$/, "")
    .trim();

  return normalized ? `分辨率1080p，${normalized}` : "分辨率1080p，写实优先，细节优先";
}

function inferSceneTransferStyleName(scene) {
  const combined = [scene.style, scene.background, scene.light, scene.color, scene.mood].join(" ");

  if (/夜间|街景光斑/.test(combined)) {
    return "夜景氛围纪实风";
  }

  if (/门店|吧台/.test(combined)) {
    return "门店氛围打卡风";
  }

  if (/天空|绿植|户外/.test(combined)) {
    return "户外自然治愈风";
  }

  if (/建筑线条|结构透视|空间线条/.test(combined)) {
    return "空间结构叙事风";
  }

  if (/桌面|简洁室内/.test(combined)) {
    return "静物陈列质感风";
  }

  if (/暖/.test(combined)) {
    return "暖调生活方式风";
  }

  if (/冷/.test(combined)) {
    return "冷调纪实随拍风";
  }

  return "真实生活方式分享风";
}

function inferSceneTransferProductRatio(scene) {
  const spreadX = Number.isFinite(scene.spreadX) ? scene.spreadX : 0.25;
  const spreadY = Number.isFinite(scene.spreadY) ? scene.spreadY : 0.25;
  const averageSpread = (spreadX + spreadY) / 2;

  if (averageSpread <= 0.18) {
    return "45%-50%";
  }

  if (averageSpread <= 0.28) {
    return "40%-45%";
  }

  return "35%-40%";
}

function buildSceneTransferEnvironmentDetail(scene) {
  if (/门店|吧台/.test(scene.background)) {
    return "保留店内人流、柜台、器具或空间纵深的轻微虚化感，形成真实到店氛围";
  }

  if (/天空|绿植|道路|街景|户外/.test(scene.background)) {
    return "保留路面、植物、建筑或远处人物的自然虚化，不做过度干净的广告背景";
  }

  if (/桌面|简洁室内/.test(scene.background)) {
    return "保留桌面、墙面、器皿或陈列关系的真实纹理，让画面有可感知的生活细节";
  }

  return "保留前景、中景、背景的空间层次和辅助元素，让场景保持真实生活感";
}

function buildSceneTransferAtmosphereDetail(scene) {
  if (/夜间/.test(scene.mood)) {
    return "加入轻微噪点和夜景颗粒，保留情绪张力，但不要出现死黑和脏噪点。";
  }

  if (/清透|轻松|松弛/.test(scene.mood)) {
    return "保留松弛、轻透、自然的手机随拍感，弱化摆拍和过度修图痕迹。";
  }

  if (/克制|干净|可信赖/.test(scene.mood)) {
    return "保持画面干净克制，但不要干净到失去真实使用痕迹。";
  }

  return "保留真实生活方式内容的轻微噪点、细节痕迹和自然景深，不要出现僵硬 AI 感。";
}

function formatSceneTransferMapping(count) {
  return Array.from({ length: count }, (_, index) => `风格${index + 1}->抓取图${index + 1}`).join("，");
}

function inferSceneTransferTemplateTheme(result, profile) {
  const combined = buildAnalysisText(result);

  if (/(咖啡|拿铁|美式|奶茶|果茶|茶饮|饮品|柠檬茶|奶盖)/.test(combined)) {
    return {
      outputLabel: "**素人实拍感**的新茶饮/咖啡分享图",
      productLabel: "真实质感饮品杯",
      productSceneLabel: "茶饮",
      productPromptLabel: "tea or coffee drink product",
      unifiedTone: "清新治愈/高级简约风格，店铺高级感场景全景图+茶饮特写图+第一视角松弛感打卡图",
    };
  }

  if (/(护肤|精华|面霜|水乳|彩妆|口红|粉底|香水)/.test(combined)) {
    return {
      outputLabel: "**素人实拍感**的护肤/彩妆产品分享图",
      productLabel: "真实质感产品包装",
      productSceneLabel: "护肤/彩妆产品",
      productPromptLabel: "skincare or makeup product",
      unifiedTone: "清新治愈/高级简约风格，梳妆台或店铺高级感场景全景图+护肤/彩妆产品特写图+第一视角松弛感打卡图",
    };
  }

  if (/(包包|鞋子|穿搭|单品|服装|饰品|配件)/.test(combined)) {
    return {
      outputLabel: "**素人实拍感**的单品种草分享图",
      productLabel: "真实质感主体单品",
      productSceneLabel: "主体单品",
      productPromptLabel: "fashion or lifestyle item",
      unifiedTone: "清新治愈/高级简约风格，空间氛围场景全景图+主体单品特写图+第一视角松弛感打卡图",
    };
  }

  return {
    outputLabel: `**素人实拍感**的${profile.topicPosition}产品场景分享图`,
    productLabel: "真实质感主体产品",
    productSceneLabel: "主体产品",
    productPromptLabel: "product",
    unifiedTone: "清新治愈/高级简约风格，高级感场景全景图+主体产品特写图+第一视角松弛感打卡图",
  };
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
  const material = describeVisualMaterial(visual);
  const details = describeVisualDetails(visual);
  const typography = "若画面里有招牌、海报或版式文字，可概括其位置与排版节奏；若无则保持无文字。";
  const mood = describeVisualMood(visual);
  const hasTextOverlay = detectVisualTextPresence(visual);
  const normalizedTypography = hasTextOverlay
    ? "画面中有文字信息，需概括其位置、字号对比、对齐方式与排版节奏。"
    : "";
  const prompt = buildVisualReplicaPrompt({
    composition,
    camera,
    background,
    light,
    color,
    material,
    details,
    mood,
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
    typography: normalizedTypography,
    hasTextOverlay,
    mood,
    prompt,
    negative: buildVisualNegativePrompt(visual),
    params: buildVisualParamHint(visual),
    aspectRatio: visual.aspectRatio,
    spreadX: visual.spreadX,
    spreadY: visual.spreadY,
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
  const hasTextOverlay = inferFallbackHasTextOverlay(result, profile);
  const typography = hasTextOverlay
    ? "画面中有文字信息，需概括其位置、字号对比、对齐方式与排版节奏。"
    : "";

  return {
    style: fallbackStyle,
    composition: fallbackComposition,
    camera: "中近景平视机位，视觉焦点清晰，背景轻微虚化",
    background: `围绕“${profile.topicPosition}”的真实生活场景`,
    light: fallbackLight,
    color: fallbackColor,
    material: fallbackMaterial,
    details: "保留清晰主体落位空间和前中后景层次，让主体产品嵌入后仍然自然可信。",
    typography: "若画面存在招牌、海报或版式文字，描述其位置与密度；若无则保持无文字。",
    mood: fallbackMood,
    typography,
    hasTextOverlay,
    prompt:
      "将主体产品自然融入当前场景风格中，保留构图、环境层次、机位、光线、配色与氛围特征，输出真实自然的高质量实拍成图。",
    negative:
      "不要出现第二个主产品，不要加入品牌logo或大段文字，不要塑料感CG，不要过度磨皮，不要文字乱码。",
    params: "画幅 3:4，写实强度中高，清晰度优先，细节优先。",
    aspectRatio: 0.75,
    spreadX: 0.25,
    spreadY: 0.25,
  };
}

function detectVisualTextPresence(visual) {
  if (!visual || typeof visual !== "object") {
    return false;
  }

  const horizontalBanding = Math.abs((visual.topBrightness || 0) - (visual.bottomBrightness || 0)) >= 16;
  const structuredLayout = Boolean(visual.hasStructuredLines);
  const focusedCenter = (visual.spreadX || 0) <= 0.24 && (visual.spreadY || 0) <= 0.22;
  const cleanSurface = Boolean(visual.isCleanBackground);

  return structuredLayout && (horizontalBanding || focusedCenter || cleanSurface);
}

function inferFallbackHasTextOverlay(result, profile) {
  const combined = buildAnalysisText(result);

  if (/(封面|标题|大字|海报|版式|排版|信息图|图文|首图|banner|headline)/i.test(combined)) {
    return true;
  }

  return /干净明亮|信息组织清楚|封面逻辑/.test(String(profile?.qualityHint || ""));
}

function describeVisualStyle(visual) {
  if (visual.isNight) {
    return visual.depthContrast >= 1.18 ? "夜间氛围实拍，浅景深纪实感" : "夜间纪实实拍，环境氛围明显";
  }

  if (visual.isOutdoor) {
    return visual.contrast >= 55 ? "户外纪实抓拍，生活感和现场感都比较强" : "清透自然的户外生活方式实拍";
  }

  if (visual.isCleanBackground) {
    return "克制简洁的商业场景摄影，画面干净";
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
      ? "视觉焦点位于画面中心"
      : horizontal === "居中"
        ? `视觉焦点居中${vertical}`
        : vertical === "居中"
          ? `视觉焦点${horizontal}`
          : `视觉焦点${horizontal}${vertical}`;
  const focusScale =
    (visual.spreadX + visual.spreadY) / 2 <= 0.18
      ? "焦点区域占比高，主视觉集中"
      : (visual.spreadX + visual.spreadY) / 2 <= 0.28
        ? "焦点区与环境比例平衡"
        : "保留较多环境信息，场景层次更完整";

  return `${placement}，${focusScale}`;
}

function describeVisualCamera(visual) {
  const spreadAverage = (visual.spreadX + visual.spreadY) / 2;
  const shotScale = spreadAverage <= 0.18 ? "近景特写" : spreadAverage <= 0.28 ? "中近景" : "中景";
  const angle = visual.centerY <= 0.38 ? "略仰视机位" : visual.centerY >= 0.62 ? "略俯视机位" : "平视机位";
  const depth = visual.depthContrast >= 1.18 ? "焦点区域清晰，背景轻虚化" : "整体清晰，景深偏深";
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
    return "简洁室内或桌面环境，干扰元素少，主视觉承载区突出";
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
    return "室内偏暖环境光，亮部柔和，焦点区域边缘有自然高光";
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

function describeVisualMaterial(visual) {
  if (visual.isNight) {
    return "玻璃、金属、路面或墙面等表面高光自然，暗部仍保有纹理";
  }

  if (visual.isOutdoor) {
    return visual.averageSaturation <= 0.22
      ? "墙面、路面、绿植或空气层次的质感自然克制"
      : "玻璃、植被、建筑和地面材质层次清楚，表面反光自然";
  }

  if (visual.isCleanBackground) {
    return "台面、墙面或背景表面干净平整，反光克制，边缘清楚";
  }

  return visual.averageSaturation <= 0.22
    ? "木质、织物、纸面、墙面等常见表面质感真实细腻"
    : "玻璃、金属、木质、织物等材质层次清楚，保留真实触感";
}

function describeVisualDetails(visual) {
  if (visual.depthContrast >= 1.18) {
    return "保留清晰焦点区与背景虚化层次，让主体产品稳定落在清晰焦点区，背景自然后退。";
  }

  if (visual.hasStructuredLines) {
    return "保留环境中的线条透视、结构层次和空间纵深，让主体产品嵌入后依然可信，不要把背景做平。";
  }

  if (visual.isCleanBackground) {
    return "减少无关元素，保留干净留白，让主体产品成为稳定视觉中心。";
  }

  return "保留前景、中景、背景的层次变化，并让辅助环境元素服务于主体产品与整体氛围。";
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
    "将主体产品自然融入一个真实生活方式场景中，整体必须像真实拍摄照片而不是AI合成图，",
    `${scene.composition}，${scene.camera}，`,
    `空间环境为${scene.background}，`,
    `光线表现为${scene.light}，`,
    `整体配色${scene.color}，`,
    `重点呈现${scene.material}，`,
    `${scene.details}`,
    "并保留物体边缘轮廓、表面纹理、真实反光、透明度变化、轻微水汽或磨损等细节，",
    `整体氛围${scene.mood}，`,
    "输出真实自然、层次清楚、可直接用于最终产品场景迁移成图的高质量画面。",
  ].join("");
}

function buildVisualNegativePrompt(visual) {
  const parts = [
    "不要出现第二个主产品",
    "不要让人物喧宾夺主",
    "不要出现与主体产品无关的抢镜食物、饮品或器物",
    "不要加入品牌logo或无关文字",
    "不要文字乱码",
    "不要塑料感CG",
    "不要过度磨皮",
    "不要过度AI味、过度完美、过度光滑",
    "不要材质失真、边缘发虚、细节糊掉",
  ];

  if (visual.isNight) {
    parts.push("不要把夜景压成死黑");
    parts.push("不要出现脏噪点");
  }

  if (visual.isOutdoor) {
    parts.push("不要做成纯棚拍白底");
  }

  if (visual.depthContrast >= 1.18) {
    parts.push("不要让背景比焦点区还清晰");
  } else {
    parts.push("不要把背景虚化过度");
  }

  return parts.join("，");
}

function buildVisualParamHint(visual) {
  const ratio = inferAspectRatioLabel(visual.aspectRatio);
  const depth = visual.depthContrast >= 1.18 ? "浅到中景深" : "中等景深";
  const lightProtection = visual.isNight ? "暗部细节优先" : "高光保护优先";
  return `画幅 ${ratio}，写实强度中高，${depth}，${lightProtection}，真实摄影质感优先，物体细节优先。`;
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
