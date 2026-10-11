// Servidor de Estudio Faceless: sirve la web y hace de proxy seguro hacia
// la YouTube Data API v3 y la Claude API. Las claves viven solo aquí (.env).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const YT = 'https://www.googleapis.com/youtube/v3';
const PUBLICOS = new Set(['index.html', 'style.css', 'plataforma.html', 'plataforma.css', 'plataforma.js']);
const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

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

http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
        if (url.pathname === '/api/estado') {
            return enviar(res, 200, { youtube: !!process.env.YOUTUBE_API_KEY, claude: !!anthropic, modelo: MODEL });
        }
        if (url.pathname === '/api/youtube/canal' && req.method === 'GET') {
            return enviar(res, 200, await canal(url.searchParams.get('q') || ''));
        }
        if (url.pathname === '/api/claude' && req.method === 'POST') {
            const { prompt } = await leerJson(req);
            return enviar(res, 200, await claude(prompt));
        }
        const archivo = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (!PUBLICOS.has(archivo)) throw new HttpError(404, 'No encontrado');
        res.writeHead(200, { 'Content-Type': TIPOS[path.extname(archivo)] });
        res.end(await readFile(path.join(ROOT, archivo)));
    } catch (e) {
        let status = e.status || 500;
        let msg = e.message;
        if (e instanceof Anthropic.RateLimitError) { status = 429; msg = 'Límite de uso de Claude alcanzado, prueba en un minuto.'; }
        else if (e instanceof Anthropic.AuthenticationError) { status = 503; msg = 'ANTHROPIC_API_KEY no es válida.'; }
        else if (e instanceof Anthropic.APIError) { status = 502; msg = `Claude: ${e.message}`; }
        if (!(e instanceof HttpError)) console.error(e);
        enviar(res, status, { error: msg });
    }
}).listen(PORT, () => console.log(`Estudio Faceless en http://localhost:${PORT}/plataforma.html`));
