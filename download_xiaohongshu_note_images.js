const fs = require("node:fs/promises");
const path = require("node:path");

const noteUrl = process.argv[2];
const downloadsDir = process.argv[3] || "/Users/ahs/Downloads";

if (!noteUrl) {
  console.error("Usage: node download_xiaohongshu_note_images.js <noteUrl> [downloadsDir]");
  process.exit(1);
}

function decodeEscaped(value) {
  return value.replaceAll("\\u002F", "/").replaceAll("\\/", "/");
}

function extFromContentType(contentType, imageUrl) {
  const map = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/gif": ".gif",
  };

  if (contentType && map[contentType.toLowerCase()]) {
    return map[contentType.toLowerCase()];
  }

  try {
    const pathname = new URL(imageUrl).pathname;
    return path.extname(pathname) || ".jpg";
  } catch (error) {
    return ".jpg";
  }
}

function noteIdFromUrl(input) {
  const pathname = new URL(input).pathname;
  return pathname.split("/").filter(Boolean).pop() || "note";
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });

  const html = await response.text();
  if (!response.ok || !html) {
    throw new Error(`页面获取失败: ${response.status}`);
  }

  return html;
}

function extractNoteImageUrls(html) {
  const urls = [...html.matchAll(/"urlDefault"\s*:\s*"([^"]+)"/g)]
    .map((match) => decodeEscaped(match[1]).replace(/^http:/, "https:"))
    .filter((url) => /https:\/\/sns-webpic[^"' ]*\/notes_pre_post\//i.test(url));

  return [...new Set(urls)];
}

async function downloadImage(imageUrl, outputPath) {
  const response = await fetch(imageUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Referer: "https://www.xiaohongshu.com/",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`图片下载失败: ${response.status} ${imageUrl}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, buffer);

  const contentType = response.headers.get("content-type")?.split(";")[0] || "";
  return { contentType, bytes: buffer.length };
}

async function main() {
  const html = await fetchHtml(noteUrl);
  const imageUrls = extractNoteImageUrls(html);
  const noteId = noteIdFromUrl(noteUrl);

  if (!imageUrls.length) {
    throw new Error("没有定位到正文配图");
  }

  try {
    await fs.unlink(path.join(downloadsDir, `xiaohongshu-${noteId}.png`));
  } catch (error) {
    // Ignore if the wrong fallback file does not exist.
  }

  const saved = [];

  for (let index = 0; index < imageUrls.length; index += 1) {
    const imageUrl = imageUrls[index];
    const tempPath = path.join(downloadsDir, `xiaohongshu-${noteId}-${String(index + 1).padStart(2, "0")}.tmp`);
    const { contentType, bytes } = await downloadImage(imageUrl, tempPath);
    const ext = extFromContentType(contentType, imageUrl);
    const finalPath = tempPath.replace(/\.tmp$/, ext);
    await fs.rename(tempPath, finalPath);

    saved.push({
      outputPath: finalPath,
      imageUrl,
      contentType,
      bytes,
    });
  }

  console.log(JSON.stringify(saved, null, 2));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
