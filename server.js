const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

loadLocalEnvFiles();

const HOST = "127.0.0.1";
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const AI_PROVIDER = String(process.env.AI_PROVIDER || "ark").trim().toLowerCase();
const AI_API_BASE_URL = String(process.env.AI_API_BASE_URL || "").trim();
const AI_API_TOKEN = String(process.env.AI_API_TOKEN || "").trim();
const AI_API_MODEL = String(process.env.AI_API_MODEL || "doubao-seed-2-0-pro-260215").trim();
const AI_CHAT_COMPLETIONS_PATH = String(
  process.env.AI_CHAT_COMPLETIONS_PATH || "/api/v3/chat/completions"
).trim();
const GROBOTAI_PROMPT_PATH = String(
  process.env.GROBOTAI_PROMPT_PATH || "/api/agent/doubao_generate_character_wf"
).trim();
const GROBOTAI_ENTERPRISE_ID = String(process.env.GROBOTAI_ENTERPRISE_ID || "").trim();
const AI_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.AI_REQUEST_TIMEOUT_MS || "90000", 10);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const FALLBACK_IMAGE =
  "https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=1200&q=80";

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

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === "POST" && requestUrl.pathname === "/api/parse") {
      await handleParse(req, res);
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/prompts") {
      await handlePromptGeneration(req, res);
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/image") {
      await handleImageProxy(requestUrl, res);
      return;
    }

    if (req.method === "GET") {
      await serveStatic(requestUrl.pathname, res);
      return;
    }

    writeJson(res, 405, { error: "Method Not Allowed" });
  } catch (error) {
    writeJson(res, 500, {
      error: error instanceof Error ? error.message : "Internal Server Error",
    });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Note parser running at http://${HOST}:${PORT}`);
  });
}

async function handleParse(req, res) {
  const body = await readJsonBody(req);
  const inputUrl = typeof body.url === "string" ? body.url.trim() : "";

  if (!inputUrl) {
    writeJson(res, 400, { error: "缺少 url 参数。" });
    return;
  }

  let noteUrl;

  try {
    noteUrl = normalizeUrl(inputUrl);
  } catch (error) {
    writeJson(res, 400, { error: "链接格式不正确。" });
    return;
  }

  try {
    const result = await parseNoteFromUrl(noteUrl);
    writeJson(res, 200, buildClientResult(result));
  } catch (error) {
    writeJson(res, 502, {
      error: error instanceof Error ? error.message : "解析失败。",
      fallback: buildClientResult(buildFallbackResult(noteUrl, "")),
    });
  }
}

async function handlePromptGeneration(req, res) {
  if (!isAiPromptConfigured()) {
    writeJson(res, 503, {
      error: "AI 服务尚未配置，请补充 AI_API_BASE_URL 和 AI_API_TOKEN。",
    });
    return;
  }

  const body = await readJsonBody(req);
  const result = body?.result;
  const target = normalizePromptTarget(body?.target);
  const rewriteDirection = typeof body?.rewriteDirection === "string" ? body.rewriteDirection.trim() : "";
  const imageDirection = typeof body?.imageDirection === "string" ? body.imageDirection.trim() : "";

  if (!result || typeof result !== "object") {
    writeJson(res, 400, { error: "缺少 result 参数。" });
    return;
  }

  try {
    const prompts = await generatePromptsWithAi(result, {
      target,
      rewriteDirection,
      imageDirection,
    });
    writeJson(res, 200, prompts);
  } catch (error) {
    writeJson(res, 502, {
      error: error instanceof Error ? error.message : "AI 提示词生成失败。",
      debugMessages: Array.isArray(error?.debugMessages) ? error.debugMessages : [],
    });
  }
}

async function handleImageProxy(requestUrl, res) {
  const rawUrl = requestUrl.searchParams.get("url") || "";
  if (!rawUrl) {
    writePlain(res, 400, "Missing url");
    return;
  }

  let imageUrl;

  try {
    imageUrl = normalizeUrl(rawUrl);
  } catch (error) {
    writePlain(res, 400, "Invalid image url");
    return;
  }

  try {
    const response = await fetchWithRetry(imageUrl, {
      headers: buildRemoteHeaders(imageUrl, "image"),
      redirect: "follow",
    });

    if (!response.ok) {
      writePlain(res, response.status, "Image fetch failed", {
        "Cache-Control": "no-store",
      });
      return;
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await response.arrayBuffer());

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(buffer);
  } catch (error) {
    writePlain(res, 502, "Image proxy error", {
      "Cache-Control": "no-store",
    });
  }
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

function loadLocalEnvFiles() {
  const candidates = [".env.local", ".env"];

  for (const filename of candidates) {
    const filePath = path.join(__dirname, filename);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const source = fs.readFileSync(filePath, "utf8");
    source.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        return;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      if (!key || process.env[key]) {
        return;
      }

      const rawValue = trimmed.slice(separatorIndex + 1).trim();
      process.env[key] = stripEnvWrappingQuotes(rawValue);
    });
  }
}

function stripEnvWrappingQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function normalizeUrl(value) {
  const completed = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return new URL(completed).toString();
}

async function parseNoteFromUrl(noteUrl) {
  const directResponse = await fetch(noteUrl, {
    headers: buildRemoteHeaders(noteUrl, "html"),
    redirect: "follow",
  });

  if (!directResponse.ok) {
    throw new Error("目标链接访问失败，可能需要登录、签名或服务端代理。");
  }

  const html = await directResponse.text();
  if (!html.trim()) {
    throw new Error("没有读取到页面内容。");
  }

  const result = extractStructuredContent(html, noteUrl);
  if (!result.meta.usedFallback) {
    return result;
  }

  const proxyResult = await tryProxyParse(noteUrl);
  return proxyResult || result;
}

async function tryProxyParse(noteUrl) {
  try {
    const targetPath = noteUrl.replace(/^https?:\/\//i, "");
    const proxyUrl = `https://r.jina.ai/http://${targetPath}`;
    const response = await fetch(proxyUrl, {
      headers: {
        Accept: "text/plain, text/markdown, text/html",
      },
    });

    if (!response.ok) {
      return null;
    }

    if (!rawText.trim()) {
      return null;
    }

    return extractStructuredContent(rawText, noteUrl);
  } catch (error) {
    return null;
  }
}

function isAiPromptConfigured() {
  return Boolean(AI_API_BASE_URL && AI_API_TOKEN);
}

function normalizePromptTarget(target) {
  return target === "rewrite" || target === "image" ? target : "all";
}

function buildAiSystemPromptV2(target) {
  const lines = [
    "你是一个把小红书笔记整理成可复用提示词的助手。",
    "任务是忠实提炼原文与参考图中的表达方式，不要泛化成空洞行业模板。",
    "输出只允许 JSON，不要添加解释、前言或备注。",
  ];

  if (target === "rewrite") {
    lines.push('只输出 {"rewrite_prompt":"..."}。');
    lines.push("rewrite_prompt 必须按以下结构组织：标题策略、正文结构、语气风格、关键信息锚点、标签策略、写作限制。");
    lines.push("写作限制固定保留：标题不超过18字；正文200-600字；标签5-8个，单个标签不超过10个字。");
  } else if (target === "image") {
    lines.push('只输出 {"image_prompt":"..."}。');
    lines.push("image_prompt 必须按图片逐张输出，每张图都包含：图片内容概括、图片风格与元素分析、可复用 Prompt 模板、负面提示、参数建议。");
    lines.push("每张图的分析都必须尽可能具体，不能只写空泛风格词，必须写清场景空间、主体位置、景别机位、前中后景、光线来源、色彩层次、材质触感、道具元素、文字版式、留白与氛围。");
    lines.push("最终模板必须能让其他 AI 最大程度复刻参考图，不允许偷懒简写成一句概括。");
    lines.push("必须明确强调真实拍摄质感、真实镜头语言、真实材质纹理、真实使用痕迹和真实环境细节，避免AI感、CG感、塑料感、过度光滑和过度完美。");
    lines.push("模板必须直接使用产品图变量，并明确保留产品外形、比例、品牌与文字信息。");
    lines.push("每张图都要显式写出 # 图片比例：3:4竖图。");
  } else {
    lines.push('同时输出 {"rewrite_prompt":"...","image_prompt":"..."}。');
    lines.push("rewrite_prompt 负责复刻内容表达，image_prompt 负责复刻参考图视觉。");
  }

  return lines.join("\n");
}

function buildAiUserContentV2(result, imageUrls, options = {}) {
  const title = String(result?.title || "").trim();
  const body = String(result?.body || "").trim();
  const tags = Array.isArray(result?.tags)
    ? result.tags.map((tag) => String(tag || "").trim()).filter(Boolean)
    : [];
  const imageAnalyses = Array.isArray(result?.imageAnalyses) ? result.imageAnalyses : [];
  const target = normalizePromptTarget(options.target);
  const includeImageContext = target !== "rewrite";
  const rewriteDirection =
    typeof options.rewriteDirection === "string" ? options.rewriteDirection.trim() : "";
  const imageDirection =
    includeImageContext && typeof options.imageDirection === "string"
      ? options.imageDirection.trim()
      : "";

  const lines = [
    `生成目标：${
      target === "rewrite"
        ? "仅生成仿写提示词"
        : target === "image"
          ? "仅生成场景迁移提示词"
          : "同时生成仿写提示词和场景迁移提示词"
    }`,
    `原笔记标题：${title || "-"}`,
    `原笔记正文：${body || "-"}`,
    `原笔记标签：${tags.length ? tags.join("、") : "-"}`,
    "",
    "请优先提炼原文的表达顺序、重点信息、语气和情绪节奏，不要只抽象成泛化分类。",
  ];

  if (includeImageContext) {
    lines.splice(4, 0, `参考图数量：${imageUrls.length}`);
  }

  if (rewriteDirection) {
    lines.push(`仿写附加方向（权重0.5）：${rewriteDirection}`);
  }

  if (imageDirection) {
    lines.push(`场景迁移附加方向（权重0.5）：${imageDirection}`);
  }

  if (includeImageContext && imageAnalyses.length && (target === "image" || target === "all")) {
    lines.push("", "图片分析（逐张对应）：");
    imageAnalyses.forEach((item, index) => {
      const label = String(item?.imageLabel || `图片${index + 1}`).trim();
      lines.push(
        "",
        `${label}：`,
        `- 风格：${String(item?.style || "").trim() || "-"}`,
        `- 构图：${String(item?.composition || "").trim() || "-"}`,
        `- 视角：${String(item?.camera || "").trim() || "-"}`,
        `- 背景：${String(item?.background || "").trim() || "-"}`,
        `- 光线：${String(item?.light || "").trim() || "-"}`,
        `- 色彩：${String(item?.color || "").trim() || "-"}`,
        `- 材质：${String(item?.material || "").trim() || "-"}`,
        `- 细节：${String(item?.details || "").trim() || "-"}`,
        `- 文字与版式：${String(item?.typography || "").trim() || "-"}`,
        `- 氛围：${String(item?.mood || "").trim() || "-"}`,
        `- 复刻概括：${String(item?.prompt || "").trim() || "-"}`,
        `- 负面约束：${String(item?.negative || "").trim() || "-"}`,
        `- 参数建议：${String(item?.params || "").trim() || "-"}`,
        `- 主体横向占比：${Number.isFinite(item?.spreadX) ? item.spreadX.toFixed(2) : "-"}`,
        `- 主体纵向占比：${Number.isFinite(item?.spreadY) ? item.spreadY.toFixed(2) : "-"}`
      );
    });
  }

  lines.push("", "输出要求：");

  if (target === "rewrite") {
    lines.push("- 只输出 rewrite_prompt，不要输出 image_prompt。");
    lines.push("- rewrite_prompt 直接写成给其他 AI 使用的仿写提示词，不要写成新笔记。");
    lines.push("- 不要出现图片分析、成图说明、镜头语言、画面风格等图片相关内容。");
  } else if (target === "image") {
    lines.push("- 只输出 image_prompt，不要输出 rewrite_prompt。");
    lines.push("- image_prompt 直接写成给其他 AI 使用的成图提示词，不要写成图片说明。");
    lines.push("- 每张图都要先用 6-10 条 bullet 细拆参考图，再给出一段高还原度、可直接复制的完整成图提示词。");
    lines.push("- 完整成图提示词必须覆盖：主体摆放、场景空间、镜头景别、机位角度、背景层次、道具元素、光线来源、颜色关系、材质表面、氛围关键词、文字处理、负面限制、参数建议。");
    lines.push("- 必须把“真实拍摄”写进模板，例如真实摄影、手机/相机实拍、自然镜头、轻微景深、真实噪点、真实反光、真实阴影、真实磨损或水汽等细节。");
    lines.push("- 必须把“物体细节”写进模板，例如边缘轮廓、表面纹理、反光方式、透明度、褶皱、接缝、刻字、瓶口、杯盖、吸管、水珠、指纹、磨砂或高光质感。");
    lines.push("- 负面提示要明确排除：AI感过强、CG渲染感、塑料假面、错误结构、细节糊掉、边缘发虚、材质失真、过度锐化、过度磨皮、画面假干净。");
    lines.push("- 如果参考图信息很少，也要尽量把能观察到的细节写具体，不要退化成简单通用模板。");
    lines.push("- 必须严格套用下面给定的模板骨架输出 image_prompt，不允许自创标题层级或改成别的格式。");
    lines.push("- 其中“风格1、2、3、4”的名称、背景层、产品层、文字层、品牌信息层内容要根据分析图动态生成；骨架标题保持不变。");
    lines.push("- 每个风格都必须独立，不混合、不简化，且统一视觉调性。");
    lines.push("", "image_prompt 模板骨架：", buildDynamicImagePromptTemplateSpec());
  } else {
    lines.push("- rewrite_prompt 直接写成给其他 AI 使用的仿写提示词，不要写成新笔记。");
    lines.push("- image_prompt 直接写成给其他 AI 使用的成图提示词，不要写成图片说明。");
  }

  lines.push("- 输出内容要结构清晰、可复制、可直接投喂。");

  const textBlock = lines.join("\n");

  if (!includeImageContext || !imageUrls.length) {
    return textBlock;
  }

  return [
    {
      type: "text",
      text: textBlock,
    },
    ...imageUrls.map((imageUrl) => ({
      type: "image_url",
      image_url: {
        url: imageUrl,
      },
    })),
  ];
}

function buildDynamicImagePromptTemplateSpec() {
  const vars = WORKFLOW_TEMPLATE_VARIABLES;
  return [
    "【核心主题】",
    `以标题“${vars.title}”为核心，结合正文“${vars.content}”和产品图“${vars.logoHint}”，LOGO“${vars.forbiddenLogo}”作为依据生成专业的电商保健品海报/图。`,
    "",
    "【生成参数】",
    "- 生成图片数量：4 张，4 种风格各生成 1 张",
    "- 图片比例：9:16 竖图",
    "- 输出要求：每张图独立风格，不混合、不简化，统一视觉调性",
    "",
    "【4种风格精准规范（可复用）】",
    "---",
    "### 风格1：根据分析图1动态命名的风格",
    "#### 背景层",
    "1. 底色：根据分析图1动态填写主色调/渐变/底纹",
    "2. 辅助元素：根据分析图1动态填写场景符号、道具、装饰元素",
    "#### 产品层",
    "核心主体：根据分析图1动态填写产品摆放、占比、阴影、真实质感、细节纹理",
    "点缀元素：根据分析图1动态填写同色系辅助元素",
    "#### 文字层",
    `主标题：${vars.title}，根据分析图1动态填写字体气质、字号、位置`,
    "#### 品牌信息层",
    `顶部：LOGO「${vars.forbiddenLogo}」，固定不变形，不变色，不新增或删减元素`,
    "底部：根据分析图1动态填写产品核心卖点/昵称小字，黑体，字号20px，居中",
    "",
    "---",
    "### 风格2：根据分析图2动态命名的风格",
    "#### 背景层",
    "1. 底色：根据分析图2动态填写主色调/渐变/底纹",
    "2. 辅助元素：根据分析图2动态填写场景符号、道具、装饰元素",
    "#### 产品层",
    "核心主体：根据分析图2动态填写产品摆放、占比、阴影、真实质感、细节纹理",
    "点缀元素：根据分析图2动态填写同色系辅助元素",
    "#### 文字层",
    `主标题：${vars.title}，根据分析图2动态填写字体气质、字号、位置`,
    "#### 品牌信息层",
    `顶部：LOGO「${vars.forbiddenLogo}」，固定不变形，不变色，不新增或删减元素`,
    "底部：根据分析图2动态填写产品核心卖点/昵称小字，黑体，字号20px，居中",
    "",
    "---",
    "### 风格3：根据分析图3动态命名的风格",
    "#### 背景层",
    "1. 底色：根据分析图3动态填写主色调/渐变/底纹",
    "2. 辅助元素：根据分析图3动态填写场景符号、道具、装饰元素",
    "#### 产品层",
    "核心主体：根据分析图3动态填写产品摆放、占比、阴影、真实质感、细节纹理",
    "点缀元素：根据分析图3动态填写同色系辅助元素",
    "#### 文字层",
    `主标题：${vars.title}，根据分析图3动态填写字体气质、字号、位置`,
    "#### 品牌信息层",
    `顶部：LOGO「${vars.forbiddenLogo}」，固定不变形，不变色，不新增或删减元素`,
    "底部：根据分析图3动态填写产品核心卖点/昵称小字，黑体，字号20px，居中",
    "",
    "---",
    "### 风格4：根据分析图4动态命名的风格",
    "#### 背景层",
    "1. 底色：根据分析图4动态填写主色调/渐变/底纹",
    "2. 辅助元素：根据分析图4动态填写场景符号、道具、装饰元素",
    "#### 产品层",
    "核心主体：根据分析图4动态填写产品摆放、占比、阴影、真实质感、细节纹理",
    "点缀元素：根据分析图4动态填写同色系辅助元素",
    "#### 文字层",
    `主标题：${vars.title}，根据分析图4动态填写字体气质、字号、位置`,
    "#### 品牌信息层",
    `顶部：LOGO「${vars.forbiddenLogo}」，固定不变形，不变色，不新增或删减元素`,
    "底部：根据分析图4动态填写产品核心卖点/昵称小字，黑体，字号20px，居中",
    "",
    "【终极禁用规则（绝对执行）】",
    "1. 只允许出现：主标题 + 副标题 + 品牌名 + 底部产品卖点/昵称小字，禁止任何其他文字",
    "2. 禁止日期、网址、二维码、乱码、符号、多余小字",
    "3. 产品必须为核心视觉主体，占比≥40%，清晰完整，不被遮挡",
    "4. 禁止3D渲染、夸张光影、杂乱元素，严格保留清新专业质感",
    "5. 色彩必须严格匹配每个风格对应参考图的主色调与场景气质",
    `6. 禁止LOGO「${vars.forbiddenLogo}」变形、变色、新增或删减元素`,
    `7. 禁止产品图「${vars.logoHint}」变形、变色、新增或删减元素/文字`,
    "8. 禁止文字乱码、变形、不清晰；禁止文字乱码、变形、不清晰；禁止文字乱码、变形、不清晰；",
  ].join("\n");
}

async function generatePromptsWithAi(result, options = {}) {
  if (AI_PROVIDER === "grobotai") {
    return generatePromptsWithGrobotai(result, options);
  }

  const endpointUrl = buildAiEndpointUrl();
  const imageUrls = collectAiImageUrls(result);
  const target = normalizePromptTarget(options.target);
  const payload = {
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: buildAiSystemPrompt(target),
      },
      {
        role: "user",
        content: buildAiUserContent(result, imageUrls, options),
      },
    ],
  };
  if (AI_API_MODEL) {
    payload.model = AI_API_MODEL;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
  const responseFormats = buildAiResponseFormatCandidates(target);

  try {
    let lastError = null;

    for (const responseFormat of responseFormats) {
      const requestPayload = { ...payload };
      if (responseFormat) {
        requestPayload.response_format = responseFormat;
      }

      const response = await fetch(endpointUrl, {
        method: "POST",
        headers: buildAiRequestHeaders(),
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });

      const rawText = await response.text();
      if (!response.ok) {
        const error = new Error(
          `AI request failed: ${response.status} ${truncateErrorText(rawText)}`
        );

        if (shouldRetryWithoutStructuredOutput(response.status, rawText)) {
          lastError = error;
          continue;
        }

        throw error;
      }

      const parsed = parseAiResponsePayload(rawText);
      const content = extractAiMessageContent(parsed);
      const promptJson = parseAiJsonContent(content);

      return {
        rewritePrompt:
          target === "image" ? "" : formatRewritePromptOutput(promptJson.rewrite_prompt),
        imagePrompt:
          target === "rewrite" ? "" : formatImagePromptOutput(promptJson.image_prompt),
        debugMessages: payload.messages,
      };
    }

    throw lastError || new Error("AI prompt generation failed.");
    /*

    if (!response.ok) {
      throw new Error(`AI 接口返回异常：${response.status} ${truncateErrorText(rawText)}`);
    }

    const parsed = parseAiResponsePayload(rawText);
    const content = extractAiMessageContent(parsed);
    const promptJson = parseAiJsonContent(content);

    return {
      rewritePrompt:
        target === "image" ? "" : formatRewritePromptOutput(promptJson.rewrite_prompt),
      imagePrompt:
        target === "rewrite" ? "" : formatImagePromptOutput(promptJson.image_prompt),
    };
    */
  } catch (error) {
    if (error && typeof error === "object") {
      error.debugMessages = payload.messages;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function generatePromptsWithGrobotai(result, options = {}) {
  const endpointUrl = buildGrobotaiPromptUrl();
  const imageUrls = collectAiImageUrls(result);
  const target = normalizePromptTarget(options.target);
  const payload = {
    messages: [
      {
        role: "system",
        content: buildAiSystemPrompt(target),
      },
      {
        role: "user",
        content: buildAiUserContent(result, imageUrls, options),
      },
    ],
    model: AI_API_MODEL,
    temperature: 0.2,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
  const responseFormats = buildAiResponseFormatCandidates(target);

  try {
    let lastError = null;

    for (const responseFormat of responseFormats) {
      const requestPayload = { ...payload };
      if (responseFormat) {
        requestPayload.response_format = responseFormat;
      }

      const response = await fetch(endpointUrl, {
        method: "POST",
        headers: buildGrobotaiRequestHeaders(),
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });

      const rawText = await response.text();
      if (!response.ok) {
        const error = new Error(
          `AI request failed: ${response.status} ${truncateErrorText(rawText)}`
        );

        if (shouldRetryWithoutStructuredOutput(response.status, rawText)) {
          lastError = error;
          continue;
        }

        throw error;
      }

      const parsed = parseAiResponsePayload(rawText);
      const content = extractAiMessageContent(parsed);
      const promptJson = parseAiJsonContent(content);

      return {
        rewritePrompt:
          target === "image" ? "" : formatRewritePromptOutput(promptJson.rewrite_prompt),
        imagePrompt:
          target === "rewrite" ? "" : formatImagePromptOutput(promptJson.image_prompt),
        debugMessages: payload.messages,
      };
    }

    throw lastError || new Error("AI prompt generation failed.");
  } catch (error) {
    if (error && typeof error === "object") {
      error.debugMessages = payload.messages;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildAiEndpointUrl() {
  return new URL(AI_CHAT_COMPLETIONS_PATH, AI_API_BASE_URL).toString();
}

function buildGrobotaiPromptUrl() {
  return new URL(GROBOTAI_PROMPT_PATH, AI_API_BASE_URL).toString();
}

function buildAiRequestHeaders() {
  const headers = {
    Accept: "application/json, text/event-stream",
    Authorization: buildAuthorizationHeader(AI_API_TOKEN),
    "Content-Type": "application/json",
  };

  return headers;
}

function buildGrobotaiRequestHeaders() {
  const headers = {
    Accept: "application/json, text/event-stream",
    Authorization: buildAuthorizationHeader(AI_API_TOKEN),
    "Content-Type": "application/json",
  };

  if (GROBOTAI_ENTERPRISE_ID) {
    headers["enterprise-id"] = GROBOTAI_ENTERPRISE_ID;
  }

  return headers;
}

function buildAuthorizationHeader(token) {
  const normalized = String(token || "").trim();
  if (!normalized) {
    return "";
  }

  return /^Bearer\s+/i.test(normalized) ? normalized : `Bearer ${normalized}`;
}

function collectAiImageUrls(result) {
  const rawImages = Array.isArray(result?.images) ? result.images : [];
  const primaryImage = typeof result?.image === "string" ? result.image : "";
  const merged = primaryImage ? [primaryImage, ...rawImages] : [...rawImages];
  const uniqueMap = new Map();

  merged.forEach((imageUrl) => {
    const sourceUrl = toAiSourceMediaUrl(imageUrl);
    if (!sourceUrl || isVideoUrl(sourceUrl)) {
      return;
    }

    const key = buildImageDedupKey(sourceUrl);
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, sourceUrl);
    }
  });

  return [...uniqueMap.values()].slice(0, 12);
}

function toAiSourceMediaUrl(mediaUrl) {
  if (!mediaUrl) {
    return "";
  }

  try {
    const parsed = new URL(mediaUrl, "http://127.0.0.1");
    let sourceUrl = parsed;

    if (parsed.pathname === "/api/image") {
      const rawUrl = parsed.searchParams.get("url");
      if (rawUrl) {
        sourceUrl = new URL(decodeURIComponent(rawUrl));
      }
    }

    return normalizeMediaUrlForAi(sourceUrl);
  } catch (error) {
    return String(mediaUrl || "").trim();
  }
}

function isVideoUrl(url) {
  return /\.(mp4|mov|m4v|webm|m3u8)(\?|#|$)/i.test(String(url || ""));
}

function normalizeMediaUrlForAi(sourceUrl) {
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

function buildAiResponseFormatCandidates(target) {
  return [buildAiJsonSchemaResponseFormat(target), { type: "json_object" }, null];
}

function buildAiJsonSchemaResponseFormat(target) {
  const properties = {};
  const required = [];

  if (target !== "image") {
    properties.rewrite_prompt = {
      type: "string",
      description:
        "给其他 AI 使用的仿写提示词，描述标题、正文结构、语气、信息组织和风格模仿要求。",
    };
    required.push("rewrite_prompt");
  }

  if (target !== "rewrite") {
    properties.image_prompt = {
      type: "string",
      description:
        "给其他 AI 使用的产品场景迁移提示词，必须按“每张抓取图一段图片风格分析 + 一段可复用 Prompt 模板”的结构输出。",
    };
    required.push("image_prompt");
  }

  return {
    type: "json_schema",
    json_schema: {
      name: "prompt_output_schema",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties,
        required,
      },
    },
  };
}

function shouldRetryWithoutStructuredOutput(status, rawText) {
  if (status !== 400) {
    return false;
  }

  const normalized = String(rawText || "").toLowerCase();
  return (
    normalized.includes("response_format") ||
    normalized.includes("json_schema") ||
    normalized.includes("json_object") ||
    normalized.includes("invalidparameter")
  );
}

function buildAiSystemPromptLegacy(target) {
  const vars = WORKFLOW_TEMPLATE_VARIABLES;
  const lines = [
    "你是一名资深小红书内容策划 + 资深视觉导演 + 文生图提示词专家。",
  ];

  if (target === "rewrite") {
    lines.push("你当前只需要生成仿写提示词，不要输出场景迁移提示词。");
  } else if (target === "image") {
    lines.push("你当前只需要生成场景迁移提示词，不要输出仿写提示词。");
  } else {
    lines.push("你会同时完成两个任务：");
    lines.push("1. 生成一段高质量的仿写提示词，用于让其他 AI 参考这条笔记的标题、正文结构、语气、信息组织方式去仿写内容。");
    lines.push("2. 生成一段高质量的产品场景迁移提示词，用于让其他 AI 基于工作流变量、主体产品图和场景要求，生成可直接复用的产品场景迁移模板。");
  }

  lines.push("场景迁移提示词必须是可直接粘贴到 n8n / 工作流节点里的模板，不是对当前图片的解释说明。");
  lines.push("场景迁移提示词要严格按照“每张抓取图 = 一段图片风格分析 + 一段可复用 Prompt 模板”的格式输出。");
  lines.push("抓取到几张图，就输出几个图块；图一对应抓取图1，图二对应抓取图2，以此类推。");
  lines.push("每个图块结构固定为：");
  lines.push("【图一】");
  lines.push("🌿 图片风格与元素分析");
  lines.push("这张图是......，核心特征如下：");
  lines.push("- 空间风格：...");
  lines.push("- 核心元素：...");
  lines.push("- 光线与色彩：...");
  lines.push("- 构图与视角：...");
  lines.push("- 氛围：...");
  lines.push("✍️ 可复用 Prompt 模板（支持变量替换）");
  lines.push("```markdown");
  lines.push("...prompt...");
  lines.push("```");
  lines.push("每张图的分析必须直接描述图片里能看到的具体空间、家具、吧台、窗景、人物、道具、材质和构图，不要只写抽象风格词。");
  lines.push(`Prompt 模板里必须直接使用产品图变量 ${vars.productImageList}，并明确保留用户上传产品图的外形、比例、品牌与文字信息。`);
  lines.push("Prompt 必须是完整可单独执行的成图指令，不要写成说明文，不要依赖“参考抓取图”这种上下文。");
  lines.push("不要禁止产品本身已有的品牌和文字信息；要禁止的是额外乱加的错误文字、错误 logo、错误贴纸和不相关文案。");
  lines.push("如果当前内容明显不是新茶饮/咖啡，也要保留相同结构，只把“产品层”的产品类型表达改成最匹配的类目。");
  lines.push("仿写提示词和场景迁移提示词都必须结构化输出，不允许写成一整段流水句。");
  lines.push("每个一级标题必须单独占一行，分段清晰，可直接复制给其他 AI 使用。");
  lines.push("如果用户额外提供了生成方向，请按 0.5 权重吸收。含义是：方向输入属于中等影响力的调节项，可以影响风格、语气、结构和画面倾向，但不能推翻原始标题、正文、标签和参考图主轴。");
  lines.push("输出必须是 JSON 对象，且只输出 JSON，不要添加解释文字。");

  if (target === "rewrite") {
    lines.push('JSON 结构固定为：{"rewrite_prompt":"..."}');
  } else if (target === "image") {
    lines.push('JSON 结构固定为：{"image_prompt":"..."}');
  } else {
    lines.push('JSON 结构固定为：{"rewrite_prompt":"...","image_prompt":"..."}');
  }

  return lines.join("\n");
}

function buildAiSystemPromptLegacy(target) {
  const vars = WORKFLOW_TEMPLATE_VARIABLES;
  const lines = [
    "你是一名擅长分析小红书图文内容并生成可复用提示词的助手。",
    "请基于给定标题、正文、标签和图片完成任务。",
    "输出必须是 JSON，且不要输出任何额外解释。",
  ];

  if (target === "rewrite") {
    lines.push('只输出仿写提示词，JSON 结构为：{"rewrite_prompt":"..."}');
  } else if (target === "image") {
    lines.push('只输出场景迁移提示词，JSON 结构为：{"image_prompt":"..."}');
    lines.push("场景迁移提示词需要按图片逐张分析，并给出可直接复用的最终成图 prompt。");
    lines.push(`最终 prompt 中必须直接使用产品图变量 ${vars.productImageList}。`);
  } else {
    lines.push(
      '同时输出仿写提示词和场景迁移提示词，JSON 结构为：{"rewrite_prompt":"...","image_prompt":"..."}'
    );
    lines.push(`场景迁移 prompt 中必须直接使用产品图变量 ${vars.productImageList}。`);
  }

  return lines.join("\n");
}

function buildAiUserContentLegacy(result, imageUrls, options = {}) {
  const title = String(result?.title || "").trim();
  const body = String(result?.body || "").trim();
  const tags = Array.isArray(result?.tags) ? result.tags.map((tag) => String(tag || "").trim()).filter(Boolean) : [];
  const target = normalizePromptTarget(options.target);
  const rewriteDirection = typeof options.rewriteDirection === "string" ? options.rewriteDirection.trim() : "";
  const imageDirection = typeof options.imageDirection === "string" ? options.imageDirection.trim() : "";
  const imagePromptExample = buildSceneTransferTemplateDynamicExample(result, imageDirection);

  const textBlock = [
    "请根据以下笔记内容和附带图片完成输出。",
    `本次生成目标：${target === "rewrite" ? "仅生成仿写提示词" : target === "image" ? "仅生成场景迁移提示词" : "同时生成仿写提示词和场景迁移提示词"}`,
    `标题：${title || "-"}`,
    `正文：${body || "-"}`,
    `标签：${tags.length ? tags.join("、") : "-"}`,
    `参考图数量：${imageUrls.length}`,
    `仿写提示词方向：${rewriteDirection || "无额外方向"}`,
    `场景迁移提示词方向：${imageDirection || "无额外方向"}`,
    "",
    "rewrite_prompt 要求：",
    "1. 产出的是给其他 AI 使用的“仿写提示词”，不是直接写成新笔记。",
    "2. 必须结构化输出，至少包含：【标题策略】【正文结构】【语气风格】【关键信息锚点】【标签策略】【写作限制】。",
    "3. 要明确标题长度、正文长度、语气、结构、叙述视角、重点信息、结尾方式等。",
    "4. 要保留原笔记的人味和平台语感，避免空泛模板话。",
    "5. 如果仿写提示词方向不为空，请按 0.5 权重吸收：可以调节语气、表达方式、结构重心，但不能推翻原笔记核心信息。",
    "",
    "image_prompt 要求：",
    "1. 必须输出强结构化模板，不能写成一大段，且必须是可直接粘贴到工作流中的模板。",
    "2. 输出必须按图分块：抓取到几张图，就输出几个图块。",
    "3. 每个图块固定结构为：【图X】+“🌿 图片风格与元素分析”+ 5 条分析 bullet +“✍️ 可复用 Prompt 模板（支持变量替换）”+ 一个 markdown 代码块。",
    "4. 分析 bullet 必须固定为：空间风格、核心元素、光线与色彩、构图与视角、氛围。",
    "5. 每个图块里的具体视觉内容都只能来自对应抓取图，不允许混图。",
    "6. 必须直接描述图片中真实可见的具体物件和空间细节，不要只写抽象风格词。",
    `7. Prompt 模板必须直接使用产品图变量 ${WORKFLOW_TEMPLATE_VARIABLES.productImageList}。`,
    "8. Prompt 模板必须明确保留用户上传产品图的外形、比例、品牌与文字信息。",
    "9. Prompt 模板必须是最终成图指令，直接可喂给其他 AI 生成图片。",
    "10. 不要写“读取抓取图”“参考抓取图”等依赖上下文的话。",
    "11. 不要禁止产品本身已有的品牌和文字信息；只禁止额外乱加的错误文字、错误 logo、错误贴纸和无关文案。",
    "12. 不能提到“白牌”。",
    "13. 如果场景迁移提示词方向不为空，请按 0.5 权重吸收：可以调节模板表达方式、画面倾向和风格强调，但不能推翻产品保持规则和抓取图对应关系。",
    "14. 如果内容不是茶饮/咖啡，也保持同样结构，只把主体产品表达替换成更匹配的类目描述。",
    "",
    "image_prompt 输出模板示意：",
    imagePromptExample,
  ].join("\n");

  if (!imageUrls.length) {
    return textBlock;
  }

  return [
    {
      type: "text",
      text: textBlock,
    },
    ...imageUrls.map((imageUrl) => ({
      type: "image_url",
      image_url: {
        url: imageUrl,
      },
    })),
  ];
}

function buildAiUserContentLegacyV2(result, imageUrls, options = {}) {
  const title = String(result?.title || "").trim();
  const body = String(result?.body || "").trim();
  const tags = Array.isArray(result?.tags)
    ? result.tags.map((tag) => String(tag || "").trim()).filter(Boolean)
    : [];
  const target = normalizePromptTarget(options.target);
  const rewriteDirection =
    typeof options.rewriteDirection === "string" ? options.rewriteDirection.trim() : "";
  const imageDirection =
    typeof options.imageDirection === "string" ? options.imageDirection.trim() : "";

  const lines = [
    `生成目标：${
      target === "rewrite"
        ? "仅生成仿写提示词"
        : target === "image"
          ? "仅生成场景迁移提示词"
          : "同时生成仿写提示词和场景迁移提示词"
    }`,
    `标题：${title || "-"}`,
    `正文：${body || "-"}`,
    `标签：${tags.length ? tags.join("、") : "-"}`,
    `参考图数量：${imageUrls.length}`,
  ];

  if (rewriteDirection) {
    lines.push(`仿写提示词方向：${rewriteDirection}`);
  }

  if (imageDirection) {
    lines.push(`场景迁移提示词方向：${imageDirection}`);
  }

  lines.push("", "请结合以上信息和附带图片直接完成输出。");

  const textBlock = lines.join("\n");

  if (!imageUrls.length) {
    return textBlock;
  }

  return [
    {
      type: "text",
      text: textBlock,
    },
    ...imageUrls.map((imageUrl) => ({
      type: "image_url",
      image_url: {
        url: imageUrl,
      },
    })),
  ];
}

function buildAiSystemPrompt(target) {
  return buildAiSystemPromptV2(target);
}

function buildAiUserContent(result, imageUrls, options = {}) {
  return buildAiUserContentV2(result, imageUrls, options);
}

function buildSceneTransferTemplateDynamicExample(result, direction = "") {
  const vars = WORKFLOW_TEMPLATE_VARIABLES;
  const theme = inferSceneTransferTemplateThemeFromResult(result);
  const imageCount = Math.max(Array.isArray(result?.images) ? result.images.length : 0, 1);
  const styleSections = Array.from({ length: imageCount }, (_, index) =>
    buildSceneTransferDynamicStyleExample(index, theme, vars)
  ).join("\n\n");

  return styleSections;
}

function buildSceneTransferDynamicStyleExample(index, theme, vars) {
  const serial = index + 1;

  return [
    `【图${numberToChineseText(serial)}】`,
    "🌿 图片风格与元素分析",
    `这张图是高级简约感的${theme.productSceneLabel}场景参考图，核心特征如下：`,
    `- 空间风格：直接写出对应抓取图${serial}的空间气质和场景类型，例如“现代极简咖啡店室内空间，通透干净，留白克制”`,
    `- 核心元素：直接写出抓取图${serial}里真实可见的吧台、桌椅、窗景、人物、道具、器具或陈列细节`,
    `- 光线与色彩：直接写出主光方向、亮部控制、阴影关系，以及主色调、冷暖关系和整体色彩气质`,
    `- 构图与视角：直接写出对应抓取图${serial}的构图方式、景别、机位和视角`,
    `- 氛围：直接写出这张图带来的情绪和生活方式感，不要只写空泛词`,
    "",
    "✍️ 可复用 Prompt 模板（支持变量替换）",
    "```markdown",
    `photorealistic lifestyle scene based on the visual style of image ${serial}, featuring the uploaded ${theme.productSceneLabel} from ${vars.productImageList}, preserve the product's original shape, proportions, branding, and text details exactly as uploaded, directly describe the specific background, props, light, color palette, composition, camera angle, and atmosphere from this image block, realistic texture, highly detailed, no altered brand text, no unrelated stickers or text overlays, --ar 3:4 --style raw`,
    "```",
  ].join("\n");
}

function buildSceneTransferTemplateExample(result, direction = "") {
  const vars = WORKFLOW_TEMPLATE_VARIABLES;
  const theme = inferSceneTransferTemplateThemeFromResult(result);

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

function inferSceneTransferTemplateThemeFromResult(result) {
  const title = String(result?.title || "").trim();
  const body = String(result?.body || "").trim();
  const tags = Array.isArray(result?.tags) ? result.tags.map((tag) => String(tag || "").trim()).filter(Boolean) : [];
  const combined = [title, body, tags.join(" ")].filter(Boolean).join(" ");

  if (/(咖啡|拿铁|美式|奶茶|果茶|茶饮|饮品|柠檬茶|奶盖)/.test(combined)) {
    return {
      outputLabel: "**素人实拍感**的新茶饮/咖啡分享图",
      productLabel: "真实质感饮品杯",
      productSceneLabel: "茶饮",
      unifiedTone: "清新治愈/高级简约风格，店铺高级感场景全景图+茶饮特写图+第一视角松弛感打卡图",
    };
  }

  if (/(护肤|精华|面霜|水乳|彩妆|口红|粉底|香水)/.test(combined)) {
    return {
      outputLabel: "**素人实拍感**的护肤/彩妆产品分享图",
      productLabel: "真实质感产品包装",
      productSceneLabel: "护肤/彩妆产品",
      unifiedTone: "清新治愈/高级简约风格，梳妆台或店铺高级感场景全景图+护肤/彩妆产品特写图+第一视角松弛感打卡图",
    };
  }

  if (/(包包|鞋子|穿搭|单品|服装|饰品|配件)/.test(combined)) {
    return {
      outputLabel: "**素人实拍感**的单品种草分享图",
      productLabel: "真实质感主体单品",
      productSceneLabel: "主体单品",
      unifiedTone: "清新治愈/高级简约风格，空间氛围场景全景图+主体单品特写图+第一视角松弛感打卡图",
    };
  }

  return {
    outputLabel: "**素人实拍感**的产品场景分享图",
    productLabel: "真实质感主体产品",
    productSceneLabel: "主体产品",
    unifiedTone: "清新治愈/高级简约风格，高级感场景全景图+主体产品特写图+第一视角松弛感打卡图",
  };
}

function parseAiResponsePayload(rawText) {
  const directPayload = tryParseJson(rawText);
  if (directPayload) {
    return directPayload;
  }

  const ssePayloads = extractSsePayloads(rawText);
  if (ssePayloads.length) {
    return ssePayloads[ssePayloads.length - 1];
  }

  throw new Error(`AI 返回不是合法 JSON：${truncateErrorText(rawText)}`);
}

function tryParseJson(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function extractSsePayloads(rawText) {
  const payloads = [];
  const lines = String(rawText || "").replace(/\r/g, "").split("\n");
  let dataLines = [];

  const flush = () => {
    if (!dataLines.length) {
      return;
    }

    const joined = dataLines.join("\n").trim();
    dataLines = [];
    if (!joined || joined === "[DONE]") {
      return;
    }

    const parsed = tryParseJson(joined);
    if (parsed) {
      payloads.push(parsed);
    }
  };

  lines.forEach((line) => {
    if (!line.trim()) {
      flush();
      return;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  });

  flush();
  return payloads;
}

function extractAiMessageContent(payload) {
  const workflowContent = payload?.data?.content;
  if (typeof workflowContent === "string" && workflowContent.trim()) {
    return workflowContent.trim();
  }

  if (workflowContent && typeof workflowContent === "object") {
    return workflowContent;
  }

  if (typeof payload?.content === "string" && payload.content.trim()) {
    return payload.content.trim();
  }

  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item && typeof item.text === "string") {
          return item.text;
        }

        return "";
      })
      .join("")
      .trim();
  }

  throw new Error("AI 返回内容为空。");
}

function parseAiJsonContent(content) {
  const normalizePromptJson = (value) => {
    if (!value || typeof value !== "object") {
      return value;
    }

    if (typeof value.rewrite_prompt !== "string" && typeof value.rewritten_prompt === "string") {
      value.rewrite_prompt = value.rewritten_prompt;
    }

    if (typeof value.image_prompt !== "string" && typeof value.imagePrompt === "string") {
      value.image_prompt = value.imagePrompt;
    }

    return value;
  };

  if (content && typeof content === "object") {
    return normalizePromptJson(content);
  }

  try {
    return normalizePromptJson(JSON.parse(content));
  } catch (error) {
    const matched = content.match(/\{[\s\S]*\}/);
    if (matched) {
      return normalizePromptJson(JSON.parse(matched[0]));
    }

    throw new Error("AI 返回内容不是合法 JSON。");
  }
}

function formatRewritePromptOutput(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  let formatted = value.replace(/\r/g, "").trim();
  formatted = formatted.replace(/\s*(【标题策略】|【正文结构】|【语气风格】|【关键信息锚点】|【标签策略】|【写作限制】)/g, "\n$1\n");
  formatted = formatted.replace(/\s*(标题：|正文：|标签：)/g, "\n$1");
  formatted = formatted.replace(/\n{3,}/g, "\n\n");
  return formatted.trim();
}

function formatImagePromptOutput(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  let formatted = value.replace(/\r/g, "").trim();
  formatted = formatted.replace(/\s*(【变量占位（固定保留）】|【核心主题】|【生成参数】|【\d+种风格精准规范（对应抓取图）】|【7种风格精准规范（可复用）】|【终极禁用规则（绝对执行）】|【统一画面基调】)/g, "\n$1\n");
  formatted = formatted.replace(/\s*(====================)/g, "\n\n$1\n");
  formatted = formatted.replace(/\s*(以下仅作为风格参考)/g, "\n$1\n");
  formatted = formatted.replace(/\s*(【图[一二三四五六七八九十]+】)/g, "\n\n====================\n$1\n");
  formatted = formatted.replace(/\s*(图片\d+：\s*---)/g, "\n\n$1\n");
  formatted = formatted.replace(/\s*(🌿\s*图片风格与元素分析)/g, "\n$1\n");
  formatted = formatted.replace(/\s*(✍️\s*可复用 Prompt 模板（支持变量替换）)/g, "\n\n$1\n");
  formatted = formatted.replace(/\s*(---)/g, "\n\n$1\n");
  formatted = formatted.replace(/\s*(###\s*风格[^\n]*)/g, "\n\n$1\n");
  formatted = formatted.replace(/\s*(####\s*(?:背景层|产品层|氛围强化))/g, "\n$1\n");
  formatted = formatted.replace(/\s*(参考图数量：)/g, "\n$1");
  formatted = formatted.replace(/\s*(-\s*(?:正文内容|主体产品图\/场景图列表|标题|主体产品图首图|LOGO参考|禁用LOGO|生成图片数量|图片比例|输出要求|产品保持基准|场景参考输入|风格对应规则|模板自包含规则|生成模式|额外生成方向(?:（权重 0\.5）)?|额外方向(?:（权重 0\.5）)?|方向吸收规则|参考图数量|建议比例|内容语境|整体氛围|分析重点|场景迁移原则|整体色调|质感|氛围|产品呈现原则)：)/g, "\n$1");
  formatted = formatted.replace(/\s*(-\s*(?:风格|构图|景别与机位|空间环境|背景|光线|配色|色彩|材质与表面质感|材质与质感|场景层次与留白|主体与道具细节|文字与版式（如有）|氛围关键词|场景迁移指令|产品主体保持要求|复刻 prompt（产品融合版）|负面提示|参数建议)：)/g, "\n$1");
  formatted = formatted.replace(/(\n\s*====================\n)(?:\s*====================\n)+/g, "$1");
  formatted = formatted.replace(/\n{3,}/g, "\n\n");
  return formatted.trim();
}

function truncateErrorText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function extractStructuredContent(rawText, noteUrl) {
  const normalized = rawText.replace(/\r/g, "");
  const lines = normalized
    .split("\n")
    .map((line) => stripTags(line).trim())
    .filter(Boolean);
  const xhsNote = isXiaohongshuUrl(noteUrl) ? extractXiaohongshuNoteData(normalized, noteUrl) : null;
  const primaryImages = extractPrimaryImages(normalized, noteUrl);

  const title =
    xhsNote?.title ||
    extractMetaContent(normalized, "property", "og:title") ||
    extractMetaContent(normalized, "name", "twitter:title") ||
    extractTitleTag(normalized) ||
    extractTitle(lines) ||
    decodeSegmentFromUrl(noteUrl) ||
    "未识别标题";

  const body =
    xhsNote?.body ||
    extractMetaContent(normalized, "property", "og:description") ||
    extractMetaContent(normalized, "name", "description") ||
    extractBody(lines, title, noteUrl);

  const image =
    primaryImages[0] ||
    extractImage(normalized, noteUrl) ||
    FALLBACK_IMAGE;

  const tags = xhsNote?.tags?.length ? xhsNote.tags : extractTags(normalized, noteUrl, title, body);
  const cleanBody = removeStandaloneTagsFromBody(body, tags);

  return {
    image,
    images: primaryImages.length ? primaryImages : [image],
    title,
    body: cleanBody,
    tags,
    meta: {
      usedFallback:
        image === FALLBACK_IMAGE ||
        title === "未识别标题" ||
        body.startsWith("已从链接提取到部分信息"),
    },
  };
}

function removeTagsFromBody(body, tags) {
  if (typeof body !== "string" || !body.trim()) {
    return body;
  }

  let cleaned = body
    .replace(/[＃#][^＃#\s]{1,40}[＃#]/gu, " ")
    .replace(/[＃#][^\s，。！？；：,.!?]{1,40}/gu, " ");

  const safeTags = Array.isArray(tags)
    ? tags
        .map((tag) => String(tag || "").trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
    : [];

  for (const tag of safeTags) {
    const escaped = escapeRegExp(tag);
    cleaned = cleaned
      .replace(new RegExp(`#\\s*${escaped}\\s*#`, "giu"), " ")
      .replace(new RegExp(`#${escaped}(?=\\s|$|[.,!?;:，。！？；：])`, "giu"), " ")
      .replace(new RegExp(`(?<=^|\\s|[，。！？；：,.!?])${escaped}(?=\\s|$|[，。！？；：,.!?])`, "giu"), " ");
  }

  return cleaned.replace(/\s+/g, " ").trim();
}

function removeStandaloneTagsFromBody(body, tags) {
  if (typeof body !== "string" || !body.trim()) {
    return body;
  }

  let cleaned = body
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => !/^[#\uFF03][^#\uFF03\s]{1,40}[#\uFF03]?$/u.test(line))
    .join(" ")
    .replace(/[#\uFF03][^#\uFF03\s]{1,40}[#\uFF03]/gu, " ")
    .replace(/[#\uFF03][^\s,.!?;:，。！？；：]{1,40}/gu, " ");

  const safeTags = Array.isArray(tags)
    ? tags
        .map((tag) => String(tag || "").trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
    : [];

  for (const tag of safeTags) {
    const escaped = escapeRegExp(tag);
    cleaned = cleaned
      .replace(new RegExp(`[#\\uFF03]\\s*${escaped}\\s*[#\\uFF03]`, "giu"), " ")
      .replace(new RegExp(`[#\\uFF03]\\s*${escaped}(?=\\s|$|[.,!?;:，。！？；：])`, "giu"), " ");
  }

  return cleaned.replace(/\s+/g, " ").trim();
}

function extractPrimaryImages(source, noteUrl) {
  const candidates = [];

  if (isXiaohongshuUrl(noteUrl)) {
    const xhsData = extractXiaohongshuNoteData(source, noteUrl);
    addUniqueImages(candidates, xhsData.images, noteUrl);

    if (!candidates.length) {
      addUniqueImages(candidates, extractXiaohongshuImagesFromSource(source), noteUrl);
    }

    if (candidates.length) {
      return dedupeAndRankImages(candidates).slice(0, 24);
    }
  }

  addUniqueImages(candidates, extractScriptImages(source, noteUrl), noteUrl);
  addUniqueImages(candidates, extractMetaImages(source, noteUrl), noteUrl);
  addUniqueImages(candidates, extractJsonLdImages(source, noteUrl), noteUrl);
  addUniqueImages(candidates, extractInlineImages(source, noteUrl), noteUrl);

  return dedupeAndRankImages(candidates).slice(0, 24);
}

function addUniqueImages(target, imageCandidates, baseUrl) {
  if (!Array.isArray(imageCandidates)) {
    return;
  }

  for (const rawCandidate of imageCandidates) {
    const resolved = resolveUrl(rawCandidate, baseUrl);
    if (!resolved) {
      continue;
    }

    if (!target.includes(resolved)) {
      target.push(resolved);
    }
  }
}

function dedupeAndRankImages(images) {
  const bestByKey = new Map();

  for (const imageUrl of images) {
    const key = buildImageDedupKey(imageUrl);
    const candidate = { url: imageUrl, score: scoreImageCandidate(imageUrl, 0) + scoreImageResolution(imageUrl) };
    const existing = bestByKey.get(key);

    if (!existing || candidate.score > existing.score) {
      bestByKey.set(key, candidate);
    }
  }

  return [...bestByKey.values()]
    .sort((a, b) => b.score - a.score)
    .map((item) => item.url);
}

function extractMetaContent(source, attrName, attrValue) {
  const pattern = new RegExp(
    `<meta[^>]*${attrName}=["']${escapeRegExp(attrValue)}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const reversePattern = new RegExp(
    `<meta[^>]*content=["']([^"']+)["'][^>]*${attrName}=["']${escapeRegExp(attrValue)}["'][^>]*>`,
    "i"
  );

  const match = source.match(pattern) || source.match(reversePattern);
  return match ? decodeHtml(match[1].trim()) : "";
}

function extractMetaImage(source, noteUrl) {
  const metaImages = extractMetaImages(source, noteUrl);
  if (metaImages.length) {
    return metaImages[0];
  }

  const jsonLdImages = extractJsonLdImages(source, noteUrl);
  return jsonLdImages[0] || "";
}

function extractMetaImages(source, noteUrl) {
  const metaImageKeys = [
    ["property", "og:image"],
    ["property", "og:image:secure_url"],
    ["property", "og:image:url"],
    ["name", "twitter:image"],
    ["name", "twitter:image:src"],
    ["itemprop", "image"],
  ];
  const candidates = [];

  for (const [attrName, attrValue] of metaImageKeys) {
    const values = extractMetaContents(source, attrName, attrValue);
    for (const value of values) {
      const resolved = resolveUrl(value, noteUrl);
      if (resolved && !candidates.includes(resolved)) {
        candidates.push(resolved);
      }
    }
  }

  return candidates;
}

function extractMetaContents(source, attrName, attrValue) {
  const escapedValue = escapeRegExp(attrValue);
  const patterns = [
    new RegExp(`<meta[^>]*${attrName}=["']${escapedValue}["'][^>]*content=["']([^"']+)["'][^>]*>`, "gi"),
    new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*${attrName}=["']${escapedValue}["'][^>]*>`, "gi"),
  ];
  const contents = [];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = decodeHtml(match[1].trim());
      if (value) {
        contents.push(value);
      }
    }
  }

  return contents;
}

function extractTitleTag(source) {
  const match = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripTags(decodeHtml(match[1])).trim() : "";
}

function extractTitle(lines) {
  const headingLine = lines.find((line) => /^#\s+/.test(line));
  if (headingLine) {
    return headingLine.replace(/^#\s+/, "").trim();
  }

  const labeledTitle = lines.find((line) => /^title:\s*/i.test(line));
  if (labeledTitle) {
    return labeledTitle.replace(/^title:\s*/i, "").trim();
  }

  return lines.find((line) => line.length >= 6 && line.length <= 80) || "";
}

function extractBody(lines, title, noteUrl) {
  const titleIndex = lines.findIndex((line) => line.includes(title));
  const contentLines = (titleIndex >= 0 ? lines.slice(titleIndex + 1) : lines)
    .filter(
      (line) =>
        !/^source url:/i.test(line) &&
        !/^description:/i.test(line) &&
        !/^published/i.test(line) &&
        !/^image:/i.test(line) &&
        !/^title:/i.test(line)
    )
    .map((line) => line.replace(/^[-*]\s+/, ""))
    .filter((line) => line.length >= 8)
    .filter((line) => !/^#{1,6}\s/.test(line));

  const compactBody = contentLines.join(" ").replace(/\s+/g, " ").trim();
  if (compactBody.length >= 60) {
    return compactBody.slice(0, 500);
  }

  return `已从链接提取到部分信息，但正文较少。建议针对目标站点补充专用解析规则。原链接：${noteUrl}`;
}

function extractImage(source, noteUrl) {
  return extractInlineImages(source, noteUrl)[0] || "";
}

function extractScriptImage(source, noteUrl) {
  return extractScriptImages(source, noteUrl)[0] || "";
}

function extractInlineImages(source, noteUrl) {
  const candidates = [];
  const markdownImages = [...source.matchAll(/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/gi)]
    .map((match) => match[1])
    .filter(Boolean);
  addUniqueImages(candidates, markdownImages, noteUrl);

  const plainImages = [...source.matchAll(/https?:\/\/[^\s"'<>]+?\.(?:png|jpe?g|webp|gif|bmp|svg|avif|heic)(?:\?[^"'<>]*)?/gi)]
    .map((match) => match[0])
    .filter(Boolean);
  addUniqueImages(candidates, plainImages, noteUrl);

  const imgTagPattern = /<(img|source)[^>]+>/gi;
  for (const match of source.matchAll(imgTagPattern)) {
    const tag = match[0];
    const tagCandidates = [
      getAttribute(tag, "src"),
      getAttribute(tag, "data-src"),
      getAttribute(tag, "data-original"),
      getAttribute(tag, "data-url"),
      getAttribute(tag, "data-image"),
      getAttribute(tag, "poster"),
      extractBestFromSrcset(getAttribute(tag, "srcset")),
      extractBestFromSrcset(getAttribute(tag, "data-srcset")),
    ];

    addUniqueImages(candidates, tagCandidates, noteUrl);
  }

  return candidates;
}

function extractScriptImages(source, noteUrl) {
  const candidates = [];
  const decodedSource = decodeEscapedSlashes(source);

  if (isXiaohongshuUrl(noteUrl)) {
    addUniqueImages(candidates, extractXiaohongshuNoteData(decodedSource, noteUrl).images, noteUrl);
    addUniqueImages(candidates, extractXiaohongshuImagesFromSource(decodedSource), noteUrl);
  }

  const genericPatterns = [
    /"(?:urlDefault|urlPre|originImageUrl|imageUrl|coverUrl|cover|thumbnailUrl)"\s*:\s*"([^"]+)"/gi,
    /'(?:urlDefault|urlPre|originImageUrl|imageUrl|coverUrl|cover|thumbnailUrl)'\s*:\s*'([^']+)'/gi,
  ];

  for (const pattern of genericPatterns) {
    for (const match of decodedSource.matchAll(pattern)) {
      addUniqueImages(candidates, [match[1]], noteUrl);
    }
  }

  return candidates;
}

function extractXiaohongshuImage(source, noteUrl) {
  const images = extractXiaohongshuNoteData(source, noteUrl).images;
  return images[0] || "";
}

function extractXiaohongshuNoteData(source, noteUrl) {
  const noteId = decodeSegmentFromUrl(noteUrl);
  const noteBlock = extractXiaohongshuNoteBlock(source, noteId) || source;
  const parsedNoteBlock = parseXiaohongshuNoteBlock(noteBlock);
  const note = findXiaohongshuNotePayload(parsedNoteBlock) || {};
  const listImages = extractXiaohongshuImagesFromImageList(note.imageList);
  const blockImages = extractXiaohongshuImagesFromSource(noteBlock);
  const noteImages = [...new Set([...listImages, ...blockImages])];

  const title = typeof note.title === "string" ? note.title : extractQuotedField(noteBlock, "title");
  const desc = typeof note.desc === "string" ? note.desc : extractQuotedField(noteBlock, "desc");
  const tags = Array.isArray(note.tagList)
    ? note.tagList
        .map((item) => (typeof item?.name === "string" ? item.name.trim() : ""))
        .filter(Boolean)
        .filter((tag) => tag.length <= 30)
        .slice(0, 10)
    : [];

  return {
    title: sanitizeXiaohongshuText(title),
    body: sanitizeXiaohongshuText(desc),
    tags,
    images: noteImages,
  };
}

function findXiaohongshuNotePayload(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findXiaohongshuNotePayload(item, depth + 1);
      if (found) {
        return found;
      }
    }

    return null;
  }

  if (value.note && typeof value.note === "object" && Array.isArray(value.note.imageList)) {
    return value.note;
  }

  if (Array.isArray(value.imageList)) {
    return value;
  }

  for (const child of Object.values(value)) {
    const found = findXiaohongshuNotePayload(child, depth + 1);
    if (found) {
      return found;
    }
  }

  return null;
}

function extractXiaohongshuImagesFromImageList(imageList) {
  if (!Array.isArray(imageList)) {
    return [];
  }

  const images = [];

  for (const item of imageList) {
    const itemCandidates = [
      item?.originImageUrl,
      item?.masterUrl,
      item?.urlDefault,
      item?.imageUrl,
      item?.coverUrl,
      item?.url,
      item?.urlOrigin,
      item?.urlPre,
      item?.thumbnailUrl,
    ]
      .map((value) => normalizeXiaohongshuImageUrl(value))
      .filter((value) => !isThumbnailLikeImageUrl(value))
      .filter(Boolean);

    const bestCandidate = pickBestImageCandidate(itemCandidates);
    if (bestCandidate && !images.includes(bestCandidate)) {
      images.push(bestCandidate);
    }
  }

  return images;
}

function extractXiaohongshuImagesFromSource(source) {
  const decodedSource = decodeEscapedSlashes(source);
  const patterns = [
    /"(?:urlDefault|urlPre|originImageUrl|imageUrl|coverUrl|thumbnailUrl|masterUrl)"\s*:\s*"([^"]+)"/gi,
    /'(?:urlDefault|urlPre|originImageUrl|imageUrl|coverUrl|thumbnailUrl|masterUrl)'\s*:\s*'([^']+)'/gi,
  ];
  const images = [];

  for (const pattern of patterns) {
    for (const match of decodedSource.matchAll(pattern)) {
      const candidate = normalizeXiaohongshuImageUrl(match[1]);
      if (!candidate) {
        continue;
      }

      if (isXiaohongshuImageUrl(candidate) || isLikelyImage(candidate)) {
        if (!images.includes(candidate)) {
          images.push(candidate);
        }
      }
    }
  }

  return images;
}

function extractXiaohongshuNoteBlock(source, noteId) {
  const marker = `"${noteId}":{`;
  const start = source.indexOf(marker);
  if (start < 0) {
    return "";
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let begin = source.indexOf("{", start);

  for (let index = begin; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(begin, index + 1);
      }
    }
  }

  return "";
}

function extractBalancedArray(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) {
    return "";
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  const begin = source.indexOf("[", start);

  for (let index = begin; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(begin, index + 1);
      }
    }
  }

  return "";
}

function parseXiaohongshuNoteBlock(noteBlock) {
  try {
    return JSON.parse(noteBlock);
  } catch (error) {
    return null;
  }
}

function extractJsonLdImage(source, noteUrl) {
  return extractJsonLdImages(source, noteUrl)[0] || "";
}

function extractJsonLdImages(source, noteUrl) {
  const scripts = source.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  const candidates = [];

  for (const scriptTag of scripts) {
    const innerMatch = scriptTag.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
    if (!innerMatch) {
      continue;
    }

    const rawJson = decodeHtml(innerMatch[1]).trim();
    if (!rawJson) {
      continue;
    }

    try {
      const payload = JSON.parse(rawJson);
      addUniqueImages(candidates, findImagesInJson(payload), noteUrl);
    } catch (error) {
      continue;
    }
  }

  return candidates;
}

function findImagesInJson(value, depth = 0) {
  const MAX_DEPTH = 12;
  const MAX_CANDIDATES = 24;
  if (depth > MAX_DEPTH) {
    return [];
  }

  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    return isLikelyImage(value) ? [value] : [];
  }

  if (Array.isArray(value)) {
    const images = [];
    for (const item of value) {
      for (const found of findImagesInJson(item, depth + 1)) {
        if (!images.includes(found)) {
          images.push(found);
        }
        if (images.length >= MAX_CANDIDATES) {
          return images;
        }
      }
    }

    return images;
  }

  if (typeof value === "object") {
    const images = [];
    const preferredKeys = ["image", "images", "thumbnailUrl", "contentUrl", "url", "src"];

    for (const key of preferredKeys) {
      if (key in value) {
        for (const found of findImagesInJson(value[key], depth + 1)) {
          if (!images.includes(found)) {
            images.push(found);
          }
          if (images.length >= MAX_CANDIDATES) {
            return images;
          }
        }
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (preferredKeys.includes(key)) {
        continue;
      }

      for (const found of findImagesInJson(child, depth + 1)) {
        if (!images.includes(found)) {
          images.push(found);
        }
        if (images.length >= MAX_CANDIDATES) {
          return images;
        }
      }
    }

    return images;
  }

  return [];
}

function collectCandidatesFromPattern(target, source, pattern, baseUrl, score) {
  const matches = [...source.matchAll(pattern)];
  for (const match of matches) {
    addImageCandidate(target, match[1], baseUrl, score);
  }
}

function extractTags(source, noteUrl, title, body) {
  const hashMatches = source.match(/#[\p{L}\p{N}_-]+/gu) || [];
  const normalizedHashTags = [...new Set(hashMatches.map((tag) => tag.replace(/^#/, "")))];

  if (normalizedHashTags.length >= 1) {
    return normalizedHashTags.slice(0, 8);
  }

  const keywords = [
    ...extractMetaKeywords(source),
    ...tokenizeText(title),
    ...tokenizeText(body),
    ...tokenizeText(new URL(noteUrl).hostname),
  ];

  const tags = [];
  for (const keyword of keywords) {
    if (keyword.length < 2) {
      continue;
    }

    if (!tags.includes(keyword)) {
      tags.push(keyword);
    }

    if (tags.length >= 6) {
      break;
    }
  }

  return tags.length ? tags : SAMPLE_TAGS;
}

function extractMetaKeywords(source) {
  const raw =
    extractMetaContent(source, "name", "keywords") ||
    extractMetaContent(source, "property", "article:tag");

  return raw
    .split(/[,\u3001，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function tokenizeText(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function decodeSegmentFromUrl(noteUrl) {
  const { pathname, hostname } = new URL(noteUrl);
  const segment = pathname
    .split("/")
    .filter(Boolean)
    .pop();

  if (!segment) {
    return hostname;
  }

  return decodeURIComponent(segment).replace(/[-_]/g, " ");
}

function buildFallbackResult(noteUrl, rawText) {
  const title = decodeSegmentFromUrl(noteUrl);
  const body =
    rawText.trim() ||
    "本地接口已建立，但目标站点可能要求登录、签名或更复杂的抓取策略。后续可以按平台补充专用解析器。";

  return {
    image: FALLBACK_IMAGE,
    title,
    body,
    tags: extractTags(rawText, noteUrl, title, body),
    meta: {
      usedFallback: true,
    },
  };
}

async function serveStatic(urlPath, res) {
  const targetPath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.join(ROOT, path.normalize(targetPath));

  if (!filePath.startsWith(ROOT)) {
    writePlain(res, 403, "Forbidden");
    return;
  }

  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) {
      writePlain(res, 404, "Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const content = await fs.promises.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    });
    res.end(content);
  } catch (error) {
    writePlain(res, 404, "Not Found");
  }
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function writePlain(res, statusCode, message, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    ...extraHeaders,
  });
  res.end(message);
}

function stripTags(value) {
  return decodeHtml(value.replace(/<[^>]+>/g, " "));
}

function decodeHtml(value) {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEscapedSlashes(value) {
  return value
    .replaceAll("\\u002F", "/")
    .replaceAll("\\u003A", ":")
    .replaceAll("\\n", "\n")
    .replaceAll("\\/", "/")
    .replaceAll("&quot;", '"');
}

function extractQuotedField(source, fieldName) {
  const match = source.match(new RegExp(`"${escapeRegExp(fieldName)}"\\s*:\\s*"([^"]*)"`, "i"));
  return match ? decodeEscapedSlashes(match[1]) : "";
}

function sanitizeXiaohongshuText(value) {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s*#([^#\s]+)/g, " #$1")
    .trim();
}

function normalizeXiaohongshuImageUrl(value) {
  if (typeof value !== "string") {
    return "";
  }

  return decodeEscapedSlashes(value).replace(/^http:/, "https:").replace(/^\/\//, "https://");
}

function isThumbnailLikeImageUrl(value) {
  if (typeof value !== "string" || !value) {
    return false;
  }

  const lower = value.toLowerCase();
  return /(thumbnail|thumb|small|mini|urlpre|imageview2\/2\/w\/|\/w\/(?:120|160|240|320|480)(?:\/|$)|[?&](?:imageview2|w|width)=(?:120|160|240|320|480)(?:&|$))/i.test(
    lower
  );
}

function isXiaohongshuImageUrl(value) {
  return /(sns-webpic|xhscdn\.com|qpic\.cn|xiaohongshu\.com\/fe_api)/i.test(value);
}

function pickBestImageCandidate(candidates) {
  let bestCandidate = "";
  let bestScore = -Infinity;

  for (const candidate of candidates) {
    if (!(isXiaohongshuImageUrl(candidate) || isLikelyImage(candidate))) {
      continue;
    }

    const score = scoreImageCandidate(candidate, 0) + scoreImageResolution(candidate);
    if (score > bestScore) {
      bestCandidate = candidate;
      bestScore = score;
    }
  }

  return bestCandidate;
}

function addImageCandidate(target, rawCandidate, baseUrl, baseScore) {
  const resolved = resolveUrl(rawCandidate, baseUrl);
  if (!resolved) {
    return;
  }

  if (isThumbnailLikeImageUrl(resolved)) {
    return;
  }

  const score = scoreImageCandidate(resolved, baseScore);
  if (score <= 0) {
    return;
  }

  if (target.some((item) => item.url === resolved)) {
    return;
  }

  target.push({ url: resolved, score });
}

function pickBestImageCandidate(candidates) {
  if (!candidates.length) {
    return "";
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].url;
}

function scoreImageCandidate(url, baseScore) {
  let score = baseScore;
  const lower = url.toLowerCase();

  if (/(logo|icon|avatar|favicon|sprite|emoji|qr|qrcode|badge|banner-icon|apple-touch-icon)/i.test(lower)) {
    score -= 120;
  }

  if (/(profile|user|author|head|sidebar|nav|tabbar|toolbar)/i.test(lower)) {
    score -= 40;
  }

  if (/(xhscdn\.com|sns-webpic)/i.test(lower)) {
    score += 18;
  }

  if (/(imageview2|w\/1080|w\/1242|w\/1440|format)/i.test(lower)) {
    score += 12;
  }

  if (/(thumbnail|thumb|small|mini|icon)/i.test(lower)) {
    score -= 14;
  }

  if (lower.length > 80) {
    score += 6;
  }

  return score;
}

function scoreImageResolution(url) {
  let score = 0;
  const lower = url.toLowerCase();

  if (/(origin|master|raw|full|large)/i.test(lower)) {
    score += 18;
  }

  if (/(urlpre|thumbnail|thumb|small|mini)/i.test(lower)) {
    score -= 16;
  }

  const width = extractLargestDimensionHint(lower);
  if (width >= 1200) {
    score += 14;
  } else if (width >= 800) {
    score += 8;
  } else if (width > 0 && width <= 480) {
    score -= 10;
  }

  return score;
}

function extractLargestDimensionHint(value) {
  const patterns = [/\/w\/(\d{2,5})/gi, /(?:^|[?&/_-])(w|width|dw|sw|x-oss-process=[^&]*w_)(\d{2,5})/gi];
  let max = 0;

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const maybe = Number(match.at(-1));
      if (Number.isFinite(maybe)) {
        max = Math.max(max, maybe);
      }
    }
  }

  return max;
}

function buildImageDedupKey(imageUrl) {
  try {
    const parsed = new URL(imageUrl);
    const host = parsed.hostname.toLowerCase();
    const pathname = normalizeImagePath(parsed.pathname);

    if (/(xhscdn\.com|sns-webpic|qpic\.cn)/i.test(host)) {
      return `${host}:${buildCdnImageAssetKey(pathname)}`;
    }

    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(w|h|width|height|quality|q|format|fit|resize|imageview2|x-oss-process)$/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }

    return `${host}${pathname}?${parsed.searchParams.toString()}`;
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

function getAttribute(tag, attributeName) {
  const pattern = new RegExp(`${escapeRegExp(attributeName)}=["']([^"']+)["']`, "i");
  const match = tag.match(pattern);
  return match ? decodeHtml(match[1].trim()) : "";
}

function extractBestFromSrcset(srcset) {
  if (!srcset) {
    return "";
  }

  const candidates = srcset
    .split(",")
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter(Boolean);

  return candidates.at(-1) || candidates[0] || "";
}

function resolveUrl(candidate, baseUrl) {
  if (!candidate) {
    return "";
  }

  const cleanValue = decodeEscapedSlashes(decodeHtml(candidate)).trim();
  if (!cleanValue || cleanValue.startsWith("data:")) {
    return "";
  }

  try {
    const resolved = new URL(cleanValue, baseUrl).toString();
    return isLikelyImage(resolved) ? resolved : "";
  } catch (error) {
    return "";
  }
}

function isLikelyImage(value) {
  return /(\.(png|jpe?g|webp|gif|bmp|svg|avif|heic)(\?|#|$))|(image\/)|(xhslink\.com)|(xhscdn\.com)|(xiaohongshu\.com\/(discovery|explore|fe_api))|(qpic\.cn)/i.test(
    value
  );
}

function isXiaohongshuUrl(value) {
  return /xiaohongshu\.com|xhslink\.com/i.test(value);
}

function buildClientResult(result) {
  const images = Array.isArray(result.images) ? result.images : [];
  const uniqueImages = dedupeImageUrls(images);
  const proxiedImages = uniqueImages.map((imageUrl) => buildImageProxyUrl(imageUrl)).filter(Boolean);
  const primarySourceImage = uniqueImages[0] || result.image;
  const primaryImage = buildImageProxyUrl(primarySourceImage) || FALLBACK_IMAGE;

  return {
    ...result,
    image: primaryImage,
    images: proxiedImages.length ? proxiedImages : [primaryImage],
  };
}

function dedupeImageUrls(images) {
  const uniqueMap = new Map();

  for (const imageUrl of images) {
    if (!imageUrl) {
      continue;
    }

    const key = buildImageDedupKey(imageUrl);
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, imageUrl);
    }
  }

  return [...uniqueMap.values()];
}

function buildImageProxyUrl(imageUrl) {
  if (!imageUrl) {
    return "";
  }

  try {
    const normalized = normalizeUrl(imageUrl);
    return `/api/image?url=${encodeURIComponent(normalized)}`;
  } catch (error) {
    return imageUrl;
  }
}

function buildRemoteHeaders(targetUrl, kind) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  };

  if (kind === "html") {
    headers.Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7";
  } else {
    headers.Accept = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
  }

  if (isXiaohongshuUrl(targetUrl) || /xhscdn\.com/i.test(targetUrl)) {
    headers.Referer = "https://www.xiaohongshu.com/";
    headers.Origin = "https://www.xiaohongshu.com";
  }

  return headers;
}

async function fetchWithRetry(url, options, retries = 1) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

module.exports = {
  buildFallbackResult,
  buildClientResult,
  extractBody,
  extractMetaImage,
  extractImage,
  extractXiaohongshuNoteData,
  extractScriptImage,
  extractStructuredContent,
  extractTags,
  normalizeUrl,
  parseNoteFromUrl,
  server,
};
