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
No inventes cifras ni fuentes; si un dato es incierto, márcalo como [VERIFICAR]. Responde en español.`;

async function claude(env, prompt) {
    if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, 'Falta la clave de Claude (Configuración)');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new HttpError(400, 'Prompt vacío');
    const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const stream = anthropic.beta.messages.stream({
        model: env.CLAUDE_MODEL || 'claude-opus-5-5',
        max_tokens: 64000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SISTEMA,
        messages: [{ role: 'user', content: prompt.slice(0, 200000) }],
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new HttpError(422, 'Claude ha rechazado la petición. Reformula el prompt.');
    const texto = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return { texto, truncado: msg.stop_reason === 'max_tokens', uso: msg.usage };
}

// ---------- Configuración (claves editables desde la web) ----------
// Los valores guardados en D1 desde la pestaña Configuración tienen prioridad sobre
// los secretos del Worker. Las claves nunca se devuelven al navegador, solo enmascaradas.
const AJUSTES = ['ANTHROPIC_API_KEY', 'YOUTUBE_API_KEY', 'CLAUDE_MODEL'];
const SECRETOS = new Set(['ANTHROPIC_API_KEY', 'YOUTUBE_API_KEY']);
const MODELOS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

async function configuracion(env) {
    const { results } = await env.DB.prepare('SELECT clave, valor, actualizado_por, actualizado_en FROM configuracion').all();
    const db = Object.fromEntries(results.map((r) => [r.clave, r]));
    const cfg = {}, meta = {};
    for (const k of AJUSTES) {
        cfg[k] = db[k]?.valor || env[k] || (k === 'CLAUDE_MODEL' ? MODELOS[0] : '');
        meta[k] = { origen: db[k] ? 'web' : env[k] ? 'cloudflare' : null, por: db[k]?.actualizado_por, en: db[k]?.actualizado_en };
    }
    return { cfg, meta };
}
const enmascarar = (v) => (v ? `${v.slice(0, 7)}…${v.slice(-4)}` : '');

// Comprueba que una clave funciona antes de guardarla.
async function probarClave(clave, valor) {
    if (clave === 'ANTHROPIC_API_KEY') {
        if (!valor.startsWith('sk-ant-api')) throw new HttpError(400, 'La clave de Claude debe empezar por "sk-ant-api". Créala en platform.claude.com → API Keys.');
        try { await new Anthropic({ apiKey: valor, maxRetries: 0 }).models.list({ limit: 1 }); }
        catch (e) {
            if (e instanceof Anthropic.AuthenticationError) throw new HttpError(400, 'Claude rechaza la clave (no válida o revocada).');
            throw new HttpError(502, `No se pudo comprobar la clave de Claude: ${e.message}`);
        }
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
        return enviar(200, await claude((await configuracion(env)).cfg, (await leerJson(req)).prompt));
    }

    if (p === '/api/configuracion') {
        soloAdmin();
        if (m === 'GET') {
            const { cfg, meta } = await configuracion(env);
            return enviar(200, { modelos: MODELOS, ajustes: Object.fromEntries(AJUSTES.map((k) =>
                [k, { ...meta[k], valor: SECRETOS.has(k) ? enmascarar(cfg[k]) : cfg[k] }])) });
        }
        if (m === 'PUT') {
            const b = await leerJson(req);
            const clave = String(b.clave), valor = String(b.valor ?? '').trim();
            if (!AJUSTES.includes(clave)) throw new HttpError(400, 'Ajuste desconocido');
            if (!valor) { // vaciar: vuelve a usar el secreto del Worker, si existe
                await DB.prepare('DELETE FROM configuracion WHERE clave = ?').bind(clave).run();
                return ok();
            }
            await probarClave(clave, valor);
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

    if (p === '/api/ideas' && m === 'GET') {
        return enviar(200, (await DB.prepare('SELECT * FROM ideas ORDER BY creado_en DESC, id DESC').all()).results);
    }
    if (p === '/api/ideas' && m === 'POST') {
        const b = await leerJson(req);
        if (!String(b.titulo || '').trim()) throw new HttpError(400, 'Falta el título');
        const idea = await DB.prepare('INSERT INTO ideas (titulo, nicho, creado_por) VALUES (?, ?, ?) RETURNING *')
            .bind(String(b.titulo).slice(0, 300), String(b.nicho || '').slice(0, 100), u.nombre).first();
        return enviar(201, idea);
    }
    if ((x = p.match(/^\/api\/ideas\/(\d+)$/))) {
        if (m === 'PATCH') {
            await DB.prepare('UPDATE ideas SET estado = ? WHERE id = ?').bind(String((await leerJson(req)).estado).slice(0, 30), +x[1]).run();
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
