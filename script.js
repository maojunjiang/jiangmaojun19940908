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
let urlHistory = loadUrlHistory();
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
  resultPrompt.value = buildRewritePrompt(result);
  resultImagePrompt.value = buildImageGenerationPrompt(result);
  resetCopyButton();
  resetImagePromptButton();
  resetAllImagesButton();
  syncMediaLinks(result);

  resultTags.innerHTML = "";
  const safeTags = Array.isArray(result.tags) ? result.tags : [];
  safeTags.forEach((tagText) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `#${tagText}`;
    resultTags.appendChild(tag);
  });
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

function buildImageGenerationPrompt(result) {
  const profile = analyzeNoteProfile(result);
  const styleHint = inferImageStyleHint(result, profile);
  const compositionHint = inferImageCompositionHint(result, profile);
  const colorHint = inferImageColorHint(result, profile);
  const layoutHint = inferImageLayoutHint(result, profile);
  const mediumHint = inferImageMediumHint(result, profile);
  const lightingHint = inferImageLightingHint(result, profile);
  const materialHint = inferImageMaterialHint(result, profile);
  const qualityHint = inferImageQualityHint(result, profile);
  const atmosphereHint = inferImageAtmosphereHint(result, profile);
  const tagsText = formatPromptTags(result.tags);
  const imageCount = collectImageReferenceUrls(result).length;
  const imageSections = imageCount
    ? Array.from({ length: imageCount }, (_, index) =>
          [
            `图片 ${index + 1}：`,
            `请先准确分析这张图的主体、场景、镜头、构图、景别、视角、光线、用色、材质、版式感、氛围、媒介属性，然后单独输出这一张图的复刻 prompt。`,
            `要求这张图的生成质量对齐原图，保留相同的视觉特征和完成度，优先做到“像同一张图”，而不是仅仅“风格相似”。`,
            "输出字段：",
            `- 视觉拆解：主体与场景 / 构图与镜头 / 光线与用色 / 材质与质感 / 版式与层次 / 媒介属性 / 质量标准`,
            `- 复刻 prompt：写成一整段可直接喂给文生图模型的中文描述`,
            `- 负面提示：列出这张图在复刻时必须避免的问题`
          ].join("\n")
        )
        .join("\n\n")
    : "图片 1：请在此处粘贴需要复刻的图片，然后按要求输出视觉拆解与复刻 prompt。";

  return [
    "你是一名专业视觉设计总监兼 AI 视觉复刻提示词专家。",
    "请对以下每一张图片分别进行专业视觉拆解，并为每一张图单独生成可直接用于文生图模型的复刻 prompt。",
    "",
    "总要求：",
    "1. 每张图都要单独分析、单独输出，不要合并成一个泛化模板。",
    "2. 目标不是做“相似风格图”，而是尽量复刻出和原图一致的视觉特征、完成度和画面质量。",
    "3. 从专业角度分析每张图的主体、场景、构图、景别、镜头视角、画风、光线、用色、材质、版式、氛围、媒介属性，必要时判断是实拍、棚拍、静物、海报、渲染还是插画。",
    "4. 生成的 prompt 要足够具体，能让其他 AI 尽量还原原图，而不是只给抽象关键词。",
    "5. 不要写“参考这张图”“结合上下文”这种依赖额外说明的话，结果要能直接复制给其他 AI 使用。",
    "6. 如果图片中有多人物、多主体、多层背景、文字排版、道具细节、空间透视、色彩重点，都要明确写进 prompt。",
    "",
    "整组图片的辅助判断：",
    `- 内容主题：${profile.topicPosition}`,
    `- 主体类型：${profile.subjectFocus}`,
    `- 常见画风倾向：${styleHint}`,
    `- 常见构图倾向：${compositionHint}`,
    `- 常见用色倾向：${colorHint}`,
    `- 常见光线倾向：${lightingHint}`,
    `- 常见材质倾向：${materialHint}`,
    `- 常见版式倾向：${layoutHint}`,
    `- 常见媒介判断：${mediumHint}`,
    `- 常见氛围判断：${atmosphereHint}`,
    `- 质量对齐要求：${qualityHint}`,
    `- 辅助关键词：${tagsText}`,
    "",
    "请按以下格式输出：",
    "图片 1",
    "视觉拆解：",
    "复刻 prompt：",
    "负面提示：",
    "",
    "图片 2",
    "视觉拆解：",
    "复刻 prompt：",
    "负面提示：",
    "",
    imageSections
  ].join("\n");
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
  const images = Array.isArray(result.images) ? result.images : [];
  const primaryImage = typeof result.image === "string" ? result.image : "";
  const merged = primaryImage ? [...images, primaryImage] : [...images];
  const uniqueMap = new Map();

  merged.forEach((imageUrl) => {
    const key = buildImageDedupKey(imageUrl);
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, imageUrl);
    }
  });

  const unique = [...uniqueMap.values()];
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
