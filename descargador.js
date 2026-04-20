const prompts = require("prompts");
const cliProgress = require("cli-progress");
const animeService = require("./src/services/animeav1.service");
const downloadService = require("./src/services/download.service");

async function main() {
  const _0xfxx = "\x1b[36m\x5B\x43\x72\x65\x61\x64\x6F\x20\x79\x20\x4D\x61\x6E\x74\x65\x6E\x69\x64\x6F\x20\x70\x6F\x72\x20\x46\x78\x78\x4D\x6F\x72\x67\x61\x6E\x20\x2D\x20\x68\x74\x74\x70\x73\x3A\x2F\x2F\x67\x69\x74\x68\x75\x62\x2E\x63\x6F\x6D\x2F\x46\x78\x78\x4D\x6F\x72\x67\x61\x6E\x2F\x5D\x1b[0m";
  console.log("=== Descargador Anime1v ===");
  console.log(_0xfxx);
  
  // 1. Buscar anime o leer URL directa
  const { query } = await prompts({
    type: "text",
    name: "query",
    message: "Ingresa el nombre del anime a buscar o pega el link directo (ej. https://animeav1.com/media/dragon-ball):"
  });

  if (!query) {
    console.log("Búsqueda cancelada.");
    return;
  }

  let animeUrl = "";

  if (query.startsWith("http://") || query.startsWith("https://") || query.includes("animeav1.com")) {
    // Es enlace directo
    animeUrl = query.trim();
    if (!animeUrl.startsWith("http")) animeUrl = `https://${animeUrl}`;
    console.log(`Usando enlace directo: ${animeUrl}`);
  } else {
    // Es busqueda
    console.log(`Buscando '${query}'...`);
    const searchResult = await animeService.searchAnime(query);
    
    if (!searchResult.data.results || searchResult.data.results.length === 0) {
      console.log("No se encontraron resultados.");
      return;
    }

    const ObjectKeys = searchResult.data.results.map((anime, i) => ({
      title: `${anime.title} (${anime.type || "Anime"})`,
      value: anime.url
    }));

    const answer = await prompts({
      type: "select",
      name: "animeUrl",
      message: "Selecciona un anime:",
      choices: ObjectKeys
    });

    if (!answer.animeUrl) return;
    animeUrl = answer.animeUrl;
  }

  // 2. Obtener info del anime y episodios
  console.log("Obteniendo información del anime, por favor espera...");
  const info = await animeService.getAnimeInfo(animeUrl);
  
  if (!info.data.episodes || info.data.episodes.length === 0) {
    console.log("No se encontraron episodios para este anime.");
    return;
  }

  const episodes = info.data.episodes.sort((a, b) => a.number - b.number);
  console.log(`Se encontraron ${episodes.length} episodios.`);

  const { targetEpisodes } = await prompts({
    type: "text",
    name: "targetEpisodes",
    message: "Ingresa los episodios (ej. 1,2,3), un rango (ej. 89-101, {89:101}), o 'todos':"
  });

  if (!targetEpisodes) return;

  let episodesToDownload = [];
  const inputCmd = targetEpisodes.trim().toLowerCase();

  if (inputCmd === "todos") {
    episodesToDownload = episodes;
  } else {
    const nums = new Set();
    // Limpiamos llaves o corchetes que el usuario pueda escribir y separamos por coma
    const parts = inputCmd.replace(/[{}[\]]/g, '').split(",");
    
    for (const part of parts) {
      const rangeMatch = part.match(/(\d+)[-:](\d+)/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        const min = Math.min(start, end);
        const max = Math.max(start, end);
        for (let i = min; i <= max; i++) {
          nums.add(i);
        }
      } else {
        const num = Number(part.trim());
        if (!isNaN(num)) nums.add(num);
      }
    }
    
    episodesToDownload = episodes.filter(ep => nums.has(ep.number));
  }

  if (episodesToDownload.length === 0) {
    console.log("Ningún episodio seleccionado.");
    return;
  }

  console.log(`\nIniciando cola de descarga para ${episodesToDownload.length} episodios...\n`);

  const multibar = new cliProgress.MultiBar({
    clearOnComplete: false,
    hideCursor: true,
    format: '{episode} | {bar} | {percentage}% | {status}'
  }, cliProgress.Presets.shades_classic);

  const activeDownloads = new Map();

  for (const ep of episodesToDownload) {
    try {
      const result = downloadService.createDownload({ url: ep.url }, "http://localhost");
      
      const bar = multibar.create(100, 0, {
        episode: `Episodio ${ep.number.toString().padStart(3, "0")}`,
        status: "Iniciando..."
      });

      activeDownloads.set(result.downloadId, {
        bar,
        completed: false
      });
    } catch (err) {
      console.error(`Error al iniciar descarga del episodio ${ep.number}: ${err.message}`);
    }
  }

  // Monitoreo de progreso
  const interval = setInterval(() => {
    let allDone = true;

    for (const [downloadId, dlObj] of activeDownloads.entries()) {
      if (dlObj.completed) continue;

      try {
        const stats = downloadService.getDownload(downloadId);
        
        dlObj.bar.update(stats.progress || 0, { status: stats.status });

        if (stats.status === "completed" || stats.status === "failed") {
          dlObj.completed = true;
          if (stats.status === "failed") {
            dlObj.bar.update(stats.progress, { status: `Fallo: ${stats.error}` });
          }
        } else {
          allDone = false;
        }
      } catch (err) {
        // En caso de que se borre o no exista
        dlObj.completed = true;
      }
    }

    if (allDone) {
      clearInterval(interval);
      multibar.stop();
      console.log("\n¡Todas las descargas han finalizado!");
    }
  }, 1000);
}

main().catch(err => {
  console.error("Error inesperado:", err);
  process.exit(1);
});
