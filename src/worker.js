// YAiContenido en Cloudflare Workers: sirve la web (solo con sesión iniciada),
// guarda usuarios y datos del equipo en D1 y hace de proxy seguro hacia la
// YouTube Data API v3 y la Claude API. Las claves son secretos del Worker.
import Anthropic from '@anthropic-ai/sdk';

const YT = 'https://www.googleapis.com/youtube/v3';
const COOKIE = 'ef_sesion';
const SESION_SEG = 30 * 86400;
const VENTANA_MS = 15 * 60 * 1000, MAX_FALLOS = 10;
const PBKDF2_ITER = 100000; // máximo que admite Web Crypto en Workers
const PUBLICOS = new Set(['/login.html', '/plataforma.css', '/style.css']);

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const enviar = (status, data, headers = {}) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
});
async function leerJson(req) {
    const txt = await req.text();
    if (txt.length > 1e6) throw new HttpError(413, 'Petición demasiado grande');
    try { return JSON.parse(txt || '{}'); } catch { throw new HttpError(400, 'JSON inválido'); }
}

// ---------- Criptografía (Web Crypto) ----------
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const deHex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

async function pbkdf2(pass, sal, iter) {
    const clave = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: iter }, clave, 256));
}
async function hashear(pass) {
    const sal = crypto.getRandomValues(new Uint8Array(16));
    return `pbkdf2$${PBKDF2_ITER}$${hex(sal)}$${await pbkdf2(pass, sal, PBKDF2_ITER)}`;
}
async function verificar(pass, guardado) {
    const [, iter, sal, h] = guardado.split('$');
    const calc = await pbkdf2(pass, deHex(sal), +iter);
    // Comparación en tiempo constante
    let dif = calc.length ^ h.length;
    for (let i = 0; i < calc.length; i++) dif |= calc.charCodeAt(i) ^ h.charCodeAt(i % h.length);
    return dif === 0;
}
const HASH_FICTICIO = `pbkdf2$${PBKDF2_ITER}$${'0'.repeat(32)}$${'0'.repeat(64)}`;

const normaliza = (n) => String(n || '').trim().toLowerCase();
function validarPassword(pass) {
    return typeof pass === 'string' && pass.length >= 8 ? null : 'La contraseña debe tener al menos 8 caracteres';
}

// ---------- Usuarios y sesiones ----------
// Primera puesta en marcha: crea los usuarios de ACCESS_USERS si no hay ninguno (el primero es admin).
async function sembrarUsuarios(env) {
    const { n } = await env.DB.prepare('SELECT count(*) AS n FROM usuarios').first();
    if (n > 0) return;
    const lista = (env.ACCESS_USERS || '').split(',').map((p) => p.trim()).filter(Boolean)
        .map((p) => { const i = p.indexOf(':'); return [normaliza(p.slice(0, i)), p.slice(i + 1)]; })
        .filter(([u, p]) => u && p);
    for (const [i, [nombre, pass]] of lista.entries()) {
        await env.DB.prepare('INSERT OR IGNORE INTO usuarios (nombre, hash, admin) VALUES (?, ?, ?)')
            .bind(nombre, await hashear(pass), i === 0 ? 1 : 0).run();
    }
}

const leerCookie = (req) => (req.headers.get('Cookie') || '').split(';').map((c) => c.trim().split('='))
    .find(([k]) => k === COOKIE)?.[1];
const cookie = (url, valor, maxAge) =>
    `${COOKIE}=${valor}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${url.protocol === 'https:' ? '; Secure' : ''}`;

async function usuarioDeSesion(env, token) {
    if (!token) return null;
    const u = await env.DB.prepare(`SELECT u.nombre, u.admin FROM sesiones s JOIN usuarios u ON u.nombre = s.usuario
        WHERE s.token_hash = ? AND s.expira > ?`).bind(await sha256(token), Date.now()).first();
    return u && { nombre: u.nombre, admin: !!u.admin };
}

async function login(req, env, url) {
    const ip = req.headers.get('CF-Connecting-IP') || 'local';
    const f = await env.DB.prepare('SELECT n, desde FROM intentos WHERE ip = ?').bind(ip).first();
    const vigente = f && Date.now() - f.desde < VENTANA_MS;
    if (vigente && f.n >= MAX_FALLOS) throw new HttpError(429, 'Demasiados intentos. Espera 15 minutos.');

    const { nombre, password } = await leerJson(req);
    await sembrarUsuarios(env);
    const u = await env.DB.prepare('SELECT nombre, hash FROM usuarios WHERE nombre = ?').bind(normaliza(nombre)).first();
    // Se verifica siempre (con hash ficticio si no existe) para no revelar qué usuarios hay.
    const ok = await verificar(String(password || ''), u?.hash || HASH_FICTICIO);
    if (!u || !ok) {
        await env.DB.prepare(`INSERT INTO intentos (ip, n, desde) VALUES (?1, 1, ?2)
            ON CONFLICT (ip) DO UPDATE SET n = CASE WHEN ?2 - desde < ?3 THEN n + 1 ELSE 1 END,
                                           desde = CASE WHEN ?2 - desde < ?3 THEN desde ELSE ?2 END`)
            .bind(ip, Date.now(), VENTANA_MS).run();
        throw new HttpError(401, 'Usuario o contraseña incorrectos');
    }
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.batch([
        env.DB.prepare('INSERT INTO sesiones (token_hash, usuario, expira) VALUES (?, ?, ?)')
            .bind(await sha256(token), u.nombre, Date.now() + SESION_SEG * 1000),
        env.DB.prepare('DELETE FROM sesiones WHERE expira < ?').bind(Date.now()),
        env.DB.prepare('DELETE FROM intentos WHERE ip = ? OR desde < ?').bind(ip, Date.now() - VENTANA_MS),
    ]);
    return enviar(200, { ok: true }, { 'Set-Cookie': cookie(url, token, SESION_SEG) });
}

// Cambia la contraseña y cierra las sesiones de ese usuario (salvo la actual, si se indica).
async function cambiarPassword(env, nombre, pass, tokenActual) {
    const err = validarPassword(pass);
    if (err) throw new HttpError(400, err);
    const r = await env.DB.prepare('UPDATE usuarios SET hash = ? WHERE nombre = ?').bind(await hashear(pass), normaliza(nombre)).run();
    if (!r.meta.changes) throw new HttpError(404, 'Usuario no encontrado');
    await env.DB.prepare('DELETE FROM sesiones WHERE usuario = ? AND token_hash <> ?')
        .bind(normaliza(nombre), tokenActual ? await sha256(tokenActual) : '').run();
}

// ---------- YouTube ----------
async function yt(env, endpoint, params) {
    if (!env.YOUTUBE_API_KEY) throw new HttpError(503, 'Falta la clave de YouTube (Configuración)');
    const url = new URL(`${YT}/${endpoint}`);
    for (const [k, v] of Object.entries({ ...params, key: env.YOUTUBE_API_KEY })) url.searchParams.set(k, v);
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new HttpError(502, `YouTube: ${data.error?.message || res.status}`);
    return data;
}

// Acepta @handle, URL de canal (/@handle, /channel/UC…) o ID UC…
function parseCanal(q) {
    q = q.trim();
    const id = q.match(/(UC[\w-]{22})/);
    if (id) return { id: id[1] };
    const handle = q.match(/@([\w.-]+)/);
    if (handle) return { forHandle: '@' + handle[1] };
    return { forHandle: '@' + q.replace(/^.*\//, '') };
}

// PT1H2M3S → minutos
function minutos(iso) {
    const m = iso?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    return m ? (+(m[1] || 0)) * 60 + (+(m[2] || 0)) + (+(m[3] || 0)) / 60 : null;
}

async function canal(env, q) {
    const { items } = await yt(env, 'channels', { part: 'snippet,contentDetails,statistics', ...parseCanal(q) });
    if (!items?.length) throw new HttpError(404, 'Canal no encontrado');
    const c = items[0];

    const ids = [];
    let pageToken = '';
    do { // hasta 100 vídeos recientes (2 páginas)
        const pl = await yt(env, 'playlistItems', {
            part: 'contentDetails', maxResults: 50, playlistId: c.contentDetails.relatedPlaylists.uploads,
            ...(pageToken && { pageToken }),
        });
        ids.push(...pl.items.map((i) => i.contentDetails.videoId));
        pageToken = pl.nextPageToken;
    } while (pageToken && ids.length < 100);

    const videos = [];
    for (let i = 0; i < ids.length; i += 50) {
        const v = await yt(env, 'videos', { part: 'snippet,statistics,contentDetails', id: ids.slice(i, i + 50).join(',') });
        videos.push(...v.items);
    }
    const ahora = Date.now();
    const dias = (fecha) => Math.round((ahora - new Date(fecha)) / 86400000);
    return {
        titulo: c.snippet.title,
        suscriptores: +c.statistics.subscriberCount || null,
        diasCanal: dias(c.snippet.publishedAt),
        videos: videos.map((v) => ({
            id: v.id,
            titulo: v.snippet.title,
            vistas: +v.statistics.viewCount || 0,
            dias: dias(v.snippet.publishedAt),
            min: Math.round(minutos(v.contentDetails.duration) * 10) / 10,
        })),
    };
}

// ---------- Claude ----------
const SISTEMA = `Eres el asistente de estrategia y guion de un estudio de canales de YouTube faceless en español.
Priorizas contenido original que aporte valor real a la audiencia: investigación propia, un ángulo diferencial y datos verificables.
No inventes cifras ni fuentes; si un dato es incierto, márcalo como [VERIFICAR]. Responde en español.
No hagas preguntas ni pidas datos antes de responder: entrega siempre el resultado completo. Si falta información,
trabaja con supuestos razonables y menciónalos brevemente al final.
Si tienes la herramienta de búsqueda web, úsala para tendencias actuales y para verificar datos, y cita las fuentes.`;

async function claude(env, prompt, web, formato) {
    if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, 'Falta la clave de Claude (Configuración)');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new HttpError(400, 'Prompt vacío');
    const anthropic = clienteClaude(env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH, env.ANTHROPIC_WORKSPACE_ID);
    const hoy = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' });
    const messages = [{ role: 'user', content: `(Fecha de hoy: ${hoy})\n\n${prompt.slice(0, 200000)}` }];
    let msg;
    // Con búsqueda web, el servidor de Claude puede pausar el turno (pause_turn); se reanuda reenviando lo recibido.
    for (let vuelta = 0; vuelta < 4; vuelta++) {
        msg = await anthropic.beta.messages.stream({
            model: env.CLAUDE_MODEL || 'claude-opus-5-5',
            max_tokens: 64000,
            thinking: { type: 'adaptive' },
            output_config: { effort: 'medium', ...(formato && { format: { type: 'json_schema', schema: formato } }) },
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            system: SISTEMA,
            ...(web && { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }] }),
            messages,
        }).finalMessage();
        if (msg.stop_reason !== 'pause_turn') break;
        messages.push({ role: 'assistant', content: msg.content });
    }
    if (msg.stop_reason === 'refusal') throw new HttpError(422, 'Claude ha rechazado la petición. Reformula el prompt.');
    const texto = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { texto, truncado: msg.stop_reason === 'max_tokens', uso: msg.usage };
}

// ---------- Storyboard y miniaturas ----------
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const ESQUEMA_STORYBOARD = obj({
    estilo_visual: str('Estilo visual común a todas las imágenes, en inglés, para añadir a cada prompt'),
    escenas: {
        type: 'array',
        items: obj({
            n: { type: 'integer' },
            narracion: str('Fragmento literal del guion que cubre la escena'),
            duracion_s: { type: 'integer', description: 'Duración aproximada en segundos' },
            prompt_imagen: str('Prompt de imagen en inglés, concreto y visual, sin texto dentro de la imagen'),
            busqueda_archivo: str('2-4 términos de búsqueda para vídeo de stock o arte de dominio público'),
            camara: str('Movimiento para el editor: zoom lento, paneo, estático, etc.'),
        }),
    },
    miniaturas: {
        type: 'array',
        items: obj({
            texto: str('Texto de la miniatura, máximo 4 palabras, en español'),
            composicion: str('Qué se ve y dónde va cada elemento, en español'),
            prompt_imagen: str('Prompt en inglés para el fondo/imagen principal, sin texto'),
        }),
    },
});

function promptStoryboard({ titulo, guion, estilo, canal, short }) {
    return `Convierte este guion de YouTube en un storyboard para el editor y propone miniaturas.

Título: ${titulo || '(sin título)'}
${canal ? `Canal: ${canal}\n` : ''}${estilo ? `Estilo visual del canal (respétalo en todos los prompts): ${estilo}\n` : ''}
Reglas:
${short
    ? `- Es un YouTube Short vertical (9:16) de ≤ 60 s: divide TODO el guion en escenas de 2–4 segundos (≈ 5–10 palabras), unas 15–25 escenas; encuadres verticales y la primera escena muy llamativa.`
    : `- Divide TODO el guion, en orden y sin saltarte partes, en escenas de 6–12 segundos (≈ 15–30 palabras de narración cada una).
  (Los vídeos del canal duran como máximo 10 minutos: unas 50–90 escenas.)`}
- "narracion" es el texto literal del guion de esa escena (sin las marcas [VISUAL]; úsalas como pista visual).
- "prompt_imagen" en inglés: sujeto, acción, entorno, luz y encuadre concretos; coherente con el estilo visual; nunca texto ni letras en la imagen; nada de personas reales identificables ni logotipos.
- "busqueda_archivo": términos para Pexels/Pixabay o Wikimedia Commons (arte de dominio público si encaja).
- Propón 4 miniaturas distintas: texto corto e impactante (≤ 4 palabras) que complemente al título sin repetirlo${short ? ' (portada vertical del Short)' : ''}.

Guion:
${guion}`;
}

// ---------- Fliki (vídeo) ----------
// Límite de Fliki: 10 peticiones cada 10 minutos por clave (cuentan todas, también el estado),
// por eso el estado de cada idea se consulta como mucho una vez por minuto.
let FLIKI = 'https://api.fliki.ai/v1'; // FLIKI_API_URL permite apuntar a un servidor de pruebas
const FLIKI_MAX_CHARS = 10000;
const FLIKI_ESTILOS = ['biblical', 'cinematic', 'realistic', 'illustration', 'fantasyArt', 'waterColor', 'filmNoir', 'anime',
    'comicBook', 'threeDimensionModel', 'lineArt', 'modelingCompound', 'whimsical', 'tinyWorld', 'technicalIllustration'];
const FLIKI_ANIMACIONES = ['Mix:Subtle Flow', 'Mix', 'Mix:Dramatic', 'None'];
const FLIKI_MODELOS_VIDEO = ['runware-seedance-pro-fast', 'runware-p-video', 'runware-pixverse-v5-fast', 'runware-ltx-2-fast', 'runware-kling-2.5-turbo'];

async function fliki(clave, metodo, ruta, cuerpo) {
    if (!clave) throw new HttpError(503, 'Falta la clave de Fliki (Configuración)');
    const res = await fetch(FLIKI + ruta, {
        method: metodo,
        headers: { Authorization: `Bearer ${clave}`, 'Content-Type': 'application/json' },
        ...(cuerpo && { body: JSON.stringify(cuerpo) }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw new HttpError(400, 'Fliki rechaza la clave (no válida o sin acceso a la API: requiere plan Premium).');
    if (res.status === 429) throw new HttpError(429, 'Límite de Fliki alcanzado (10 peticiones cada 10 minutos). Espera unos minutos.');
    if (!res.ok || data.success === false) {
        const msg = data.message || data.error?.message || data.error || `HTTP ${res.status}`;
        throw new HttpError(502, `Fliki: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    }
    return data.data ?? data;
}

// Voces en español (se guardan en caché un día para no gastar el cupo de peticiones).
async function vocesFliki(env, cfg, refrescar) {
    const cache = await env.DB.prepare("SELECT valor, actualizado_en FROM configuracion WHERE clave = 'FLIKI_VOICES_CACHE'").first();
    if (cache && !refrescar && Date.now() - new Date(cache.actualizado_en) < 86400000) return JSON.parse(cache.valor);
    const idiomas = await fliki(cfg.FLIKI_API_KEY, 'GET', '/languages');
    const lista = Array.isArray(idiomas) ? idiomas : idiomas.languages || [];
    // Respuesta documentada: [{ _id, name: "Spanish", slug: "es" }]
    const es = lista.find((l) => l.slug === 'es') || lista.find((l) => /^(spanish|español)/i.test(l.name || ''));
    if (!es) throw new HttpError(502, 'Fliki: no se encontró el idioma español en /languages');
    const mapa = (v, dialecto = '') => ({
        id: v._id, nombre: v.name, genero: v.gender, ultra: v.isUltra === true || v.isUltra === 'true',
        muestra: v.audioSample || null, dialecto,
    });
    const lista2 = (r) => (Array.isArray(r) ? r : r.voices || []);
    // Dialectos documentados: [{ _id, name: "Spanish (Mexico)", slug: "es-mx" }]
    const dialectos = lista2(await fliki(cfg.FLIKI_API_KEY, 'GET', '/dialects')).filter((d) => /^es(-|$)/i.test(d.slug || ''));
    let voces = lista2(await fliki(cfg.FLIKI_API_KEY, 'GET', `/voices?languageId=${encodeURIComponent(es._id)}`)).map((v) => mapa(v));
    if (!voces.length) {
        // Si hace falta el dialecto: España, México y EE. UU. primero (máx. 3 peticiones por el límite de Fliki).
        const orden = ['es-es', 'es-mx', 'es-us'];
        const elegidos = [...dialectos].sort((x, y) => (orden.indexOf(x.slug) + 1 || 9) - (orden.indexOf(y.slug) + 1 || 9)).slice(0, 3);
        for (const d of elegidos) {
            const r = await fliki(cfg.FLIKI_API_KEY, 'GET', `/voices?languageId=${encodeURIComponent(es._id)}&dialectId=${encodeURIComponent(d._id)}`);
            voces.push(...lista2(r).map((v) => mapa(v, d.name)));
        }
    }
    if (!voces.length) throw new HttpError(502, 'Fliki no devolvió voces en español');
    await env.DB.prepare(`INSERT INTO configuracion (clave, valor) VALUES ('FLIKI_VOICES_CACHE', ?1)
        ON CONFLICT (clave) DO UPDATE SET valor = ?1, actualizado_en = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).bind(JSON.stringify(voces)).run();
    return voces;
}

// Crea uno o varios vídeos (uno por parte) en una sola petición.
async function crearVideoFliki(env, cfg, b, u) {
    if (!cfg.FLIKI_VOICE_ID) throw new HttpError(400, 'Elige una voz de Fliki en Configuración');
    const partes = (Array.isArray(b.partes) ? b.partes : []).map((t) => String(t).trim()).filter(Boolean);
    if (!partes.length) throw new HttpError(400, 'No hay guion para el vídeo');
    if (partes.length > 1) throw new HttpError(400, 'Un vídeo por petición (máximo 10 minutos)');
    const largo = partes.find((t) => t.length > FLIKI_MAX_CHARS);
    if (largo) throw new HttpError(400, `Cada parte admite como máximo ${FLIKI_MAX_CHARS} caracteres en la API de Fliki`);
    const estilo = FLIKI_ESTILOS.includes(b.artStyle) ? b.artStyle : 'biblical';
    const titulo = String(b.titulo || 'YAiContenido').slice(0, 80);
    const payload = partes.map((content, i) => ({
        workflowType: 'script',
        workflowFormat: 'video',
        content,
        voiceId: cfg.FLIKI_VOICE_ID,
        aspectRatio: ['16:9', '9:16', '1:1'].includes(b.aspectRatio) ? b.aspectRatio : '16:9',
        resolution: '1080p',
        visuals: 'ai',
        artStyle: estilo,
        // Los clips de vídeo IA solo se generan con un aiVideoModel (plan de pago); sin él, solo imágenes animadas.
        ...(FLIKI_MODELOS_VIDEO.includes(b.modeloVideo) && +b.clipPct > 0 && {
            aiVideoModel: b.modeloVideo,
            aiVideoClipPercentage: Math.max(1, Math.min(100, Math.round(+b.clipPct))),
        }),
        generateSfx: !!b.efectos,
        addPauses: b.pausas !== false,
        imageAnimationPreset: FLIKI_ANIMACIONES.includes(b.animacion) ? b.animacion : 'Mix:Subtle Flow',
        bgMusicVolume: Math.max(0, Math.min(100, Math.round(b.musica ?? 20))),
        highlightSubtitles: !!b.subtitulos,
        sceneBreakdown: b.lineas ? 'lineBreak' : 'auto',
        fileName: partes.length > 1 ? `${titulo} — parte ${i + 1}` : titulo,
        ...(cfg.FLIKI_BRAND_ID && { brandId: cfg.FLIKI_BRAND_ID }),
        shouldExport: true,
    }));
    const r = await fliki(cfg.FLIKI_API_KEY, 'POST', '/generate/video', { payload, file: 'YAiContenido' });
    const ids = r.filesCreated || [];
    if (!ids.length) throw new HttpError(502, 'Fliki no devolvió ningún archivo');
    const estado = {
        creado: new Date().toISOString(), por: u.nombre, estilo, consultado: 0,
        archivos: ids.map((id, i) => ({ id, parte: i + 1, estado: 'queued', progreso: 0, descarga: null })),
    };
    if (b.ideaId) await env.DB.prepare('UPDATE ideas SET fliki = ? WHERE id = ?').bind(JSON.stringify(estado), +b.ideaId).run();
    return estado;
}

const FLIKI_FINAL = new Set(['success', 'error', 'canceled']);
async function estadoFliki(env, cfg, ideaId) {
    const fila = await env.DB.prepare('SELECT fliki FROM ideas WHERE id = ?').bind(ideaId).first();
    if (!fila?.fliki) throw new HttpError(404, 'Esta idea no tiene vídeo en Fliki');
    const est = JSON.parse(fila.fliki);
    const pendientes = est.archivos.filter((a) => !FLIKI_FINAL.has(a.estado));
    if (!pendientes.length || Date.now() - (est.consultado || 0) < 60000) return est; // máx. 1 consulta/min
    for (const a of pendientes) {
        const d = await fliki(cfg.FLIKI_API_KEY, 'GET', `/generate/status?fileId=${encodeURIComponent(a.id)}`);
        a.estado = d.status || a.estado;
        a.progreso = typeof d.progress === 'number' ? d.progress : a.progreso;
        a.descarga = d.download || a.descarga;
    }
    est.consultado = Date.now();
    await env.DB.prepare('UPDATE ideas SET fliki = ? WHERE id = ?').bind(JSON.stringify(est), ideaId).run();
    return est;
}

// ---------- Paquete para Fliki (uso manual, sin API) ----------
const ESQUEMA_PAQUETE = obj({
    personajes: {
        type: 'array',
        description: 'Personas o grupos nombrados en la narración que Fliki detectará como personajes',
        items: obj({
            nombre: str('Nombre tal como lo detectaría Fliki, en inglés (p. ej. "Pontius Pilate", "Women visiting the tomb")'),
            aparece: { type: 'boolean', description: 'true si actúa en alguna escena; false si solo se le menciona o cita' },
            descripcion: str('Descripción visual en inglés para pegar en Fliki'),
        }),
    },
    guias_visuales: { type: 'array', items: { type: 'string' }, description: '3-5 etiquetas cortas en español para «Añadir guía visual»' },
    titulos: { type: 'array', items: { type: 'string' }, description: '3 títulos de YouTube, máx. 70 caracteres, la frase que se busca al principio' },
    descripcion_youtube: str('Descripción para YouTube en español: 2-3 frases, referencias citadas y 3 hashtags'),
    etiquetas: { type: 'array', items: { type: 'string' }, description: '10-15 etiquetas de YouTube en español' },
});

function promptPaquete({ titulo, guion, canal, personajesCanal, estilo, short }) {
    return `Prepara el material para producir este guion en Fliki (editor web) y publicarlo en YouTube.

Título de trabajo: ${titulo || '(sin título)'}
${canal ? `Canal: ${canal}\n` : ''}${estilo ? `Estilo visual del canal: ${estilo}\n` : ''}Formato: ${short ? 'YouTube Short vertical (≤ 60 s)' : 'vídeo largo horizontal (≤ 10 min)'}
${personajesCanal ? `\nPersonajes ya definidos en el canal (REUTILIZA estas descripciones tal cual si el personaje aparece; así se mantiene la coherencia entre vídeos):\n${personajesCanal}\n` : ''}
Reglas para los personajes (Fliki crea uno por cada persona o grupo nombrado en el guion y no deja borrarlos):
- Incluye a TODAS las personas o grupos nombrados, también los que solo se citan (autores, emperadores, evangelistas).
- Los que solo se mencionan o citan: represéntalos de forma que encaje con la cita y no protagonicen escenas (busto de mármol, escriba escribiendo visto de espaldas o de perfil, manuscrito…). Marca "aparece": false.
- Grupos (mujeres, soldados, consejo…): descríbelos como grupo, con edades variadas.
- Rigor histórico: ropa, armas y peinados de la época y el lugar; varones romanos del s. I afeitados; soldados auxiliares en Judea con cota de malla (lorica hamata); franjas púrpura en la túnica según el rango.
- Nada de "visible pores" ni detalles que fuercen primeros planos de piel; expresión y luz incluidas.
- Personajes sagrados (Jesús, María…): representación digna y respetuosa, sin halo salvo que el estilo lo pida; escenas de violencia o crucifixión solo como siluetas lejanas, sin sangre ni heridas.
- Edades coherentes con el momento en que aparecen.

Guion:
${guion}`;
}

// ---------- Automatización: series, Shorts derivados y capítulos ----------
const ESQUEMA_SERIE = obj({
    nombre: str('Nombre corto de la serie (p. ej. «Expediente Resurrección»)'),
    episodios: {
        type: 'array',
        items: obj({
            titulo: str('Título de YouTube (máx. 70 caracteres), con la frase que se busca al principio'),
            angulo: str('Contenido del episodio: qué cubre, en qué orden, qué fuentes usa y con qué gancho termina hacia el siguiente'),
        }),
    },
    shorts: {
        type: 'array',
        items: obj({
            episodio: { type: 'integer', description: 'Número (1..N) del episodio al que lleva este Short' },
            titulo: str('Título del Short (máx. 70 caracteres)'),
            angulo: str('Una sola idea del episodio, con su gancho de 2 segundos'),
        }),
    },
});
function promptSerie({ tema, episodios, shortsPorEpisodio, canal, tradicion, ganadoras }) {
    return `Planifica una serie de YouTube sobre: "${tema}".
${canal ? `Canal: ${canal}\n` : ''}${tradicion ? `Tradición bíblica y público (obligatorio): ${tradicion}\n` : ''}${ganadoras ? `Lo que ya funciona en el canal (úsalo como patrón):\n${ganadoras}\n` : ''}
- ${episodios} episodios largos de 8–10 minutos que se sigan en orden; cada uno cierra con un gancho al siguiente.
- ${shortsPorEpisodio} Shorts por episodio (≤ 60 s), cada uno con una sola idea del episodio y que lleve a él.
- Títulos pensados para búsqueda: la frase que la gente escribe, al principio.
- Rigor: fuentes verificables; separa lo que la historia puede comprobar de lo que es fe.`;
}

const ESQUEMA_SHORTS = obj({
    shorts: {
        type: 'array',
        items: obj({
            titulo: str('Título del Short (máx. 70 caracteres), con la frase que se busca al principio'),
            guion: str('Guion de 90–130 palabras con marcas [VISUAL: …]: gancho en 2 s, una sola idea, cita exacta si hay texto bíblico, cierre que remita al vídeo largo'),
        }),
    },
});
function promptShorts({ titulo, guion, n, tradicion }) {
    return `Del siguiente guion de un vídeo largo ("${titulo || 'vídeo'}"), extrae ${n} YouTube Shorts verticales de 35–55 segundos.
${tradicion ? `Tradición bíblica y público (obligatorio): ${tradicion}\n` : ''}Cada Short: una sola idea fuerte del vídeo, gancho en los 2 primeros segundos (sin saludos), frases cortas,
referencia exacta si cita la Biblia o una fuente, y cierre que remita al vídeo largo («El expediente completo, en el vídeo relacionado»).
Prohibido "No es X, es Y", cadenas de negaciones y muletillas. No pidas suscripciones ni likes.

Guion del vídeo largo:
${guion}`;
}

const ESQUEMA_CAPITULOS = obj({
    capitulos: { type: 'array', items: obj({ segundo: { type: 'integer' }, titulo: str('Título del capítulo, máx. 60 caracteres, con palabras que la gente buscaría') }) },
});
function promptCapitulos({ transcripcion, duracion }) {
    return `Crea los capítulos de YouTube para este vídeo de ${Math.round(duracion)} segundos a partir de su transcripción con tiempos.
- Entre 6 y 15 capítulos; el primero en el segundo 0; cada uno de al menos 15 segundos; usa el segundo donde empieza cada tema.
- Títulos claros y buscables (personajes, fuentes, preguntas), en español.

Transcripción ([segundo] texto):
${transcripcion}`;
}

async function claudeJson(cfg, prompt, esquema) {
    const r = await claude(cfg, prompt, false, esquema);
    if (r.truncado) throw new HttpError(422, 'La respuesta de Claude se cortó; prueba con menos contenido.');
    try { return JSON.parse(r.texto); } catch { throw new HttpError(502, 'Claude no devolvió un resultado válido; inténtalo de nuevo.'); }
}

// ---------- YouTube: conexión OAuth, subida y programación ----------
// Permisos: subir vídeos y gestionar miniaturas, subtítulos y listas de reproducción.
const YT_SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl';
const oauthRedirect = (url) => `${url.origin}/api/youtube/oauth/callback`;
const guardarAjuste = (DB, clave, valor, usuario) => DB.prepare(`INSERT INTO configuracion (clave, valor, actualizado_por) VALUES (?1, ?2, ?3)
    ON CONFLICT (clave) DO UPDATE SET valor = ?2, actualizado_por = ?3, actualizado_en = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).bind(clave, valor, usuario).run();
const leerAjuste = async (DB, clave) => (await DB.prepare('SELECT valor FROM configuracion WHERE clave = ?').bind(clave).first())?.valor || '';

async function googleToken(cuerpo) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(cuerpo),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(400, `Google: ${d.error_description || d.error || res.status}`);
    return d;
}

let tokenYT = null; // { token, caduca } en memoria del Worker
async function accesoYT(env, cfg) {
    if (tokenYT && tokenYT.caduca > Date.now() + 60000) return tokenYT.token;
    const refresh = await leerAjuste(env.DB, 'YT_REFRESH_TOKEN');
    if (!refresh) throw new HttpError(400, 'Conecta primero tu canal de YouTube (Configuración)');
    try {
        const d = await googleToken({ client_id: cfg.GOOGLE_CLIENT_ID, client_secret: cfg.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: 'refresh_token' });
        tokenYT = { token: d.access_token, caduca: Date.now() + (d.expires_in || 3600) * 1000 };
        return tokenYT.token;
    } catch (e) {
        throw new HttpError(400, `La conexión con YouTube ha caducado o se revocó: vuelve a conectar el canal en Configuración. (${e.message})`);
    }
}

async function ytAuth(token, metodo, ruta, { query = {}, json: cuerpo, body, tipo } = {}) {
    const url = new URL(ruta.startsWith('http') ? ruta : `${YT}/${ruta}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, {
        method: metodo,
        headers: { Authorization: `Bearer ${token}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : tipo ? { 'Content-Type': tipo } : {}) },
        body: cuerpo ? JSON.stringify(cuerpo) : body,
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(502, `YouTube: ${d.error?.message || res.status}`);
    return d;
}

// 'AAAA-MM-DD HH:MM' en hora de España → ISO en UTC (tiene en cuenta el horario de verano)
function madridAUTC(f) {
    const m = String(f || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!m) return null;
    const objetivo = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
    const enMadrid = (t) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
        return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute);
    };
    let t = objetivo;
    for (let i = 0; i < 3; i++) t -= enMadrid(t) - objetivo;
    return new Date(t).toISOString();
}

// Metadatos del vídeo a partir de la idea y su paquete.
function metadatosYT(idea, b) {
    const pq = idea.paquete ? JSON.parse(idea.paquete) : {};
    const titulo = String(b.titulo || pq.titulos?.[0] || idea.titulo).slice(0, 100);
    const descripcion = [pq.capitulos, b.descripcion ?? pq.descripcion_youtube].filter(Boolean).join('\n\n').slice(0, 5000);
    let etiquetas = [], largo = 0;
    for (const e of pq.etiquetas || []) { if (largo + e.length + 1 > 480) break; etiquetas.push(e); largo += e.length + 1; }
    const publishAt = b.programar ? madridAUTC(b.publicar_en || idea.publicar_en) : null;
    if (b.programar && !publishAt) throw new HttpError(400, 'Fecha de publicación no válida');
    if (publishAt && new Date(publishAt) < new Date(Date.now() + 15 * 60000)) throw new HttpError(400, 'La fecha de publicación debe ser al menos 15 minutos en el futuro');
    return {
        snippet: { title: titulo, description: descripcion, tags: etiquetas, categoryId: String(b.categoria || '27'),
            defaultLanguage: 'es-ES', defaultAudioLanguage: 'es-ES' },
        status: {
            privacyStatus: publishAt ? 'private' : (['public', 'unlisted', 'private'].includes(b.privacidad) ? b.privacidad : 'private'),
            ...(publishAt && { publishAt }),
            selfDeclaredMadeForKids: false, embeddable: true, license: 'youtube',
            containsSyntheticMedia: b.sintetico !== false,
        },
    };
}

async function listaReproduccion(token, nombre) {
    let pageToken = '';
    do {
        const r = await ytAuth(token, 'GET', 'playlists', { query: { part: 'snippet', mine: 'true', maxResults: '50', ...(pageToken && { pageToken }) } });
        const l = r.items?.find((x) => x.snippet.title.trim().toLowerCase() === nombre.trim().toLowerCase());
        if (l) return l.id;
        pageToken = r.nextPageToken;
    } while (pageToken);
    const nueva = await ytAuth(token, 'POST', 'playlists', { query: { part: 'snippet,status' },
        json: { snippet: { title: nombre, defaultLanguage: 'es-ES' }, status: { privacyStatus: 'public' } } });
    return nueva.id;
}

// ---------- Configuración (claves editables desde la web) ----------
// Los valores guardados en D1 desde la pestaña Configuración tienen prioridad sobre
// los secretos del Worker. Las claves nunca se devuelven al navegador, solo enmascaradas.
const AJUSTES = ['ANTHROPIC_API_KEY', 'YOUTUBE_API_KEY', 'CLAUDE_MODEL', 'FLIKI_API_KEY', 'FLIKI_VOICE_ID', 'FLIKI_VOICE_NAME', 'FLIKI_BRAND_ID',
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
const SECRETOS = new Set(['ANTHROPIC_API_KEY', 'YOUTUBE_API_KEY', 'FLIKI_API_KEY', 'GOOGLE_CLIENT_SECRET']);
const MODELOS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

// Las claves de la consola de Claude se envían como x-api-key; otros tipos de credencial
// (p. ej. tokens de usuario) como Authorization: Bearer. Se guarda el modo que funcionó.
// Las claves de usuario (no ligadas a un espacio de trabajo) necesitan además la cabecera
// anthropic-workspace-id con el ID del espacio de trabajo (wrkspc_…).
let CLAUDE_BASE_URL; // ANTHROPIC_BASE_URL permite apuntar a un servidor de pruebas
function clienteClaude(clave, modo, workspace, opciones = {}) {
    const auth = modo === 'authToken' ? { authToken: clave, apiKey: null } : { apiKey: clave };
    const defaultHeaders = workspace ? { 'anthropic-workspace-id': workspace } : undefined;
    return new Anthropic({ ...auth, defaultHeaders, ...(CLAUDE_BASE_URL && { baseURL: CLAUDE_BASE_URL }), ...opciones });
}
const pideWorkspace = (e) => e instanceof Anthropic.BadRequestError && /anthropic-workspace-id/.test(e.message);

async function configuracion(env) {
    const { results } = await env.DB.prepare('SELECT clave, valor, actualizado_por, actualizado_en FROM configuracion').all();
    const db = Object.fromEntries(results.map((r) => [r.clave, r]));
    const cfg = {}, meta = {};
    for (const k of AJUSTES) {
        cfg[k] = db[k]?.valor || env[k] || (k === 'CLAUDE_MODEL' ? MODELOS[0] : '');
        meta[k] = { origen: db[k] ? 'web' : env[k] ? 'cloudflare' : null, por: db[k]?.actualizado_por, en: db[k]?.actualizado_en };
    }
    cfg.ANTHROPIC_AUTH = db.ANTHROPIC_AUTH?.valor || 'apiKey';
    cfg.ANTHROPIC_WORKSPACE_ID = db.ANTHROPIC_WORKSPACE_ID?.valor || env.ANTHROPIC_WORKSPACE_ID || '';
    meta.ANTHROPIC_WORKSPACE_ID = cfg.ANTHROPIC_WORKSPACE_ID;
    return { cfg, meta };
}
const enmascarar = (v) => (v ? `${v.slice(0, 7)}…${v.slice(-4)}` : '');

// Comprueba que una clave funciona antes de guardarla.
async function probarClave(clave, valor, workspace) {
    if (clave === 'ANTHROPIC_API_KEY') {
        if (!valor.startsWith('sk-ant-')) throw new HttpError(400, 'La clave de Claude debe empezar por "sk-ant-". Créala en platform.claude.com → API Keys.');
        let ultimo;
        for (const modo of ['apiKey', 'authToken']) {
            try {
                await clienteClaude(valor, modo, workspace, { maxRetries: 0 }).models.list({ limit: 1 });
                return modo;
            } catch (e) {
                ultimo = e;
                if (!(e instanceof Anthropic.AuthenticationError)) break;
            }
        }
        if (ultimo instanceof Anthropic.AuthenticationError) throw new HttpError(400, 'Claude rechaza la clave (no válida o revocada).');
        if (pideWorkspace(ultimo)) {
            throw new HttpError(400, workspace
                ? 'Claude no acepta ese ID de espacio de trabajo para esta clave. Revísalo en platform.claude.com → Settings → Workspaces.'
                : 'Esta clave no está ligada a un espacio de trabajo: rellena también "ID del espacio de trabajo" (platform.claude.com → Settings → Workspaces, empieza por wrkspc_), o crea una clave dentro de un espacio de trabajo.');
        }
        if (ultimo instanceof Anthropic.PermissionDeniedError) throw new HttpError(400, `Claude no permite usar esta clave para la API: ${ultimo.message}`);
        throw new HttpError(502, `No se pudo comprobar la clave de Claude: ${ultimo.message}`);
    }
    if (clave === 'YOUTUBE_API_KEY') {
        const res = await fetch(`${YT}/videos?part=id&id=dQw4w9WgXcQ&key=${encodeURIComponent(valor)}`);
        if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            throw new HttpError(400, `YouTube rechaza la clave: ${d.error?.message || res.status}`);
        }
    }
    if (clave === 'CLAUDE_MODEL' && !MODELOS.includes(valor)) throw new HttpError(400, 'Modelo no válido');
    if (clave === 'FLIKI_API_KEY') await fliki(valor, 'GET', '/languages'); // lanza error si la clave no vale
    if (clave === 'GOOGLE_CLIENT_ID' && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(valor)) throw new HttpError(400, 'El ID de cliente de Google termina en «.apps.googleusercontent.com»');
    if (clave === 'FLIKI_BRAND_ID' && !/^[\w-]{6,64}$/.test(valor)) throw new HttpError(400, 'ID de kit de marca no válido (cópialo del final de su URL en app.fliki.ai/brand-kits)');
}

// ---------- Esquema ----------
// Añade las columnas nuevas si la base de datos se creó con una versión anterior
// (así no hace falta ejecutar migraciones a mano en la consola de D1).
let esquemaListo = false;
async function asegurarEsquema(DB) {
    if (esquemaListo) return;
    const { results } = await DB.prepare('PRAGMA table_info(ideas)').all();
    const hay = new Set(results.map((c) => c.name));
    const faltan = [
        ['detalle', "TEXT NOT NULL DEFAULT ''"], ['guion', "TEXT NOT NULL DEFAULT ''"], ['guion_en', 'TEXT'], ['storyboard', 'TEXT'], ['fliki', 'TEXT'], ['paquete', 'TEXT'],
        ['formato', "TEXT NOT NULL DEFAULT 'largo'"], ['serie', "TEXT NOT NULL DEFAULT ''"], ['padre_id', 'INTEGER'], ['publicar_en', 'TEXT'], ['youtube', 'TEXT'],
    ].filter(([col]) => !hay.has(col));
    for (const [col, tipo] of faltan) await DB.prepare(`ALTER TABLE ideas ADD COLUMN ${col} ${tipo}`).run();
    esquemaListo = true;
}
const COLS_IDEA = "id, titulo, nicho, estado, creado_por, creado_en, detalle, guion_en, length(guion) > 0 AS tiene_guion, storyboard IS NOT NULL AS tiene_storyboard, fliki, formato, serie, padre_id, publicar_en, youtube";

// ---------- API con sesión ----------
async function api(req, env, url, u) {
    const p = url.pathname, m = req.method, DB = env.DB;
    const soloAdmin = () => { if (!u.admin) throw new HttpError(403, 'Solo para administradores'); };
    const ok = () => enviar(200, { ok: true });
    let x;

    if (p === '/api/estado') {
        const { cfg } = await configuracion(env);
        return enviar(200, { usuario: u.nombre, admin: u.admin, db: true,
            youtube: !!cfg.YOUTUBE_API_KEY, claude: !!cfg.ANTHROPIC_API_KEY, modelo: cfg.CLAUDE_MODEL });
    }
    if (p === '/api/youtube/canal' && m === 'GET') {
        return enviar(200, await canal((await configuracion(env)).cfg, url.searchParams.get('q') || ''));
    }
    if (p.startsWith('/api/youtube/') && p !== '/api/youtube/canal') {
        soloAdmin();
        const { cfg } = await configuracion(env);
        if (p === '/api/youtube/oauth/inicio' && m === 'GET') {
            if (!cfg.GOOGLE_CLIENT_ID || !cfg.GOOGLE_CLIENT_SECRET) throw new HttpError(400, 'Guarda primero el ID y el secreto de cliente de Google');
            const estado = hex(crypto.getRandomValues(new Uint8Array(16)));
            await guardarAjuste(DB, 'YT_OAUTH_STATE', `${estado}:${Date.now() + 600000}`, u.nombre);
            const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
            Object.entries({ client_id: cfg.GOOGLE_CLIENT_ID, redirect_uri: oauthRedirect(url), response_type: 'code', scope: YT_SCOPES,
                access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: estado }).forEach(([k, v]) => auth.searchParams.set(k, v));
            return Response.redirect(auth.toString(), 302);
        }
        if (p === '/api/youtube/oauth/callback' && m === 'GET') {
            const volver = (msg) => Response.redirect(`${url.origin}/plataforma.html?youtube=${encodeURIComponent(msg)}`, 302);
            if (url.searchParams.get('error')) return volver('cancelado');
            const [estado, caduca] = (await leerAjuste(DB, 'YT_OAUTH_STATE')).split(':');
            await DB.prepare("DELETE FROM configuracion WHERE clave = 'YT_OAUTH_STATE'").run();
            if (!estado || estado !== url.searchParams.get('state') || Date.now() > +caduca) return volver('error-estado');
            try {
                const d = await googleToken({ client_id: cfg.GOOGLE_CLIENT_ID, client_secret: cfg.GOOGLE_CLIENT_SECRET,
                    code: url.searchParams.get('code'), redirect_uri: oauthRedirect(url), grant_type: 'authorization_code' });
                if (!d.refresh_token) return volver('sin-refresh');
                tokenYT = { token: d.access_token, caduca: Date.now() + (d.expires_in || 3600) * 1000 };
                const ch = await ytAuth(d.access_token, 'GET', 'channels', { query: { part: 'snippet', mine: 'true' } });
                await guardarAjuste(DB, 'YT_REFRESH_TOKEN', d.refresh_token, u.nombre);
                await guardarAjuste(DB, 'YT_CANAL', JSON.stringify({ id: ch.items?.[0]?.id, titulo: ch.items?.[0]?.snippet?.title || '' }), u.nombre);
                return volver('conectado');
            } catch (e) { console.error(e); return volver('error'); }
        }
        if (p === '/api/youtube/estado' && m === 'GET') {
            const canalYT = await leerAjuste(DB, 'YT_CANAL');
            return enviar(200, { configurado: !!(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET), redirect: oauthRedirect(url),
                conectado: !!(await leerAjuste(DB, 'YT_REFRESH_TOKEN')), canal: canalYT ? JSON.parse(canalYT) : null });
        }
        if (p === '/api/youtube/desconectar' && m === 'POST') {
            const refresh = await leerAjuste(DB, 'YT_REFRESH_TOKEN');
            if (refresh) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST' }).catch(() => {});
            await DB.prepare("DELETE FROM configuracion WHERE clave IN ('YT_REFRESH_TOKEN', 'YT_CANAL')").run();
            tokenYT = null;
            return ok();
        }
        // El navegador sube el archivo directamente a Google (subida reanudable) con un token de corta duración:
        // así el vídeo no pasa por el Worker (que limita el tamaño de las peticiones).
        if (p === '/api/youtube/iniciar' && m === 'POST') {
            const b = await leerJson(req);
            await asegurarEsquema(DB);
            const idea = await DB.prepare('SELECT * FROM ideas WHERE id = ?').bind(+b.ideaId).first();
            if (!idea) throw new HttpError(404, 'Idea no encontrada');
            return enviar(200, { token: await accesoYT(env, cfg), metadatos: metadatosYT(idea, b) });
        }
        if (p === '/api/youtube/finalizar' && m === 'POST') {
            const fd = await req.formData();
            const ideaId = +fd.get('ideaId'), videoId = String(fd.get('videoId') || '');
            if (!/^[\w-]{6,20}$/.test(videoId)) throw new HttpError(400, 'ID de vídeo no válido');
            const token = await accesoYT(env, cfg), avisos = [], hecho = [];
            const miniatura = fd.get('miniatura');
            if (miniatura && miniatura.size) {
                if (miniatura.size > 2 * 1024 * 1024) avisos.push('Miniatura: supera 2 MB (límite de YouTube)');
                else try {
                    await ytAuth(token, 'POST', 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set',
                        { query: { videoId }, body: await miniatura.arrayBuffer(), tipo: miniatura.type || 'image/jpeg' });
                    hecho.push('miniatura');
                } catch (e) { avisos.push(`Miniatura: ${e.message} (el canal debe estar verificado por teléfono para miniaturas personalizadas)`); }
            }
            const srt = fd.get('subtitulos');
            if (srt && srt.size) try {
                const limite = 'yaicontenido' + hex(crypto.getRandomValues(new Uint8Array(8)));
                const meta = JSON.stringify({ snippet: { videoId, language: 'es-ES', name: 'Español', isDraft: false } });
                const cuerpo = new Blob([`--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${limite}\r\nContent-Type: application/octet-stream\r\n\r\n`,
                    await srt.arrayBuffer(), `\r\n--${limite}--`]);
                await ytAuth(token, 'POST', 'https://www.googleapis.com/upload/youtube/v3/captions',
                    { query: { part: 'snippet', uploadType: 'multipart' }, body: cuerpo, tipo: `multipart/related; boundary=${limite}` });
                hecho.push('subtítulos');
            } catch (e) { avisos.push(`Subtítulos: ${e.message}`); }
            const lista = String(fd.get('lista') || '').trim();
            if (lista) try {
                const listaId = await listaReproduccion(token, lista);
                await ytAuth(token, 'POST', 'playlistItems', { query: { part: 'snippet' },
                    json: { snippet: { playlistId: listaId, resourceId: { kind: 'youtube#video', videoId } } } });
                hecho.push(`lista «${lista}»`);
            } catch (e) { avisos.push(`Lista de reproducción: ${e.message}`); }
            const v = await ytAuth(token, 'GET', 'videos', { query: { part: 'status', id: videoId } });
            const st = v.items?.[0]?.status || {};
            const datos = { videoId, url: `https://youtu.be/${videoId}`, privacidad: st.privacyStatus, publishAt: st.publishAt || null,
                subido: new Date().toISOString(), por: u.nombre, hecho, avisos };
            if (ideaId) {
                await asegurarEsquema(DB);
                await DB.prepare("UPDATE ideas SET youtube = ?, estado = 'Programado' WHERE id = ?").bind(JSON.stringify(datos), ideaId).run();
            }
            return enviar(200, datos);
        }
    }
    if (p.startsWith('/api/fliki/')) {
        await asegurarEsquema(DB);
        const { cfg } = await configuracion(env);
        if (p === '/api/fliki/voces' && m === 'GET') {
            return enviar(200, { voces: await vocesFliki(env, cfg, url.searchParams.has('refrescar')), estilos: FLIKI_ESTILOS,
                animaciones: FLIKI_ANIMACIONES, voz: cfg.FLIKI_VOICE_ID, maxChars: FLIKI_MAX_CHARS });
        }
        if (p === '/api/fliki/video' && m === 'POST') return enviar(200, await crearVideoFliki(env, cfg, await leerJson(req), u));
        if (p === '/api/fliki/estado' && m === 'GET') return enviar(200, await estadoFliki(env, cfg, +url.searchParams.get('ideaId')));
    }
    if (p === '/api/ia/serie' && m === 'POST') {
        const b = await leerJson(req);
        if (!String(b.tema || '').trim()) throw new HttpError(400, 'Falta el tema de la serie');
        b.episodios = Math.max(1, Math.min(8, +b.episodios || 3));
        b.shortsPorEpisodio = Math.max(0, Math.min(5, +(b.shortsPorEpisodio ?? 2) || 0));
        return enviar(200, await claudeJson((await configuracion(env)).cfg, promptSerie(b), ESQUEMA_SERIE));
    }
    if (p === '/api/ia/shorts' && m === 'POST') {
        const b = await leerJson(req);
        if (!String(b.guion || '').trim()) throw new HttpError(400, 'No hay guion');
        b.n = Math.max(1, Math.min(7, +b.n || 3));
        return enviar(200, await claudeJson((await configuracion(env)).cfg, promptShorts(b), ESQUEMA_SHORTS));
    }
    if (p === '/api/ia/capitulos' && m === 'POST') {
        const b = await leerJson(req);
        if (!String(b.transcripcion || '').trim()) throw new HttpError(400, 'No hay transcripción');
        return enviar(200, await claudeJson((await configuracion(env)).cfg, promptCapitulos(b), ESQUEMA_CAPITULOS));
    }
    if (p === '/api/paquete' && m === 'POST') {
        const b = await leerJson(req);
        if (!String(b.guion || '').trim()) throw new HttpError(400, 'No hay guion');
        const r = await claude((await configuracion(env)).cfg, promptPaquete(b), false, ESQUEMA_PAQUETE);
        let pq;
        try { pq = JSON.parse(r.texto); } catch { throw new HttpError(502, 'Claude no devolvió un paquete válido; inténtalo de nuevo.'); }
        if (b.ideaId) {
            await asegurarEsquema(DB);
            await DB.prepare('UPDATE ideas SET paquete = ? WHERE id = ?').bind(JSON.stringify(pq), +b.ideaId).run();
        }
        return enviar(200, pq);
    }
    if (p === '/api/storyboard' && m === 'POST') {
        const b = await leerJson(req);
        if (!String(b.guion || '').trim()) throw new HttpError(400, 'No hay guion para el storyboard');
        const r = await claude((await configuracion(env)).cfg, promptStoryboard(b), false, ESQUEMA_STORYBOARD);
        if (r.truncado) throw new HttpError(422, 'El guion es demasiado largo para un solo storyboard; divídelo en partes.');
        let sb;
        try { sb = JSON.parse(r.texto); } catch { throw new HttpError(502, 'Claude no devolvió un storyboard válido; inténtalo de nuevo.'); }
        if (b.ideaId) {
            await asegurarEsquema(DB);
            await DB.prepare('UPDATE ideas SET storyboard = ? WHERE id = ?').bind(JSON.stringify(sb), +b.ideaId).run();
        }
        return enviar(200, sb);
    }
    if (p === '/api/claude' && m === 'POST') {
        const { prompt, web } = await leerJson(req);
        return enviar(200, await claude((await configuracion(env)).cfg, prompt, !!web));
    }

    if (p === '/api/configuracion') {
        soloAdmin();
        if (m === 'GET') {
            const { cfg, meta } = await configuracion(env);
            return enviar(200, { modelos: MODELOS, workspace: meta.ANTHROPIC_WORKSPACE_ID, ajustes: Object.fromEntries(AJUSTES.map((k) =>
                [k, { ...meta[k], valor: SECRETOS.has(k) ? enmascarar(cfg[k]) : cfg[k] }])) });
        }
        if (m === 'PUT') {
            const b = await leerJson(req);
            const clave = String(b.clave), valor = String(b.valor ?? '').trim();
            if (!AJUSTES.includes(clave)) throw new HttpError(400, 'Ajuste desconocido');
            if (!valor) { // vaciar: vuelve a usar el secreto del Worker, si existe
                await DB.prepare('DELETE FROM configuracion WHERE clave = ?').bind(clave).run();
                if (clave === 'ANTHROPIC_API_KEY') {
                    await DB.prepare("DELETE FROM configuracion WHERE clave IN ('ANTHROPIC_AUTH', 'ANTHROPIC_WORKSPACE_ID')").run();
                }
                return ok();
            }
            const workspace = String(b.workspace ?? '').trim();
            if (workspace && !/^[\w-]{3,100}$/.test(workspace)) throw new HttpError(400, 'ID de espacio de trabajo no válido');
            const modo = await probarClave(clave, valor, workspace);
            if (clave === 'FLIKI_API_KEY') await DB.prepare("DELETE FROM configuracion WHERE clave = 'FLIKI_VOICES_CACHE'").run();
            if (clave === 'ANTHROPIC_API_KEY') {
                const guardar = DB.prepare(`INSERT INTO configuracion (clave, valor, actualizado_por) VALUES (?1, ?2, ?3)
                    ON CONFLICT (clave) DO UPDATE SET valor = ?2, actualizado_por = ?3`);
                await DB.batch([
                    guardar.bind('ANTHROPIC_AUTH', modo, u.nombre),
                    workspace ? guardar.bind('ANTHROPIC_WORKSPACE_ID', workspace, u.nombre)
                        : DB.prepare("DELETE FROM configuracion WHERE clave = 'ANTHROPIC_WORKSPACE_ID'"),
                ]);
            }
            await DB.prepare(`INSERT INTO configuracion (clave, valor, actualizado_por) VALUES (?1, ?2, ?3)
                ON CONFLICT (clave) DO UPDATE SET valor = ?2, actualizado_por = ?3,
                actualizado_en = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).bind(clave, valor, u.nombre).run();
            return ok();
        }
    }

    if (p === '/api/logout' && m === 'POST') {
        await DB.prepare('DELETE FROM sesiones WHERE token_hash = ?').bind(await sha256(leerCookie(req) || '')).run();
        return enviar(200, { ok: true }, { 'Set-Cookie': cookie(url, '', 0) });
    }
    if (p === '/api/password' && m === 'POST') {
        await cambiarPassword(env, u.nombre, (await leerJson(req)).password, leerCookie(req)); return ok();
    }

    if (p.startsWith('/api/ideas')) await asegurarEsquema(DB);
    if (p === '/api/ideas' && m === 'GET') {
        // La lista no incluye el texto del guion (puede ser largo); se pide idea a idea.
        const { results } = await DB.prepare(`SELECT ${COLS_IDEA} FROM ideas ORDER BY creado_en DESC, id DESC`).all();
        return enviar(200, results.map((r) => ({ ...r, tiene_guion: !!r.tiene_guion, tiene_storyboard: !!r.tiene_storyboard,
            fliki: r.fliki ? JSON.parse(r.fliki) : null, youtube: r.youtube ? JSON.parse(r.youtube) : null })));
    }
    if (p === '/api/ideas' && m === 'POST') {
        const b = await leerJson(req);
        if (!String(b.titulo || '').trim()) throw new HttpError(400, 'Falta el título');
        const idea = await DB.prepare(`INSERT INTO ideas (titulo, nicho, detalle, creado_por, estado, formato, serie, padre_id, publicar_en)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLS_IDEA}`)
            .bind(String(b.titulo).slice(0, 300), String(b.nicho || '').slice(0, 100), String(b.detalle || '').slice(0, 5000), u.nombre,
                String(b.estado || 'Idea').slice(0, 30), b.formato === 'short' ? 'short' : 'largo', String(b.serie || '').slice(0, 120),
                Number.isInteger(b.padre_id) ? b.padre_id : null, b.publicar_en ? String(b.publicar_en).slice(0, 25) : null).first();
        return enviar(201, { ...idea, tiene_guion: false, tiene_storyboard: false });
    }
    if ((x = p.match(/^\/api\/ideas\/(\d+)$/))) {
        if (m === 'GET') {
            const idea = await DB.prepare('SELECT * FROM ideas WHERE id = ?').bind(+x[1]).first();
            if (!idea) throw new HttpError(404, 'Idea no encontrada');
            return enviar(200, { ...idea, storyboard: idea.storyboard ? JSON.parse(idea.storyboard) : null,
                youtube: idea.youtube ? JSON.parse(idea.youtube) : null,
                paquete: idea.paquete ? JSON.parse(idea.paquete) : null,
                fliki: idea.fliki ? JSON.parse(idea.fliki) : null });
        }
        if (m === 'PATCH') {
            // Actualiza solo los campos enviados: estado, detalle y/o guion.
            const b = await leerJson(req), sets = [], vals = [];
            if (b.estado != null) { sets.push('estado = ?'); vals.push(String(b.estado).slice(0, 30)); }
            if (b.detalle != null) { sets.push('detalle = ?'); vals.push(String(b.detalle).slice(0, 5000)); }
            if (b.guion != null) {
                sets.push('guion = ?', "guion_en = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
                vals.push(String(b.guion).slice(0, 300000));
            }
            if (b.titulo != null && String(b.titulo).trim()) { sets.push('titulo = ?'); vals.push(String(b.titulo).slice(0, 300)); }
            if (b.formato != null) { sets.push('formato = ?'); vals.push(b.formato === 'short' ? 'short' : 'largo'); }
            if (b.publicar_en !== undefined) { sets.push('publicar_en = ?'); vals.push(b.publicar_en ? String(b.publicar_en).slice(0, 25) : null); }
            if (b.paquete !== undefined) { sets.push('paquete = ?'); vals.push(b.paquete ? JSON.stringify(b.paquete).slice(0, 200000) : null); }
            if (!sets.length) throw new HttpError(400, 'Nada que actualizar');
            await DB.prepare(`UPDATE ideas SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, +x[1]).run();
            return ok();
        }
        if (m === 'DELETE') { await DB.prepare('DELETE FROM ideas WHERE id = ?').bind(+x[1]).run(); return ok(); }
    }

    if (p === '/api/playbooks' && m === 'GET') {
        const { results } = await DB.prepare('SELECT * FROM playbooks ORDER BY canal').all();
        return enviar(200, Object.fromEntries(results.map((r) =>
            [r.canal, { ...JSON.parse(r.datos), actualizado: r.actualizado_en, actualizado_por: r.actualizado_por }])));
    }
    if ((x = p.match(/^\/api\/playbooks\/(.+)$/)) && m === 'PUT') {
        await DB.prepare(`INSERT INTO playbooks (canal, datos, actualizado_por) VALUES (?1, ?2, ?3)
            ON CONFLICT (canal) DO UPDATE SET datos = ?2, actualizado_por = ?3,
            actualizado_en = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
            .bind(decodeURIComponent(x[1]).slice(0, 120), JSON.stringify(await leerJson(req)), u.nombre).run();
        return ok();
    }

    if (p === '/api/usuarios') {
        soloAdmin();
        if (m === 'GET') {
            const { results } = await DB.prepare('SELECT nombre, admin, creado_en FROM usuarios ORDER BY nombre').all();
            return enviar(200, results.map((r) => ({ ...r, admin: !!r.admin })));
        }
        if (m === 'POST') {
            const b = await leerJson(req);
            const nombre = normaliza(b.nombre);
            if (!/^[a-z0-9._-]{2,40}$/.test(nombre)) throw new HttpError(400, 'Usuario: 2–40 caracteres (letras, números, . _ -)');
            const err = validarPassword(b.password);
            if (err) throw new HttpError(400, err);
            const r = await DB.prepare('INSERT OR IGNORE INTO usuarios (nombre, hash, admin) VALUES (?, ?, ?)')
                .bind(nombre, await hashear(b.password), b.admin ? 1 : 0).run();
            if (!r.meta.changes) throw new HttpError(400, 'Ese usuario ya existe');
            return enviar(201, { ok: true });
        }
    }
    if ((x = p.match(/^\/api\/usuarios\/([^/]+)(\/password)?$/))) {
        soloAdmin();
        const nombre = normaliza(decodeURIComponent(x[1]));
        if (x[2] && m === 'POST') { await cambiarPassword(env, nombre, (await leerJson(req)).password); return ok(); }
        if (!x[2] && m === 'DELETE') {
            if (nombre === u.nombre) throw new HttpError(400, 'No puedes borrarte a ti mismo');
            await DB.batch([
                DB.prepare('DELETE FROM sesiones WHERE usuario = ?').bind(nombre),
                DB.prepare('DELETE FROM usuarios WHERE nombre = ?').bind(nombre),
            ]);
            return ok();
        }
    }
    throw new HttpError(404, 'No encontrado');
}

export default {
    async fetch(req, env) {
        if (env.FLIKI_API_URL) FLIKI = env.FLIKI_API_URL;
        if (env.ANTHROPIC_BASE_URL) CLAUDE_BASE_URL = env.ANTHROPIC_BASE_URL;
        const url = new URL(req.url);
        try {
            if (url.pathname === '/healthz') return new Response('ok');
            if (url.pathname === '/api/login' && req.method === 'POST') return await login(req, env, url);
            if (PUBLICOS.has(url.pathname)) return env.ASSETS.fetch(req);

            const u = await usuarioDeSesion(env, leerCookie(req));
            if (!u) {
                if (url.pathname.startsWith('/api/')) throw new HttpError(401, 'Inicia sesión');
                return Response.redirect(new URL('/login.html', url), 302);
            }
            if (url.pathname.startsWith('/api/')) return await api(req, env, url, u);
            if (url.pathname === '/') return env.ASSETS.fetch(new Request(new URL('/index.html', url), req));
            return env.ASSETS.fetch(req);
        } catch (e) {
            let status = e.status || 500;
            let msg = e instanceof HttpError ? e.message : 'Error interno';
            if (e instanceof Anthropic.RateLimitError) { status = 429; msg = 'Límite de uso de Claude alcanzado, prueba en un minuto.'; }
            else if (e instanceof Anthropic.AuthenticationError) { status = 503; msg = 'ANTHROPIC_API_KEY no es válida.'; }
            else if (e instanceof Anthropic.APIError) { status = 502; msg = `Claude: ${e.message}`; }
            if (!(e instanceof HttpError)) console.error(e);
            return enviar(status, { error: msg });
        }
    },
};
