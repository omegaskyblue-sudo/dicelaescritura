// Servidor de Estudio Faceless: sirve la web y hace de proxy seguro hacia
// la YouTube Data API v3 y la Claude API. Las claves viven solo aquí (.env).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import * as db from './db.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const YT = 'https://www.googleapis.com/youtube/v3';
const PUBLICOS = new Set(['index.html', 'style.css', 'plataforma.html', 'plataforma.css', 'plataforma.js', 'login.html']);
const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

// Control de acceso. Con DATABASE_URL: inicio de sesión con usuarios en Postgres
// (ACCESS_USERS solo crea los usuarios iniciales). Sin base de datos: HTTP Basic.
// ACCESS_USERS="ana:clave1,luis:clave2" → cada persona con su usuario y contraseña.
// ACCESS_PASSWORD="x" → una contraseña común, con cualquier usuario (modo simple).
const hash = (s) => createHash('sha256').update(s).digest();
const LISTA_USUARIOS = (process.env.ACCESS_USERS || '').split(',').map((par) => par.trim()).filter(Boolean)
    .map((par) => { const i = par.indexOf(':'); return [par.slice(0, i).trim().toLowerCase(), par.slice(i + 1)]; })
    .filter(([u, p]) => u && p);
const USUARIOS = new Map(LISTA_USUARIOS.map(([u, p]) => [u, hash(p)]));
const CLAVE = process.env.ACCESS_PASSWORD ? hash(process.env.ACCESS_PASSWORD) : null;
const PROTEGIDO = USUARIOS.size > 0 || !!CLAVE;
const CON_DB = !!db.pool;

// Devuelve el nombre de usuario si las credenciales son válidas, o null.
function autenticarBasic(req) {
    if (!PROTEGIDO) return 'local';
    const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
    if (!m) return null;
    const txt = Buffer.from(m[1], 'base64').toString();
    const i = txt.indexOf(':');
    if (i < 0) return null;
    const usuario = txt.slice(0, i).trim().toLowerCase(), pass = hash(txt.slice(i + 1));
    const esperado = USUARIOS.get(usuario);
    if (esperado && timingSafeEqual(pass, esperado)) return usuario;
    if (CLAVE && timingSafeEqual(pass, CLAVE)) return usuario || 'invitado';
    return null;
}

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ---------- YouTube ----------
async function yt(endpoint, params) {
    if (!process.env.YOUTUBE_API_KEY) throw new HttpError(503, 'Falta YOUTUBE_API_KEY en .env');
    const url = new URL(`${YT}/${endpoint}`);
    for (const [k, v] of Object.entries({ ...params, key: process.env.YOUTUBE_API_KEY })) url.searchParams.set(k, v);
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

async function canal(q) {
    const { items } = await yt('channels', { part: 'snippet,contentDetails,statistics', ...parseCanal(q) });
    if (!items?.length) throw new HttpError(404, 'Canal no encontrado');
    const c = items[0];

    const ids = [];
    let pageToken = '';
    do { // hasta 100 vídeos recientes (2 páginas)
        const pl = await yt('playlistItems', {
            part: 'contentDetails', maxResults: 50, playlistId: c.contentDetails.relatedPlaylists.uploads,
            ...(pageToken && { pageToken }),
        });
        ids.push(...pl.items.map((i) => i.contentDetails.videoId));
        pageToken = pl.nextPageToken;
    } while (pageToken && ids.length < 100);

    const videos = [];
    for (let i = 0; i < ids.length; i += 50) {
        const v = await yt('videos', { part: 'snippet,statistics,contentDetails', id: ids.slice(i, i + 50).join(',') });
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

async function claude(prompt) {
    if (!anthropic) throw new HttpError(503, 'Falta ANTHROPIC_API_KEY en .env');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new HttpError(400, 'Prompt vacío');
    const stream = anthropic.beta.messages.stream({
        model: MODEL,
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

// ---------- HTTP ----------
const leerJson = (req) => new Promise((ok, ko) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) ko(new HttpError(413, 'Petición demasiado grande')); });
    req.on('end', () => { try { ok(JSON.parse(body || '{}')); } catch { ko(new HttpError(400, 'JSON inválido')); } });
});

const enviar = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
};

// Límite de intentos de login: 10 fallos por IP cada 15 minutos.
const FALLOS = new Map();
const VENTANA = 15 * 60 * 1000, MAX_FALLOS = 10;
const ipDe = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function bloqueado(ip) {
    const f = FALLOS.get(ip);
    if (f && Date.now() - f.desde > VENTANA) { FALLOS.delete(ip); return false; }
    return f?.n >= MAX_FALLOS;
}
function anotarFallo(ip) {
    const f = FALLOS.get(ip) || { n: 0, desde: Date.now() };
    f.n++; FALLOS.set(ip, f);
    if (FALLOS.size > 10000) FALLOS.delete(FALLOS.keys().next().value);
}

const COOKIE = 'ef_sesion';
const leerCookie = (req) => (req.headers.cookie || '').split(';').map((c) => c.trim().split('='))
    .find(([k]) => k === COOKIE)?.[1];
function ponerCookie(req, res, valor, maxAge) {
    const segura = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${valor}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${segura}`);
}

// Devuelve { nombre, admin } o null.
async function autenticar(req) {
    if (CON_DB) return db.usuarioDeSesion(leerCookie(req));
    const nombre = autenticarBasic(req);
    return nombre && { nombre, admin: false };
}

const soloAdmin = (u) => { if (!u.admin) throw new HttpError(403, 'Solo para administradores'); };
const comprobar = (err) => { if (err) throw new HttpError(400, err); };

// Rutas de la API que requieren sesión. Devuelve true si atendió la petición.
async function rutasApi(req, res, url, u) {
    const p = url.pathname, m = req.method;
    let id;
    if (p === '/api/estado') {
        return enviar(res, 200, { usuario: u.nombre, admin: u.admin, db: CON_DB,
            youtube: !!process.env.YOUTUBE_API_KEY, claude: !!anthropic, modelo: MODEL });
    }
    if (p === '/api/youtube/canal' && m === 'GET') return enviar(res, 200, await canal(url.searchParams.get('q') || ''));
    if (p === '/api/claude' && m === 'POST') return enviar(res, 200, await claude((await leerJson(req)).prompt));

    if (!CON_DB) throw new HttpError(404, 'No encontrado');
    if (p === '/api/logout' && m === 'POST') {
        await db.logout(leerCookie(req)); ponerCookie(req, res, '', 0); return enviar(res, 200, { ok: true });
    }
    if (p === '/api/password' && m === 'POST') {
        comprobar(await db.cambiarPassword(u.nombre, (await leerJson(req)).password, leerCookie(req)));
        return enviar(res, 200, { ok: true });
    }
    if (p === '/api/ideas' && m === 'GET') return enviar(res, 200, await db.listarIdeas());
    if (p === '/api/ideas' && m === 'POST') {
        const b = await leerJson(req);
        if (!b.titulo?.trim()) throw new HttpError(400, 'Falta el título');
        return enviar(res, 201, await db.crearIdea(b, u.nombre));
    }
    if ((id = p.match(/^\/api\/ideas\/(\d+)$/)?.[1])) {
        if (m === 'PATCH') { await db.cambiarEstadoIdea(+id, String((await leerJson(req)).estado).slice(0, 30)); return enviar(res, 200, { ok: true }); }
        if (m === 'DELETE') { await db.borrarIdea(+id); return enviar(res, 200, { ok: true }); }
    }
    if (p === '/api/playbooks' && m === 'GET') return enviar(res, 200, await db.listarPlaybooks());
    if ((id = p.match(/^\/api\/playbooks\/(.+)$/)?.[1]) && m === 'PUT') {
        await db.guardarPlaybook(decodeURIComponent(id), await leerJson(req), u.nombre); return enviar(res, 200, { ok: true });
    }
    if (p === '/api/usuarios') {
        soloAdmin(u);
        if (m === 'GET') return enviar(res, 200, await db.listarUsuarios());
        if (m === 'POST') {
            const b = await leerJson(req);
            comprobar(await db.crearUsuario(b.nombre, b.password, b.admin)); return enviar(res, 201, { ok: true });
        }
    }
    if ((id = p.match(/^\/api\/usuarios\/([^/]+)(\/password)?$/))) {
        soloAdmin(u);
        const nombre = decodeURIComponent(id[1]);
        if (id[2] && m === 'POST') { comprobar(await db.cambiarPassword(nombre, (await leerJson(req)).password)); return enviar(res, 200, { ok: true }); }
        if (!id[2] && m === 'DELETE') { comprobar(await db.borrarUsuario(nombre, u.nombre)); return enviar(res, 200, { ok: true }); }
    }
    throw new HttpError(404, 'No encontrado');
}

const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
        if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
        if (CON_DB && url.pathname === '/api/login' && req.method === 'POST') {
            const ip = ipDe(req);
            if (bloqueado(ip)) throw new HttpError(429, 'Demasiados intentos. Espera 15 minutos.');
            const { nombre, password } = await leerJson(req);
            const s = await db.login(nombre, password);
            if (!s) { anotarFallo(ip); throw new HttpError(401, 'Usuario o contraseña incorrectos'); }
            FALLOS.delete(ip);
            ponerCookie(req, res, s.token, s.maxAge);
            return enviar(res, 200, { ok: true });
        }
        const archivo = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const publico = CON_DB && ['login.html', 'plataforma.css', 'style.css'].includes(archivo);

        const u = publico ? null : await autenticar(req);
        if (!publico && !u) {
            if (!CON_DB) {
                res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Estudio Faceless", charset="UTF-8"' });
                return res.end('Acceso restringido');
            }
            if (url.pathname.startsWith('/api/')) throw new HttpError(401, 'Inicia sesión');
            res.writeHead(302, { Location: '/login.html' });
            return res.end();
        }
        if (url.pathname.startsWith('/api/')) return await rutasApi(req, res, url, u);

        if (!PUBLICOS.has(archivo) || (archivo === 'login.html' && !CON_DB)) throw new HttpError(404, 'No encontrado');
        res.writeHead(200, { 'Content-Type': TIPOS[path.extname(archivo)] });
        res.end(await readFile(path.join(ROOT, archivo)));
    } catch (e) {
        let status = e.status || 500;
        let msg = status === 500 ? 'Error interno' : e.message;
        if (e instanceof Anthropic.RateLimitError) { status = 429; msg = 'Límite de uso de Claude alcanzado, prueba en un minuto.'; }
        else if (e instanceof Anthropic.AuthenticationError) { status = 503; msg = 'ANTHROPIC_API_KEY no es válida.'; }
        else if (e instanceof Anthropic.APIError) { status = 502; msg = `Claude: ${e.message}`; }
        if (!(e instanceof HttpError)) console.error(e);
        enviar(res, status, { error: msg });
    }
});

async function arrancar() {
    if (CON_DB) {
        await db.migrar();
        const n = await db.sembrarUsuarios(LISTA_USUARIOS);
        if (n) console.log(`Creados ${n} usuario(s) iniciales; administrador: ${LISTA_USUARIOS[0][0]}.`);
        const hay = (await db.listarUsuarios()).length;
        if (!hay) console.warn('Aviso: no hay usuarios. Define ACCESS_USERS para crear el primer administrador.');
        console.log('Base de datos lista: inicio de sesión con usuarios de Postgres.');
    } else if (!PROTEGIDO) {
        console.warn('Aviso: sin base de datos ni ACCESS_USERS/ACCESS_PASSWORD; la web es accesible sin contraseña.');
    } else {
        console.log(`Acceso protegido (HTTP Basic): ${USUARIOS.size} usuario(s)${CLAVE ? ' + contraseña común' : ''}.`);
    }
    servidor.listen(PORT, () => console.log(`Estudio Faceless en http://localhost:${PORT}/plataforma.html`));
}
arrancar().catch((e) => { console.error('No se pudo arrancar:', e); process.exit(1); });
