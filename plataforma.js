// Estudio Faceless — todo corre en el navegador, sin servidor.
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

document.querySelectorAll('button.copy').forEach((b) =>
    b.addEventListener('click', () => navigator.clipboard?.writeText($(b.dataset.copy).textContent)));

// ---------- 1. Outliers + MRV ----------
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

$('btnOutliers').addEventListener('click', () => {
    const rows = $('refVideos').value.split('\n').map((l) => l.split('|').map((x) => x.trim()))
        .filter((r) => r.length >= 2 && !isNaN(parseFloat(r[1])))
        .map(([titulo, v, d, m]) => ({ titulo, vistas: parseFloat(v), dias: parseFloat(d) || null, min: parseFloat(m) || null }));
    if (!rows.length) { $('outOutliers').innerHTML = '<p class="hint">No hay filas válidas.</p>'; return; }

    const med = median(rows.map((r) => r.vistas));
    const edadCanal = parseFloat($('refEdad').value);
    rows.forEach((r) => {
        r.ratio = r.vistas / med;
        r.reciente = r.dias != null && r.dias <= 90;
        r.viral = r.ratio >= 3 || r.vistas >= 500000;
        r.mejorable = r.min != null && r.min < 15; // margen para alargar a 20–40 min
        r.score = (r.reciente ? 1 : 0) + (r.viral ? 1 : 0) + (r.mejorable ? 1 : 0);
    });
    rows.sort((a, b) => b.score - a.score || b.ratio - a.ratio);

    const tag = (ok, txt) => `<span class="tag ${ok ? 'ok' : 'bad'}">${txt}</span>`;
    const canalNota = isNaN(edadCanal) ? '' :
        `<div class="card">Canal ${edadCanal <= 90 ? 'reciente (≤ 3 meses): buena señal de nicho abierto' : 'con más de 3 meses: busca un mercado o subnicho donde aún no exista'}. Mediana: ${Math.round(med).toLocaleString('es')} vistas.</div>`;
    $('outOutliers').innerHTML = canalNota + `<table><tr><th>Vídeo</th><th>Vistas</th><th>× mediana</th><th>MRV</th></tr>${
        rows.map((r) => `<tr><td>${esc(r.titulo)}</td><td>${r.vistas.toLocaleString('es')}</td><td>${r.ratio.toFixed(1)}×</td><td>${
            tag(r.mejorable, 'M')} ${tag(r.reciente, 'R')} ${tag(r.viral, 'V')}</td></tr>`).join('')}</table>
        <p class="hint">M = dura &lt; 15 min (mejorable en duración; revisa también formato y contenido a mano) · R = ≤ 90 días · V = ≥ 3× la mediana. Las ideas con M+R+V salen arriba: llévalas a la pestaña Ideas.</p>`;
});

// ---------- 2. Ideas ----------
const PALANCAS = {
    duracion: 'Amplía la idea a un vídeo de 20–40 minutos con más profundidad, contexto y ejemplos que el original.',
    formato: 'Propón un formato visual distinto al del referente (p. ej. documental con material de archivo/stock en vez de animación) y justifica por qué encaja.',
    mercado: 'Adapta la idea al mercado {mercado}: conserva solo lo que también interese a esa audiencia, cambia ejemplos, referencias y perspectiva culturales. Indica si hay demanda real en ambos mercados.',
    subnicho: 'Traslada la idea al subnicho "{nicho}" manteniendo el gancho que la hizo viral.',
    inverso: 'Aplica la técnica del título inverso: reordena y recombina las palabras clave para crear títulos nuevos con un ángulo diferente.',
    patron: 'Combina los patrones de mis ideas ganadoras con temas de actualidad de esta semana.',
};

$('btnIdea').addEventListener('click', () => {
    const ref = $('ideaRef').value || '(título referente)';
    const nicho = $('ideaNicho').value || 'mi nicho';
    const mercado = $('ideaMercado').value || 'hispanohablante';
    const pal = [...document.querySelectorAll('#ideas fieldset input:checked')].map((c) =>
        '- ' + PALANCAS[c.value].replace('{mercado}', mercado).replace('{nicho}', nicho));
    const gan = $('ideaGanadoras').value.trim();
    $('outIdea').textContent =
`Actúa como estratega de contenido para un canal de YouTube del nicho "${nicho}" dirigido al público ${mercado}.

Vídeo referente (reciente y viral): "${ref}"

Objetivo: no copiar, sino MEJORAR la idea aportando un valor diferencial claro y original.
Aplica estas palancas:
${pal.join('\n') || '- (elige al menos una palanca)'}
${gan ? `\nMis ideas ganadoras (patrones que ya funcionan en mi canal):\n${gan}\n` : ''}
Devuélveme 10 propuestas. Para cada una: título (máx. 60 caracteres), ángulo único en una frase, qué aporta que el referente no tiene, y concepto de miniatura (máx. 4 palabras de texto).`;
});

const pipeline = store.get('ef_pipeline', []);
const ESTADOS = ['Idea', 'Guion', 'Edición', 'Publicado', 'Descartada'];
function pintarPipeline() {
    $('pipeline').innerHTML = pipeline.map((p, i) => `<li><span>${esc(p.titulo)} <small class="hint">· ${esc(p.nicho)}</small></span>
        <select data-i="${i}">${ESTADOS.map((e) => `<option${e === p.estado ? ' selected' : ''}>${e}</option>`).join('')}</select>
        <button data-del="${i}" class="copy">✕</button></li>`).join('') || '<li class="hint">Vacío</li>';
}
$('pipeline').addEventListener('change', (e) => { pipeline[e.target.dataset.i].estado = e.target.value; store.set('ef_pipeline', pipeline); });
$('pipeline').addEventListener('click', (e) => {
    if (e.target.dataset.del == null) return;
    pipeline.splice(+e.target.dataset.del, 1); store.set('ef_pipeline', pipeline); pintarPipeline();
});
$('btnGuardarIdea').addEventListener('click', () => {
    const titulo = prompt('Título de la idea elegida:', $('ideaRef').value);
    if (!titulo) return;
    pipeline.push({ titulo, nicho: $('ideaNicho').value, estado: 'Idea', fecha: new Date().toISOString().slice(0, 10) });
    store.set('ef_pipeline', pipeline); pintarPipeline();
});
pintarPipeline();

// ---------- 3. Guion ----------
$('btnGuionPrompt').addEventListener('click', () => {
    const min = +$('gMin').value || 25;
    $('outGuionPrompt').textContent =
`Escribe un guion de narración para YouTube sobre: "${$('gTema').value || '(tema)'}".
Duración: ~${min} minutos (~${min * 140} palabras).

Intro (primeros 30 segundos, objetivo 75 % de retención): ${$('gIntro').value}. Promete algo concreto que el vídeo cumplirá.

Estilo — obligatorio:
- Investigación y aportación propias: datos concretos, fuentes verificables, una tesis original. Nada de relleno.
- Ritmo variado: alterna frases muy cortas con otras largas; cambia de tono; usa pausas y preguntas.
- Prohibido el recurso "No es X, es Y" y sus variantes.
- Prohibidas las cadenas de negaciones del tipo "No con A, no con B, no con C, sino con…".
- Evita las muletillas: "en definitiva", "sin duda", "cabe destacar", "en un mundo donde", "adentrémonos".
- Bloques de 2–4 minutos, cada uno cierra con un gancho hacia el siguiente.
Devuelve solo el texto narrado, con marcas [VISUAL: …] para el editor.`;
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
        <td><span class="tag ${metronomo ? 'warn' : 'ok'}">${metronomo ? 'monótono' : 'variado'}</span></td></tr></table>
        <div class="out">${marcado}</div>`;
});

// ---------- 4. Métricas ----------
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
});

// ---------- 5. Playbook ----------
const playbooks = store.get('ef_playbooks', {});
const pintarLista = () => { $('pbLista').innerHTML = Object.keys(playbooks).map((k) => `<option>${esc(k)}</option>`).join(''); };
const leerPb = () => Object.fromEntries([...document.querySelectorAll('[data-pb]')].map((el) => [el.dataset.pb, el.value]));

$('btnPbGuardar').addEventListener('click', () => {
    const nombre = $('pbCanal').value.trim();
    if (!nombre) { alert('Ponle nombre al canal'); return; }
    playbooks[nombre] = { ...leerPb(), actualizado: new Date().toISOString() };
    store.set('ef_playbooks', playbooks); pintarLista();
});
$('btnPbCargar').addEventListener('click', () => {
    const pb = playbooks[$('pbLista').value];
    if (!pb) return;
    $('pbCanal').value = $('pbLista').value;
    document.querySelectorAll('[data-pb]').forEach((el) => { el.value = pb[el.dataset.pb] ?? ''; });
});
$('btnPbExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ playbooks, pipeline }, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'estudio-faceless.json' });
    a.click();
});
pintarLista();
