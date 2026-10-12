// YAiContenido — todo corre en el navegador, sin servidor.

// Formato del canal: vídeos de 10 minutos como máximo (~140 palabras por minuto de narración).
const MAX_MIN = 10, PALABRAS_MIN = 140;
const esShort = () => $('gFormato').value === 'short';
const limiteMin = () => (esShort() ? 1 : MAX_MIN); // Short: 60 s como máximo
const duracionTxt = (min) => (min < 2 ? `${Math.round(min * 60)} s` : `${min.toFixed(1)} min`);
// Deja solo lo que se narra: quita marcas [VISUAL]/[VERIFICAR], títulos de bloque, separadores,
// formato Markdown y las notas para el equipo que añaden algunos guiones al final.
function soloNarracion(texto) {
    return texto
        .split(/^\s*\**\s*notas?\s+(para\s+el\s+equipo|de\s+producci[oó]n)\b/im)[0]
        .replace(/\[(VISUAL|VERIFICAR)[^\]]*\]/gi, '')
        .split('\n')
        .filter((l) => !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l))                  // separadores
        .filter((l) => !/^\s*(#{1,6}\s|\**\s*(BLOQUE|CIERRE|INTRO|GANCHO|PARTE)\b)/i.test(l)) // títulos de bloque
        .map((l) => l.replace(/\*\*|__/g, '').replace(/(^|\s)\*(?=\S)|(?<=\S)\*(?=\s|$|[.,;:])/g, '$1').trim())
        .filter(Boolean)
        .join('\n');
}
const minutosDe = (texto) => soloNarracion(texto).split(/\s+/).filter(Boolean).length / PALABRAS_MIN;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const store = {
    get(k, def) { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

// Pestañas
$('tabs').addEventListener('click', (e) => {
    const t = e.target.dataset.tab;
    if (!t) return;
    document.querySelectorAll('.tabs button, .panel').forEach((el) => el.classList.remove('active'));
    e.target.classList.add('active');
    $(t).classList.add('active');
});

const irA = (tab) => document.querySelector(`[data-tab="${tab}"]`).click();

document.querySelectorAll('button.copy[data-copy]').forEach((b) =>
    b.addEventListener('click', () => navigator.clipboard?.writeText($(b.dataset.copy).textContent)));

// ---------- 1. Outliers + MRV ----------
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

let outliers = [];
$('refTipo').addEventListener('change', () => $('refVideos').value.trim() && $('btnOutliers').click());
$('btnOutliers').addEventListener('click', () => {
    const rows = $('refVideos').value.split('\n').map((l) => l.split('|').map((x) => x.trim()))
        .filter((r) => r.length >= 2 && !isNaN(parseFloat(r[1])))
        .map(([titulo, v, d, m]) => ({ titulo, vistas: parseFloat(v), dias: parseFloat(d) || null, min: parseFloat(m) || null }))
        // Shorts: hasta 3 min (la API de YouTube no los distingue; se deduce por la duración)
        .map((r) => ({ ...r, short: r.min != null && r.min <= 3 }))
        .filter((r) => $('refTipo').value === 'todos' || (r.short === ($('refTipo').value === 'shorts')));
    if (!rows.length) { $('outOutliers').innerHTML = '<p class="hint">No hay filas válidas para ese filtro.</p>'; return; }

    // Cada vídeo se compara con la mediana de su tipo: los Shorts y los largos tienen audiencias distintas.
    const medShorts = median(rows.filter((r) => r.short).map((r) => r.vistas) || []);
    const medLargos = median(rows.filter((r) => !r.short).map((r) => r.vistas) || []);
    const med = median(rows.map((r) => r.vistas));
    const edadCanal = parseFloat($('refEdad').value);
    rows.forEach((r) => {
        r.ratio = r.vistas / ((r.short ? medShorts : medLargos) || med);
        r.reciente = r.dias != null && r.dias <= 90;
        r.viral = r.ratio >= 3 || r.vistas >= 500000;
        // Mejorable en duración para el formato de 8–10 min: corto (se profundiza) o muy largo (se condensa)
        // (un Short siempre es ampliable a vídeo largo del mismo tema)
        r.mejorable = r.short || (r.min != null && (r.min < 6 || r.min > 15));
        r.score = (r.reciente ? 1 : 0) + (r.viral ? 1 : 0) + (r.mejorable ? 1 : 0);
    });
    rows.sort((a, b) => b.score - a.score || b.ratio - a.ratio);
    outliers = rows;

    const tag = (ok, txt) => `<span class="tag ${ok ? 'ok' : 'bad'}">${txt}</span>`;
    const canalNota = isNaN(edadCanal) ? '' :
        `<div class="card">Canal ${edadCanal <= 90 ? 'reciente (≤ 3 meses): buena señal de nicho abierto' : 'con más de 3 meses: busca un mercado o subnicho donde aún no exista'}. Mediana: ${
            [rows.some((r) => !r.short) && `vídeos largos ${Math.round(medLargos).toLocaleString('es')} vistas`,
             rows.some((r) => r.short) && `Shorts ${Math.round(medShorts).toLocaleString('es')} vistas`].filter(Boolean).join(' · ')}.</div>`;
    $('outOutliers').innerHTML = canalNota + `<table><tr><th>Vídeo</th><th>Vistas</th><th>× mediana</th><th>MRV</th><th></th></tr>${
        rows.map((r, i) => `<tr><td>${r.short ? '<span class="tag warn">Short</span> ' : ''}${esc(r.titulo)}</td><td>${r.vistas.toLocaleString('es')}</td><td>${r.ratio.toFixed(1)}×</td><td>${
            tag(r.mejorable, 'M')} ${tag(r.reciente, 'R')} ${tag(r.viral, 'V')}</td>
            <td><button class="mini" data-usar="${i}">Usar</button></td></tr>`).join('')}</table>
        <p class="hint">Short = dura ≤ 3 min; cada vídeo se compara con la mediana de su tipo. M = Short (ampliable a vídeo largo) o vídeo de &lt; 6 min o &gt; 15 min (adaptable a 8–10 min) · R = ≤ 90 días · V = ≥ 3× la mediana. Las ideas con M+R+V salen arriba: pulsa «Usar» para llevarla a Ideas.</p>`;
});

// «Usar»: el vídeo pasa a Ideas como referente, con los demás éxitos del canal como contexto.
$('outOutliers').addEventListener('click', (e) => {
    const i = e.target.dataset.usar;
    if (i == null) return;
    const r = outliers[+i];
    $('ideaRef').value = r.titulo + (r.short ? ' (Short)' : '');
    $('ideaContexto').value = outliers.filter((o) => o !== r).sort((a, b) => b.ratio - a.ratio).slice(0, 5)
        .map((o) => `${o.titulo} — ${o.vistas.toLocaleString('es')} vistas (${o.ratio.toFixed(1)}× la mediana)`).join('\n');
    irA('ideas');
});

// ---------- 2. Ideas ----------
const PALANCAS = {
    duracion: 'Adapta la idea a un vídeo de 8–10 minutos (máximo 10): si el referente es corto, aporta más profundidad y contexto; si es largo, condénsalo en lo esencial sin relleno.',
    formato: 'Propón un formato visual distinto al del referente (p. ej. documental con material de archivo/stock en vez de animación) y justifica por qué encaja.',
    mercado: 'Adapta la idea al mercado {mercado}: conserva solo lo que también interese a esa audiencia, cambia ejemplos, referencias y perspectiva culturales. Indica si hay demanda real en ambos mercados.',
    subnicho: 'Traslada la idea al subnicho "{nicho}" manteniendo el gancho que la hizo viral.',
    inverso: 'Aplica la técnica del título inverso: reordena y recombina las palabras clave para crear títulos nuevos con un ángulo diferente.',
    patron: 'Busca en internet qué temas relacionados con el nicho están en tendencia esta semana y conecta cada propuesta con uno de ellos (indica la fuente). {ganadoras}',
};

$('btnIdea').addEventListener('click', () => {
    const ref = $('ideaRef').value || '(título referente)';
    const nicho = $('ideaNicho').value || 'mi nicho';
    const mercado = $('ideaMercado').value || 'hispanohablante';
    const pal = [...document.querySelectorAll('#ideas fieldset input:checked')].map((c) =>
        '- ' + PALANCAS[c.value].replace('{mercado}', mercado).replace('{nicho}', nicho)
            .replace('{ganadoras}', $('ideaGanadoras').value.trim()
                ? 'Combínalos con los patrones de mis ideas ganadoras (más abajo).'
                : 'Combínalos con los patrones que explican por qué el referente se hizo viral.'));
    const gan = $('ideaGanadoras').value.trim();
    const ctx = $('ideaContexto').value.trim();
    const canalRef = $('refCanal').value.trim();
    // La palanca de tendencia necesita búsqueda en internet: se activa sola.
    if (document.querySelector('#ideas fieldset input[value=patron]').checked) $('webIdea').checked = true;
    $('outIdea').textContent =
`Actúa como estratega de contenido para un canal de YouTube del nicho "${nicho}" dirigido al público ${mercado}.

Vídeo referente (reciente y viral): "${ref}"

Objetivo: no copiar, sino MEJORAR la idea aportando un valor diferencial claro y original.${
    /\(Short\)\s*$/.test(ref) ? '\nEl referente es un Short que funcionó: cada propuesta debe ser un vídeo largo (8–10 min) que desarrolle el tema y, además, un Short derivado de ≤ 60 s que lleve a ese vídeo (indica su gancho de 2 s).' : ''}
Aplica estas palancas:
${pal.join('\n') || '- (elige al menos una palanca)'}
${gan ? `\nMis ideas ganadoras (patrones que ya funcionan en mi canal):\n${gan}\n` : ''}${
    ctx ? `\nOtros éxitos del canal referente${canalRef ? ` «${canalRef}»` : ''} (detecta qué tienen en común):\n${ctx}\n` : ''}
Si te falta algún dato, no lo pidas: trabaja con supuestos razonables y menciónalos en una línea al final.
Devuélveme 10 propuestas. Empieza cada una con una línea «## N. Título» (título de máx. 60 caracteres) y debajo, en líneas cortas:
ángulo único en una frase, qué aporta que el referente no tiene, y concepto de miniatura (máx. 4 palabras de texto).`;
});

// Con base de datos (servidor con Postgres) el pipeline y los playbooks son compartidos por el equipo;
// sin ella se guardan en este navegador.
let MODO_DB = false;
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let pipeline = store.get('ef_pipeline', []);
const ESTADOS = ['Idea', 'Guion', 'Edición', 'Publicado', 'Descartada'];
function pintarPipeline() {
    $('pipeline').innerHTML = pipeline.map((p, i) => `<li><span>${p.tiene_guion || p.guion ? '<span title="Tiene guion guardado">📄</span> ' : ''}${p.fliki ? '<span title="Vídeo en Fliki">🎬</span> ' : ''}${esc(p.titulo)} <small class="hint">· ${esc(p.nicho)}${
        p.creado_por ? ' · ' + esc(p.creado_por) : ''}</small></span>
        <button class="mini" data-guion="${i}">Guion</button>
        <select data-i="${i}">${ESTADOS.map((e) => `<option${e === p.estado ? ' selected' : ''}>${e}</option>`).join('')}</select>
        <button data-del="${i}" class="copy">✕</button></li>`).join('') || '<li class="hint">Vacío</li>';
    // Selector de la pestaña Métricas
    const sel = $('mIdea'), previo = sel.value;
    sel.innerHTML = '<option value="">— sin vincular —</option>' + pipeline.map((p, i) =>
        `<option value="${i}">${esc(p.titulo)} (${esc(p.estado)})</option>`).join('');
    if (previo && pipeline[+previo]) sel.value = previo;
}

async function crearIdea(titulo, nicho, estado = 'Idea', detalle = '') {
    const idea = { titulo, nicho, estado, detalle, fecha: new Date().toISOString().slice(0, 10) };
    if (MODO_DB) {
        const creada = await api('/api/ideas', json('POST', idea));
        if (estado !== 'Idea') await api(`/api/ideas/${creada.id}`, json('PATCH', { estado }));
        creada.estado = estado;
        pipeline.unshift(creada);
    } else { pipeline.unshift(idea); store.set('ef_pipeline', pipeline); }
    pintarPipeline();
    return pipeline[0];
}
async function cambiarEstado(idea, estado) {
    if (!idea || idea.estado === estado) return;
    idea.estado = estado;
    if (MODO_DB && idea.id) await api(`/api/ideas/${idea.id}`, json('PATCH', { estado })).catch(fallo);
    else store.set('ef_pipeline', pipeline);
    pintarPipeline();
}
// Guarda el guion en la idea (y opcionalmente cambia su estado).
async function guardarGuion(idea, guion, estado) {
    if (MODO_DB && idea.id) await api(`/api/ideas/${idea.id}`, json('PATCH', { guion, ...(estado && { estado }) }));
    idea.guion = guion;
    idea.tiene_guion = !!guion;
    if (estado) idea.estado = estado;
    if (!MODO_DB) store.set('ef_pipeline', pipeline);
    pintarPipeline();
}
const fallo = (e) => alert(e.message);
$('pipeline').addEventListener('change', (e) => cambiarEstado(pipeline[e.target.dataset.i], e.target.value));
$('pipeline').addEventListener('click', async (e) => {
    if (e.target.dataset.guion != null) {
        const idea = pipeline[+e.target.dataset.guion];
        try {
            if (MODO_DB && idea.id) Object.assign(idea, await api(`/api/ideas/${idea.id}`)); // trae detalle y guion
        } catch (err) { return fallo(err); }
        return irAGuion({ titulo: idea.titulo, detalle: idea.detalle || '', idea });
    }
    if (e.target.dataset.del == null) return;
    const [p] = pipeline.splice(+e.target.dataset.del, 1);
    if (MODO_DB) await api(`/api/ideas/${p.id}`, { method: 'DELETE' }).catch(fallo);
    else store.set('ef_pipeline', pipeline);
    pintarPipeline();
});
$('btnGuardarIdea').addEventListener('click', async () => {
    const titulo = prompt('Título de la idea:', $('ideaRef').value);
    if (titulo) await crearIdea(titulo, $('ideaNicho').value).catch(fallo);
});

// D. Propuestas de Claude: cada «## N. Título» se convierte en una tarjeta con acciones.
let propuestas = [];
function mostrarPropuestas(texto) {
    propuestas = texto.split(/^(?=#{1,4}\s*\d+\s*[.)])/m).filter((b) => /^#{1,4}\s*\d+/.test(b)).map((b) => {
        const [cab, ...resto] = b.trim().split('\n');
        return { titulo: cab.replace(/^#{1,4}\s*\d+\s*[.)]\s*/, '').replace(/\*\*|[«»"]/g, '').trim(), detalle: resto.join('\n').trim() };
    });
    $('propuestas').innerHTML = propuestas.length ? '<h3>Propuestas</h3>' + propuestas.map((p, i) => `<div class="propuesta">
        <b>${esc(p.titulo)}</b><p>${esc(p.detalle)}</p>
        <button class="mini" data-guardar="${i}">Guardar en pipeline</button>
        <button class="mini ia" data-escribir="${i}">Escribir guion</button></div>`).join('') : '';
}
$('propuestas').addEventListener('click', async (e) => {
    const { guardar, escribir } = e.target.dataset;
    const p = propuestas[+(guardar ?? escribir)];
    if (!p) return;
    try {
        let idea = pipeline.find((x) => x.titulo === p.titulo);
        if (guardar != null) {
            if (idea) return alert('Ya está en el pipeline.');
            idea = await crearIdea(p.titulo, $('ideaNicho').value, 'Idea', p.detalle);
            e.target.textContent = 'Guardada ✓'; e.target.disabled = true;
        } else {
            idea ||= await crearIdea(p.titulo, $('ideaNicho').value, 'Guion', p.detalle);
            irAGuion({ titulo: p.titulo, detalle: p.detalle, idea });
        }
    } catch (err) { fallo(err); }
});
pintarPipeline();

// ---------- 3. Guion ----------
let ideaEnGuion = null; // idea del pipeline cuyo guion se está escribiendo
function irAGuion({ titulo, detalle, idea }) {
    $('gTema').value = titulo;
    $('gAngulo').value = detalle || '';
    ideaEnGuion = idea || null;
    $('gIdeaVinculada').textContent = !idea ? ''
        : idea.guion ? `Idea «${idea.titulo}»: guion guardado el ${new Date(idea.guion_en || Date.now()).toLocaleString('es')}. Puedes revisarlo, editarlo y volver a guardarlo.`
        : `Vinculado a la idea «${idea.titulo}»: el guion que escriba Claude se guardará en ella y pasará a «Edición».`;
    $('btnGuardarGuion').hidden = !idea;
    if (idea && idea.estado === 'Idea') cambiarEstado(idea, 'Guion');
    // Si ya tiene guion, se muestra; si no, se prepara el prompt para escribirlo.
    $('iaGuion').hidden = !idea?.guion;
    $('iaGuion').textContent = idea?.guion || '';
    $('gTexto').value = idea?.guion || '';
    $('outRevision').innerHTML = '';
    if (idea?.guion) $('btnRevisar').click();
    pintarStoryboard(idea?.storyboard || null);
    pintarFliki(idea?.fliki || null);
    $('btnGuionPrompt').click();
    irA('guion');
}

$('gFormato').addEventListener('change', () => {
    $('gMinLabel').hidden = esShort();
    $('fkFormato').value = esShort() ? '9:16' : '16:9';
    $('btnGuionPrompt').click();
});

const PROMPT_SHORT = (tema, angulo, canal, extra) =>
`Escribe el guion de un YouTube Short (vídeo vertical) sobre: "${tema}".
${angulo ? `\nÁngulo y detalles de la idea:\n${angulo}\n` : ''}${canal ? `\nCanal: ${canal}\n` : ''}
Duración: 45–60 segundos. Extensión: 110–140 palabras y NUNCA más de 150.

Estructura obligatoria:
- 0–2 s: gancho que detenga el scroll (pregunta directa, frase inesperada o promesa concreta). Sin saludos ni presentaciones.
- Desarrollo: una sola idea, en frases cortas, con una imagen o historia concreta; si citas la Biblia, libro, capítulo y versículo exactos.
- Cierre: una aplicación práctica para hoy y una última frase que conecte con el gancho inicial para que el vídeo se vea en bucle.
- No pidas suscripciones ni likes dentro del guion.

Estilo: cercano y sereno; ritmo variado; prohibido "No es X, es Y", las cadenas de negaciones y las muletillas.
${extra ? `\nInstrucciones propias del canal (tienen prioridad):\n${extra}\n` : ''}
Devuelve solo el texto narrado, con marcas [VISUAL: …] para el editor (planos de 2–4 s).`;

$('btnGuionPrompt').addEventListener('click', () => {
    if (esShort()) {
        const pb = playbooks[canalActivo()] || {};
        const canal = [canalActivo(), pb.nicho, pb.voz && `voz: ${pb.voz}`].filter(Boolean).join(' · ');
        $('outGuionPrompt').textContent = PROMPT_SHORT($('gTema').value || '(tema)', $('gAngulo').value.trim(), canal, $('gExtra').value.trim());
        return;
    }
    const min = Math.min(MAX_MIN, Math.max(1, +$('gMin').value || MAX_MIN));
    $('gMin').value = min;
    const pb = playbooks[canalActivo()] || {};
    const angulo = $('gAngulo').value.trim(), extra = $('gExtra').value.trim();
    const canal = [pb.nicho && `nicho: ${pb.nicho}`, pb.formato && `formato visual: ${pb.formato}`, pb.voz && `voz: ${pb.voz}`].filter(Boolean).join(' · ');
    $('outGuionPrompt').textContent =
`Escribe un guion de narración para YouTube sobre: "${$('gTema').value || '(tema)'}".
${angulo ? `\nÁngulo y detalles de la idea:\n${angulo}\n` : ''}${canal ? `\nCanal (${canalActivo()}): ${canal}\n` : ''}
Duración: ~${min} minutos. Extensión: unas ${Math.min(min * PALABRAS_MIN, MAX_MIN * PALABRAS_MIN - 100)} palabras de narración y NUNCA más de ${MAX_MIN * PALABRAS_MIN} (límite de ${MAX_MIN} minutos).

Intro (primeros 30 segundos, objetivo 75 % de retención): ${$('gIntro').value}. Promete algo concreto que el vídeo cumplirá.${
    pb.intro ? `\nCómo hacemos las intros en este canal: ${pb.intro}` : ''}

Estilo — obligatorio:
- Investigación y aportación propias: datos concretos, fuentes verificables, una tesis original. Nada de relleno.
- Ritmo variado: alterna frases muy cortas con otras largas; cambia de tono; usa pausas y preguntas.
- Prohibido el recurso "No es X, es Y" y sus variantes.
- Prohibidas las cadenas de negaciones del tipo "No con A, no con B, no con C, sino con…".
- Evita las muletillas: "en definitiva", "sin duda", "cabe destacar", "en un mundo donde", "adentrémonos".
- Bloques de 1–2 minutos, cada uno cierra con un gancho hacia el siguiente. Sin relleno: cada frase debe aportar.
${extra ? `\nInstrucciones propias del canal (tienen prioridad):\n${extra}\n` : ''}
Devuelve solo el texto narrado, con marcas [VISUAL: …] para el editor.`;
});

$('btnGuardarEstilo').addEventListener('click', async () => {
    const nombre = canalActivo();
    if (!nombre) return alert('Elige arriba el «Canal activo» (o crea su playbook en la pestaña 5).');
    try {
        await guardarPlaybook(nombre, { ...camposPb(playbooks[nombre]), prompt: $('gExtra').value, estilo_imagen: $('sbEstilo').value });
        alert(`Instrucciones y estilo visual guardados en el playbook de «${nombre}».`);
    } catch (err) { fallo(err); }
});

const PATRONES = [
    { nombre: 'Antítesis binaria ("no es X, es Y")', re: /\bno (es|era|son|fue|se trata de)\b[^.!?\n]{1,60}?[,;:]\s*(es|era|son|fue|sino)\b/gi },
    { nombre: 'Cadena de negaciones', re: /(\bno\s+(con|por|en|de|a)?\s*[^,.;\n]{1,30},\s*){2,}/gi },
    { nombre: 'Muletillas', re: /\b(en definitiva|sin duda|cabe destacar|en un mundo donde|adentrémonos|es importante señalar|en resumen)\b/gi },
];

$('btnRevisar').addEventListener('click', () => {
    const txt = $('gTexto').value;
    if (!txt.trim()) return;
    let marcado = esc(txt);
    const hallazgos = PATRONES.map((p) => {
        const n = (txt.match(p.re) || []).length;
        marcado = marcado.replace(p.re, (m) => `<mark title="${p.nombre}">${m}</mark>`);
        return { ...p, n };
    });
    // Metrónomo: poca variación en la longitud de frases
    const frases = txt.split(/[.!?…]+/).map((f) => f.trim().split(/\s+/).filter(Boolean).length).filter((n) => n > 0);
    const media = frases.reduce((a, b) => a + b, 0) / frases.length;
    const cv = Math.sqrt(frases.reduce((a, b) => a + (b - media) ** 2, 0) / frases.length) / media;
    const metronomo = frases.length >= 8 && cv < 0.45;

    $('outRevision').innerHTML = `<table><tr><th>Patrón</th><th>Casos</th></tr>${
        hallazgos.map((h) => `<tr><td>${h.nombre}</td><td><span class="tag ${h.n ? 'warn' : 'ok'}">${h.n}</span></td></tr>`).join('')}
        <tr><td>Ritmo (variación de longitud de frase, CV=${cv.toFixed(2)}; media ${media.toFixed(1)} palabras)</td>
        <td><span class="tag ${metronomo ? 'warn' : 'ok'}">${metronomo ? 'monótono' : 'variado'}</span></td></tr>
        <tr><td>Duración estimada (${PALABRAS_MIN} palabras/min; máximo ${esShort() ? '60 s (Short)' : MAX_MIN + ' min'})</td>
        <td><span class="tag ${minutosDe(txt) > limiteMin() ? 'bad' : 'ok'}">${duracionTxt(minutosDe(txt))}</span></td></tr></table>
        ${minutosDe(txt) > limiteMin() ? `<p class="error">El guion supera ${esShort() ? 'los 60 segundos de un Short' : `los ${MAX_MIN} minutos`}: recórtalo hasta unas ${Math.round(limiteMin() * PALABRAS_MIN)} palabras.</p>` : ''}
        <div class="out">${marcado}</div>`;
});

// ---------- 4. Métricas ----------
let ultimoDiag = null;
$('mIdea').addEventListener('change', () => { $('btnGanadora').hidden = !($('mIdea').value && ultimoDiag); });
$('btnGanadora').addEventListener('click', async () => {
    const idea = pipeline[+$('mIdea').value], nombre = canalActivo();
    if (!idea) return;
    if (!nombre) return alert('Elige arriba el «Canal activo» para guardar la idea ganadora en su playbook.');
    const d = ultimoDiag || {};
    const linea = `${idea.titulo}${isNaN(d.ctr) ? '' : ` — CTR ${d.ctr}%`}${isNaN(d.ret) ? '' : `, retención ${d.ret.toFixed(0)}%`}`;
    const pb = camposPb(playbooks[nombre]);
    pb.ganadoras = [pb.ganadoras, linea].filter((x) => x && x.trim()).join('\n');
    try {
        await guardarPlaybook(nombre, pb);
        $('ideaGanadoras').value = pb.ganadoras;
        await cambiarEstado(idea, 'Publicado');
        alert(`Añadida a las ideas ganadoras de «${nombre}». Se usará al generar nuevas ideas.`);
    } catch (err) { fallo(err); }
});
$('btnDiag').addEventListener('click', () => {
    const v = (id) => parseFloat($(id).value);
    const ctr = v('mCtr'), ctrCanal = v('mCtrCanal'), dur = v('mDur'), avd = v('mAvd'), r30 = v('mR30'), imp = v('mImp');
    const ret = dur && avd ? (avd / dur) * 100 : NaN;
    const out = [];
    const linea = (c, t) => out.push(`<div class="card"><span class="tag ${c}">${{ ok: 'OK', warn: 'Revisar', bad: 'Problema' }[c]}</span> ${t}</div>`);

    if (!isNaN(ctr)) {
        const diff = ctr - (ctrCanal || 0);
        if (diff <= -1.5) linea('bad', `CTR ${ctr}% está ${Math.abs(diff).toFixed(1)} pts por debajo del canal. Si la retención es buena, el fallo suele ser la <b>idea</b>; si no, la <b>miniatura/título</b>.`);
        else if (ctr >= 7) linea('ok', `CTR ${ctr}%: fuerte. Es normal que baje cuando YouTube amplía a audiencia fría.`);
        else linea('warn', `CTR ${ctr}%: en línea con el canal.`);
    }
    if (!isNaN(ret)) {
        if (ret >= 40) linea('ok', `Retención media ${ret.toFixed(0)}%: excelente para vídeo largo.`);
        else if (ret >= 30) linea('warn', `Retención ${ret.toFixed(0)}%: aceptable; apunta al 40% mejorando estructura del guion y ritmo visual.`);
        else linea('bad', `Retención ${ret.toFixed(0)}%: revisa estructura del guion y aspecto visual.`);
    }
    if (!isNaN(r30)) linea(r30 >= 75 ? 'ok' : 'bad', `Retención a 30 s: ${r30}% (objetivo ≥ 75%). ${r30 < 75 ? 'Reescribe la intro: cumple la promesa del título enseguida.' : ''}`);
    if (!isNaN(imp) && imp < 1000) linea('warn', 'Pocas impresiones: en un canal nuevo, sé paciente y constante los primeros 10 vídeos; si persiste, revisa nicho y originalidad.');

    const buenCtr = !isNaN(ctr) && ctr >= (ctrCanal || 6), buenaRet = ret >= 35;
    const veredicto = buenCtr && buenaRet ? 'Doblar apuesta: replica esta idea/patrón en variantes.'
        : buenaRet ? 'El contenido retiene: prueba otra miniatura/título o una idea con más demanda.'
        : buenCtr ? 'La gente entra pero se va: arregla intro y guion.'
        : 'Descarta esta idea y vuelve a la búsqueda MRV.';
    out.push(`<div class="card"><b>Veredicto:</b> ${veredicto}</div>`);
    $('outDiag').innerHTML = out.join('');
    ultimoDiag = { ctr, ret, bueno: buenCtr && buenaRet };
    $('btnGanadora').hidden = !$('mIdea').value;
});

// ---------- 5. Playbook ----------
let playbooks = store.get('ef_playbooks', {});
const CAMPOS_PB = [...document.querySelectorAll('[data-pb]')].map((el) => el.dataset.pb);
const camposPb = (pb = {}) => Object.fromEntries(CAMPOS_PB.map((k) => [k, pb[k] ?? '']));
const leerPb = () => Object.fromEntries([...document.querySelectorAll('[data-pb]')].map((el) => [el.dataset.pb, el.value]));
const canalActivo = () => $('canalActivo').value;

function pintarLista() {
    const nombres = Object.keys(playbooks);
    $('pbLista').innerHTML = nombres.map((k) => `<option>${esc(k)}</option>`).join('');
    const sel = $('canalActivo'), previo = sel.value || store.get('ef_canal', '');
    sel.innerHTML = '<option value="">— ninguno —</option>' + nombres.map((k) => `<option>${esc(k)}</option>`).join('');
    if (playbooks[previo]) sel.value = previo;
}
async function guardarPlaybook(nombre, datos) {
    if (MODO_DB) await api('/api/playbooks/' + encodeURIComponent(nombre), json('PUT', datos));
    playbooks[nombre] = { ...datos, actualizado: new Date().toISOString() };
    if (!MODO_DB) store.set('ef_playbooks', playbooks);
    pintarLista();
}
function cargarPbEnFormulario(nombre) {
    const pb = playbooks[nombre];
    if (!pb) return;
    $('pbCanal').value = nombre;
    document.querySelectorAll('[data-pb]').forEach((el) => { el.value = pb[el.dataset.pb] ?? ''; });
}
// Al elegir canal activo, su playbook rellena Ideas, Guion y el formulario del Playbook.
function aplicarCanal() {
    const nombre = canalActivo();
    const pb = playbooks[nombre];
    if (!pb) return;
    if (pb.nicho) $('ideaNicho').value = pb.nicho;
    $('ideaGanadoras').value = pb.ganadoras || '';
    $('gExtra').value = pb.prompt || '';
    $('sbEstilo').value = pb.estilo_imagen || '';
    cargarPbEnFormulario(nombre);
}
const elegirCanal = (nombre) => { $('canalActivo').value = nombre; store.set('ef_canal', nombre); aplicarCanal(); };
$('canalActivo').addEventListener('change', () => elegirCanal(canalActivo()));

$('btnPbGuardar').addEventListener('click', async () => {
    const nombre = $('pbCanal').value.trim();
    if (!nombre) { alert('Ponle nombre al canal'); return; }
    try { await guardarPlaybook(nombre, leerPb()); } catch (e) { return fallo(e); }
    if (!canalActivo()) elegirCanal(nombre);
});
$('btnPbCargar').addEventListener('click', () => cargarPbEnFormulario($('pbLista').value));
$('btnPbExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ playbooks, pipeline }, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'yaicontenido.json' });
    a.click();
});
pintarLista();
aplicarCanal();

// ---------- Conexión con el servidor (YouTube + Claude) ----------
async function api(ruta, opciones) {
    let res;
    try { res = await fetch(ruta, opciones); } catch { throw new Error('Servidor no disponible. Arranca con "npm start".'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || (res.status === 404 ? 'Servidor no disponible. Arranca con "npm start".' : `Error ${res.status}`));
    return data;
}

api('/api/estado').then(async (e) => {
    if (e.db) await activarEquipo(e);
    $('estadoApi').textContent = `${e.usuario && e.usuario !== 'local' ? 'Sesión: ' + e.usuario + ' · ' : ''}Conexiones: YouTube ${e.youtube ? '✓' : '✗ (falta clave)'} · Claude ${e.claude ? '✓ ' + e.modelo : '✗ (falta clave)'}`;
}).catch(() => { $('estadoApi').textContent = 'Modo sin conexión: esta copia no tiene servidor (login, YouTube y Claude solo en la versión de Cloudflare).'; });

$('btnYt').addEventListener('click', async () => {
    const q = $('ytCanal').value.trim();
    if (!q) return;
    const b = $('btnYt'); b.disabled = true; b.textContent = 'Importando…';
    try {
        const c = await api('/api/youtube/canal?q=' + encodeURIComponent(q));
        $('refCanal').value = c.titulo;
        $('refEdad').value = c.diasCanal;
        $('refVideos').value = c.videos.map((v) => `${v.titulo.replace(/\|/g, '/')} | ${v.vistas} | ${v.dias} | ${v.min}`).join('\n');
        $('btnOutliers').click();
    } catch (e) { alert(e.message); }
    finally { b.disabled = false; b.textContent = 'Importar desde YouTube'; }
});

document.querySelectorAll('button.ia[data-prompt]').forEach((b) => b.addEventListener('click', async () => {
    const prompt = $(b.dataset.prompt).textContent.trim();
    if (!prompt) { alert('Genera primero el prompt.'); return; }
    const out = $(b.dataset.out), txt = b.textContent;
    b.disabled = true; b.textContent = 'Claude está escribiendo…';
    out.hidden = false; out.textContent = '…';
    try {
        const web = !!$(b.dataset.web)?.checked;
        if (web) b.textContent = 'Claude está investigando y escribiendo…';
        const r = await api('/api/claude', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, web }) });
        out.textContent = r.texto + (r.truncado ? '\n\n[Respuesta cortada por longitud]' : '');
        if (b.dataset.out === 'iaIdea') mostrarPropuestas(r.texto);
        if (b.dataset.out === 'iaGuion' && ideaEnGuion) {
            await guardarGuion(ideaEnGuion, r.texto, ideaEnGuion.estado === 'Guion' || ideaEnGuion.estado === 'Idea' ? 'Edición' : undefined)
                .then(() => { $('gIdeaVinculada').textContent = `Guion guardado en la idea «${ideaEnGuion.titulo}».`; })
                .catch((err) => fallo(new Error('El guion se generó pero no se pudo guardar: ' + err.message)));
        }
    } catch (e) { out.textContent = '⚠ ' + e.message; }
    finally { b.disabled = false; b.textContent = txt; }
}));

// Guarda en la idea el texto del revisor (la versión editada) o, si está vacío, el de Claude.
$('btnGuardarGuion').addEventListener('click', async () => {
    if (!ideaEnGuion) return;
    const texto = $('gTexto').value.trim() || $('iaGuion').textContent.trim();
    if (!texto) return alert('No hay guion que guardar.');
    try {
        await guardarGuion(ideaEnGuion, texto);
        $('gIdeaVinculada').textContent = `Guion guardado en la idea «${ideaEnGuion.titulo}».`;
    } catch (err) { fallo(err); }
});

// ---------- Storyboard y miniaturas ----------
let storyboard = null;
const conEstilo = (prompt) => [prompt, storyboard?.estilo_visual || $('sbEstilo').value].filter(Boolean).join(', ');
function pintarStoryboard(sb) {
    storyboard = sb;
    if (!sb) { $('outStoryboard').innerHTML = ''; return; }
    const total = sb.escenas.reduce((a, e) => a + (e.duracion_s || 0), 0);
    $('outStoryboard').innerHTML = `
        <p class="hint">${sb.escenas.length} escenas · ~${total < 60 ? total + ' s' : Math.round(total / 60) + ' min'} · estilo: ${esc(sb.estilo_visual)}</p>
        <button class="mini" id="sbCsv">Descargar CSV</button>
        <button class="mini" id="sbTodos">Copiar todos los prompts</button>
        <h4>Miniaturas</h4>
        ${sb.miniaturas.map((m, i) => `<div class="propuesta"><b>«${esc(m.texto)}»</b><p>${esc(m.composicion)}</p>
            <p><i>${esc(m.prompt_imagen)}</i></p><button class="mini" data-copiar="m${i}">Copiar prompt</button></div>`).join('')}
        <h4>Escenas</h4>
        ${sb.escenas.map((e, i) => `<div class="escena"><span class="tag ok">${e.n}</span> <small class="hint">${e.duracion_s}s · ${esc(e.camara)}</small>
            <p>${esc(e.narracion)}</p><p class="prompt"><i>${esc(e.prompt_imagen)}</i></p>
            <small class="hint">Archivo: ${esc(e.busqueda_archivo)}</small>
            <button class="mini" data-copiar="e${i}">Copiar prompt</button></div>`).join('')}`;
}
const copiar = (t, boton) => navigator.clipboard?.writeText(t).then(() => {
    const txt = boton.textContent; boton.textContent = 'Copiado ✓'; setTimeout(() => { boton.textContent = txt; }, 1200);
});
$('outStoryboard').addEventListener('click', (e) => {
    const b = e.target, c = b.dataset.copiar;
    if (c) {
        const item = c[0] === 'm' ? storyboard.miniaturas[+c.slice(1)] : storyboard.escenas[+c.slice(1)];
        return copiar(conEstilo(item.prompt_imagen), b);
    }
    if (b.id === 'sbTodos') return copiar(storyboard.escenas.map((x) => conEstilo(x.prompt_imagen)).join('\n'), b);
    if (b.id === 'sbCsv') {
        const celda = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const filas = [['escena', 'segundos', 'narracion', 'prompt_imagen', 'busqueda_archivo', 'camara'],
            ...storyboard.escenas.map((x) => [x.n, x.duracion_s, x.narracion, conEstilo(x.prompt_imagen), x.busqueda_archivo, x.camara]),
            [], ['miniatura', '', 'texto', 'prompt_imagen', 'composicion'],
            ...storyboard.miniaturas.map((m, i) => [i + 1, '', m.texto, conEstilo(m.prompt_imagen), m.composicion])];
        const blob = new Blob(['\ufeff' + filas.map((f) => f.map(celda).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const nombre = ($('gTema').value || 'storyboard').replace(/[^\w\sáéíóúñ-]/gi, '').trim().slice(0, 60) || 'storyboard';
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${nombre}.csv` });
        document.body.append(a); a.click(); a.remove();
    }
});
$('btnStoryboard').addEventListener('click', async () => {
    const guion = $('gTexto').value.trim() || $('iaGuion').textContent.trim();
    if (!guion || guion.startsWith('⚠')) return alert('Primero escribe o pega el guion (pestaña Guion).');
    const b = $('btnStoryboard'), txt = b.textContent;
    b.disabled = true; b.textContent = 'Claude está preparando el storyboard…';
    $('outStoryboard').innerHTML = '<p class="hint">Puede tardar 1–2 minutos…</p>';
    try {
        const sb = await api('/api/storyboard', json('POST', {
            guion, titulo: $('gTema').value, estilo: $('sbEstilo').value, canal: canalActivo(), short: esShort(),
            ideaId: MODO_DB ? ideaEnGuion?.id : undefined,
        }));
        pintarStoryboard(sb);
        if (ideaEnGuion) { ideaEnGuion.storyboard = sb; ideaEnGuion.tiene_storyboard = true; if (!MODO_DB) store.set('ef_pipeline', pipeline); }
    } catch (err) { $('outStoryboard').innerHTML = `<p class="error">⚠ ${esc(err.message)}</p>`; }
    finally { b.disabled = false; b.textContent = txt; }
});

// ---------- Vídeo con Fliki ----------
const FK_ESTILOS = { biblical: 'Bíblico', cinematic: 'Cinematográfico', realistic: 'Realista', illustration: 'Ilustración',
    fantasyArt: 'Arte fantástico', waterColor: 'Acuarela', filmNoir: 'Cine negro', anime: 'Anime', comicBook: 'Cómic',
    threeDimensionModel: '3D', lineArt: 'Dibujo de línea', modelingCompound: 'Plastilina', whimsical: 'Caprichoso',
    tinyWorld: 'Mundo en miniatura', technicalIllustration: 'Ilustración técnica' };
const FK_ANIM = { 'Mix:Subtle Flow': 'Suave (recomendado)', Mix: 'Mixta', 'Mix:Dramatic': 'Dramática', None: 'Sin animación' };
const FK_MAX = 10000; // límite de caracteres por vídeo de la API de Fliki
const FK_ESTADOS = { queued: 'En cola', processing: 'Procesando', success: 'Listo', error: 'Error', canceled: 'Cancelado' };
$('fkEstilo').innerHTML = Object.entries(FK_ESTILOS).map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
$('fkAnim').innerHTML = Object.entries(FK_ANIM).map(([v, t]) => `<option value="${v}">${t}</option>`).join('');

// Texto para Fliki: las escenas del storyboard (una por línea) o el guion sin las marcas [VISUAL: …].
function textoFliki() {
    if ($('fkEscenas').checked && storyboard?.escenas?.length) {
        return { lineas: storyboard.escenas.map((e) => e.narracion.replace(/\s+/g, ' ').trim()).filter(Boolean), porLineas: true };
    }
    const guion = soloNarracion($('gTexto').value.trim() || $('iaGuion').textContent.trim());
    if (/\[VERIFICAR/i.test($('gTexto').value)) alert('Aviso: el guion tiene marcas [VERIFICAR]. Se quitan al enviarlo, pero comprueba esos datos antes de publicar.');
    return { lineas: guion.split(/\n+/).map((l) => l.trim()).filter(Boolean), porLineas: false };
}
let fkTimer = null;
function pintarFliki(est) {
    clearTimeout(fkTimer);
    if (!est) { $('outFliki').innerHTML = ''; return; }
    const pendiente = est.archivos.some((a) => !['success', 'error', 'canceled'].includes(a.estado));
    $('outFliki').innerHTML = `<p class="hint">Creado el ${new Date(est.creado).toLocaleString('es')} por ${esc(est.por)} · estilo ${esc(FK_ESTILOS[est.estilo] || est.estilo)}</p>
        ${est.archivos.map((a) => `<div class="escena"><b>${est.archivos.length > 1 ? `Parte ${a.parte}: ` : ''}${esc(FK_ESTADOS[a.estado] || a.estado)}</b>
            ${a.estado === 'success' ? '' : `<progress max="100" value="${a.progreso || 0}"></progress> ${a.progreso || 0}%`}
            <div>${a.descarga ? `<a class="boton" href="${esc(a.descarga)}" target="_blank" rel="noopener">Descargar MP4</a>` : ''}
            <a class="boton gris" href="https://app.fliki.ai/editor/${encodeURIComponent(a.id)}" target="_blank" rel="noopener">Abrir en el editor de Fliki</a></div></div>`).join('')}
        ${pendiente ? '<button class="mini" id="fkActualizar">Actualizar estado</button> <small class="hint">Se actualiza solo cada minuto.</small>' : ''}`;
    if (pendiente) fkTimer = setTimeout(() => actualizarFliki(), 65000);
}
async function actualizarFliki() {
    if (!ideaEnGuion?.id) return;
    try {
        const est = await api(`/api/fliki/estado?ideaId=${ideaEnGuion.id}`);
        ideaEnGuion.fliki = est;
        pintarFliki(est);
    } catch (err) { $('outFliki').insertAdjacentHTML('beforeend', `<p class="error">⚠ ${esc(err.message)}</p>`); }
}
$('outFliki').addEventListener('click', (e) => { if (e.target.id === 'fkActualizar') actualizarFliki(); });

$('btnFliki').addEventListener('click', async () => {
    if (!MODO_DB || !ideaEnGuion?.id) return alert('Abre el guion desde una idea del pipeline (botón «Guion» o «Escribir guion») para poder seguir el vídeo.');
    const { lineas, porLineas } = textoFliki();
    if (!lineas.length) return alert('No hay guion. Escríbelo o pégalo en el revisor.');
    const texto = lineas.join('\n');
    const minutos = minutosDe(texto);
    if (minutos > limiteMin() * 1.1 || texto.length > FK_MAX) {
        return alert(`El guion dura ~${duracionTxt(minutos)} (${texto.length.toLocaleString('es')} caracteres). El máximo es ${esShort() ? '60 segundos para un Short' : MAX_MIN + ' minutos'}: recórtalo en el revisor y guárdalo.`);
    }
    if (ideaEnGuion.fliki && !confirm('Esta idea ya tiene un vídeo en Fliki. ¿Crear otro? (gasta créditos de nuevo)')) return;
    if (!confirm(`Se enviará ${esShort() ? 'un Short' : 'un vídeo'} de ~${duracionTxt(minutos)} a Fliki, con estilo «${FK_ESTILOS[$('fkEstilo').value]}»${$('fkModelo').value ? ` y clips de vídeo IA en el ${$('fkClip').value}% de escenas (más caro)` : ''}. Gasta créditos de tu plan. ¿Continuar?`)) return;
    const b = $('btnFliki'), txt = b.textContent;
    b.disabled = true; b.textContent = 'Enviando a Fliki…';
    try {
        const est = await api('/api/fliki/video', json('POST', {
            ideaId: ideaEnGuion.id, titulo: $('gTema').value, partes: [texto], lineas: porLineas,
            aspectRatio: $('fkFormato').value, artStyle: $('fkEstilo').value, animacion: $('fkAnim').value,
            modeloVideo: $('fkModelo').value, clipPct: +$('fkClip').value || 0, musica: +$('fkMusica').value,
            subtitulos: $('fkSubs').checked, pausas: $('fkPausas').checked, efectos: $('fkSfx').checked,
        }));
        ideaEnGuion.fliki = est;
        pintarFliki(est);
        pintarPipeline();
    } catch (err) { $('outFliki').innerHTML = `<p class="error">⚠ ${esc(err.message)}</p>`; }
    finally { b.disabled = false; b.textContent = txt; }
});

$('btnAlRevisor').addEventListener('click', () => { $('gTexto').value = $('iaGuion').textContent; $('btnRevisar').click(); });

// ---------- Equipo (solo con base de datos) ----------
async function activarEquipo(e) {
    MODO_DB = true;
    $('barraSesion').hidden = false;
    $('nombreSesion').textContent = e.usuario + (e.admin ? ' (admin)' : '');
    if (e.admin) { $('tabEquipo').hidden = false; $('tabConfig').hidden = false; }
    try {
        [pipeline, playbooks] = await Promise.all([api('/api/ideas'), api('/api/playbooks')]);
        pintarPipeline(); pintarLista(); aplicarCanal();
        if (e.admin) { pintarUsuarios(); pintarConfig(); }
    } catch (err) { fallo(err); }
}

$('btnSalir').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    location.href = '/login.html';
});
$('btnMiPassword').addEventListener('click', async () => {
    const password = prompt('Nueva contraseña (mínimo 8 caracteres):');
    if (!password) return;
    try { await api('/api/password', json('POST', { password })); alert('Contraseña cambiada. Se han cerrado tus otras sesiones.'); }
    catch (err) { fallo(err); }
});

async function pintarUsuarios() {
    const lista = await api('/api/usuarios').catch((err) => { fallo(err); return []; });
    $('listaUsuarios').innerHTML = lista.map((u) => `<tr><td>${esc(u.nombre)}</td><td>${u.admin ? 'Admin' : 'Miembro'}</td>
        <td>${new Date(u.creado_en).toLocaleDateString('es')}</td>
        <td><button class="copy" data-reset="${esc(u.nombre)}">Nueva contraseña</button>
        <button class="copy" data-borrar="${esc(u.nombre)}">Eliminar</button></td></tr>`).join('');
}
$('formUsuario').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
        await api('/api/usuarios', json('POST', { nombre: f.nombre.value, password: f.password.value, admin: f.admin.checked }));
        f.reset(); pintarUsuarios();
    } catch (err) { fallo(err); }
});
$('listaUsuarios').addEventListener('click', async (ev) => {
    const { reset, borrar } = ev.target.dataset;
    try {
        if (reset) {
            const password = prompt(`Nueva contraseña para ${reset} (mínimo 8 caracteres):`);
            if (!password) return;
            await api(`/api/usuarios/${encodeURIComponent(reset)}/password`, json('POST', { password }));
            alert('Contraseña cambiada. Sus sesiones abiertas se han cerrado.');
        }
        if (borrar && confirm(`¿Eliminar a ${borrar}? Perderá el acceso.`)) {
            await api(`/api/usuarios/${encodeURIComponent(borrar)}`, { method: 'DELETE' });
            pintarUsuarios();
        }
    } catch (err) { fallo(err); }
});

// ---------- Configuración (solo administradores) ----------
let fkVoces = [];
async function cargarVoces(refrescar) {
    const b = $('btnFkVoces'); b.disabled = true; b.textContent = 'Cargando…';
    try {
        const r = await api('/api/fliki/voces' + (refrescar ? '?refrescar' : ''));
        fkVoces = r.voces;
        $('fkVoz').innerHTML = '<option value="">— elige una voz —</option>' + fkVoces.map((v) =>
            `<option value="${esc(v.id)}"${v.id === r.voz ? ' selected' : ''}>${esc(v.nombre)}${v.dialecto ? ` (${esc(v.dialecto)})` : ''} · ${esc(v.genero || '')}${v.ultra ? ' · ultrarrealista' : ''}</option>`).join('');
        $('fkVoz').dispatchEvent(new Event('change'));
    } catch (err) { fallo(err); }
    finally { b.disabled = false; b.textContent = 'Cargar voces'; }
}
$('btnFkVoces').addEventListener('click', () => cargarVoces(fkVoces.length > 0));
$('fkVoz').addEventListener('change', () => {
    const v = fkVoces.find((x) => x.id === $('fkVoz').value);
    $('fkMuestra').hidden = !v?.muestra;
    if (v?.muestra) $('fkMuestra').src = v.muestra;
});
$('btnFkVoz').addEventListener('click', async () => {
    const v = fkVoces.find((x) => x.id === $('fkVoz').value);
    if (!v) return alert('Carga las voces y elige una.');
    try {
        await api('/api/configuracion', json('PUT', { clave: 'FLIKI_VOICE_ID', valor: v.id }));
        await api('/api/configuracion', json('PUT', { clave: 'FLIKI_VOICE_NAME', valor: v.nombre }));
        await pintarConfig();
        alert(`Voz «${v.nombre}» guardada.`);
    } catch (err) { fallo(err); }
});
const ORIGEN = { web: 'guardada desde la web', cloudflare: 'secreto de Cloudflare' };
async function pintarConfig() {
    let c;
    try { c = await api('/api/configuracion'); } catch (err) { return fallo(err); }
    $('cfgModelo').innerHTML = c.modelos.map((m) => `<option${m === c.ajustes.CLAUDE_MODEL.valor ? ' selected' : ''}>${m}</option>`).join('');
    const vz = c.ajustes.FLIKI_VOICE_NAME;
    $('fkVozActual').textContent = vz?.valor ? `Voz actual: ${vz.valor}` : 'Sin voz elegida.';
    const ws = document.querySelector('form.ajuste [name=workspace]');
    if (ws) ws.value = c.workspace || '';
    document.querySelectorAll('form.ajuste').forEach((f) => {
        const a = c.ajustes[f.dataset.clave];
        f.querySelector('.actual').textContent = !a.origen ? 'Sin configurar.'
            : `Actual: ${a.valor} (${ORIGEN[a.origen]}${a.por ? ', por ' + a.por + ' el ' + new Date(a.en).toLocaleDateString('es') : ''}).`;
    });
}
document.querySelectorAll('form.ajuste').forEach((f) => f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const campo = f.querySelector('input:not([name=workspace]), select'), boton = f.querySelector('button'), txt = boton.textContent;
    if (!campo.value && !confirm('¿Borrar esta clave guardada?')) return;
    boton.disabled = true; boton.textContent = 'Comprobando…';
    try {
        await api('/api/configuracion', json('PUT', { clave: f.dataset.clave, valor: campo.value, workspace: f.workspace?.value }));
        if (campo.tagName === 'INPUT') campo.value = '';
        await pintarConfig();
        const e = await api('/api/estado');
        $('estadoApi').textContent = `Sesión: ${e.usuario} · Conexiones: YouTube ${e.youtube ? '✓' : '✗ (falta clave)'} · Claude ${e.claude ? '✓ ' + e.modelo : '✗ (falta clave)'}`;
        alert('Guardado.');
    } catch (err) { fallo(err); }
    finally { boton.disabled = false; boton.textContent = txt; }
}));

// Al cambiar de pestaña, que la pestaña activa quede visible en la barra deslizable (móvil).
$('tabs').addEventListener('click', (e) => e.target.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: 'smooth' }));
