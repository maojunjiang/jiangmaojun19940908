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
    setStatus("error", "链接格式不正确", "请补充完整链接，例如 https://example.com/note/123。");
    return;
  }

  setStatus("loading", "正在解析", "正在抓取页面内容并整理结构化字段。");
  submitButton.disabled = true;

  try {
    const result = await parseNoteFromUrl(noteUrl);
    renderResult(result);

    const hasFallback = result.meta.usedFallback;
    setStatus(
      hasFallback ? "error" : "success",
      hasFallback ? "解析受限" : "解析完成",
      hasFallback
        ? "目标站点可能限制跨域或防抓取，当前结果基于可读内容推断。后续接入后端代理后会更稳定。"
        : "已成功提取图片、标题、正文和标签。"
    );
  } catch (error) {
    renderResult(buildFallbackResult(noteUrl, ""));
    setStatus(
      "error",
      "解析失败",
      error instanceof Error
        ? error.message
        : "当前无法访问该链接内容，建议稍后重试或接入服务端代理解析。"
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
    rawText.trim() ||
    "当前本地服务已经接入，但目标站点可能还需要登录态、签名参数或专门的站点解析规则。";

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

  resultTitle.textContent = result.title;
  resultBody.textContent = result.body;

  resultTags.innerHTML = "";

  result.tags.forEach((tagText) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `#${tagText}`;
    resultTags.appendChild(tag);
  });
}

function normalizeImages(result) {
  const images = Array.isArray(result.images) ? result.images : [];
  const merged = [...images, result.image].filter(Boolean);
  const unique = [...new Set(merged)];
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
  return text
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
