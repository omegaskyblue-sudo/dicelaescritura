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

async function claude(env, prompt, web) {
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
            output_config: { effort: 'medium' },
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

// ---------- Configuración (claves editables desde la web) ----------
// Los valores guardados en D1 desde la pestaña Configuración tienen prioridad sobre
// los secretos del Worker. Las claves nunca se devuelven al navegador, solo enmascaradas.
const AJUSTES = ['ANTHROPIC_API_KEY', 'YOUTUBE_API_KEY', 'CLAUDE_MODEL'];
const SECRETOS = new Set(['ANTHROPIC_API_KEY', 'YOUTUBE_API_KEY']);
const MODELOS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

// Las claves de la consola de Claude se envían como x-api-key; otros tipos de credencial
// (p. ej. tokens de usuario) como Authorization: Bearer. Se guarda el modo que funcionó.
// Las claves de usuario (no ligadas a un espacio de trabajo) necesitan además la cabecera
// anthropic-workspace-id con el ID del espacio de trabajo (wrkspc_…).
function clienteClaude(clave, modo, workspace, opciones = {}) {
    const auth = modo === 'authToken' ? { authToken: clave, apiKey: null } : { apiKey: clave };
    const defaultHeaders = workspace ? { 'anthropic-workspace-id': workspace } : undefined;
    return new Anthropic({ ...auth, defaultHeaders, ...opciones });
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
        ['detalle', "TEXT NOT NULL DEFAULT ''"], ['guion', "TEXT NOT NULL DEFAULT ''"], ['guion_en', 'TEXT'],
    ].filter(([col]) => !hay.has(col));
    for (const [col, tipo] of faltan) await DB.prepare(`ALTER TABLE ideas ADD COLUMN ${col} ${tipo}`).run();
    esquemaListo = true;
}
const COLS_IDEA = "id, titulo, nicho, estado, creado_por, creado_en, detalle, guion_en, length(guion) > 0 AS tiene_guion";

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
        return enviar(200, results.map((r) => ({ ...r, tiene_guion: !!r.tiene_guion })));
    }
    if (p === '/api/ideas' && m === 'POST') {
        const b = await leerJson(req);
        if (!String(b.titulo || '').trim()) throw new HttpError(400, 'Falta el título');
        const idea = await DB.prepare(`INSERT INTO ideas (titulo, nicho, detalle, creado_por) VALUES (?, ?, ?, ?) RETURNING ${COLS_IDEA}`)
            .bind(String(b.titulo).slice(0, 300), String(b.nicho || '').slice(0, 100), String(b.detalle || '').slice(0, 5000), u.nombre).first();
        return enviar(201, { ...idea, tiene_guion: false });
    }
    if ((x = p.match(/^\/api\/ideas\/(\d+)$/))) {
        if (m === 'GET') {
            const idea = await DB.prepare('SELECT * FROM ideas WHERE id = ?').bind(+x[1]).first();
            if (!idea) throw new HttpError(404, 'Idea no encontrada');
            return enviar(200, idea);
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
