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
const AI_VISION_MODEL = String(process.env.AI_VISION_MODEL || AI_API_MODEL).trim();
const AI_CHAT_COMPLETIONS_PATH = String(
  process.env.AI_CHAT_COMPLETIONS_PATH || "/api/v3/chat/completions"
).trim();
const GROBOTAI_PROMPT_PATH = String(
  process.env.GROBOTAI_PROMPT_PATH || "/api/agent/doubao_generate_character_wf"
).trim();
const GROBOTAI_ENTERPRISE_ID = String(process.env.GROBOTAI_ENTERPRISE_ID || "").trim();
const AI_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.AI_REQUEST_TIMEOUT_MS || "90000", 10);
const AI_IMAGE_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.AI_IMAGE_REQUEST_TIMEOUT_MS || String(Math.max(AI_REQUEST_TIMEOUT_MS, 180000)),
  10
);
const AI_VISION_TIMEOUT_MS = Number.parseInt(
  process.env.AI_VISION_TIMEOUT_MS || String(Math.max(AI_IMAGE_REQUEST_TIMEOUT_MS, 180000)),
  10
);

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
const IMAGE_PROMPT_REFERENCE_LIMIT = 8;

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
  const rewriteInstruction =
    typeof body?.rewriteInstruction === "string"
      ? body.rewriteInstruction.trim()
      : typeof body?.rewriteDirection === "string"
        ? body.rewriteDirection.trim()
        : "";
  const imageInstruction =
    typeof body?.imageInstruction === "string"
      ? body.imageInstruction.trim()
      : typeof body?.imageDirection === "string"
        ? body.imageDirection.trim()
        : "";

  if (!result || typeof result !== "object") {
    writeJson(res, 400, { error: "缺少 result 参数。" });
    return;
  }

  try {
    const prompts = await generatePromptsWithAi(result, {
      target,
      rewriteInstruction,
      imageInstruction,
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
    "如果用户在当前轮补充了额外要求，要把这些要求当成他直接对你说的话来执行。",
    "但用户补充要求不能违背原笔记事实、原文主轴或参考图的核心视觉关系。",
  ];

  if (target === "rewrite") {
    lines.push('只输出 {"rewrite_prompt":"..."}。');
    lines.push("把结果写入 rewrite_prompt 字段。");
    lines.push("rewrite_prompt 字段里的内容必须是一个完整 markdown 代码块字符串，代码块内直接放最终模板。");
  } else if (target === "image") {
    lines.push('只输出 {"image_prompt":"..."}。');
    lines.push("把结果写入 image_prompt 字段。");
    lines.push("image_prompt 必须输出成可直接投喂豆包生图模型的最终 prompt。");
    lines.push("image_prompt 字段里的内容必须是一个完整 markdown 代码块字符串，代码块内直接放最终模板。");
    lines.push("如果有多张参考图，就按“图一 / 图二 / ...”分块输出，每块只保留一条最终可用 prompt，不要附加分析说明。");
  } else {
    lines.push('同时输出 {"rewrite_prompt":"...","image_prompt":"..."}。');
    lines.push("rewrite_prompt 负责复刻内容表达，image_prompt 负责复刻参考图视觉。");
    lines.push("rewrite_prompt 和 image_prompt 字段里的内容都必须是完整 markdown 代码块字符串，代码块内直接放最终模板。");
  }

  return lines.join("\n");
}

function buildAiUserContentV2(result, imageUrls, options = {}) {
  const target = normalizePromptTarget(options.target);
  const title = String(result?.title || "").trim();
  const body = String(result?.body || "").trim();
  const tags = Array.isArray(result?.tags)
    ? result.tags.map((tag) => String(tag || "").trim()).filter(Boolean)
    : [];
  const imageAnalyses = Array.isArray(result?.imageAnalyses) ? result.imageAnalyses : [];
  const includeImageContext = target !== "rewrite";
  const rewriteInstruction =
    typeof options.rewriteInstruction === "string"
      ? options.rewriteInstruction.trim()
      : typeof options.rewriteDirection === "string"
        ? options.rewriteDirection.trim()
        : "";
  const imageInstruction =
    includeImageContext
      ? typeof options.imageInstruction === "string"
        ? options.imageInstruction.trim()
        : typeof options.imageDirection === "string"
          ? options.imageDirection.trim()
          : ""
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

  if (rewriteInstruction) {
    lines.push(`用户对生文 AI 的补充要求：${rewriteInstruction}`);
  }

  if (imageInstruction) {
    lines.push(`用户对生图 AI 的补充要求：${imageInstruction}`);
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
        `- 画面比例：${inferDynamicImageRatioLabel(item?.aspectRatio)}`,
        `- 主体横向占比：${Number.isFinite(item?.spreadX) ? item.spreadX.toFixed(2) : "-"}`,
        `- 主体纵向占比：${Number.isFinite(item?.spreadY) ? item.spreadY.toFixed(2) : "-"}`
      );
    });
  }

  lines.push("", "输出要求：");

  if (target === "rewrite") {
    lines.push("- 只输出 rewrite_prompt，不要输出 image_prompt。");
    lines.push("- rewrite_prompt 不是直接写成新笔记，而是输出给其他 AI 使用的最终生文 PROMPT 模板。");
    lines.push("- 不要出现图片分析、成图说明、镜头语言、画面风格等图片相关内容。");
    lines.push("- rewrite_prompt 必须整体包在一个 markdown 代码块里返回，前端只原样展示，不做额外排版。");
    lines.push("- 不要输出拆解过程、分析说明、bullet 解释或中间推理，只输出最终模板成品。");
    lines.push("- 最终模板必须结构化显示，每个模块单独成段，使用“模块名”+换行+“---”+换行+模块内容的形式。");
    lines.push("- 固定输出这些模块，顺序不能改：标题要求、开头钩子、正文结构、高频元素、结尾动作、标签策略、写作限制。");
    lines.push("- 每个模块都要直接写给其他 AI 的可执行要求，不要写“分析如下”“原文体现了”这类说明句。");
    lines.push("- 标题要求要明确标题写法、字数建议、关键词组织方式。");
    lines.push("- 开头钩子要明确开场句式、情绪强度和进入主题的方式。");
    lines.push("- 正文结构要明确内容分段逻辑、展开顺序和每段承担的作用。");
    lines.push("- 高频元素要明确数字、对比、口语感、标签词、列表感、情绪词等保留方式。");
    lines.push("- 结尾动作要明确如何收束，以及是否引导点赞、收藏、评论、关注或转发。");
    lines.push("- 标签策略要明确标签数量、标签类型和标签承担的分发作用。");
    lines.push("- 写作限制要明确哪些能模仿、哪些不能编造、哪些事实必须保持一致。");
    lines.push("- 标签不能只罗列，必须说明标签在关键词覆盖、情绪强化、搜索分发或话题归类上的作用。");
    lines.push("- 不要输出泛化空话，不要把模板写成空泛行业方法论。");
    lines.push("- 如果原文没有某种元素，不要编造，只能如实说明缺失。");
    lines.push("- 最终模板允许模仿结构和表达策略，但不能要求照抄原句，也不能编造原文没有的事实。");
    lines.push("- 最终模板需补充基本约束：标题建议不超过18字，正文建议200-600字，标签建议5-8个。");
    lines.push("- 如果用户补充了新的偏好、口吻或强调点，可以直接融合到最终模板里，但不能篡改原笔记的事实和核心表达逻辑。");
  } else if (target === "image") {
    lines.push("- 只输出 image_prompt，不要输出 rewrite_prompt。");
    lines.push("- image_prompt 直接写成可投喂豆包生图模型的最终成图提示词，不要写成模板说明文。");
    lines.push("- image_prompt 必须整体包在一个 markdown 代码块里返回，前端只原样展示，不做额外排版。");
    lines.push("- 不要输出分析标题、拆解过程、bullet 解释、固定头部或固定尾部。");
    lines.push("- 每张参考图最终只输出 1 条可直接使用的 prompt。");
    lines.push("- 最终输出必须按“图一”“---”“prompt内容”“图二”“---”“prompt内容”这种结构展示，不要写成“图一最终Prompt：”。");
    lines.push("- 每个图块里的 prompt 内容也必须继续结构化分块展示，使用多个加粗小节标题，例如：**场景主体：**、**城市映射：**、**构图与镜头：**、**光线与色彩：**、**画面质感：**、**画面比例：**、**实景实拍要求：**、**负面限制：**。");
    lines.push("- 每个加粗小节单独成段，不要把所有内容写成一整段长句。");
    lines.push("- prompt 重点保留参考图的画面质感、图片风格、构图镜头、光线色彩、摄影参数、情绪氛围。");
    lines.push("- 不要描述图里具体出现了什么物件、人物、建筑、道具、装饰或空间组件，也不要罗列前景、中景、背景元素。");
    lines.push("- 如果需要体现地点差异，必须写成“地点驱动的地域映射规则”，而不是写死某个城市。");
    lines.push(`- 最终 prompt 必须能读取地点变量 ${WORKFLOW_TEMPLATE_VARIABLES.locationContext}：当地点是山东时映射为山东对应的地标/海岸/泉城/城市风貌，当地点是北京时映射为北京对应的地标/中轴线/胡同/城市天际线，但构图骨架、镜头关系和氛围逻辑仍保持与参考图一致。`);
    lines.push("- 地点映射要强调“同类替换”原则：替换的是地域标识符，不替换构图逻辑、光线逻辑、主体摆放逻辑和画面节奏。");
    lines.push("- 生成目标改为“城市地标/景区系列图”：主体必须随着城市变化，不再固定沿用参考图原主体。");
    lines.push("- 多张图之间必须体现“同城多个地标”规则：每张图生成同一城市的不同代表性地标、景区或城市名片场景，不能重复同一个主体。");
    lines.push("- 风格上严格参考笔记配图的视觉语法，例如构图、机位、色调、光线、质感和氛围；但主体/景区必须根据城市输入动态变化。");
    lines.push("- 完整成图提示词必须覆盖：视觉风格、画面质感、镜头景别、机位角度、光线来源、颜色关系、摄影参数、氛围关键词、负面限制。");
    lines.push("- 每张图的 prompt 必须严格围绕对应抓取图的视觉语言来写，不要落到具体元素、具体物件和具体场景细节。");
    lines.push("- 不要在图片分析和视觉提示词里写任何具体品牌名、具体 logo 名称、商标词或品牌故事，只保留可复用的通用视觉描述。");
    lines.push("- 必须把“真实拍摄”写进模板，而且这是硬性要求：生成结果必须是实景、实拍、自然画面，明确强调真实摄影、真实场景、自然光影、自然环境痕迹、轻微景深、真实噪点、真实反光和真实阴影。");
    lines.push("- 负面提示要明确排除：AI感过强、CG渲染感、塑料假面、错误结构、细节糊掉、边缘发虚、材质失真、过度锐化、过度磨皮、画面假干净。");
    lines.push("- 如果参考图信息很少，也要尽量把视觉风格依据写具体，不要退化成简单通用模板。");
    lines.push("- 输出时每个风格块都只保留最终 prompt，不要解释你为什么这样写。");
    lines.push("- 如果用户补充了新的画面要求、氛围要求或商业要求，可以直接融合到动态风格内容里，但不能破坏参考图对应关系和城市主体映射规则。");
    lines.push("", "image_prompt 输出骨架：", buildDynamicImagePromptDynamicSectionSpecV2(imageUrls.length, result));
  } else {
    lines.push("- rewrite_prompt 直接写成给其他 AI 使用的仿写提示词，不要写成新笔记。");
    lines.push("- image_prompt 直接写成给其他 AI 使用的成图提示词，不要写成图片说明。");
  }

  lines.push("- 输出内容要结构清晰、可复制、可直接投喂。");

  const textBlock = lines.join("\n");

  if (!includeImageContext || !imageUrls.length || imageAnalyses.length) {
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


function buildDynamicImagePromptTemplateSpec(styleCount = IMAGE_PROMPT_REFERENCE_LIMIT, result = null) {
  return [
    buildDynamicImagePromptFixedPrefix(styleCount, result),
    buildDynamicImagePromptDynamicSectionSpecV2(styleCount, result),
    buildDynamicImagePromptFixedSuffix(result),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildDynamicImagePromptFixedPrefix(styleCount = IMAGE_PROMPT_REFERENCE_LIMIT, result = null, instruction = "") {
  const vars = WORKFLOW_TEMPLATE_VARIABLES;
  const safeCount = Math.max(1, Math.min(Number(styleCount) || 1, IMAGE_PROMPT_REFERENCE_LIMIT));
  const analyses = Array.isArray(result?.imageAnalyses)
    ? result.imageAnalyses.slice(0, safeCount)
    : [];
  const theme = inferSceneTransferTemplateThemeFromResult(result);
  const ratioText = buildDynamicImageRatioSummary(analyses, safeCount);
  const lines = [
    "【核心主题】",
    `以标题“${vars.title}”为核心，结合正文“${vars.content}”和产品图“${vars.firstImage}”，产品图“${vars.imageList}”作为依据生成${theme.outputLabel}。`,
    "",
    "【生成参数】",
    `- 生成图片数量：${safeCount} 张，${safeCount}种风格各生成1张`,
    `- 图片比例：${ratioText}`,
    "- 输出要求：每张图独立风格，不混合、不简化，统一视觉调性；**图片中不得出现任何文字、LOGO、标签、贴纸类元素**；**强化真实生活感，弱化AI合成感**",
    `- 城市输入：优先读取地点变量“${vars.locationContext}”，将同一套构图骨架映射到该城市的多个代表性地标、景区或城市名片场景`,
    `- 风格参考输入：解析图列表统一引用“${vars.imageList}”，只复用配图风格，不复用原图主体`,
    "- 主体生成规则：每张图都要生成当前城市的不同地标/景区主体，主体内容必须随城市变化，不得重复同一个地标",
  ];

  if (instruction) {
    lines.push(`- 用户补充要求：${instruction}`);
    lines.push("- 执行规则：将这条要求视为用户当前轮直接对模型的补充说明，但不能覆盖城市映射规则、产品保持规则与对应分析图风格骨架。");
  }

  return lines.join("\n");
}

function buildDynamicImagePromptDynamicSectionSpec(styleCount = IMAGE_PROMPT_REFERENCE_LIMIT, result = null) {
  const safeCount = Math.max(1, Math.min(Number(styleCount) || 1, IMAGE_PROMPT_REFERENCE_LIMIT));
  const analyses = Array.isArray(result?.imageAnalyses)
    ? result.imageAnalyses.slice(0, safeCount)
    : [];
  const styleBlocks = Array.from({ length: safeCount }, (_, index) => {
    const serial = index + 1;
    const analysis = analyses[index] || null;
    const styleName = inferDynamicImageStyleName(analysis, serial);
    const ratioLabel = inferDynamicImageRatioLabel(analysis?.aspectRatio);
    return [
      "---",
      `### 风格${serial}：${styleName}`,
      `- 对应分析图：图${serial}`,
      `- 参考比例：${ratioLabel}`,
      "#### 背景层",
      `1. 场景空间：根据分析图${serial}动态填写真实可见的空间类型、前中后景关系、桌面/吧台/窗景/街景/绿植/人物等环境层次`,
      `2. 道具与环境元素：根据分析图${serial}动态填写真实可见的器具、陪体、手部、餐具、陈列物与生活化细节，但不要写具体品牌和logo`,
      "#### 产品层",
      `1. 主体产品：固定使用变量 {{ $('输入参数汇总').item.json['图片信息'][0] }} 与 {{ $('输入参数汇总').item.json['图片信息'] }}，根据分析图${serial}动态填写主体摆放、占比、遮挡关系、表面质感与细节纹理，但不得改变原始产品结构`,
      `2. 构图与镜头：根据分析图${serial}动态填写景别、机位、视角、主体重心和留白关系`,
      `3. 光线与色彩：根据分析图${serial}动态填写主光方向、亮暗过渡、阴影关系、主色调和冷暖关系`,
      `4. 材质细节：根据分析图${serial}动态填写边缘轮廓、反光方式、透明度、水珠、磨砂、接缝、指纹、磨损等真实细节`,
      "#### 氛围强化",
      `- 根据分析图${serial}动态填写真实手机/相机实拍感、轻微景深、自然噪点、生活方式氛围与情绪节奏`,
      `- 画面比例保持${ratioLabel}，只吸收图${serial}的风格特征，不与其他分析图混合`,
    ].join("\n");
  }).join("\n\n");

  return [
    `【${safeCount}种风格精准规范（可复用）】`,
    styleBlocks,
  ].join("\n");
}

function buildDynamicImagePromptDynamicSectionSpecV2(styleCount = IMAGE_PROMPT_REFERENCE_LIMIT, result = null) {
  const safeCount = Math.max(1, Math.min(Number(styleCount) || 1, IMAGE_PROMPT_REFERENCE_LIMIT));
  const analyses = Array.isArray(result?.imageAnalyses)
    ? result.imageAnalyses.slice(0, safeCount)
    : [];
  const styleBlocks = Array.from({ length: safeCount }, (_, index) => {
    const serial = index + 1;
    const analysis = analyses[index] || null;
    const styleName = inferDynamicImageStyleName(analysis, serial);
    const ratioLabel = inferDynamicImageRatioLabel(analysis?.aspectRatio);
    const sceneType = inferDynamicSceneType(analysis);
    const promptCode = buildDynamicImagePromptCodeBlock(serial, styleName, ratioLabel, analysis, sceneType);
    return [
      `图${numberToChineseText(serial)}`,
      "---",
      promptCode,
    ].join("\n");
  }).join("\n\n");

  return styleBlocks;
}

function buildDynamicImagePromptFixedSuffix(result = null) {
  return [
    "【终极禁用规则（绝对执行）】",
    "1. **严格禁止图片中出现任何文字、LOGO、标签、贴纸、二维码、装饰性文字元素**，背景文字需完全模糊至不可辨认",
    "2. 禁止日期、网址、二维码、乱彩符号、多余装饰文字",
    "3. 城市地标或景区主体必须成为核心视觉主体，占比合理、识别清晰、不被无关元素抢戏",
    "4. 禁止过度干净或完美的AI质感，必须加入**环境噪点、轻微模糊、动态人物、真实生活细节**强化实拍感",
    "5. 色彩与场景必须严格匹配对应分析图，不得混用其他分析图风格",
    "6. 禁止沿用错误城市、错误地标、错误景区，禁止把不同城市地标混在同一张图里",
    "7. 禁止出现乱码、文字不清晰！禁止出现乱码、文字不清晰！禁止出现乱码、文字不清晰！",
  ].join("\n");
}

function composeFixedImagePrompt(dynamicContent, result, instruction = "") {
  const styleCount = Math.max(
    Array.isArray(result?.imageAnalyses) ? result.imageAnalyses.length : 0,
    Array.isArray(result?.images) ? result.images.length : 0,
    1
  );
  const dynamicSection =
    extractDynamicImagePromptSection(dynamicContent) ||
    buildDynamicImagePromptDynamicSectionSpecV2(styleCount, result);
  return ensureMarkdownCodeBlock(dynamicSection);
}

function extractDynamicImagePromptSection(content) {
  const normalized = String(content || "").replace(/\r/g, "").trim();
  if (!normalized) {
    return "";
  }

  return normalized;
}

function ensureMarkdownCodeBlock(content) {
  const normalized = String(content || "").trim();
  if (!normalized) {
    return "";
  }

  if (/^```[\w-]*\n[\s\S]*\n```$/m.test(normalized)) {
    return normalized;
  }

  return ["```markdown", normalized, "```"].join("\n");
}

function buildDynamicImageRatioSummary(analyses, safeCount) {
  const safeAnalyses = Array.isArray(analyses) ? analyses.filter(Boolean) : [];
  if (!safeAnalyses.length) {
    return "按分析图原始比例输出";
  }

  const labels = Array.from({ length: safeCount }, (_, index) => ({
    index,
    label: inferDynamicImageRatioLabel(safeAnalyses[index]?.aspectRatio),
  }));
  const uniqueLabels = Array.from(new Set(labels.map((item) => item.label)));

  if (uniqueLabels.length === 1) {
    return `${uniqueLabels[0]}（与分析图一致）`;
  }

  return `按分析图原始比例输出（${labels
    .map((item) => `图${item.index + 1}${item.label}`)
    .join("；")}）`;
}

function inferDynamicImageRatioLabel(aspectRatio) {
  const numeric = Number(aspectRatio);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "按分析图原始比例";
  }

  if (numeric <= 0.78) {
    return "3:4 竖图";
  }

  if (numeric >= 1.2) {
    return "4:3 横图";
  }

  return "1:1 方图";
}

function inferDynamicImageStyleName(analysis, serial) {
  const combined = [
    String(analysis?.style || "").trim(),
    String(analysis?.background || "").trim(),
    String(analysis?.light || "").trim(),
    String(analysis?.color || "").trim(),
    String(analysis?.mood || "").trim(),
  ]
    .filter(Boolean)
    .join(" ");

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

  return `根据分析图${serial}动态识别的风格`;
}

function inferDynamicSceneType(analysis) {
  const combined = [
    String(analysis?.background || "").trim(),
    String(analysis?.style || "").trim(),
    String(analysis?.mood || "").trim(),
  ]
    .filter(Boolean)
    .join(" ");

  if (/门店|吧台|咖啡店|店内/.test(combined)) {
    return "门店到店打卡场景";
  }

  if (/桌面|托盘|摆拍|静物/.test(combined)) {
    return "桌面静物特写场景";
  }

  if (/窗边|窗景/.test(combined)) {
    return "窗边氛围场景";
  }

  if (/户外|街景|自然/.test(combined)) {
    return "户外生活方式场景";
  }

  return "真实生活方式场景";
}

function buildDynamicImageCoreElements(analysis, serial) {
  const details = String(analysis?.details || "").trim();
  if (details) {
    return `根据图${serial}把真实可见元素抽象成可复用的环境组件类型与陪体类别：${details}`;
  }

  return `根据图${serial}补充前景组件、中景陪体、背景识别符号、人物或手部关系、桌面/街区/室内外环境组件，不写死具体物件名称`;
}

function buildDynamicImageSubjectLine(analysis, serial) {
  const prompt = String(analysis?.prompt || "").trim();
  if (prompt) {
    return `根据图${serial}的主体布局逻辑，替换为目标城市的代表性地标或景区主体，并保持相同的主体占比、前后关系和视觉重心：${prompt}`;
  }

  return `根据分析图${serial}明确目标城市地标或景区主体的摆放方式、占画面比例、与环境的关系，以及是否有局部遮挡或前景压层`;
}

function buildDynamicImageCompositionLine(analysis, serial) {
  const composition = String(analysis?.composition || "").trim();
  const camera = String(analysis?.camera || "").trim();
  if (composition && camera) {
    return `${composition}，${camera}`;
  }

  if (composition || camera) {
    return composition || camera;
  }

  return `根据分析图${serial}补充景别、机位、视角、主体重心、留白与前后景关系`;
}

function buildDynamicImageLightColorLine(analysis, serial) {
  const light = String(analysis?.light || "").trim();
  const color = String(analysis?.color || "").trim();
  if (light && color) {
    return `${light}，${color}`;
  }

  if (light || color) {
    return light || color;
  }

  return `根据分析图${serial}补充主光方向、亮暗过渡、阴影关系、主色调和冷暖关系`;
}

function buildDynamicImageRealityLine(analysis, serial) {
  const details = String(analysis?.details || "").trim();
  if (details) {
    return details;
  }

  return `根据分析图${serial}补充真实摄影痕迹，例如轻微噪点、景深、边缘虚实、反光、水汽、指纹、磨损、褶皱或环境使用痕迹`;
}

function buildDynamicImageTypographyLine(analysis, serial) {
  const typography = String(analysis?.typography || "").trim();
  if (typography) {
    return typography;
  }

  return `根据分析图${serial}说明画面中文字、招牌、包装字样是否清晰可见、是否需要模糊化处理，以及哪些文字信息不能额外乱加`;
}

function buildDynamicLocationMappingLine(serial) {
  const locationVar = WORKFLOW_TEMPLATE_VARIABLES.locationContext;
  return `城市主体映射：读取地点变量“${locationVar}”，保持图${serial}的构图、机位、空间层次和氛围逻辑不变，将主体和背景共同替换为该城市的代表性地标、景区或城市名片场景；多张图必须覆盖同城多个不同地标，不得重复同一个主体。`;
}

function buildDynamicImagePromptCodeBlock(serial, styleName, ratioLabel, analysis, sceneType) {
  const composition = buildDynamicImageCompositionLine(analysis, serial);
  const lightColor = buildDynamicImageLightColorLine(analysis, serial);
  const material = String(analysis?.material || `根据分析图${serial}补充真实摄影质感、表面纹理与颗粒层次`).trim();
  const mood = String(analysis?.mood || `根据分析图${serial}补充真实生活方式氛围`).trim();
  const params = String(analysis?.params || `根据分析图${serial}补充焦段感、景深、曝光倾向和清晰度控制`).trim();
  const subjectLine = buildDynamicImageSubjectLine(analysis, serial);
  const locationMapping = buildDynamicLocationMappingLine(serial);
  const realismRule = "必须生成实景、实拍、自然的真实摄影画面，使用真实场景逻辑、自然光影、自然环境痕迹、轻微景深、真实噪点、真实反光、真实阴影和自然色彩过渡，严禁出现棚拍假感、CG渲染感或过度修图感。";
  const negativeRule = "禁止出现任何新增文字、LOGO、标签、贴纸、二维码、错误品牌信息、乱码、水印和无关装饰元素，同时避免AI感过强、塑料感、结构错误、边缘发虚、材质失真、过度锐化和画面假干净。";

  return [
    `**生成目标：** 请生成一张${sceneType}的${styleName}城市地标场景图，主体由地点变量 ${WORKFLOW_TEMPLATE_VARIABLES.locationContext} 决定。`,
    `**场景主体：** ${subjectLine}。主体必须生成该城市的代表性地标、景区或城市名片场景，不再沿用参考图原主体；如果输出多张图，每张图都要是同城不同地标。`,
    `**城市映射：** ${locationMapping}`,
    `**构图与镜头：** ${composition}。`,
    `**光线与色彩：** ${lightColor}。`,
    `**画面质感：** ${material}。`,
    `**摄影参数参考：** ${params}。`,
    `**整体氛围：** ${mood}。`,
    `**画面比例：** ${ratioLabel}。`,
    `**实景实拍要求：** ${realismRule}`,
    `**补充要求：** 不要根据参考图去硬写具体元素描述，只复用其画面质感、风格语法、构图逻辑、光线关系和摄影感觉，由模型自行补充合理场景细节。`,
    `**负面限制：** ${negativeRule}`,
  ].join("\n\n");
}
async function generatePromptsWithAi(result, options = {}) {
  if (AI_PROVIDER === "grobotai") {
    return generatePromptsWithGrobotai(result, options);
  }

  const endpointUrl = buildAiEndpointUrl();
  const imageUrls = collectAiImageUrls(result);
  const target = normalizePromptTarget(options.target);
  const enrichedResult =
    target !== "rewrite" && imageUrls.length
      ? {
          ...result,
          imageAnalyses: await requestVisionAnalyses(endpointUrl, buildAiRequestHeaders(), imageUrls),
        }
      : result;
  const payload = {
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: buildAiSystemPrompt(target),
      },
      {
        role: "user",
        content: buildAiUserContent(enrichedResult, imageUrls, options),
      },
    ],
  };
  if (AI_API_MODEL) {
    payload.model = AI_API_MODEL;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), resolvePromptRequestTimeoutMs(target));
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
          target === "rewrite"
            ? ""
            : formatImagePromptOutput(
                composeFixedImagePrompt(
                  promptJson.image_prompt,
                  enrichedResult,
                  options.imageInstruction || options.imageDirection
                )
              ),
        debugMessages: target === "image" ? [] : payload.messages,
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
      error.debugMessages = target === "image" ? [] : payload.messages;
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
  const enrichedResult =
    target !== "rewrite" && imageUrls.length
      ? {
          ...result,
          imageAnalyses: await requestVisionAnalyses(endpointUrl, buildGrobotaiRequestHeaders(), imageUrls),
        }
      : result;
  const payload = {
    messages: [
      {
        role: "system",
        content: buildAiSystemPrompt(target),
      },
      {
        role: "user",
        content: buildAiUserContent(enrichedResult, imageUrls, options),
      },
    ],
    model: AI_API_MODEL,
    temperature: 0.2,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), resolvePromptRequestTimeoutMs(target));
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
          target === "rewrite"
            ? ""
            : formatImagePromptOutput(
                composeFixedImagePrompt(
                  promptJson.image_prompt,
                  enrichedResult,
                  options.imageInstruction || options.imageDirection
                )
              ),
        debugMessages: target === "image" ? [] : payload.messages,
      };
    }

    throw lastError || new Error("AI prompt generation failed.");
  } catch (error) {
    if (error && typeof error === "object") {
      error.debugMessages = target === "image" ? [] : payload.messages;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildAiEndpointUrl() {
  return new URL(AI_CHAT_COMPLETIONS_PATH, AI_API_BASE_URL).toString();
}

function resolvePromptRequestTimeoutMs(target) {
  return target === "rewrite" ? AI_REQUEST_TIMEOUT_MS : AI_IMAGE_REQUEST_TIMEOUT_MS;
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

  return [...uniqueMap.values()].slice(0, IMAGE_PROMPT_REFERENCE_LIMIT);
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
        "给其他 AI 使用的生文 PROMPT 模板，必须先按固定 5 项结构拆解原笔记，再输出最终可复用模板。",
    };
    required.push("rewrite_prompt");
  }

  if (target !== "rewrite") {
    properties.image_prompt = {
      type: "string",
      description:
        "给其他 AI 使用的生图最终 prompt；如果有多张抓取图，则按图分块输出，每块只保留一条可直接投喂模型的最终 prompt。",
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
  lines.push("🌿 图片风格分析");
  lines.push("这张图的视觉参考如下：");
  lines.push("- 画面质感：...");
  lines.push("- 图片风格：...");
  lines.push("- 光线与色彩：...");
  lines.push("- 构图与视角：...");
  lines.push("- 摄影参数：...");
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
    "5. 必须分析原笔记的写法，而不只是总结主题；重点识别标题和开头用了什么钩子，例如反差钩子、结果先行、提问式、痛点式、清单式、劝告式、悬念式、身份背书式。",
    "6. 必须识别原笔记对数字的使用方式：是否用了数量词、步骤编号、时间/金额/频次/比例、排名、区间、对比数字；如果原文没有数字，不要硬编，但要说明是否适合补充数字增强记忆点。",
    "7. 必须识别原笔记的语气和口吻：是分享感、安利感、劝退感、吐槽感、复盘感、闺蜜聊天感、专业建议感，还是冷静克制型；同时说明情绪浓度、主观判断强弱、口语化程度。",
    "8. 必须识别原笔记的节奏和句式：短句/长句比例、是否高频断句、是否用排比、对比、设问、感叹、反问、括号补充、破折号式转折、口头语、强调词。",
    "9. 必须识别原笔记的信息组织方式：先结论后展开、先场景后观点、先痛点后方案、先体验后总结、先对比后推荐，还是清单分点推进。",
    "10. 关键信息锚点里要拆出哪些内容必须保留原貌或同等力度复现，例如核心卖点、使用场景、个人感受、对比对象、结果反馈、品牌词、产品名、价格信息、时间信息、行动建议。",
    "11. 写作限制里要明确：允许模仿写法，但不能照抄原句；不能编造原文没有的事实、数据、体验、效果或立场。",
    "12. 如果仿写提示词方向不为空，请按 0.5 权重吸收：可以调节语气、表达方式、结构重心，但不能推翻原笔记核心信息。",
    "",
    "image_prompt 要求：",
    "1. 必须输出强结构化模板，不能写成一大段，且必须是可直接粘贴到工作流中的模板。",
    "2. 输出必须按图分块：抓取到几张图，就输出几个图块。",
    "3. 每个图块固定结构为：【图X】+“🌿 图片风格分析”+ 6 条分析 bullet +“✍️ 可复用 Prompt 模板（支持变量替换）”+ 一个 markdown 代码块。",
    "4. 分析 bullet 必须固定为：画面质感、图片风格、光线与色彩、构图与视角、摄影参数、氛围。",
    "5. 每个图块里的具体视觉内容都只能来自对应抓取图，不允许混图。",
    "6. 只分析图片的视觉语言，不描述具体物件和空间细节。",
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

function buildVisionAnalysisSystemPrompt() {
  return [
    "你是一个专业的摄影视觉分析助手。",
    "你的任务是逐张分析输入图片的视觉语言，并输出结构化 JSON。",
    "不要猜测品牌、地名、产品名或故事背景，只提炼画面本身可见的摄影与风格特征。",
    "不要输出任何 JSON 之外的内容。",
  ].join("\n");
}

function buildVisionAnalysisUserContent(imageUrls) {
  if (!Array.isArray(imageUrls) || !imageUrls.length) {
    return "没有可分析的图片。";
  }

  return [
    {
      type: "text",
      text: [
        "请按图片输入顺序逐张完成视觉分析，并返回 JSON。",
        "每张图都必须输出以下字段：imageLabel、style、composition、camera、background、light、color、material、details、typography、mood、params。",
        "字段要求：",
        "1. style：整体图片风格和成片气质。",
        "2. composition：构图方式、主体重心、留白、画面组织方式。",
        "3. camera：景别、机位、视角、焦段感、景深感。",
        "4. background：只写背景空间类型和空间层次，不写具体地点名。",
        "5. light：主光方向、明暗关系、阴影和高光控制。",
        "6. color：主色调、冷暖关系、饱和度与色彩气质。",
        "7. material：画面质感、纹理、颗粒、空气感、真实摄影质感。",
        "8. details：真实摄影痕迹，例如轻微噪点、动态模糊、边缘虚实、反光、磨损、水汽等。",
        "9. typography：画面中文字或招牌字样是否明显、是否需要模糊化处理；没有就写“无明显文字信息”。",
        "10. mood：整体氛围和情绪感受。",
        "11. params：适合复现该画面语言的摄影参数建议，例如画幅比例、焦段感、景深、曝光倾向、清晰度倾向。",
        "不要描述具体品牌、具体 logo、具体产品名，也不要扩展成剧情说明。",
      ].join("\n"),
    },
    ...imageUrls.map((imageUrl) => ({
      type: "image_url",
      image_url: {
        url: imageUrl,
      },
    })),
  ];
}

function buildVisionAnalysisResponseFormats() {
  return [
    {
      type: "json_schema",
      json_schema: {
        name: "vision_analysis_schema",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            analyses: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  imageLabel: { type: "string" },
                  style: { type: "string" },
                  composition: { type: "string" },
                  camera: { type: "string" },
                  background: { type: "string" },
                  light: { type: "string" },
                  color: { type: "string" },
                  material: { type: "string" },
                  details: { type: "string" },
                  typography: { type: "string" },
                  mood: { type: "string" },
                  params: { type: "string" },
                },
                required: [
                  "imageLabel",
                  "style",
                  "composition",
                  "camera",
                  "background",
                  "light",
                  "color",
                  "material",
                  "details",
                  "typography",
                  "mood",
                  "params",
                ],
              },
            },
          },
          required: ["analyses"],
        },
      },
    },
    { type: "json_object" },
    null,
  ];
}

function normalizeVisionAnalyses(payload, imageUrls) {
  const items = Array.isArray(payload?.analyses)
    ? payload.analyses
    : Array.isArray(payload?.images)
      ? payload.images
      : [];

  return imageUrls.map((imageUrl, index) => {
    const item = items[index] && typeof items[index] === "object" ? items[index] : {};
    return {
      imageLabel: String(item.imageLabel || `图片${index + 1}`).trim() || `图片${index + 1}`,
      style: String(item.style || "").trim(),
      composition: String(item.composition || "").trim(),
      camera: String(item.camera || "").trim(),
      background: String(item.background || "").trim(),
      light: String(item.light || "").trim(),
      color: String(item.color || "").trim(),
      material: String(item.material || "").trim(),
      details: String(item.details || "").trim(),
      typography: String(item.typography || "").trim(),
      mood: String(item.mood || "").trim(),
      params: String(item.params || "").trim(),
    };
  });
}

async function requestVisionAnalyses(endpointUrl, headers, imageUrls) {
  const payload = {
    messages: [
      {
        role: "system",
        content: buildVisionAnalysisSystemPrompt(),
      },
      {
        role: "user",
        content: buildVisionAnalysisUserContent(imageUrls),
      },
    ],
    temperature: 0.1,
  };

  if (AI_VISION_MODEL) {
    payload.model = AI_VISION_MODEL;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_VISION_TIMEOUT_MS);

  try {
    let lastError = null;

    for (const responseFormat of buildVisionAnalysisResponseFormats()) {
      const requestPayload = { ...payload };
      if (responseFormat) {
        requestPayload.response_format = responseFormat;
      }

      const response = await fetch(endpointUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });

      const rawText = await response.text();
      if (!response.ok) {
        const error = new Error(
          `Vision analysis failed: ${response.status} ${truncateErrorText(rawText)}`
        );

        if (shouldRetryWithoutStructuredOutput(response.status, rawText)) {
          lastError = error;
          continue;
        }

        throw error;
      }

      const parsed = parseAiResponsePayload(rawText);
      const content = extractAiMessageContent(parsed);
      const analysisJson = parseAiJsonContent(content);
      const analyses = normalizeVisionAnalyses(analysisJson, imageUrls);
      if (analyses.length) {
        return analyses;
      }
    }

    throw lastError || new Error("Vision analysis returned empty result.");
  } finally {
    clearTimeout(timeoutId);
  }
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
    "🌿 图片风格分析",
    `这张图的视觉参考只提炼画面语言，不展开具体元素，核心特征如下：`,
    `- 画面质感：写出图${serial}的真实摄影质感、颗粒感、清晰度、表面纹理和空气感`,
    `- 图片风格：写出图${serial}的整体视觉风格、审美取向和成片气质`,
    `- 构图与视角：写出图${serial}的构图方式、景别、机位、视角和画面重心`,
    `- 光线与色彩：写出主光方向、亮部控制、阴影关系，以及主色调、冷暖关系和整体色彩气质`,
    `- 摄影参数：写出焦段感、景深、曝光倾向、动态模糊、清晰度和画幅比例等摄影依据`,
    `- 氛围：写出这张图带来的情绪和生活方式感，不要只写空泛词`,
    "",
    "✍️ 可复用 Prompt 模板（支持变量替换）",
    "```markdown",
    `photorealistic lifestyle city-landmark scene based on the visual grammar of image ${serial}, keep the same composition logic and atmosphere, use location ${vars.locationContext} to generate a representative landmark or scenic spot of that city, and if generating multiple images ensure each image uses a different landmark from the same city, realistic texture, highly detailed, no unrelated stickers or text overlays, --ar 3:4 --style raw`,
    "```",
  ].join("\n");
}

function buildSceneTransferTemplateExample(result, direction = "") {
  const vars = WORKFLOW_TEMPLATE_VARIABLES;
  const theme = inferSceneTransferTemplateThemeFromResult(result);

  return [
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
    try {
      return JSON.parse(repairJsonString(value));
    } catch (repairError) {
      return null;
    }
  }
}

function repairJsonString(value) {
  const source = String(value || "");
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (escaped) {
      repaired += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      repaired += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = !inString;
      continue;
    }

    if (inString) {
      if (char === "\n") {
        repaired += "\\n";
        continue;
      }

      if (char === "\r") {
        repaired += "\\r";
        continue;
      }

      if (char === "\t") {
        repaired += "\\t";
        continue;
      }

      if (char < " ") {
        repaired += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
    }

    repaired += char;
  }

  return repaired;
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
    const repairedContent = repairJsonString(content);

    if (repairedContent !== content) {
      try {
        return normalizePromptJson(JSON.parse(repairedContent));
      } catch (repairError) {
        // Continue to broad extraction fallback below.
      }
    }

    const extractedJson = extractFirstJsonObject(content) || extractFirstJsonObject(repairedContent);
    if (extractedJson) {
      try {
        return normalizePromptJson(JSON.parse(extractedJson));
      } catch (matchedError) {
        return normalizePromptJson(JSON.parse(repairJsonString(extractedJson)));
      }
    }

    throw new Error("AI 返回内容不是合法 JSON。");
  }
}

function extractFirstJsonObject(value) {
  const source = String(value || "");
  const start = source.indexOf("{");

  if (start < 0) {
    return "";
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return "";
}

function formatRewritePromptOutput(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  return ensureMarkdownCodeBlock(
    canonicalizeWorkflowTemplateVariables(value.replace(/\r/g, "").trim())
  );
}

function formatImagePromptOutput(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  return ensureMarkdownCodeBlock(
    canonicalizeWorkflowTemplateVariables(value.replace(/\r/g, "").trim())
  );
}

function canonicalizeWorkflowTemplateVariables(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  const canonicalMap = [
    {
      pattern: /\{\{\s*\$\('输入参数汇总'\)\.item\.json\[(["'])用户输入1\1\]\s*\}\}/g,
      replacement: WORKFLOW_TEMPLATE_VARIABLES.locationContext,
    },
    {
      pattern: /\{\{\s*\$\('输入参数汇总'\)\.item\.json\[(["'])用户输入１\1\]\s*\}\}/g,
      replacement: WORKFLOW_TEMPLATE_VARIABLES.locationContext,
    },
    {
      pattern: /\{\{\s*\$\('输入参数汇总'\)\.item\.json\[(["'])用户输入２\1\]\s*\}\}/g,
      replacement: WORKFLOW_TEMPLATE_VARIABLES.logoHint,
    },
    {
      pattern: /\{\{\s*\$\('输入参数汇总'\)\.item\.json\[(["'])用户输入３\1\]\s*\}\}/g,
      replacement: WORKFLOW_TEMPLATE_VARIABLES.forbiddenLogo,
    },
  ];

  return canonicalMap.reduce(
    (current, entry) => current.replace(entry.pattern, entry.replacement),
    value
  );
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
