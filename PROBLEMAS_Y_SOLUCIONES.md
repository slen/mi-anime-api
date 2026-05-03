# Problemas detectados y propuestas de solución

Fecha: 2026-05-02

Resumen breve
- Se detectaron fallos en el motor de descarga al intentar bajar el episodio 1 de "Luck & Logic" desde AnimeFLV: extracción de episodios OK, pero la descarga falla porque la mayoría de servidores son páginas embed (HTML/JS) o requieren flujos especiales (1Fichier).

Problemas y diagnóstico

1) SyntaxError por expresiones regulares inválidas
- Descripción: Se introdujeron literales de regex con escapes incorrectos que provocaban "Invalid regular expression flags" al requerir `download.service.js`.
- Causa probable: cadenas con barras escapadas doblemente y uso de constructores `RegExp` con comillas mal escapadas.

2) Resolución de embeds (Streamwish / Streamtape / YourUpload / Okru / Fembed / Netu)
- Descripción: Las páginas embed devuelven HTML/JS en lugar de URLs directas (.mp4/.m3u8). Los resolvers actuales devuelven HTML o null.
- Causa probable: los players inyectan las URLs en variables JS, arrays `sources`, o las codifican/obfuscan (base64/escape). Algunos endpoints requieren navegación adicional o solicitudes AJAX.

3) 1Fichier no resuelve enlace directo
- Descripción: 1Fichier aparece en la lista pero no retorna la URL final. A veces responde con formularios o redirect por `Location` tras POST `dl=1`.
- Causa probable: falta manejo robusto de cookies, tokens de formulario y seguimiento de redirecciones con `maxRedirects: 0` y captura de `Location`.

4) Detección/selección de candidatos ineficiente
- Descripción: El algoritmo de selección puede priorizar servidores que no devuelven contenido descargable; además no existe caché de salud de cada servidor.
- Causa probable: ordenamiento estático (`SERVER_PRIORITY`) y ausencia de comprobaciones de integridad previas.

5) Manejo HLS/ffmpeg
- Descripción: HLS se descarga con `ffmpeg` y cabeceras inyectadas, pero si faltan cookies/referer correctos o hay tokens en el m3u8, falla.
- Causa probable: no se propagan cookies/autenticación entre peticiones, ni se inspeccionan los m3u8 secundarios.

6) Validación de archivos descargados y umbral rígido
- Descripción: Archivos <512KB son considerados inválidos; esto puede falsear descargas parciales o contenidos válidos pequeños.
- Causa probable: umbral estático no configurable.

7) Logging insuficiente para debugging por candidato
- Descripción: Mensajes agregados informan fallos pero no incluyen fragmento HTML, cabeceras o código de estado en varios casos.
- Causa probable: logs de errores demasiado resumidos.

Propuestas de solución (priorizadas)

A. Corto plazo (rápido, alto impacto)
- Corregir y sanitizar expresiones regulares: usar literales simples o `new RegExp()` con escape controlado; añadir tests unitarios para cada regex. (Ya se aplicó una corrección temporal.)
- Simplificar/reservar un "resolver básico" por proveedor que extraiga URLs mediante:
  - Buscar `sources`, `file`, `sources: [...]`, `file: "..."`, `.m3u8` en el HTML.
  - Decodificar cadenas (unescape, replace `\u0026`, base64) antes de matching.
- Mejorar logging por candidato: registrar (server, url, HTTP status, content-type, primer fragmento de HTML/JS de hasta N bytes) para análisis rápido.

B. Mediano plazo (implementación y endurecimiento)
- Implementar resolver 1Fichier completo:
  - Mantener cookie-jar (usar `tough-cookie` + `axios-cookiejar-support`) o mejorar `buildCookieHeader`.
  - Hacer POST `dl=1` y seguir `Location` (cuando `maxRedirects:0` devuelve redirect), soportar token CSRF si existe.
  - Retries y backoff en caso de errores transitorios.
- Mejorar resolvers de embeds:
  - Añadir parsing de player JS (buscar `sources`, `player.config`, `video_url`, `get_video`), evaluar estructuras no maliciosas con `vm` y timeout.
  - Añadir decodificadores (base64, atob polyfill, escape sequences) y heurísticas para unir partes de URL.
  - Implementar parsers específicos para Streamtape (buscar `get_video` endpoints) y Streamwish.
- Agregar propagation de cookies y Referer entre solicitudes (importante para hosts que validan Referer).

C. Largo plazo (robustez y optimizaciones)
- Añadir caching de salud de servidores: comprobaciones periódicas (p. ej. /health ping que intenta resolver una URL de ejemplo) y ajustar `SERVER_PRIORITY` dinámicamente.
- Implementar un modo debug que guarde por candidato: request/response headers, respuesta HTML completa (rotada), m3u8 manifests descargados, y pasos seguidos para la resolución.
- Añadir tests automáticos de integración (fixtures con HTMLs de ejemplo) y tests end-to-end que simulen la extracción y descarga HLS (mockear ffmpeg si es necesario).
- Exponer métricas (conteo de fallos por servidor, latencia de resolución) para priorizar mantenimientos.

Cambios sugeridos en código (localización)
- `src/services/download.service.js`:
  - Corregir todas las regex problemáticas; añadir pruebas de carga al require.
  - Mejorar `resolveEmbedUrl`, `resolveOneFichierUrl`, `resolveStreamtapeUrl`, `resolveStreamwishUrl`.
  - Añadir opción de registro detallado `DEBUG_DOWNLOAD_RESOLVER=true`.
- `src/services/animeflv.service.js`:
  - Añadir más heurísticas en `parseVideoSources` (already used) y safe-eval con límites.
- Tests/bench:
  - `tests/` añadir `resolver.unit.js` y `resolver.integration.js`.

Plan de trabajo inmediato recomendado
1. Implementar resolver robusto para `1Fichier` (cookies + POST + Location + retries).
2. Implementar heurística común: extract -> decode -> match (.m3u8/.mp4) para todos los embeds.
3. Añadir logs detallados por candidato y reintentar descarga del episodio 1.
4. Crear tests unitarios para las regex y parsing de players.

Comandos útiles para pruebas locales

```bash
# Ejecutar prueba que crea y monitorea la descarga del ep1
node tests/run_and_monitor.js

# Validar carga del módulo download.service
node -e "require('./src/services/download.service'); console.log('download.service ok');"
```

Notas finales
- Evitar la evaluación sin límites de JS proveniente de páginas externas: usar `vm.runInNewContext` con timeout y contexto vacío.
- Registrar cualquier cambio mayor en una rama y crear PR para pruebas antes de mezclar en producción.

---
Generado por el asistente para ayudar a priorizar correcciones y acelerar la validación de descargas.
