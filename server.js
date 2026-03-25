const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const vm = require("node:vm");

loadLocalEnvFiles();

const HOST = "127.0.0.1";
const PORT = process.env.PORT || 3001;
const ROOT = __dirname;
const AI_PROVIDER = String(process.env.AI_PROVIDER || "ark").trim().toLowerCase();
const AI_API_BASE_URL = String(process.env.AI_API_BASE_URL || "").trim();
const AI_API_TOKEN = String(process.env.AI_API_TOKEN || "").trim();
const AI_API_MODEL = String(process.env.AI_API_MODEL || "doubao-seed-2-0-pro-260215").trim();
const AI_VISION_MODEL = String(process.env.AI_VISION_MODEL || AI_API_MODEL).trim();
const AI_CHAT_COMPLETIONS_PATH = String(
  process.env.AI_CHAT_COMPLETIONS_PATH || "/api/v3/chat/completions"
).trim();
const AI_IMAGE_GENERATIONS_PATH = String(
  process.env.AI_IMAGE_GENERATIONS_PATH || "/api/agent/seedream_generation_image_wf"
).trim();
const GROBOTAI_PROMPT_PATH = String(
  process.env.GROBOTAI_PROMPT_PATH || "/api/agent/doubao_generate_character_wf"
).trim();
const GROBOTAI_ENTERPRISE_ID = String(process.env.GROBOTAI_ENTERPRISE_ID || "").trim();
const AI_IMAGE_MODEL = String(process.env.AI_IMAGE_MODEL || "doubao-seedream-4-5-251128").trim();
const AI_IMAGE_SIZE = String(process.env.AI_IMAGE_SIZE || "").trim();
const AI_IMAGE_MAX_IMAGES = normalizePositiveInteger(process.env.AI_IMAGE_MAX_IMAGES, 5);
const AI_IMAGE_PROMPT_MODE = String(process.env.AI_IMAGE_PROMPT_MODE || "standard").trim();
const DEFAULT_AI_REQUEST_TIMEOUT_MS = AI_PROVIDER === "grobotai" ? 180000 : 90000;
const AI_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.AI_REQUEST_TIMEOUT_MS || String(DEFAULT_AI_REQUEST_TIMEOUT_MS),
  10
);
const AI_IMAGE_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.AI_IMAGE_REQUEST_TIMEOUT_MS ||
    String(Math.max(AI_PROVIDER === "grobotai" ? 300000 : 180000, AI_REQUEST_TIMEOUT_MS)),
  10
);
const AI_VISION_TIMEOUT_MS = Number.parseInt(
  process.env.AI_VISION_TIMEOUT_MS ||
    String(Math.max(AI_PROVIDER === "grobotai" ? 300000 : 180000, AI_IMAGE_REQUEST_TIMEOUT_MS)),
  10
);
const AI_PROMPT_SELF_CHECK_ENABLED = !/^(0|false|off)$/i.test(
  String(process.env.AI_PROMPT_SELF_CHECK || "").trim()
);
const AI_PROMPT_SELF_CHECK_ROUNDS = normalizePositiveInteger(
  process.env.AI_PROMPT_SELF_CHECK_ROUNDS,
  3
);
const AI_PROMPT_SELF_CHECK_MIN_SCORE = normalizePositiveInteger(
  process.env.AI_PROMPT_SELF_CHECK_MIN_SCORE,
  82
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
  locationContext: "{{ $('\u8f93\u5165\u53c2\u6570\u6c47\u603b').item.json['\u7528\u6237\u8f93\u5165'] }}",
  imageLocationContext: "{{ $('\u8f93\u5165\u53c2\u6570\u6c47\u603b').item.json['\u56fe\u7247\u4fe1\u606f'] }}",
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

    if (req.method === "POST" && requestUrl.pathname === "/api/selftest") {
      await handlePromptSelfTest(req, res);
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
      selfTest: body?.selfTest,
    });
    writeJson(res, 200, sanitizePromptResponseVariables(prompts));
  } catch (error) {
    writeJson(res, 502, {
      error: error instanceof Error ? error.message : "AI 提示词生成失败。",
      debugMessages: Array.isArray(error?.debugMessages) ? error.debugMessages : [],
      qualityReview: error?.qualityReview || null,
      generatedPrompts: error?.generatedPrompts || null,
    });
  }
}

async function handlePromptSelfTest(req, res) {
  const body = await readJsonBody(req);
  const result = body?.result;
  const rewritePrompt = typeof body?.rewritePrompt === "string" ? body.rewritePrompt.trim() : "";
  const imagePrompt = typeof body?.imagePrompt === "string" ? body.imagePrompt.trim() : "";
  const selfTest = normalizeSelfTestContext(body?.selfTest);

  if (!result || typeof result !== "object") {
    writeJson(res, 400, { error: "缺少 result 参数。" });
    return;
  }

  if (!rewritePrompt || !imagePrompt) {
    writeJson(res, 400, { error: "缺少 prompt 模板，请先生成仿写和生图 prompt。" });
    return;
  }

  const generated = {
    rewritePrompt,
    imagePrompt,
    debugMessages: [],
  };

  try {
    writeJson(res, 200, {
      ...(await executePromptSelfTest(result, generated, selfTest)),
    });
  } catch (error) {
    writeJson(res, 502, {
      error: error instanceof Error ? error.message : "自测执行失败。",
    });
  }
}

function sanitizePromptResponseVariables(value) {
  const rewriteVar = "{{ $('\\u8f93\\u5165\\u53c2\\u6570\\u6c47\\u603b').item.json['\\u7528\\u6237\\u8f93\\u5165'] }}";
  const imageVar = "{{ $('\\u8f93\\u5165\\u53c2\\u6570\\u6c47\\u603b').item.json['\\u56fe\\u7247\\u4fe1\\u606f'] }}";

  if (Array.isArray(value)) {
    return value.map((item) => sanitizePromptResponseVariables(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (typeof entry === "string") {
        if (key === "imagePrompt" || key === "image_prompt") {
          return [key, entry.split(rewriteVar).join(imageVar)];
        }

        if (key === "rewritePrompt" || key === "rewrite_prompt") {
          return [key, entry.split(imageVar).join(rewriteVar)];
        }
      }

      return [key, sanitizePromptResponseVariables(entry)];
    }));
  }

  if (typeof value === "string") {
    return value;
  }

  return value;
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

  const raw = decodeJsonRequestBuffer(Buffer.concat(chunks), req.headers["content-type"]).trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

function decodeJsonRequestBuffer(buffer, contentType = "") {
  if (!buffer || !buffer.length) {
    return "";
  }

  const normalizedCharset = normalizeRequestCharset(contentType);
  if (normalizedCharset === "utf16le") {
    return stripBom(buffer.toString("utf16le"));
  }

  if (normalizedCharset === "latin1") {
    return buffer.toString("latin1");
  }

  if (hasUtf16LeBom(buffer)) {
    return stripBom(buffer.toString("utf16le"));
  }

  if (looksLikeUtf16Le(buffer)) {
    return stripBom(buffer.toString("utf16le"));
  }

  return stripBom(buffer.toString("utf8"));
}

function normalizeRequestCharset(contentType = "") {
  const match = String(contentType || "").match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  const charset = match ? match[1].trim().toLowerCase() : "";

  if (!charset) {
    return "utf8";
  }

  if (charset === "utf-8" || charset === "utf8") {
    return "utf8";
  }

  if (charset === "utf-16" || charset === "utf-16le" || charset === "utf16" || charset === "utf16le") {
    return "utf16le";
  }

  if (charset === "latin1" || charset === "iso-8859-1") {
    return "latin1";
  }

  return "utf8";
}

function hasUtf16LeBom(buffer) {
  return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
}

function looksLikeUtf16Le(buffer) {
  if (buffer.length < 4 || buffer.length % 2 !== 0) {
    return false;
  }

  let zeroHighBytes = 0;
  let sampledPairs = 0;

  for (let index = 1; index < buffer.length; index += 2) {
    sampledPairs += 1;
    if (buffer[index] === 0x00) {
      zeroHighBytes += 1;
    }
  }

  return sampledPairs > 0 && zeroHighBytes / sampledPairs >= 0.3;
}

function stripBom(value) {
  return String(value || "").replace(/^\uFEFF/, "");
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

function createTimeoutController(timeoutMs, label) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`${label}超时（${Math.ceil(timeoutMs / 1000)} 秒）`));
  }, timeoutMs);

  return { controller, timeoutId };
}

function isAbortLikeError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const name = String(error.name || "").toLowerCase();
  const message = String(error.message || "").toLowerCase();
  return name === "aborterror" || message.includes("aborted") || message.includes("timeout");
}

function normalizeTimeoutError(error, label, timeoutMs) {
  if (!isAbortLikeError(error)) {
    return error;
  }

  return new Error(`${label}超时（${Math.ceil(timeoutMs / 1000)} 秒）`);
}

function extractUrlFromText(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) {
    return text;
  }

  return match[0].replace(/[)\]}>）】》"'`,，。！!？?；;：:]+$/u, "");
}

function normalizeUrl(value) {
  const extracted = extractUrlFromText(value);
  const completed = /^https?:\/\//i.test(extracted) ? extracted : `https://${extracted}`;
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
    "在正式输出前，先在心里按质量标准自检一遍，目标是首轮就达到系统自检通过线。",
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
    lines.push("图块标题、分隔线和加粗小节标题必须严格遵守用户提供的输出骨架，不得改名、不得漏项、不得合并段落。");
  } else {
    lines.push('同时输出 {"rewrite_prompt":"...","image_prompt":"..."}。');
    lines.push("rewrite_prompt 负责复刻内容表达，image_prompt 负责复刻参考图视觉。");
    lines.push("rewrite_prompt 和 image_prompt 字段里的内容都必须是完整 markdown 代码块字符串，代码块内直接放最终模板。");
  }

  lines.push("", buildPromptGenerationQualityCriteria(target));

  return lines.join("\n");
}

function buildPromptGenerationQualityCriteria(target) {
  const lines = [
    "生成质量标准：",
    "1. 产物必须可被后端直接判卷通过；通过线为 82 分。",
    "2. 提示词不能为空，信息密度要足够，不能过短。",
    "3. rewrite_prompt 和 image_prompt 都必须是完整 markdown 代码块字符串。",
    "4. 不要输出解释性废话、占位说明或额外备注，代码块里只放最终可复用模板。",
  ];

  if (target !== "image") {
    lines.push(
      "5. rewrite_prompt 必须明确它是给下游 AI 用的仿写提示词，而不是直接成文。",
      "6. rewrite_prompt 必须结构化，至少稳定覆盖标题要求、开头钩子、正文结构、高频元素、结尾动作、标签策略、写作限制中的大部分模块。",
      `7. rewrite_prompt 必须稳定使用用户输入变量 ${WORKFLOW_TEMPLATE_VARIABLES.locationContext}。`,
      "8. rewrite_prompt 必须保留原笔记的人味、口语感和真实分享感，避免空泛模板话。"
    );
  }

  if (target !== "rewrite") {
    lines.push(
      "9. image_prompt 必须明确体现真实拍摄、实拍、实景、真实摄影这类实拍感。",
      "10. image_prompt 必须包含构图、光线、色彩、质感、镜头、氛围等可执行视觉语言。",
      `11. image_prompt 必须稳定使用图片信息变量 ${WORKFLOW_TEMPLATE_VARIABLES.imageLocationContext}。`,
      `12. image_prompt 必须直接使用产品图变量 ${WORKFLOW_TEMPLATE_VARIABLES.productImageList}，并保留产品外形、比例、品牌与文字信息。`,
      "13. image_prompt 必须是可直接投喂模型的最终成图 prompt，不要写成解释说明。"
    );
  }

  lines.push("14. 如果你发现某一项标准还没满足，先修正后再输出 JSON。");

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
    "请严格结合下面的质量标准一起生成，目标是一次通过系统自检：",
    buildPromptGenerationQualityCriteria(target),
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
    lines.push("- 被分析的原笔记只允许参考它的钩子写法、造句手法、语气、笔风、结构节奏和信息组织方式，不允许沿用其中的具体景点、人、物、店名、路线节点、美食名称、价格、时间等细节。");
    lines.push(`- 最终生文模板必须直接使用固定用户输入变量 ${WORKFLOW_TEMPLATE_VARIABLES.locationContext}，不能改成别的字段名，不能写成具体城市名。`);
    lines.push(`- 标题、正文、标签都必须围绕用户输入变量 ${WORKFLOW_TEMPLATE_VARIABLES.locationContext} 生成：标题要体现该地点/城市的核心吸引点，正文内容要根据该地点展开，标签也要包含该地点对应的城市/地区类关键词。`);
    lines.push(`- 当用户输入变量 ${WORKFLOW_TEMPLATE_VARIABLES.locationContext} 的值变化时，标题、正文、标签内容也必须跟着变化；禁止在模板里写死“北京”“上海”“珠海”这类具体城市。`);
    lines.push(`- 可以把用户输入变量 ${WORKFLOW_TEMPLATE_VARIABLES.locationContext} 直接写进标题模板、正文模板和标签模板中，作为生成时的唯一城市输入依据。`);
    lines.push(`- 生成内容时要围绕用户输入变量 ${WORKFLOW_TEMPLATE_VARIABLES.locationContext} 对应城市主动补充该地的地标、景区、攻略、路线、打卡点、美食、交通、小贴士等本地内容模块，但这些内容必须来自当前地点本身，而不是来自被分析笔记里的原始细节。`);
    lines.push(`- 允许模型主动联网搜索用户输入变量 ${WORKFLOW_TEMPLATE_VARIABLES.locationContext} 对应城市的最新景点、攻略、路线、美食和打卡信息，再按原笔记的表达方式重新组织成内容。`);
    lines.push("- 不要输出拆解过程、分析说明、bullet 解释或中间推理，只输出最终模板成品。");
    lines.push("- 最终模板必须结构化显示，每个模块单独成段，使用“模块名”+换行+“---”+换行+模块内容的形式。");
    lines.push("- 固定输出这些模块，顺序不能改：标题要求、开头钩子、正文结构、高频元素、结尾动作、标签策略、写作限制。");
    lines.push("- 每个模块都要直接写给其他 AI 的可执行要求，不要写“分析如下”“原文体现了”这类说明句。");
    lines.push(`- 标题要求要明确标题写法、字数建议、关键词组织方式，并说明标题如何结合用户输入变量 ${WORKFLOW_TEMPLATE_VARIABLES.locationContext} 生成。`);
    lines.push("- 开头钩子要明确开场句式、情绪强度和进入主题的方式。");
    lines.push(`- 正文结构要明确内容分段逻辑、展开顺序和每段承担的作用，并说明正文如何根据用户输入变量 ${WORKFLOW_TEMPLATE_VARIABLES.locationContext} 自动生成该地的景区介绍、游玩攻略、路线安排、打卡建议、美食推荐和实用信息。`);
    lines.push("- 高频元素要明确数字、对比、口语感、标签词、列表感、情绪词等保留方式。");
    lines.push("- 结尾动作要明确如何收束，以及是否引导点赞、收藏、评论、关注或转发。");
    lines.push(`- 标签策略要明确标签数量、标签类型和标签承担的分发作用，并要求标签中直接体现用户输入变量 ${WORKFLOW_TEMPLATE_VARIABLES.locationContext} 对应的目的地词。`);
    lines.push("- 写作限制要明确哪些能模仿、哪些不能编造、哪些事实必须保持一致，并强调只能模仿写法，不能照搬原笔记里的具体细节。");
    lines.push("- 标签不能只罗列，必须说明标签在关键词覆盖、情绪强化、搜索分发或话题归类上的作用。");
    lines.push("- 不要输出泛化空话，不要把模板写成空泛行业方法论。");
    lines.push("- 如果原文没有某种元素，不要编造，只能如实说明缺失。");
    lines.push("- 最终模板允许模仿结构和表达策略，但不能要求照抄原句，也不能编造原文没有的事实。");
    lines.push("- 最终模板需补充基本约束：标题建议不超过18字，正文建议200-600字，标签建议5-8个。");
    lines.push("- 如果用户补充了新的偏好、口吻或强调点，可以直接融合到最终模板里，但不能篡改原笔记的事实和核心表达逻辑。");
  } else if (target === "image") {
    lines.push("- 只输出 image_prompt，不要输出 rewrite_prompt。");
    lines.push("- image_prompt 只负责输出“视觉风格”这一段可直接复用的结构化内容，不要重复外层固定模板。");
    lines.push("- image_prompt 必须整体包在一个 markdown 代码块里返回，前端只原样展示，不做额外排版。");
    lines.push("- 最终 image_prompt 全文必须使用简体中文输出，不允许夹带英文短语、英文摄影术语、英文风格词、英文参数描述或中英混写。");
    lines.push("- 如果涉及摄影术语，也必须翻译成中文，例如用“中景”“平视机位”“浅景深”“背景虚化”“标准焦段”“胶片颗粒感”“低饱和”“柔和自然光”，不要写 Medium close-up、eye-level、bokeh、film grain、telephoto、soft light 这类英文。");
    lines.push("- 不要输出分析标题、拆解过程、bullet 解释、固定头部或固定尾部。");
    lines.push("- 每张参考图最终只输出 1 条可直接使用的 prompt。");
    lines.push("- 输出内容会被系统自动填充到固定模板的“视觉风格”位置，所以这里只写视觉风格本身，不要重复“图生图生成指令”“基础素材”“输出要求”等固定文案。");
    lines.push("- 视觉风格内容要尽量结构化，重点覆盖：构图关系、镜头景别与机位、光线与色彩、画面质感、氛围气质、实拍感要求。");
    lines.push("- 如果用户在“和生图 AI 直接对话”里输入了补充要求，必须把这段内容自然融合进“视觉风格”主描述里，而不是单独列一条说明。");
    lines.push("- 允许依据这段直接对话内容，结合参考图/产品图/场景图自行补充合理的画面元素、环境细节、氛围细节和镜头细节，但不能破坏参考图主体与核心布局保留规则。");
    lines.push("- prompt 重点保留参考图的画面质感、图片风格、构图镜头、光线色彩、摄影参数、情绪氛围。");
    lines.push("- 不要描述图里具体出现了什么物件、人物、建筑、道具、装饰或空间组件，也不要罗列前景、中景、背景元素。");
    lines.push("- 生图方向统一改为“本地生活内容视觉”，不再生成城市地标/景区宣传图。");
    lines.push("- 多图内容方向要优先覆盖这三类本地生活表达：多店饮品 / 环境拼贴海报、高级感咖啡特调特写图、清新治愈 / 自驾松弛风格；具体哪一张对应哪一类，可按参考图的视觉气质做匹配。");
    lines.push("- 如果需要体现地点差异，必须写成“地点驱动的本地生活映射规则”，而不是写死某个城市。");
    lines.push(`- 最终 prompt 必须能读取图片信息变量 ${WORKFLOW_TEMPLATE_VARIABLES.imageLocationContext}：当变量变化时，自动映射为对应的本地生活线索，如街区商圈、咖啡馆聚集区、饮品门店氛围、可到达的轻出行路线、适合松弛停留的环境气质；但构图骨架、镜头关系和氛围逻辑仍保持与参考图一致。`);
    lines.push("- 地点映射要强调“同类替换”原则：替换的是本地生活语境与地域氛围，不替换构图逻辑、光线逻辑、主体摆放逻辑和画面节奏。");
    lines.push("- 多张图之间必须体现“同城本地生活组图”规则：可以分别生成多店饮品氛围、咖啡特调特写、松弛感出行或治愈系环境表达，但不要重复完全相同的画面任务。");
    lines.push("- 风格上严格参考笔记配图的视觉语法，例如构图、机位、色调、光线、质感和氛围；但内容目标改为本地生活相关表达。");
    lines.push("- 完整成图提示词必须覆盖：视觉风格、画面质感、镜头景别、机位角度、光线来源、颜色关系、摄影参数、氛围关键词、负面限制。");
    lines.push("- 每张图的 prompt 必须严格围绕对应抓取图的视觉语言来写，不要落到具体元素、具体物件和具体场景细节。");
    lines.push("- 不要在图片分析和视觉提示词里写任何具体品牌名、具体 logo 名称、商标词或品牌故事，只保留可复用的通用视觉描述。");
    lines.push("- 必须把“真实拍摄”写进模板，而且这是硬性要求：生成结果必须是实景、实拍、自然画面，明确强调真实摄影、真实场景、自然光影、自然环境痕迹、轻微景深、真实噪点、真实反光和真实阴影。");
    lines.push("- 负面提示要明确排除：AI感过强、CG渲染感、塑料假面、错误结构、细节糊掉、边缘发虚、材质失真、过度锐化、过度磨皮、画面假干净。");
    lines.push("- 如果参考图信息很少，也要尽量把视觉风格依据写具体，不要退化成简单通用模板。");
    lines.push("- 输出时只保留可直接填入模板“视觉风格”区域的最终内容，不要解释你为什么这样写。");
    lines.push("- 如果用户补充了新的画面要求、氛围要求或商业要求，可以直接融合到动态风格内容里，但不能破坏参考图对应关系和本地生活映射规则。");
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
    `- 城市输入：优先读取图片信息变量“${vars.imageLocationContext}”，将同一套构图骨架映射到该城市的多个代表性地标、景区或城市名片场景`,
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
    const promptCode = buildDynamicImagePromptCodeBlock(
      serial,
      styleName,
      ratioLabel,
      analysis,
      sceneType,
      result
    );
    return [
      `图${numberToChineseText(serial)}`,
      "---",
      promptCode,
    ].join("\n");
  }).join("\n\n");

  return styleBlocks;
}

function buildStrictImagePromptOutputSkeleton(styleCount = 1) {
  const safeCount = Math.max(1, Math.min(Number(styleCount) || 1, IMAGE_PROMPT_REFERENCE_LIMIT));
  return Array.from({ length: safeCount }, (_, index) => {
    const serial = numberToChineseText(index + 1);
    return [
      `图${serial}`,
      "---",
      "**生成目标：**",
      "",
      "**场景主体：**",
      "",
      "**城市映射：**",
      "",
      "**构图与镜头：**",
      "",
      "**光线与色彩：**",
      "",
      "**画面质感：**",
      "",
      "**摄影参数参考：**",
      "",
      "**整体氛围：**",
      "",
      "**画面比例：**",
      "",
      "**实景实拍要求：**",
      "",
      "**补充要求：**",
      "",
      "**负面限制：**",
    ].join("\n");
  }).join("\n\n");
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
  return ensureMarkdownCodeBlock(
    buildFixedImageGenerationTemplate(
      sanitizeImagePromptContext(dynamicSection),
      result,
      instruction
    )
  );
}

function buildFixedImageGenerationTemplate(visualStyleContent, result = null, instruction = "") {
  const normalizedVisualStyle = normalizeVisualStyleTemplateContent(visualStyleContent, instruction);

  return [
    "### 图生图生成指令",
    "1. 核心参考依据：",
    `   - 必须以参考图【${WORKFLOW_TEMPLATE_VARIABLES.imageList}】为唯一底图基础进行重构`,
    "   - 强制保留参考图中：产品主体的物理形态/轮廓/核心特征、场景的核心空间布局/物体位置关系，不得篡改或替换产品主体、核心场景结构",
    "   - 文案变量：画面中出现店铺名/产品名字/地名，严格使用{{ $('输入参数汇总').item.json['用户输入'] }}替换",
    "2. 视觉重构要求：",
    "   严格按照以下描述，对参考图进行风格、视觉效果的精准重构，且仅修改视觉维度（不改变产品/场景核心）：",
    `   ${WORKFLOW_TEMPLATE_VARIABLES.content}`,
    "3. 视觉风格",
    normalizedVisualStyle,
    "",
    "4. 输出硬性标准：",
    "   - 产品主体：100%保留原图形态，细节清晰度≥4K级别，无模糊/形变/缺失",
    "   - 主物体尺寸：按照画面调整大小，符合实际物理大小",
    "   - 文案变量：画面中出现店铺名/产品名字/地名，严格使用{{ $('输入参数汇总').item.json['用户输入'] }}替换",
    "   - 场景融合：参考图核心布局不变，风格/色调/光影/氛围与描述完全匹配，融合无割裂感",
    "   - 画质要求：高清（分辨率≥1200×1600）、无噪点、无压缩失真",
    "   - 格式要求：3:4竖图比例，数量1-5张",
    "   - 生图类同：保证每个生成图之间都有一定的差异性，确保生成图片的丰富性",
    "   - 约束优先级：参考图主体/布局保留 > 风格细节匹配 > 画质输出",
  ].join("\n");
}

function normalizeVisualStyleTemplateContent(content, instruction = "") {
  const normalized = String(content || "")
    .replace(/\r/g, "")
    .replace(/^```[\w-]*\n?/g, "")
    .replace(/\n```$/g, "")
    .trim();
  const normalizedInstruction = String(instruction || "").trim();

  if (!normalized) {
    const fallbackLines = [
      "   ** 图一",
      "   - 真实拍摄，强调真实摄影质感、自然光影层次、明确构图关系、统一色调氛围与清晰产品细节。",
      "   - 负面限制：排除AI感过强、CG渲染感、塑料假面、错误结构、细节糊掉、边缘发虚、材质失真、过度锐化、过度磨皮、画面假干净。",
    ];

    if (normalizedInstruction) {
      fallbackLines[1] = mergeInstructionIntoVisualLine(fallbackLines[1], normalizedInstruction);
    }

    return fallbackLines.join("\n");
  }

  const lines = normalized
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .filter(Boolean)
    .map((line) => line.trim())
    .map((line) => {
      if (/^图[一二三四五六七八九十]/.test(line)) {
        return `   ** ${line.replace(/^图/, "图")}`;
      }

      if (line === "---") {
        return "";
      }

      if (/^\*\*\s*图[一二三四五六七八九十]/.test(line)) {
        return `   ${line.replace(/\s+/g, " ").trim()}`;
      }

      const cleaned = line
        .replace(/^\*\*([^*]+)\*\*[:：]?\s*/, "$1：")
        .replace(/^[-*]\s*/, "");

      return `   - ${cleaned}`;
    })
    .filter(Boolean);

  if (normalizedInstruction) {
    const targetIndex = lines.findIndex(
      (line) => /^\s*-\s*/.test(line) && !/负面限制[:：]/.test(line)
    );

    if (targetIndex >= 0) {
      lines[targetIndex] = mergeInstructionIntoVisualLine(lines[targetIndex], normalizedInstruction);
    } else {
      lines.unshift("   ** 图一");
      lines.splice(
        1,
        0,
        mergeInstructionIntoVisualLine(
          "   - 真实拍摄，强调真实摄影质感、自然光影层次、明确构图关系、统一色调氛围与清晰产品细节。",
          normalizedInstruction
        )
      );
    }
  }

  return lines.length
    ? lines.join("\n")
    : [
        "   ** 图一",
        normalizedInstruction
          ? mergeInstructionIntoVisualLine(
              "   - 真实拍摄，强调真实摄影质感、自然光影层次、明确构图关系、统一色调氛围与清晰产品细节。",
              normalizedInstruction
            )
          : "   - 真实拍摄，强调真实摄影质感、自然光影层次、明确构图关系、统一色调氛围与清晰产品细节。",
        "   - 负面限制：排除AI感过强、CG渲染感、塑料假面、错误结构、细节糊掉、边缘发虚、材质失真、过度锐化、过度磨皮、画面假干净。",
      ].join("\n");
}

function mergeInstructionIntoVisualLine(line, instruction) {
  const baseLine = String(line || "").trim();
  const normalizedInstruction = String(instruction || "").trim();

  if (!normalizedInstruction) {
    return baseLine;
  }

  const content = baseLine.replace(/^\s*-\s*/, "");
  return `   - ${content}，融合“${normalizedInstruction}”的画面意图，并结合参考图/产品图/场景图自行补充合理画面细节。`;
}

function sanitizeImagePromptContext(content) {
  let output = String(content || "");

  const replacements = [
    [/\u6839\u636e\u5206\u6790\u56fe\d+\u52a8\u6001\u8bc6\u522b\u7684\u98ce\u683c/g, "\u771f\u5b9e\u751f\u6d3b\u65b9\u5f0f\u6444\u5f71\u98ce\u683c"],
    [/\u6839\u636e\u5206\u6790\u56fe\d+\u7684\u4e3b\u4f53\u5e03\u5c40\u903b\u8f91\uff0c/g, ""],
    [/\u6839\u636e\u5206\u6790\u56fe\d+\u660e\u786e/g, "\u660e\u786e"],
    [/\u6839\u636e\u5206\u6790\u56fe\d+\u8865\u5145/g, "\u8865\u5145"],
    [/\u4fdd\u6301\u56fe\d+\u7684/g, "\u4fdd\u6301\u5f53\u524d\u753b\u9762\u7684"],
    [/\u6309\u5206\u6790\u56fe\u539f\u59cb\u6bd4\u4f8b/g, "\u6309\u539f\u59cb\u753b\u9762\u6bd4\u4f8b"],
    [/\uff08\u4e0e\u5206\u6790\u56fe\u4e00\u81f4\uff09/g, "\uff08\u4fdd\u6301\u7edf\u4e00\u6bd4\u4f8b\uff09"],
  ];

  replacements.forEach(([pattern, value]) => {
    output = output.replace(pattern, value);
  });

  return output;
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
    return "\u6309\u539f\u59cb\u753b\u9762\u6bd4\u4f8b\u8f93\u51fa";
  }

  const labels = Array.from({ length: safeCount }, (_, index) => ({
    index,
    label: inferDynamicImageRatioLabel(safeAnalyses[index]?.aspectRatio),
  }));
  const uniqueLabels = Array.from(new Set(labels.map((item) => item.label)));

  if (uniqueLabels.length === 1) {
    return `${uniqueLabels[0]}?\u4fdd\u6301\u7edf\u4e00\u6bd4\u4f8b?`;
  }

  return `\u6309\u539f\u59cb\u753b\u9762\u6bd4\u4f8b\u8f93\u51fa\uff08${labels
    .map((item) => `\u56fe${item.index + 1}${item.label}`)
    .join("\u3001")}\uff09`;
}

function inferDynamicImageRatioLabel(aspectRatio) {
  const numeric = Number(aspectRatio);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "\u6309\u539f\u59cb\u753b\u9762\u6bd4\u4f8b";
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

  return "\u771f\u5b9e\u751f\u6d3b\u65b9\u5f0f\u6444\u5f71\u98ce\u683c";
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

function inferParsedNoteLifeCategory(result) {
  const title = String(result?.title || "").trim();
  const body = String(result?.body || "").trim();
  const tags = Array.isArray(result?.tags)
    ? result.tags.map((tag) => String(tag || "").trim()).filter(Boolean)
    : [];
  const combined = [title, body, tags.join(" ")].filter(Boolean).join(" ");

  if (/(咖啡|拿铁|美式|澳白|手冲|特调|咖啡馆|咖啡店)/.test(combined)) {
    return "coffee";
  }

  if (/(奶茶|果茶|茶饮|饮品|柠檬茶|奶盖|鲜果|多店|探店|门店)/.test(combined)) {
    return "drink";
  }

  if (/(自驾|露营|周边游|公路|出逃|兜风|松弛|治愈|路线|出行)/.test(combined)) {
    return "relax_trip";
  }

  if (/(环境|空间|店内|氛围|街区|商圈|打卡|合集|拼贴|海报)/.test(combined)) {
    return "collage";
  }

  return "local_life";
}

function inferLocalLifeDirection(serial, analysis, result = null) {
  const noteCategory = inferParsedNoteLifeCategory(result);
  const combined = [
    String(analysis?.style || "").trim(),
    String(analysis?.background || "").trim(),
    String(analysis?.mood || "").trim(),
    String(analysis?.details || "").trim(),
  ]
    .filter(Boolean)
    .join(" ");

  if (noteCategory === "coffee") {
    return {
      label: "高级感咖啡特调特写图",
      subjectHint: "围绕高级感咖啡或饮品特调做近景特写表达，强调液体层次、杯体质感、局部氛围和精致感",
    };
  }

  if (noteCategory === "drink") {
    return {
      label: "多店饮品 / 环境拼贴海报",
      subjectHint: "围绕同城多店饮品与门店环境信息做拼贴化海报表达，强调多空间切片、门店氛围切换和生活方式感",
    };
  }

  if (noteCategory === "relax_trip") {
    return {
      label: "清新治愈 / 自驾松弛风格",
      subjectHint: "围绕轻出行、松弛停留、清新治愈氛围做生活方式表达，强调路途感、停靠感和自然呼吸感",
    };
  }

  if (noteCategory === "collage") {
    return {
      label: "多店饮品 / 环境拼贴海报",
      subjectHint: "围绕同城门店环境与本地生活信息做拼贴化海报表达，强调多空间切片、氛围切换和城市生活感",
    };
  }

  if (/拼贴|海报|门店|吧台|商圈|街区|店内/.test(combined)) {
    return {
      label: "多店饮品 / 环境拼贴海报",
      subjectHint: "围绕同城多店饮品与门店环境信息做拼贴化海报表达，强调多空间切片、门店氛围切换和生活方式感",
    };
  }

  if (/特写|桌面|静物|近景|细节|咖啡|饮品/.test(combined)) {
    return {
      label: "高级感咖啡特调特写图",
      subjectHint: "围绕高级感咖啡或饮品特调做近景特写表达，强调液体层次、杯体质感、局部氛围和精致感",
    };
  }

  if (/户外|自然|街景|窗景|公路|松弛|治愈|出行/.test(combined)) {
    return {
      label: "清新治愈 / 自驾松弛风格",
      subjectHint: "围绕轻出行、松弛停留、清新治愈氛围做生活方式表达，强调路途感、停靠感和自然呼吸感",
    };
  }

  const fallbackDirections = [
    {
      label: "多店饮品 / 环境拼贴海报",
      subjectHint: "围绕同城多店饮品与门店环境信息做拼贴化海报表达，强调多空间切片、门店氛围切换和生活方式感",
    },
    {
      label: "高级感咖啡特调特写图",
      subjectHint: "围绕高级感咖啡或饮品特调做近景特写表达，强调液体层次、杯体质感、局部氛围和精致感",
    },
    {
      label: "清新治愈 / 自驾松弛风格",
      subjectHint: "围绕轻出行、松弛停留、清新治愈氛围做生活方式表达，强调路途感、停靠感和自然呼吸感",
    },
  ];

  return fallbackDirections[(Math.max(1, serial) - 1) % fallbackDirections.length];
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
    return `替换为目标地点下的本地生活主体关系，并保持稳定的主体占比、前后关系和视觉重心：${prompt}`;
  }

  return "明确本地生活主体的摆放方式、占画面比例、与环境的关系，以及局部遮挡或前景压层，不写死具体物体名称";
}

function buildDynamicImageCompositionLine(analysis, serial) {
  const composition = String(analysis?.composition || "").trim();
  const camera = String(analysis?.camera || "").trim();
  if (composition && camera) {
    return `${composition}\uff0c${camera}`;
  }

  if (composition || camera) {
    return composition || camera;
  }

  return "\u8865\u5145\u666f\u522b\u3001\u673a\u4f4d\u3001\u89c6\u89d2\u3001\u4e3b\u4f53\u91cd\u5fc3\u3001\u7559\u767d\u4e0e\u524d\u540e\u666f\u5173\u7cfb";
}

function buildDynamicImageLightColorLine(analysis, serial) {
  const light = String(analysis?.light || "").trim();
  const color = String(analysis?.color || "").trim();
  if (light && color) {
    return `${light}\uff0c${color}`;
  }

  if (light || color) {
    return light || color;
  }

  return "\u8865\u5145\u4e3b\u5149\u65b9\u5411\u3001\u4eae\u6697\u8fc7\u6e21\u3001\u9634\u5f71\u5173\u7cfb\u3001\u4e3b\u8272\u8c03\u548c\u51b7\u6696\u5173\u7cfb";
}

function buildDynamicImageRealityLine(analysis, serial) {
  const details = String(analysis?.details || "").trim();
  if (details) {
    return details;
  }

  return "\u8865\u5145\u771f\u5b9e\u6444\u5f71\u75d5\u8ff9\uff0c\u4f8b\u5982\u8f7b\u5fae\u566a\u70b9\u3001\u666f\u6df1\u3001\u8fb9\u7f18\u865a\u5b9e\u3001\u53cd\u5149\u3001\u6c34\u6c7d\u3001\u6307\u7eb9\u3001\u78e8\u635f\u3001\u8936\u76b1\u6216\u73af\u5883\u4f7f\u7528\u75d5\u8ff9";
}

function buildDynamicImageTypographyLine(analysis, serial) {
  const typography = String(analysis?.typography || "").trim();
  if (typography) {
    return typography;
  }

  return "\u8bf4\u660e\u753b\u9762\u4e2d\u6587\u5b57\u3001\u62db\u724c\u3001\u5305\u88c5\u5b57\u6837\u662f\u5426\u6e05\u6670\u53ef\u89c1\u3001\u662f\u5426\u9700\u8981\u6a21\u7cca\u5316\u5904\u7406\uff0c\u4ee5\u53ca\u54ea\u4e9b\u6587\u5b57\u4fe1\u606f\u4e0d\u80fd\u989d\u5916\u4e71\u52a0";
}

function buildDynamicLocationMappingLine(serial) {
  const locationVar = WORKFLOW_TEMPLATE_VARIABLES.imageLocationContext;
  return `读取图片信息变量“${locationVar}”，保持当前画面的构图、机位、空间层次和氛围逻辑不变，将内容目标映射为该城市的本地生活语境，例如商圈街区、门店氛围、饮品消费场景、咖啡特调表达、周边轻出行和松弛停留方式；多张图需覆盖同城不同的本地生活切面，避免重复同一种表达。`;
}

function buildDynamicImagePromptCodeBlock(serial, styleName, ratioLabel, analysis, sceneType, result = null) {
  const composition = buildDynamicImageCompositionLine(analysis, serial);
  const lightColor = buildDynamicImageLightColorLine(analysis, serial);
  const material = String(analysis?.material || "\u8865\u5145\u771f\u5b9e\u6444\u5f71\u8d28\u611f\u3001\u8868\u9762\u7eb9\u7406\u4e0e\u9897\u7c92\u5c42\u6b21").trim();
  const mood = String(analysis?.mood || "\u8865\u5145\u771f\u5b9e\u751f\u6d3b\u65b9\u5f0f\u6c1b\u56f4").trim();
  const params = String(analysis?.params || "\u8865\u5145\u7126\u6bb5\u611f\u3001\u666f\u6df1\u3001\u66dd\u5149\u503e\u5411\u548c\u6e05\u6670\u5ea6\u63a7\u5236").trim();
  const direction = inferLocalLifeDirection(serial, analysis, result);
  const subjectLine = buildDynamicImageSubjectLine(analysis, serial);
  const locationMapping = buildDynamicLocationMappingLine(serial);
  const realismRule = "必须生成实景、实拍、自然的真实摄影画面，使用真实场景逻辑、自然光影、自然环境痕迹、轻微景深、真实噪点、真实反光、真实阴影和自然色彩过渡，严禁出现棚拍假感、CG渲染感或过度修图感。";
  const negativeRule = "禁止出现任何新增文字、LOGO、标签、贴纸、二维码、错误品牌信息、乱码、水印和无关装饰元素，同时避免AI感过强、塑料感、结构错误、边缘发虚、材质失真、过度锐化和画面假干净。";

  return [
    `**生成目标：** 请生成一张${sceneType}的${styleName}${direction.label}，主体方向由图片信息变量 ${WORKFLOW_TEMPLATE_VARIABLES.imageLocationContext} 决定。`,
    `**场景主体：** ${direction.subjectHint}；${subjectLine}。不要复写参考图中的特定物体、品牌或具体场景细节，只保留可迁移的主体关系与视觉角色。`,
    `**城市映射：** ${locationMapping}`,
    `**构图与镜头：** ${composition}。`,
    `**光线与色彩：** ${lightColor}。`,
    `**画面质感：** ${material}。`,
    `**摄影参数参考：** ${params}。`,
    `**整体氛围：** ${mood}。`,
    `**画面比例：** ${ratioLabel}。`,
    `**实景实拍要求：** ${realismRule}`,
    `**补充要求：** 不要根据参考图去硬写具体元素描述，只复用其画面质感、风格语法、构图逻辑、光线关系和摄影感觉；最终内容统一服务于本地生活表达，优先落在多店饮品 / 环境拼贴海报、高级感咖啡特调特写图、清新治愈 / 自驾松弛风格这三类方向。`,
    `**负面限制：** ${negativeRule}`,
  ].join("\n\n");
}
async function generatePromptsWithAi(result, options = {}) {
  if (AI_PROVIDER === "grobotai") {
    return generatePromptsWithGrobotaiCore(result, options);
  }

  return generatePromptsWithAiCore(result, options);
}

async function generatePromptsWithAiCore(result, options = {}) {
  if (AI_PROVIDER === "grobotai") {
    return generatePromptsWithGrobotaiCore(result, options);
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

  const timeoutMs = resolvePromptRequestTimeoutMs(target);
  const { controller, timeoutId } = createTimeoutController(timeoutMs, "提示词生成请求");
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
      const promptJson = parseAiJsonContent(content, target);

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
    const promptJson = parseAiJsonContent(content, target);

    return {
      rewritePrompt:
        target === "image" ? "" : formatRewritePromptOutput(promptJson.rewrite_prompt),
      imagePrompt:
        target === "rewrite" ? "" : formatImagePromptOutput(promptJson.image_prompt),
    };
    */
  } catch (error) {
    const normalizedError = normalizeTimeoutError(error, "提示词生成请求", timeoutMs);
    if (error && typeof error === "object") {
      normalizedError.debugMessages = target === "image" ? [] : payload.messages;
    }
    throw normalizedError;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function generatePromptsWithGrobotaiCore(result, options = {}) {
  const endpointUrl = buildGrobotaiPromptUrl();
  const imageUrls = collectAiImageUrls(result);
  const target = normalizePromptTarget(options.target);
  let enrichedResult = result;
  const imageDebugMessages = [];

  if (target !== "rewrite" && imageUrls.length) {
    imageDebugMessages.push(`阶段 1/2：开始分析参考图，共 ${imageUrls.length} 张`);

    try {
      enrichedResult = {
        ...result,
        imageAnalyses: await requestVisionAnalyses(
          endpointUrl,
          buildGrobotaiRequestHeaders(),
          imageUrls
        ),
      };
      imageDebugMessages.push("阶段 1/2：参考图分析完成");
    } catch (error) {
      const visionError = new Error(
        `图片分析失败：${error instanceof Error ? error.message : "未知错误"}`
      );
      visionError.debugMessages = [
        ...imageDebugMessages,
        `参考图接口：${endpointUrl}`,
        `失败原因：${visionError.message}`,
      ];
      throw visionError;
    }
  }

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

  const timeoutMs = resolvePromptRequestTimeoutMs(target);
  const { controller, timeoutId } = createTimeoutController(timeoutMs, "提示词生成请求");
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
      const promptJson = parseAiJsonContent(content, target);

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
        debugMessages:
          target === "image"
            ? [
                ...imageDebugMessages,
                "阶段 2/2：生图提示词生成完成",
              ]
            : payload.messages,
      };
    }

    throw lastError || new Error("AI prompt generation failed.");
  } catch (error) {
    const normalizedError = normalizeTimeoutError(error, "提示词生成请求", timeoutMs);
    if (error && typeof error === "object") {
      normalizedError.debugMessages =
        target === "image"
          ? [
              ...imageDebugMessages,
              "阶段 2/2：生图提示词生成失败",
              `请求接口：${endpointUrl}`,
              `失败原因：${normalizedError instanceof Error ? normalizedError.message : "未知错误"}`,
            ]
          : payload.messages;
    }
    throw normalizedError;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function generatePromptsWithQualityGate(providerName, result, options, requestOnce) {
  const target = normalizePromptTarget(options.target);
  const maxRounds = Math.max(1, AI_PROMPT_SELF_CHECK_ROUNDS);
  const shouldCheckQuality = AI_PROMPT_SELF_CHECK_ENABLED && maxRounds > 0;
  const selfTest = normalizeSelfTestContext(options.selfTest);
  let currentOptions = { ...options };

  if (!shouldCheckQuality) {
    return requestOnce(result, currentOptions);
  }

  for (let attempt = 1; attempt <= maxRounds; attempt += 1) {
    const generated = await requestOnce(result, currentOptions);
    const review = shouldCheckQuality
      ? await reviewGeneratedPrompts(providerName, result, currentOptions, generated, selfTest)
      : buildFallbackPromptReview(target, generated, result, currentOptions, selfTest);
    const mergedMessages = [
      ...ensureDebugMessageArray(generated.debugMessages),
      ...buildGeneratedPromptDebugMessages(generated, target),
      ...buildPromptSelfCheckDebugMessages(attempt, maxRounds, review, target),
    ];

    if (review.pass) {
      return {
        ...generated,
        qualityReview: review,
        debugMessages: mergedMessages,
      };
    }

    if (attempt >= maxRounds) {
      const error = new Error(buildPromptQualityFailureMessage(review, target, providerName));
      error.debugMessages = mergedMessages;
      error.qualityReview = review;
      error.generatedPrompts = {
        rewritePrompt: String(generated?.rewritePrompt || ""),
        imagePrompt: String(generated?.imagePrompt || ""),
      };
      throw error;
    }

    currentOptions = buildPromptRetryOptions(currentOptions, review, target);
  }
}

function buildGeneratedPromptDebugMessages(generated, target) {
  const messages = [];

  if (target !== "image") {
    const rewritePrompt = String(generated?.rewritePrompt || "").trim();
    messages.push(`rewrite_prompt 预览：${truncateErrorText(rewritePrompt, 220) || "-"}`);
  }

  if (target !== "rewrite") {
    const imagePrompt = String(generated?.imagePrompt || "").trim();
    messages.push(`image_prompt 预览：${truncateErrorText(imagePrompt, 220) || "-"}`);
  }

  return messages;
}

function buildPromptRetryOptions(options, review, target) {
  const nextOptions = { ...options };
  const rewriteFeedback = extractPromptReviewFeedback(review, "rewrite");
  const imageFeedback = extractPromptReviewFeedback(review, "image");

  if (target !== "image" && rewriteFeedback) {
    nextOptions.rewriteInstruction = mergePromptInstructions(
      options.rewriteInstruction || options.rewriteDirection || "",
      rewriteFeedback
    );
  }

  if (target !== "rewrite" && imageFeedback) {
    nextOptions.imageInstruction = mergePromptInstructions(
      options.imageInstruction || options.imageDirection || "",
      imageFeedback
    );
  }

  return nextOptions;
}

function mergePromptInstructions(baseInstruction, extraInstruction) {
  const base = String(baseInstruction || "").trim();
  const extra = String(extraInstruction || "").trim();

  if (!base) {
    return extra;
  }

  if (!extra) {
    return base;
  }

  if (base.includes(extra)) {
    return base;
  }

  return `${base}\n\n【自检修正】${extra}`;
}

function buildPromptSelfCheckDebugMessages(attempt, maxRounds, review, target) {
  const messages = [`自检轮次 ${attempt}/${maxRounds}`];

  if (target === "all") {
    messages.push(
      `rewrite_prompt: ${formatPromptReviewScore(review?.rewrite)}`,
      `image_prompt: ${formatPromptReviewScore(review?.image)}`
    );
  } else {
    messages.push(`prompt: ${formatPromptReviewScore(review)}`);
  }

  if (review?.summary) {
    messages.push(`判卷摘要：${review.summary}`);
  }

  return messages;
}

function formatPromptReviewScore(review) {
  if (!review || typeof review !== "object") {
    return "未评分";
  }

  const score = Number(review.score);
  const scoreText = Number.isFinite(score) ? `${Math.round(score)}/100` : "未评分";
  const statusText = review.pass ? "通过" : "未通过";
  return `${statusText}，${scoreText}`;
}

function buildPromptQualityFailureMessage(review, target, providerName) {
  const label = providerName === "grobotai" ? "GrobotAI" : "AI";
  const failureText = target === "all"
    ? `${formatPromptReviewScore(review?.rewrite)}；${formatPromptReviewScore(review?.image)}`
    : formatPromptReviewScore(review);

  return `${label} 提示词质量未达标，已重试到上限：${failureText}`;
}

function extractPromptReviewFeedback(review, target) {
  if (!review || typeof review !== "object") {
    return "";
  }

  if (target === "rewrite" && review.rewrite && typeof review.rewrite === "object") {
    return buildPromptReviewFeedback(review.rewrite, "rewrite");
  }

  if (target === "image" && review.image && typeof review.image === "object") {
    return buildPromptReviewFeedback(review.image, "image");
  }

  if (target === "rewrite" || target === "image") {
    return buildPromptReviewFeedback(review, target);
  }

  return "";
}

function buildPromptReviewFeedback(review, target) {
  const issues = Array.isArray(review.issues)
    ? review.issues.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const misses = Array.isArray(review.missing_points)
    ? review.missing_points.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const notes = [];

  if (issues.length) {
    notes.push(`优先修正：${issues.join("；")}`);
  }

  if (misses.length) {
    notes.push(`补充缺失：${misses.join("；")}`);
  }

  const rewriteInstruction = String(review.rewrite_instruction || review.rewriteInstruction || "").trim();
  if (rewriteInstruction) {
    notes.push(rewriteInstruction);
  }

  if (!notes.length) {
    const score = Number(review.score);
    const scoreText = Number.isFinite(score) ? Math.round(score) : "较低";
    notes.push(
      target === "rewrite"
        ? `请提高仿写提示词的结构完整度、原笔记风格贴合度和可执行性，当前评分 ${scoreText}。`
        : `请提高生图提示词的真实实拍感、视觉一致性和可直接投喂性，当前评分 ${scoreText}。`
    );
  }

  return notes.join(" ");
}

function ensureDebugMessageArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : [];
}

function normalizeSelfTestContext(value) {
  return {
    location: String(value?.location || "").trim(),
    imageInfo: String(value?.imageInfo || "").trim(),
    imageDataUrls: Array.isArray(value?.imageDataUrls)
      ? value.imageDataUrls.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
  };
}

async function executePromptSelfTest(result, generated, selfTest) {
  if (!isAiPromptConfigured()) {
    throw new Error("AI 服务尚未配置，无法执行自测生成。");
  }

  const resolvedRewritePrompt = materializePromptTemplate(generated?.rewritePrompt, selfTest);
  const resolvedImagePrompt = materializePromptTemplate(generated?.imagePrompt, selfTest);
  const rewriteOutput = await generateRewriteSelfTestOutput(result, resolvedRewritePrompt);
  const imageGeneration = await tryGenerateImageSelfTestOutput(resolvedImagePrompt, selfTest);

  return {
    statusText: "完成",
    summary: buildSelfTestExecutionSummary(rewriteOutput, resolvedImagePrompt, imageGeneration),
    rewriteOutput: formatResolvedRewriteSelfTestOutput(resolvedRewritePrompt, rewriteOutput),
    imageOutput: resolvedImagePrompt || "-",
    generatedImages: imageGeneration.images,
    imageError: imageGeneration.error,
  };
}

function formatResolvedRewriteSelfTestOutput(resolvedRewritePrompt, rewriteOutput) {
  const resolved = String(resolvedRewritePrompt || "").trim();
  const generated = String(rewriteOutput || "").trim();

  if (resolved && generated) {
    return [
      "【变量代入后的生文 Prompt】",
      resolved,
      "",
      "【按该 Prompt 生成的生文结果】",
      generated,
    ].join("\n");
  }

  return generated || resolved || "-";
}

function materializePromptTemplate(templateText, selfTest) {
  const normalized = unwrapMarkdownCodeBlock(String(templateText || "").trim());
  if (!normalized) {
    return "";
  }

  const productImageList = Array.isArray(selfTest?.imageDataUrls) ? selfTest.imageDataUrls : [];
  const productImagePlaceholderList = buildSelfTestImagePlaceholderList(productImageList);
  const replacements = [
    [WORKFLOW_TEMPLATE_VARIABLES.locationContext, String(selfTest?.location || "").trim() || "未提供用户输入变量"],
    [WORKFLOW_TEMPLATE_VARIABLES.imageLocationContext, String(selfTest?.imageInfo || "").trim() || "未提供图片信息变量"],
    [WORKFLOW_TEMPLATE_VARIABLES.productImageList, productImagePlaceholderList || "未提供产品图片"],
    [WORKFLOW_TEMPLATE_VARIABLES.imageList, productImagePlaceholderList || "未提供测试图片"],
    [WORKFLOW_TEMPLATE_VARIABLES.firstImage, productImageList.length ? "测试图片1" : "未提供测试图片"],
  ];

  let next = normalized;
  replacements.forEach(([token, value]) => {
    next = next.split(token).join(value);
  });
  return next.trim();
}

function buildSelfTestImagePlaceholderList(imageUrls = []) {
  const total = Array.isArray(imageUrls) ? imageUrls.length : 0;
  if (!total) {
    return "";
  }

  return Array.from({ length: total }, (_, index) => `测试图片${index + 1}`).join("、");
}

async function generateRewriteSelfTestOutput(result, resolvedPrompt) {
  const template = String(resolvedPrompt || "").trim();
  if (!template) {
    return "";
  }

  const endpointUrl = AI_PROVIDER === "grobotai" ? buildGrobotaiPromptUrl() : buildAiEndpointUrl();
  const headers = AI_PROVIDER === "grobotai" ? buildGrobotaiRequestHeaders() : buildAiRequestHeaders();
  const requestPayload = {
    model: AI_API_MODEL,
    temperature: 0.4,
    messages: [
      {
        role: "system",
        content: [
          "你是一个执行写作模板的助手。",
          "用户会提供一段已经代入变量的仿写提示词，请直接根据提示词产出最终成稿。",
          "只输出最终成稿，不要解释执行过程，不要输出 JSON。",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `原笔记标题：${String(result?.title || "").trim() || "-"}`,
          `原笔记正文：${String(result?.body || "").trim() || "-"}`,
          `原笔记标签：${
            Array.isArray(result?.tags) ? result.tags.map((tag) => String(tag || "").trim()).filter(Boolean).join("、") : "-"
          }`,
          "",
          "请严格执行下面这段仿写提示词模板，直接输出最终文案：",
          template,
        ].join("\n"),
      },
    ],
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(30000, AI_REQUEST_TIMEOUT_MS));

  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestPayload),
      signal: controller.signal,
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`生文自测执行失败：${response.status} ${truncateErrorText(rawText)}`);
    }

    const parsed = parseAiResponsePayload(rawText);
    const content = extractAiMessageContent(parsed);
    return String(content || "").trim();
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildSelfTestExecutionSummary(rewriteOutput, resolvedImagePrompt, imageGeneration = { images: [], error: "" }) {
  const rewriteReady = String(rewriteOutput || "").trim();
  const imageReady = String(resolvedImagePrompt || "").trim();
  const generatedImages = Array.isArray(imageGeneration?.images) ? imageGeneration.images : [];
  const imageError = String(imageGeneration?.error || "").trim();

  if (rewriteReady && generatedImages.length) {
    return `已完成变量代入，生成了生文自测结果，并成功产出 ${generatedImages.length} 张测试图片。`;
  }

  if (rewriteReady && imageReady && imageError) {
    return `已完成变量代入，并生成了生文自测结果；测试图片暂未生成：${imageError}`;
  }

  if (rewriteReady && imageReady) {
    return "已完成变量代入，并生成了生文自测结果与生图最终 Prompt。";
  }

  if (rewriteReady) {
    return "已完成变量代入，并生成了生文自测结果。";
  }

  if (imageReady) {
    return "已完成变量代入，并整理出生图最终 Prompt。";
  }

  return "自测已执行，但未生成可展示结果。";
}

async function tryGenerateImageSelfTestOutput(resolvedImagePrompt, selfTest = {}) {
  const prompt = sanitizeImageSelfTestPrompt(resolvedImagePrompt);
  if (!prompt) {
    return { images: [], error: "当前生图模板为空，无法生成测试图片。" };
  }

  const endpointUrl = buildAiImageGenerationUrl();
  const headers = AI_PROVIDER === "grobotai" ? buildGrobotaiRequestHeaders() : buildAiRequestHeaders();
  const uploadedImageUrls = Array.isArray(selfTest?.imageDataUrls)
    ? selfTest.imageDataUrls.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const imageUrlList = uploadedImageUrls.length ? uploadedImageUrls : extractImageUrlsFromPrompt(prompt);
  const outputImageCount = resolveImageSelfTestCount(prompt);
  const requestPayload =
    AI_PROVIDER === "grobotai"
      ? {
          image_url_list: imageUrlList,
          prompt,
          model: AI_IMAGE_MODEL || AI_API_MODEL,
          size: AI_IMAGE_SIZE,
          max_images: outputImageCount,
          prompt_mode: AI_IMAGE_PROMPT_MODE,
        }
      : {
          model: AI_IMAGE_MODEL || AI_API_MODEL,
          prompt,
          size: AI_IMAGE_SIZE,
          n: outputImageCount,
        };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(45000, AI_IMAGE_REQUEST_TIMEOUT_MS));

  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestPayload),
      signal: controller.signal,
    });
    const rawText = await response.text();
    if (!response.ok) {
      return {
        images: [],
        error: `生图接口不可用：${response.status} ${truncateErrorText(rawText)}`,
      };
    }

    const payload = tryParseJson(rawText);
    const images = extractGeneratedImageUrls(payload);
    if (images.length) {
      return {
        images,
        error: "",
      };
    }

    return {
      images: [],
      error: "生图接口已返回，但未解析到图片地址。",
    };
  } catch (error) {
    return {
      images: [],
      error: error instanceof Error ? error.message : "生图测试失败。",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function sanitizeImageSelfTestPrompt(promptText) {
  return String(promptText || "")
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, "[测试图片数据]")
    .replace(/\bhttps?:\/\/[^\s)\]}>"'`]+/g, "[测试图片链接]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractGeneratedImageUrls(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const directList =
    Array.isArray(payload?.data?.image_info_list) ? payload.data.image_info_list : Array.isArray(payload.data) ? payload.data : [];
  const urls = [];

  directList.forEach((item) => {
    const directUrl = typeof item?.url === "string" ? item.url.trim() : "";
    if (directUrl) {
      urls.push(directUrl);
      return;
    }

    const b64 = typeof item?.b64_json === "string" ? item.b64_json.trim() : "";
    if (b64) {
      urls.push(`data:image/png;base64,${b64}`);
    }
  });

  return urls.filter(Boolean);
}

function resolveImageSelfTestCount(promptText) {
  const prompt = unwrapMarkdownCodeBlock(promptText);
  const rangePatterns = [
    /数量\s*[:：]?\s*(\d+)\s*[-~至到]\s*(\d+)\s*张/gi,
    /输出\s*[:：]?\s*(\d+)\s*[-~至到]\s*(\d+)\s*张/gi,
    /生成\s*[:：]?\s*(\d+)\s*[-~至到]\s*(\d+)\s*张/gi,
    /(\d+)\s*[-~至到]\s*(\d+)\s*张/gi,
  ];
  const exactPatterns = [
    /数量\s*[:：]?\s*(\d+)\s*张/gi,
    /输出\s*[:：]?\s*(\d+)\s*张/gi,
    /生成\s*[:：]?\s*(\d+)\s*张/gi,
    /建议\s*(\d+)\s*张/gi,
  ];

  for (const pattern of rangePatterns) {
    const match = pattern.exec(prompt);
    if (!match) {
      continue;
    }

    const upper = Number.parseInt(match[2], 10);
    if (Number.isFinite(upper) && upper > 0) {
      return Math.min(Math.max(1, upper), AI_IMAGE_MAX_IMAGES);
    }
  }

  for (const pattern of exactPatterns) {
    const match = pattern.exec(prompt);
    if (!match) {
      continue;
    }

    const count = Number.parseInt(match[1], 10);
    if (Number.isFinite(count) && count > 0) {
      return Math.min(Math.max(1, count), AI_IMAGE_MAX_IMAGES);
    }
  }

  return Math.min(Math.max(1, AI_IMAGE_MAX_IMAGES), 5);
}

function extractImageUrlsFromPrompt(prompt) {
  const urls = [];
  const text = String(prompt || "");
  const patterns = [
    /https?:\/\/[^\s)\]}>"'`]+/g,
    /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g,
  ];

  patterns.forEach((pattern) => {
    const matches = text.match(pattern) || [];
    matches.forEach((match) => {
      const clean = String(match || "").trim();
      if (clean) {
        urls.push(clean);
      }
    });
  });

  return [...new Set(urls)];
}

function buildFallbackPromptReview(target, generated, result, options) {
  const rewriteText = unwrapMarkdownCodeBlock(generated?.rewritePrompt || "");
  const imageText = unwrapMarkdownCodeBlock(generated?.imagePrompt || "");

  if (target === "rewrite") {
    return assessPromptTextQuality("rewrite", rewriteText, result, options);
  }

  if (target === "image") {
    return assessPromptTextQuality("image", imageText, result, options);
  }

  const rewrite = assessPromptTextQuality("rewrite", rewriteText, result, options);
  const image = assessPromptTextQuality("image", imageText, result, options);

  // 构建详细的回退审查信息
  let summary = "已使用本地硬规则回退评分。";
  const issues = [];

  if (!rewrite.pass) {
    issues.push(`仿写提示词未通过：${rewrite.issues.join("；")}`);
  }

  if (!image.pass) {
    issues.push(`生图提示词未通过：${image.issues.join("；")}`);
  }

  if (issues.length > 0) {
    summary = `${summary} ${issues.join("；")}`;
  }

  return {
    pass: Boolean(rewrite.pass && image.pass),
    rewrite,
    image,
    summary: summary,
  };
}

async function reviewGeneratedPrompts(providerName, result, options, generated, selfTest = null) {
  const target = normalizePromptTarget(options.target);
  const endpointUrl = providerName === "grobotai" ? buildGrobotaiPromptUrl() : buildAiEndpointUrl();
  const headers = providerName === "grobotai" ? buildGrobotaiRequestHeaders() : buildAiRequestHeaders();
  const selfTestImageAnalyses =
    Array.isArray(selfTest?.imageDataUrls) && selfTest.imageDataUrls.length
      ? await requestVisionAnalyses(endpointUrl, headers, selfTest.imageDataUrls)
      : [];
  const reviewPayload = buildPromptReviewPayload(
    target,
    result,
    options,
    generated,
    selfTest,
    selfTestImageAnalyses
  );
  const requestModel = AI_API_MODEL;
  const timeoutMs = Math.max(30000, Math.min(resolvePromptRequestTimeoutMs(target), 60000));
  const { controller, timeoutId } = createTimeoutController(timeoutMs, "提示词自检请求");
  const responseFormats = buildPromptReviewResponseFormats(target);

  try {
    let lastError = null;

    for (const responseFormat of responseFormats) {
      const requestPayload = {
        model: requestModel,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: buildPromptReviewSystemPrompt(target),
          },
          {
            role: "user",
            content: reviewPayload,
          },
        ],
      };

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
        const error = new Error(`Prompt review failed: ${response.status} ${truncateErrorText(rawText)}`);
        if (shouldRetryWithoutStructuredOutput(response.status, rawText)) {
          lastError = error;
          continue;
        }

        throw error;
      }

      const parsed = parseAiResponsePayload(rawText);
      const content = extractAiMessageContent(parsed);
      const reviewJson = parsePromptReviewJson(content, target);
      return normalizePromptReviewResult(reviewJson, target);
    }

    throw lastError || new Error("Prompt review failed.");
  } catch (error) {
    const normalizedError = normalizeTimeoutError(error, "提示词自检请求", timeoutMs);
    if (isAbortLikeError(normalizedError)) {
      throw normalizedError;
    }

    return buildFallbackPromptReview(target, generated, result, options, selfTest);
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildPromptReviewPayload(
  target,
  result,
  options,
  generated,
  selfTest = null,
  selfTestImageAnalyses = []
) {
  const title = String(result?.title || "").trim();
  const body = String(result?.body || "").trim();
  const tags = Array.isArray(result?.tags)
    ? result.tags.map((tag) => String(tag || "").trim()).filter(Boolean)
    : [];
  const imageAnalyses = Array.isArray(result?.imageAnalyses) ? result.imageAnalyses : [];
  const rewritePrompt = unwrapMarkdownCodeBlock(generated?.rewritePrompt || "");
  const imagePrompt = unwrapMarkdownCodeBlock(generated?.imagePrompt || "");

  const lines = [
    `审查目标：${target === "rewrite" ? "仿写提示词" : target === "image" ? "生图提示词" : "仿写提示词 + 生图提示词"}`,
    `原笔记标题：${title || "-"}`,
    `原笔记正文：${body || "-"}`,
    `原笔记标签：${tags.length ? tags.join("、") : "-"}`,
    `参考图分析数量：${imageAnalyses.length}`,
    "",
    "用户原始补充要求：",
    `- rewriteInstruction: ${String(options.rewriteInstruction || options.rewriteDirection || "").trim() || "-"}`,
    `- imageInstruction: ${String(options.imageInstruction || options.imageDirection || "").trim() || "-"}`,
    "",
    "自测输入：",
    `- 用户输入变量: ${String(selfTest?.location || "").trim() || "-"}`,
    `- 图片信息变量: ${String(selfTest?.imageInfo || "").trim() || "-"}`,
    `- 自测图片数量: ${Array.isArray(selfTest?.imageDataUrls) ? selfTest.imageDataUrls.length : 0}`,
    "",
    "生成结果：",
  ];

  if (target !== "image") {
    lines.push("", "[rewrite_prompt]", rewritePrompt || "-");
  }

  if (target !== "rewrite") {
    lines.push("", "[image_prompt]", imagePrompt || "-");
  }

  if (imageAnalyses.length) {
    lines.push("", "参考图视觉摘要：");
    imageAnalyses.forEach((item, index) => {
      lines.push(
        `图${index + 1}：风格=${String(item?.style || "").trim() || "-"}；构图=${String(item?.composition || "").trim() || "-"}；光线=${String(item?.light || "").trim() || "-"}；色彩=${String(item?.color || "").trim() || "-"}；氛围=${String(item?.mood || "").trim() || "-"}`
      );
    });
  }

  if (selfTestImageAnalyses.length) {
    lines.push("", "自测图片视觉摘要：");
    selfTestImageAnalyses.forEach((item, index) => {
      lines.push(
        `自测图${index + 1}：风格=${String(item?.style || "").trim() || "-"}；构图=${String(item?.composition || "").trim() || "-"}；光线=${String(item?.light || "").trim() || "-"}；色彩=${String(item?.color || "").trim() || "-"}；氛围=${String(item?.mood || "").trim() || "-"}`
      );
    });
  }

  lines.push("", "请从以下维度判卷：", "- 是否紧贴原笔记/参考图，而不是泛化模板", "- 是否保留足够强的素人实拍感/真实摄影感", "- 是否能直接给下游模型使用", "- 是否缺少关键结构或变量", "- 是否存在空话、跑题、编造、混入无关视觉语言");

  return lines.join("\n");
}

function buildPromptReviewSystemPrompt(target) {
  const lines = [
    "你是专业的提示词质量审查员，负责客观、全面地评估AI生成的提示词模板质量。",
    "请严格按照以下质量标准进行审查，并输出JSON格式的审查结果。",
    "只输出JSON，不要输出解释文字。",
    "评分标准：100分满分，82分以上才算通过；如果存在严重问题（如跑题、空泛、结构缺失、缺乏真实感等），必须判不通过。",
  ];

  if (target === "rewrite") {
    lines.push("你只审查 rewrite_prompt（仿写提示词）。审查重点包括：");
    lines.push("1. 明确性：目标是否清晰，是否有明确的结构要求");
    lines.push("2. 完整性：是否包含标题要求、开头钩子、正文结构、高频元素、结尾动作、标签策略、写作限制等必要模块");
    lines.push("3. 精确性：用户输入变量是否正确使用，是否有明确的写作约束");
    lines.push("4. 实用性：是否能直接被其他AI使用，是否有明确的仿写指导");
    lines.push("5. 一致性：风格是否与原笔记相符，是否保持真实感");
  } else if (target === "image") {
    lines.push("你只审查 image_prompt（生图提示词）。审查重点包括：");
    lines.push("1. 明确性：是否有明确的视觉风格、构图、光线、色彩要求");
    lines.push("2. 完整性：是否包含真实实拍要求、摄影参数、画面质感、比例、氛围等必要信息");
    lines.push("3. 精确性：图片信息变量是否正确使用，是否有明确的负面限制");
    lines.push("4. 实用性：是否能直接被生图AI使用，是否有具体的视觉描述");
    lines.push("5. 一致性：风格是否与参考图相符，是否保持真实摄影感");
    lines.push("如果提供了自测图片样本，请把它们视为判卷基准，判断生成结果是否足够接近样本的实拍质感与镜头逻辑。");
  } else {
    lines.push("你同时审查 rewrite_prompt 和 image_prompt，分别打分，再给出总评。");
    lines.push("rewrite_prompt 审查重点：明确性、完整性、精确性、实用性、一致性");
    lines.push("image_prompt 审查重点：明确性、完整性、精确性、实用性、一致性");
  }

  return lines.join("\n");
}

function buildPromptReviewResponseFormats(target) {
  const itemSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      pass: { type: "boolean" },
      score: { type: "number" },
      issues: {
        type: "array",
        items: { type: "string" },
      },
      missing_points: {
        type: "array",
        items: { type: "string" },
      },
      rewrite_instruction: { type: "string" },
      summary: { type: "string" },
    },
    required: ["pass", "score", "issues", "missing_points", "rewrite_instruction", "summary"],
  };

  if (target === "all") {
    return [
      {
        type: "json_schema",
        json_schema: {
          name: "prompt_review_schema",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              pass: { type: "boolean" },
              summary: { type: "string" },
              rewrite: itemSchema,
              image: itemSchema,
            },
            required: ["pass", "summary", "rewrite", "image"],
          },
        },
      },
      { type: "json_object" },
      null,
    ];
  }

  return [
    {
      type: "json_schema",
      json_schema: {
        name: "prompt_review_schema",
        strict: true,
        schema: itemSchema,
      },
    },
    { type: "json_object" },
    null,
  ];
}

function parsePromptReviewJson(content, target) {
  const parsed = parseAiJsonContent(content, target === "all" ? "all" : target);
  return parsed;
}

function normalizePromptReviewResult(reviewJson, target) {
  if (target === "all") {
    const rewrite = normalizeSinglePromptReview(reviewJson?.rewrite, "rewrite");
    const image = normalizeSinglePromptReview(reviewJson?.image, "image");
    return {
      pass: Boolean(reviewJson?.pass && rewrite.pass && image.pass),
      summary: String(reviewJson?.summary || "").trim(),
      rewrite,
      image,
    };
  }

  return normalizeSinglePromptReview(reviewJson, target);
}

function normalizeSinglePromptReview(reviewJson, target) {
  const score = Number(reviewJson?.score);
  const scoreValue = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
  const issues = Array.isArray(reviewJson?.issues)
    ? reviewJson.issues.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const missingPoints = Array.isArray(reviewJson?.missing_points)
    ? reviewJson.missing_points.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const rewriteInstruction = String(reviewJson?.rewrite_instruction || "").trim();
  const summary = String(reviewJson?.summary || "").trim();
  const pass = Boolean(reviewJson?.pass) && scoreValue >= AI_PROMPT_SELF_CHECK_MIN_SCORE;

  return {
    pass,
    score: scoreValue,
    issues,
    missing_points: missingPoints,
    rewrite_instruction: rewriteInstruction,
    summary,
    target,
  };
}

function assessPromptTextQuality(target, promptText, result, options) {
  const normalizedText = unwrapMarkdownCodeBlock(promptText);
  const issues = [];
  const missingPoints = [];

  if (!normalizedText) {
    issues.push("提示词为空或无法解析。");
  }

  if (normalizedText.length < (target === "image" ? 220 : 260)) {
    issues.push("提示词过短，信息密度不足。");
  }

  if (!/^```[\w-]*\n[\s\S]*\n```$/m.test(String(promptText || "").trim())) {
    issues.push("没有按 markdown 代码块输出。");
  }

  if (target === "rewrite") {
    const requiredMarkers = [
      "标题要求",
      "开头钩子",
      "正文结构",
      "高频元素",
      "结尾动作",
      "标签策略",
      "写作限制",
    ];
    const hitCount = requiredMarkers.filter((marker) => normalizedText.includes(marker)).length;

    if (hitCount < 5) {
      issues.push("rewrite_prompt 的结构模块不够完整，应包含标题要求、开头钩子、正文结构、高频元素、结尾动作、标签策略、写作限制等模块。");
    }

    if (!normalizedText.includes(WORKFLOW_TEMPLATE_VARIABLES.locationContext)) {
      issues.push("rewrite_prompt 没有稳定使用用户输入变量。");
    }

    if (!/仿写|生文|提示词/.test(normalizedText)) {
      issues.push("rewrite_prompt 没有体现它是给下游 AI 用的仿写提示词。");
    }

    if (!/实拍|真实|人味|口语|像素人/.test(normalizedText)) {
      missingPoints.push("可以更明确保留原笔记的人味、口语感和真实分享感。");
    }
  } else {
    if (!normalizedText.includes(WORKFLOW_TEMPLATE_VARIABLES.imageLocationContext)) {
      issues.push("image_prompt 没有稳定使用图片信息变量。");
    }

    if (!/真实拍摄|实拍|真实摄影|素人实拍|实景/.test(normalizedText)) {
      issues.push("image_prompt 的实拍感描述不够明确，应包含真实拍摄要求。");
    }

    if (!/构图|光线|色彩|质感|镜头|氛围/.test(normalizedText)) {
      issues.push("image_prompt 的视觉要素太少，缺少可执行的画面语言，应包含构图、光线、色彩、质感、镜头、氛围等要素。");
    }

    if (!/提示词|prompt|成图/.test(normalizedText)) {
      missingPoints.push("可以再加强它是可直接投喂生图模型的最终 prompt。");
    }
  }

  const resultScore = Math.max(
    0,
    100 -
      issues.length * 16 -
      missingPoints.length * 6 -
      Math.max(0, 220 - normalizedText.length) / 20
  );
  const pass = issues.length === 0 && resultScore >= AI_PROMPT_SELF_CHECK_MIN_SCORE;
  return {
    pass,
    score: Math.max(0, Math.round(resultScore)),
    issues,
    missing_points: missingPoints,
    rewrite_instruction: buildPromptReviewFeedback(
      {
        score: resultScore,
        issues,
        missing_points: missingPoints,
      },
      target
    ),
    summary: pass ? "本地硬规则检查通过。" : "本地硬规则检查未通过。",
  };
}

function unwrapMarkdownCodeBlock(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  const match = normalized.match(/^```(?:markdown|md|json|text)?\s*\n([\s\S]*?)\n```$/i);
  if (match && match[1]) {
    return match[1].trim();
  }

  return normalized
    .replace(/^```[\w-]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function buildAiEndpointUrl() {
  return new URL(AI_CHAT_COMPLETIONS_PATH, AI_API_BASE_URL).toString();
}

function buildAiImageGenerationUrl() {
  return new URL(AI_IMAGE_GENERATIONS_PATH, AI_API_BASE_URL).toString();
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
    "不要把分析重心放在某个具体物体上，只总结可迁移的构图关系、镜头语言、光线逻辑、色彩关系、材质表现和氛围气质。",
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
        "如果画面里存在明显主体，也只把它抽象成主体类型和视觉角色，不要围绕特定物体做细节复述。",
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

  const { controller, timeoutId } = createTimeoutController(AI_VISION_TIMEOUT_MS, "参考图分析请求");

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
  } catch (error) {
    throw normalizeTimeoutError(error, "参考图分析请求", AI_VISION_TIMEOUT_MS);
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
    `photorealistic lifestyle city-landmark scene based on the visual grammar of image ${serial}, keep the same composition logic and atmosphere, use location ${vars.imageLocationContext} to generate a representative landmark or scenic spot of that city, and if generating multiple images ensure each image uses a different landmark from the same city, realistic texture, highly detailed, no unrelated stickers or text overlays, --ar 3:4 --style raw`,
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

function parseAiJsonContent(content, target = "all") {
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

  const fallbackPromptJson = (rawContent) => {
    const explicitField = extractPromptFieldFallback(rawContent, target);
    if (explicitField) {
      return explicitField;
    }

    const text = extractPromptTextFallback(rawContent);
    if (!text) {
      return null;
    }

    if (target === "rewrite") {
      return { rewrite_prompt: text };
    }

    if (target === "image") {
      return { image_prompt: text };
    }

    return { rewrite_prompt: text, image_prompt: text };
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

    const fallback = fallbackPromptJson(content);
    if (fallback) {
      return normalizePromptJson(fallback);
    }

    throw new Error("AI ???????? JSON?");
  }
}

function extractPromptTextFallback(content) {
  let text = String(content || "").trim();
  if (!text) {
    return "";
  }

  text = text
    .replace(/^```(?:json|markdown|md|text)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  text = text
    .replace(/^image[_\s-]?prompt[?:]\s*/i, "")
    .replace(/^rewrite[_\s-]?prompt[?:]\s*/i, "")
    .trim();

  if (!text || text === "{}") {
    return "";
  }

  return text;
}

function extractPromptFieldFallback(content, target = "all") {
  const source = String(content || "")
    .replace(/^```(?:json|markdown|md|text)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!source) {
    return null;
  }

  const extractField = (fieldName) => {
    const pattern = new RegExp(`"${fieldName}"\\\\s*:\\\\s*"([\\\\s\\\\S]*?)"(?=\\\\s*,|\\\\s*})`, "i");
    const match = source.match(pattern);
    if (!match || typeof match[1] !== "string") {
      return "";
    }

    try {
      return JSON.parse(`"${match[1]}"`);
    } catch (error) {
      return match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    }
  };

  const rewritePrompt = extractField("rewrite_prompt") || extractField("rewritten_prompt");
  const imagePrompt = extractField("image_prompt") || extractField("imagePrompt");

  if (target === "rewrite" && rewritePrompt) {
    return { rewrite_prompt: rewritePrompt };
  }

  if (target === "image" && imagePrompt) {
    return { image_prompt: imagePrompt };
  }

  if (rewritePrompt || imagePrompt) {
    return {
      rewrite_prompt: rewritePrompt,
      image_prompt: imagePrompt,
    };
  }

  return null;
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

  const extracted = extractPromptFieldFallback(value, "rewrite");
  const normalizedValue =
    extracted && typeof extracted.rewrite_prompt === "string" && extracted.rewrite_prompt.trim()
      ? extracted.rewrite_prompt
      : value;

  return ensureMarkdownCodeBlock(
    normalizePromptLocationVariables(
      replaceLegacyLocationVariable(
        canonicalizeWorkflowTemplateVariables(normalizedValue.replace(/\r/g, "").trim()),
        "rewrite"
      ),
      "rewrite"
    )
  );
}

function formatImagePromptOutput(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  const extracted = extractPromptFieldFallback(value, "image");
  const normalizedValue =
    extracted && typeof extracted.image_prompt === "string" && extracted.image_prompt.trim()
      ? extracted.image_prompt
      : value;

  return ensureMarkdownCodeBlock(
    restoreFixedTemplateUserInputVariable(
      normalizePromptLocationVariables(
        ensureImagePromptLocationVariable(
          localizeImagePromptText(
            replaceLegacyLocationVariable(
              canonicalizeWorkflowTemplateVariables(normalizedValue.replace(/\r/g, "").trim()),
              "image"
            )
          )
        ),
        "image"
      )
    )
  );
}

function restoreFixedTemplateUserInputVariable(value) {
  const source = String(value || "");
  return source
    .replace(
      /文案变量：画面中出现店铺名\/产品名字\/地名，严格使用\{\{\s*\$\('输入参数汇总'\)\.item\.json\['图片信息'\]\s*\}\}替换/g,
      "文案变量：画面中出现店铺名/产品名字/地名，严格使用{{ $('输入参数汇总').item.json['用户输入'] }}替换"
    )
    .replace(
      /文案变量：如果画面中有出现产品名字\/地名，直接用 json 变量的内容[“"]\{\{\s*\$\('输入参数汇总'\)\.item\.json\['图片信息'\]\s*\}\}[”"]?/g,
      "文案变量：画面中出现店铺名/产品名字/地名，严格使用{{ $('输入参数汇总').item.json['用户输入'] }}替换"
    );
}

function normalizePromptLocationVariables(value, target = "rewrite") {
  const replacement =
    target === "image"
      ? WORKFLOW_TEMPLATE_VARIABLES.imageLocationContext
      : WORKFLOW_TEMPLATE_VARIABLES.locationContext;

  const patterns = [
    /\{\{\s*\$\('\?{2,}'\)\.item\.json\[['"]\?{2,}['"]\]\s*\}\}/g,
    /\{\{\s*\$\('[^']*'\)\.item\.json\[['"]用户输入['"]\]\s*\}\}/g,
    /\{\{\s*\$\('[^']*'\)\.item\.json\[['"]图片信息['"]\]\s*\}\}/g,
    /\{\{\s*\$\('\\u8f93\\u5165\\u53c2\\u6570\\u6c47\\u603b'\)\.item\.json\[['"]\\u7528\\u6237\\u8f93\\u5165['"]\]\s*\}\}/g,
    /\{\{\s*\$\('\\u8f93\\u5165\\u53c2\\u6570\\u6c47\\u603b'\)\.item\.json\[['"]\\u56fe\\u7247\\u4fe1\\u606f['"]\]\s*\}\}/g,
  ];

  return patterns.reduce(
    (current, pattern) => String(current || "").replace(pattern, replacement),
    String(value || "")
  );
}

function replaceLegacyLocationVariable(value, target = "rewrite") {
  const locationReplacement =
    target === "image"
      ? WORKFLOW_TEMPLATE_VARIABLES.imageLocationContext
      : WORKFLOW_TEMPLATE_VARIABLES.locationContext;

  return String(value || "")
    .replace(
      /\{\{\s*\$\('\u8f93\u5165\u53c2\u6570\u6c47\u603b'\)\.item\.json\[\["']\u7528\u6237\u8f93\u5165\["']\]\s*\}\}/g,
      locationReplacement
    )
    .replace(
      /\{\{\s*\$\('[^']*'\)\.item\.json\[\["']\u7528\u6237\u8f93\u5165\["']\]\s*\}\}/g,
      locationReplacement
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

  const normalized = canonicalMap.reduce(
    (current, entry) => current.replace(entry.pattern, entry.replacement),
    value
  );

  return normalized.replace(
    /\{\{\s*\$\('\\u8f93\\u5165\\u53c2\\u6570\\u6c47\\u603b'\)\.item\.json\[['"]\\u7528\\u6237\\u8f93\\u5165['"]\]\s*\}\}/g,
    WORKFLOW_TEMPLATE_VARIABLES.locationContext
  );
}

function localizeImagePromptText(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  const replacements = [
    [/\bMedium close-up\b/gi, "中景近距"],
    [/\bclose-up\b/gi, "近景特写"],
    [/\bmedium shot\b/gi, "中景"],
    [/\bwide shot\b/gi, "远景"],
    [/\beye-level\b/gi, "平视机位"],
    [/\blow angle\b/gi, "低机位仰拍"],
    [/\bhigh angle\b/gi, "高机位俯拍"],
    [/\bshallow depth of field\b/gi, "浅景深"],
    [/\bdepth of field\b/gi, "景深"],
    [/\bbokeh\b/gi, "背景虚化光斑"],
    [/\btelephoto lens\b/gi, "长焦镜头"],
    [/\btelephoto\b/gi, "长焦感"],
    [/\bstandard lens\b/gi, "标准焦段"],
    [/\bsoft,?\s*diffused natural light\b/gi, "柔和漫射自然光"],
    [/\bsoft natural light\b/gi, "柔和自然光"],
    [/\bdiffused natural light\b/gi, "漫射自然光"],
    [/\bfilm grain\b/gi, "胶片颗粒感"],
    [/\bsoft focus\b/gi, "柔焦效果"],
    [/\bunderexposed\b/gi, "轻微压暗曝光"],
    [/\bdesaturated\b/gi, "低饱和"],
    [/\bmuted color palette\b/gi, "低饱和柔和配色"],
    [/\bwarm\b/gi, "暖调"],
    [/\bcool\b/gi, "冷调"],
    [/\bcentral focus\b/gi, "主体居中聚焦"],
    [/\bphotorealistic\b/gi, "真实摄影感"],
    [/\brealistic\b/gi, "真实自然"],
    [/\bvintage feel\b/gi, "复古氛围"],
    [/\bserene\b/gi, "宁静"],
    [/\bnostalgic\b/gi, "怀旧"],
    [/\bmelancholic\b/gi, "淡淡感伤"],
  ];

  return replacements.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value
  );
}

function ensureImagePromptLocationVariable(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  const locationVar = WORKFLOW_TEMPLATE_VARIABLES.imageLocationContext;
  if (value.includes(locationVar)) {
    return value;
  }

  let next = value;

  if (/\*\*生成目标：\*\*/.test(next)) {
    next = next.replace(
      /\*\*生成目标：\*\*\s*/g,
      `**生成目标：** 请围绕固定图片信息变量 ${locationVar} 生成城市地标/景区系列图。`
    );
  }

  if (/\*\*场景主体：\*\*/.test(next)) {
    next = next.replace(
      /\*\*场景主体：\*\*\s*/g,
      `**场景主体：** 根据图片信息变量 ${locationVar} 动态替换为该城市的代表性地标、景区或城市名片场景。`
    );
  }

  if (/\*\*城市映射：\*\*/.test(next)) {
    next = next.replace(
      /\*\*城市映射：\*\*\s*/g,
      `**城市映射：** 读取图片信息变量 ${locationVar}，保持构图逻辑、镜头关系和氛围节奏不变，只替换为该地点对应的城市地标/景区。`
    );
  }

  if (!/\*\*城市映射：\*\*/.test(next)) {
    next = next.replace(
      /(图[一二三四五六七八九十]+\s*\n---\s*)/g,
      `$1**城市映射：** 读取图片信息变量 ${locationVar}，保持构图逻辑、镜头关系和氛围节奏不变，只替换为该地点对应的城市地标/景区。\n\n`
    );
  }

  return next;
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
      return dedupeImagesPreserveOrder(candidates).slice(0, 24);
    }
  }

  addUniqueImages(candidates, extractScriptImages(source, noteUrl), noteUrl);
  addUniqueImages(candidates, extractMetaImages(source, noteUrl), noteUrl);
  addUniqueImages(candidates, extractJsonLdImages(source, noteUrl), noteUrl);
  addUniqueImages(candidates, extractInlineImages(source, noteUrl), noteUrl);

  return dedupeAndRankImages(candidates).slice(0, 24);
}

function dedupeImagesPreserveOrder(images) {
  const seen = new Set();
  const ordered = [];

  for (const imageUrl of images) {
    const key = buildImageDedupKey(imageUrl);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ordered.push(imageUrl);
  }

  return ordered;
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
  const initialStateNote = extractXiaohongshuNoteFromInitialState(source, noteId);
  const noteBlock = extractXiaohongshuNoteBlock(source, noteId) || source;
  const parsedNoteBlock = parseXiaohongshuNoteBlock(noteBlock);
  const note = initialStateNote || findXiaohongshuNotePayload(parsedNoteBlock) || {};
  const listImages = extractXiaohongshuImagesFromImageList(note.imageList);
  const blockImages = extractXiaohongshuImagesFromSource(noteBlock);
  const noteImages = listImages.length ? listImages : blockImages;

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

function extractXiaohongshuNoteFromInitialState(source, noteId) {
  const initialState = extractXiaohongshuInitialState(source);
  if (!initialState || typeof initialState !== "object") {
    return null;
  }

  const noteStore = initialState.note;
  if (!noteStore || typeof noteStore !== "object") {
    return null;
  }

  const targetId = noteId || noteStore.currentNoteId || noteStore.firstNoteId;
  if (!targetId) {
    return null;
  }

  const candidate =
    noteStore.noteDetailMap?.[targetId]?.note ||
    noteStore.noteDetailMap?.[String(targetId)]?.note ||
    null;

  return candidate && typeof candidate === "object" ? candidate : null;
}

function extractXiaohongshuInitialState(source) {
  const marker = "window.__INITIAL_STATE__=";
  const start = source.indexOf(marker);
  if (start < 0) {
    return null;
  }

  const begin = source.indexOf("{", start);
  if (begin < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

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
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const jsonText = source.slice(begin, index + 1);
        try {
          return JSON.parse(jsonText);
        } catch (error) {
          try {
            return vm.runInNewContext(`(${jsonText})`, {}, { timeout: 1000 });
          } catch (vmError) {
            return null;
          }
        }
      }
    }
  }

  return null;
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
    const bestCandidate = pickBestXiaohongshuImageVariant(item);
    if (bestCandidate && !images.includes(bestCandidate)) {
      images.push(bestCandidate);
    }
  }

  return images;
}

function pickBestXiaohongshuImageVariant(item) {
  const infoList = Array.isArray(item?.infoList) ? item.infoList : [];
  const itemCandidates = [
    infoList.find((entry) => entry?.imageScene === "WB_DFT")?.url,
    item?.urlDefault,
    item?.originImageUrl,
    item?.masterUrl,
    item?.imageUrl,
    item?.coverUrl,
    item?.url,
    item?.urlOrigin,
    infoList.find((entry) => entry?.imageScene === "WB_PRV")?.url,
    item?.urlPre,
    item?.thumbnailUrl,
  ]
    .map((value) => normalizeXiaohongshuImageUrl(value))
    .filter(Boolean);

  return itemCandidates[0] || "";
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

  if (/!nd_dft_/i.test(lower) || /imageScene":"WB_DFT"/i.test(lower)) {
    score += 24;
  }

  if (/!nd_prv_/i.test(lower) || /urlpre/i.test(lower)) {
    score -= 18;
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
