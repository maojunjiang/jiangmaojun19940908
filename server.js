const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const HOST = "127.0.0.1";
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

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

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === "POST" && requestUrl.pathname === "/api/parse") {
      await handleParse(req, res);
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

    const rawText = await response.text();
    if (!rawText.trim()) {
      return null;
    }

    return extractStructuredContent(rawText, noteUrl);
  } catch (error) {
    return null;
  }
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
    addUniqueImages(candidates, extractXiaohongshuImagesFromSource(source), noteUrl);
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

    for (const candidate of itemCandidates) {
      if ((isXiaohongshuImageUrl(candidate) || isLikelyImage(candidate)) && !images.includes(candidate)) {
        images.push(candidate);
      }
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
      return `${host}${pathname}`;
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
