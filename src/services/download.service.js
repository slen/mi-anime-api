const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const axios = require("axios");
const ffmpegPath = require("ffmpeg-static");
const ffmpeg = require("fluent-ffmpeg");
ffmpeg.setFfmpegPath(ffmpegPath);
const { ApiError } = require("../utils/api-error");
const animeService = require("./animeav1.service");

const downloadStore = new Map();
const batchStore = new Map();

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "*/*",
  Referer: "https://animeav1.com/",
};

const SERVER_PRIORITY = ["pdrain", "1fichier", "mp4upload", "upnshare","hls", "mega"];

function getDownloadsDir() {
  const configuredPath = process.env.DOWNLOADS_DIR || "downloads";
  const targetPath = path.resolve(process.cwd(), configuredPath);
  fs.mkdirSync(targetPath, { recursive: true });
  return targetPath;
}

function safeFilePart(value) {
  return (value || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function extractEpisodeNumber(episodeUrl) {
  const parts = episodeUrl.split("/").filter(Boolean);
  const maybeNumber = Number(parts[parts.length - 1]);
  return Number.isFinite(maybeNumber) ? maybeNumber : null;
}

function extractAnimeSlug(episodeUrl) {
  const parts = episodeUrl.split("/").filter(Boolean);
  const mediaIndex = parts.findIndex((part) => part === "media");
  if (mediaIndex === -1 || !parts[mediaIndex + 1]) {
    return "anime";
  }
  return safeFilePart(parts[mediaIndex + 1]) || "anime";
}

function getExtensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname || "";
    const ext = path.extname(pathname).toLowerCase();
    if ([".mp4", ".mkv", ".avi", ".mov", ".webm"].includes(ext)) {
      return ext;
    }
  } catch (_error) {
    // Ignore parse errors and fallback.
  }

  return ".mp4";
}

function chooseCandidateLinks(episodeData, variant, preferredServer) {
  const normalizedVariant = String(variant || "SUB").toUpperCase() === "DUB" ? "DUB" : "SUB";
  const otherVariant = normalizedVariant === "SUB" ? "DUB" : "SUB";

  const downloadLinks = episodeData.downloadLinks || { SUB: [], DUB: [] };
  const streamLinks = episodeData.streamLinks || { SUB: [], DUB: [] };

  const candidates = [
    ...(downloadLinks[normalizedVariant] || []),
    ...(downloadLinks[otherVariant] || []),
    ...(streamLinks[normalizedVariant] || []),
    ...(streamLinks[otherVariant] || []),
  ];

  const seen = new Set();
  const deduped = [];

  for (const item of candidates) {
    if (!item || typeof item.url !== "string" || !item.url.trim()) {
      continue;
    }

    const key = item.url.trim();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push({
      server: item.server || "Unknown",
      url: key,
      quality: item.quality || null,
    });
  }

  const preferredToken = safeFilePart(preferredServer);

  deduped.sort((a, b) => {
    const serverA = safeFilePart(a.server);
    const serverB = safeFilePart(b.server);

    const preferredBonusA = preferredToken && serverA.includes(preferredToken) ? -100 : 0;
    const preferredBonusB = preferredToken && serverB.includes(preferredToken) ? -100 : 0;

    const priorityA = SERVER_PRIORITY.findIndex((token) => serverA.includes(token));
    const priorityB = SERVER_PRIORITY.findIndex((token) => serverB.includes(token));
    const resolvedA = priorityA === -1 ? 999 : priorityA;
    const resolvedB = priorityB === -1 ? 999 : priorityB;

    return resolvedA + preferredBonusA - (resolvedB + preferredBonusB);
  });

  return deduped;
}

function makeDownloadFilename(record, sourceUrl, serverName) {
  const slug = extractAnimeSlug(record.url);
  const episodeNumber = extractEpisodeNumber(record.url);
  const ext = getExtensionFromUrl(sourceUrl);
  const serverToken = safeFilePart(serverName || "server");
  const qualityToken = safeFilePart(record.quality || "auto");
  const suffix = record.downloadId.split("-")[0];
  const episodeLabel = Number.isFinite(episodeNumber) ? `ep${episodeNumber}` : "epx";

  return `${slug}-${episodeLabel}-${qualityToken}-${serverToken}-${suffix}${ext}`;
}

async function removeFileIfExists(targetPath) {
  try {
    await fs.promises.unlink(targetPath);
  } catch (_error) {
    // Ignore missing files.
  }
}

function ensureDirectLikeContent(contentType, url) {
  const lowered = (contentType || "").toLowerCase();
  if (/(text\/html|application\/json|application\/javascript|text\/plain)/i.test(lowered)) {
    throw new Error(`El servidor devolvio contenido no descargable (${lowered || "desconocido"}) para ${url}`);
  }
}

function resolveDirectDownloadUrl(rawUrl, serverName) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return rawUrl;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_error) {
    return rawUrl;
  }

  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const serverToken = safeFilePart(serverName || "");

  if (host.includes("pixeldrain.com") || serverToken.includes("pdrain") || serverToken.includes("pixeldrain")) {
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const isFileApi = pathParts[0] === "api" && pathParts[1] === "file" && pathParts[2];
    const isUserShare = pathParts[0] === "u" && pathParts[1];

    const fileId = isFileApi ? pathParts[2] : isUserShare ? pathParts[1] : null;
    if (fileId) {
      return `https://pixeldrain.com/api/file/${fileId}?download`;
    }
  }

  if (host.includes("zilla-networks.com") && parsed.pathname.startsWith("/play/")) {
    const videoId = parsed.pathname.split("/").pop();
    if (videoId) {
      return `https://player.zilla-networks.com/m3u8/${videoId}`;
    }
  }

  return rawUrl;
}

async function downloadHlsVideo(finalUrl, filePath, record, candidate) {
  record.status = "downloading";
  record.currentServer = candidate.server;
  record.sourceUrl = finalUrl;
  record.totalBytes = null;
  record.downloadedBytes = 0;
  record.progress = 1;
  record.updatedAt = Date.now();

  return new Promise((resolve, reject) => {
    ffmpeg(finalUrl)
      .inputOptions([
        '-headers',
        `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\r\nReferer: https://animeav1.com/\r\n`
      ])
      .outputOptions([
        "-c copy",
        "-bsf:a aac_adtstoasc"
      ])
      .output(filePath)
      .on("start", () => {
        record.status = "downloading";
        record.progress = 1;
        record.updatedAt = Date.now();
      })
      .on("progress", (progress) => {
        if (progress.percent && progress.percent > 0) {
          record.progress = Math.max(1, Math.min(99, Math.floor(progress.percent)));
        } else {
          // Si ffmpeg no nos da un %, subimos el progreso visualmente poco a poco
          record.progress = Math.min(90, record.progress + 1);
        }
        record.updatedAt = Date.now();
      })
      .on("error", async (err) => {
        await removeFileIfExists(filePath);
        reject(new Error(`Transferencia fallida en ${candidate.server} (HLS): ${err.message}`));
      })
      .on("end", () => {
        resolve();
      })
      .run();
  });
}

async function downloadFromUrl(record, candidate) {
  const finalUrl = resolveDirectDownloadUrl(candidate.url, candidate.server);
  const downloadsDir = getDownloadsDir();
  const fileName = makeDownloadFilename(record, finalUrl, candidate.server);
  const filePath = path.join(downloadsDir, fileName);

  const isHls = finalUrl.toLowerCase().includes(".m3u8") || /hls/i.test(candidate.server);

  if (isHls) {
    await downloadHlsVideo(finalUrl, filePath, record, candidate);
  } else {
    let response;
    try {
      const timeout = Number(process.env.DOWNLOAD_REQUEST_TIMEOUT_MS || 120000);
      response = await axios.get(finalUrl, {
        responseType: "stream",
        timeout,
        maxRedirects: 5,
        headers: DEFAULT_HEADERS,
        validateStatus: (status) => status >= 200 && status < 400,
      });
    } catch (error) {
      throw new Error(`No se pudo abrir enlace ${candidate.server}: ${error.message}`);
    }

    const contentType = response.headers["content-type"] || "";
    ensureDirectLikeContent(contentType, finalUrl);

    const totalBytesRaw = Number(response.headers["content-length"] || 0);
    const totalBytes = Number.isFinite(totalBytesRaw) && totalBytesRaw > 0 ? totalBytesRaw : null;

    record.status = "downloading";
    record.currentServer = candidate.server;
    record.sourceUrl = finalUrl;
    record.totalBytes = totalBytes;
    record.downloadedBytes = 0;
    record.progress = 1;
    record.updatedAt = Date.now();

    const writer = fs.createWriteStream(filePath, { flags: "w" });

    response.data.on("data", (chunk) => {
      if (!Buffer.isBuffer(chunk)) {
        return;
      }

      record.downloadedBytes += chunk.length;
      record.updatedAt = Date.now();

      if (record.totalBytes && record.totalBytes > 0) {
        const pct = Math.floor((record.downloadedBytes / record.totalBytes) * 100);
        record.progress = Math.max(1, Math.min(99, pct));
        return;
      }

      record.progress = Math.min(90, record.progress + 1);
    });

    try {
      await pipeline(response.data, writer);
    } catch (error) {
      await removeFileIfExists(filePath);
      throw new Error(`Transferencia fallida en ${candidate.server}: ${error.message}`);
    }
  }

  const stat = await fs.promises.stat(filePath);
  if (!stat.size || stat.size < 512 * 1024) {
    await removeFileIfExists(filePath);
    throw new Error(`Archivo invalido en ${candidate.server}: tamano demasiado pequeno`);
  }

  record.status = "completed";
  record.progress = 100;
  record.fileName = fileName;
  record.filePath = filePath;
  record.fileSize = String(stat.size);
  record.downloadUrl = `${record.baseUrl}/downloads/${fileName}`;
  record.completedAt = Date.now();
  record.error = null;
}

async function runDownload(record, payload) {
  record.status = "preparing";
  record.updatedAt = Date.now();

  const variant = String(record.variant || "SUB").toUpperCase() === "DUB" ? "DUB" : "SUB";
  const includeMega = String(payload?.includeMega).toLowerCase() === "true";
  const excludeServers = payload?.excludeServers;
  const preferredServer = payload?.preferredServer;

  try {
    const episodeResponse = await animeService.getEpisodeLinks(record.url, includeMega, excludeServers);
    const candidates = chooseCandidateLinks(episodeResponse.data, variant, preferredServer);

    if (candidates.length === 0) {
      throw new Error("No se encontraron enlaces para descarga real");
    }

    const errors = [];
    for (const candidate of candidates) {
      try {
        await downloadFromUrl(record, candidate);
        return;
      } catch (error) {
        errors.push(`${candidate.server}: ${error.message}`);
      }
    }

    throw new Error(`Todos los servidores fallaron. ${errors.join(" | ")}`);
  } catch (error) {
    record.status = "failed";
    record.progress = 0;
    record.error = error.message || "Error desconocido en descarga";
    record.updatedAt = Date.now();
  }
}

function createDownload(payload, baseUrl) {
  if (!payload || typeof payload.url !== "string" || !payload.url.trim()) {
    throw new ApiError(400, "Se requiere el parametro url en el body");
  }

  const downloadId = randomUUID();
  const record = {
    downloadId,
    status: "queued",
    progress: 0,
    url: payload.url.trim(),
    quality: payload.quality || "1080p",
    variant: payload.variant || "SUB",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    baseUrl,
    error: null,
    downloadUrl: null,
    fileSize: null,
    fileName: null,
    downloadedBytes: 0,
    totalBytes: null,
    sourceUrl: null,
    currentServer: null,
  };

  downloadStore.set(downloadId, record);

  void runDownload(record, payload);

  return {
    id: downloadId,
    downloadId,
    status: record.status,
    statusUrl: `/api/v1/anime/download/${downloadId}`,
    url: record.url,
    quality: record.quality,
    variant: record.variant,
  };
}

function getDownload(downloadId) {
  const record = downloadStore.get(downloadId);
  if (!record) {
    throw new ApiError(404, "Descarga no encontrada");
  }

  return {
    id: record.downloadId,
    downloadId: record.downloadId,
    status: record.status,
    progress: record.progress,
    url: record.url,
    quality: record.quality,
    variant: record.variant,
    downloadUrl: record.downloadUrl,
    fileSize: record.fileSize,
    sourceUrl: record.sourceUrl,
    currentServer: record.currentServer,
    downloadedBytes: record.downloadedBytes,
    totalBytes: record.totalBytes,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt || null,
  };
}

function createBatch(payload, baseUrl) {
  const animeUrl = (payload?.animeUrl || "").toString().trim();
  const episodes = Array.isArray(payload?.episodes) ? payload.episodes : [];

  if (!animeUrl) {
    throw new ApiError(400, "Se requiere animeUrl en el body");
  }

  if (episodes.length === 0) {
    throw new ApiError(400, "Se requiere un arreglo de episodes con al menos un elemento");
  }

  const normalizedEpisodes = episodes
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0);

  if (normalizedEpisodes.length === 0) {
    throw new ApiError(400, "episodes debe contener numeros de episodio validos");
  }

  const batchId = randomUUID();
  const entries = normalizedEpisodes.map((episodeNumber) => {
    const episodeUrl = `${animeUrl.replace(/\/$/, "")}/${episodeNumber}`;
    const created = createDownload(
      {
        url: episodeUrl,
        quality: payload.quality || "1080p",
        variant: payload.variant || "SUB",
        includeMega: payload.includeMega,
        excludeServers: payload.excludeServers,
        preferredServer: payload.preferredServer,
      },
      baseUrl
    );

    return {
      episode: episodeNumber,
      downloadId: created.downloadId,
      status: created.status,
    };
  });

  const batch = {
    batchId,
    animeUrl,
    quality: payload.quality || "1080p",
    variant: payload.variant || "SUB",
    createdAt: Date.now(),
    items: entries,
  };

  batchStore.set(batchId, batch);

  return {
    batchId,
    status: "queued",
    total: entries.length,
    statusUrl: `/api/v1/anime/batch/${batchId}`,
    items: entries,
  };
}

function getBatch(batchId) {
  const batch = batchStore.get(batchId);
  if (!batch) {
    throw new ApiError(404, "Batch no encontrado");
  }

  const items = batch.items.map((item) => {
    const snapshot = getDownload(item.downloadId);
    return {
      episode: item.episode,
      downloadId: item.downloadId,
      status: snapshot.status,
      progress: snapshot.progress,
      downloadUrl: snapshot.downloadUrl,
      error: snapshot.error,
    };
  });

  const total = items.length;
  const completed = items.filter((item) => item.status === "completed").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  return {
    batchId,
    status: completed === total ? "completed" : failed === total ? "failed" : "downloading",
    progress,
    total,
    completed,
    failed,
    items,
  };
}

module.exports = {
  createDownload,
  getDownload,
  createBatch,
  getBatch,
  getDownloadsDir,
};
