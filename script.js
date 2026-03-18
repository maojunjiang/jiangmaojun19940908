const form = document.querySelector("#parse-form");
const urlInput = document.querySelector("#note-url");
const submitButton = document.querySelector("#submit-button");
const statusCard = document.querySelector("#status-card");
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
const resultPrompt = document.querySelector("#result-prompt");
const copyPromptButton = document.querySelector("#copy-prompt-button");

const FALLBACK_IMAGE =
  "https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=1200&q=80";

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

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const rawUrl = urlInput.value.trim();
  if (!rawUrl) {
    setStatus("error", "链接不能为空", "先输入一条笔记链接再开始解析。");
    return;
  }

  let noteUrl;

  try {
    noteUrl = normalizeUrl(rawUrl);
  } catch (error) {
    setStatus("error", "链接格式不正确", "请输入完整链接，例如 https://example.com/note/123");
    return;
  }

  setStatus("loading", "正在解析", "正在抓取页面内容并整理结果，请稍等。");
  submitButton.disabled = true;

  try {
    const result = await parseNoteFromUrl(noteUrl);
    renderResult(result);

    const hasFallback = Boolean(result?.meta?.usedFallback);
    setStatus(
      hasFallback ? "error" : "success",
      hasFallback ? "解析受限" : "解析完成",
      hasFallback
        ? "目标站点可能限制抓取，当前结果基于可读取内容整理，建议稍后重试。"
        : "已成功提取图片、标题、正文、标签和提示词模板。"
    );
  } catch (error) {
    renderResult(buildFallbackResult(noteUrl, ""));
    setStatus(
      "error",
      "解析失败",
      error instanceof Error ? error.message : "当前无法访问该链接内容，请稍后重试。"
    );
  } finally {
    submitButton.disabled = false;
  }
});

carouselPrev.addEventListener("click", () => {
  moveCarousel(-1);
});

carouselNext.addEventListener("click", () => {
  moveCarousel(1);
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
  resetCopyButton();

  resultTags.innerHTML = "";
  const safeTags = Array.isArray(result.tags) ? result.tags : [];
  safeTags.forEach((tagText) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `#${tagText}`;
    resultTags.appendChild(tag);
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

function setStatus(type, title, message) {
  statusCard.className = `status-card ${type}`;
  statusCard.innerHTML = `
    <strong>${escapeHtml(title)}</strong>
    <p>${escapeHtml(message)}</p>
  `;
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

function buildImageDedupKey(imageUrl) {
  try {
    const parsed = new URL(imageUrl, window.location.origin);
    const proxied = parsed.pathname === "/api/image" ? parsed.searchParams.get("url") : "";
    const sourceUrl = proxied ? new URL(decodeURIComponent(proxied)) : parsed;
    const host = sourceUrl.hostname.toLowerCase();
    const pathname = normalizeImagePath(sourceUrl.pathname);

    if (/(xhscdn\.com|sns-webpic|qpic\.cn)/i.test(host)) {
      return `${host}${pathname}`;
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

function normalizeImagePath(pathname) {
  return pathname
    .replace(/!\w[\w-]*/g, "")
    .replace(/\/(thumbnail|thumb|small|mini|origin|master)\//gi, "/")
    .replace(/\/{2,}/g, "/");
}
