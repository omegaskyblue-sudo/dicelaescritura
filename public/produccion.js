// YAiContenido — producción automática: series, «Producir» (guion → corrección → paquete → Shorts),
// calendario y capítulos desde .srt. Usa las funciones y el estado de plataforma.js.

// ---------- Utilidades ----------
const pad2 = (n) => String(n).padStart(2, '0');
const fechaISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
// Suma días a 'AAAA-MM-DD' y devuelve 'AAAA-MM-DD'
function sumarDias(dia, n) {
    const [a, m, d] = dia.split('-').map(Number);
    const f = new Date(Date.UTC(a, m - 1, d + n));
    return `${f.getUTCFullYear()}-${pad2(f.getUTCMonth() + 1)}-${pad2(f.getUTCDate())}`;
}
function proximoDomingo() {
    const d = new Date();
    d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7));
    return fechaISO(d);
}
// Shorts de un episodio: el primero el mismo día y a la misma hora; el resto, cada 2 días a la hora de los Shorts.
function fechaShort(diaEpisodio, j, horaLargo, horaShort) {
    return j === 0 ? `${diaEpisodio} ${horaLargo}` : `${sumarDias(diaEpisodio, 2 * j)} ${horaShort}`;
}
$('srInicio').value = proximoDomingo();

function log(msg, tipo = '') {
    const el = $('prodLog');
    el.hidden = false;
    el.insertAdjacentHTML('beforeend', `<div class="${tipo}">${new Date().toLocaleTimeString('es')} · ${msg}</div>`);
    el.scrollTop = el.scrollHeight;
}

// Mismas reglas que el revisor de la pestaña Guion.
function analizarGuion(txt, short) {
    const limpio = soloNarracion(txt);
    const problemas = [];
    for (const p of PATRONES) {
        const casos = limpio.match(p.re) || [];
        if (casos.length) problemas.push(`${p.nombre}: ${casos.slice(0, 3).map((c) => `«${c.trim()}»`).join(', ')}`);
    }
    const frases = limpio.split(/[.!?…]+/).map((f) => f.trim().split(/\s+/).filter(Boolean).length).filter((n) => n > 0);
    const media = frases.reduce((a, b) => a + b, 0) / (frases.length || 1);
    const cv = Math.sqrt(frases.reduce((a, b) => a + (b - media) ** 2, 0) / (frases.length || 1)) / (media || 1);
    if (frases.length >= 8 && cv < 0.45) problemas.push('Ritmo monótono: alterna frases muy cortas con otras largas');
    const min = minutosDe(limpio), max = short ? 1 : MAX_MIN;
    if (min > max) problemas.push(`Demasiado largo (${short ? Math.round(min * 60) + ' s' : min.toFixed(1) + ' min'}): recórtalo a unas ${Math.round(max * PALABRAS_MIN * 0.93)} palabras como máximo`);
    return { problemas, minutos: min };
}

const claudeTexto = (prompt, web = false) =>
    api('/api/claude', json('POST', { prompt, web })).then((r) => r.texto);

// ---------- Producir una idea ----------
let produciendo = false;
async function producirIdea(idea, { derivarShorts = true } = {}) {
    if (MODO_DB && idea.id) Object.assign(idea, await api(`/api/ideas/${idea.id}`));
    const short = idea.formato === 'short';
    log(`▶ <b>${esc(idea.titulo)}</b> ${short ? '(Short)' : '(vídeo largo)'}`);
    irAGuion({ titulo: idea.titulo, detalle: idea.detalle || '', idea }, false);

    // 1. Guion (si aún no tiene)
    let guion = idea.guion || '';
    if (!guion) {
        log('Claude escribe el guion…');
        guion = await claudeTexto($('outGuionPrompt').textContent, $('webGuion').checked);
    } else log('Ya tiene guion: se revisa.');

    // 2. Revisión y corrección automática (hasta 2 rondas)
    for (let ronda = 1; ronda <= 2; ronda++) {
        const { problemas, minutos } = analizarGuion(guion, short);
        if (!problemas.length) { log(`✓ Revisor sin avisos · ${short ? Math.round(minutos * 60) + ' s' : minutos.toFixed(1) + ' min'}`, 'ok-txt'); break; }
        log(`Revisor: ${problemas.length} aviso(s). Claude corrige (ronda ${ronda})…`);
        guion = await claudeTexto(`Corrige este guion de YouTube${short ? ' (Short de ≤ 60 s)' : ''} para resolver estos problemas, sin cambiar los datos, las citas ni la estructura:
${problemas.map((p) => '- ' + p).join('\n')}
Reescribe solo lo necesario. Mantén las marcas [VISUAL: …]. Devuelve únicamente el guion corregido, sin comentarios.

Guion:
${guion}`);
        if (ronda === 2) {
            const rest = analizarGuion(guion, short).problemas;
            log(rest.length ? `⚠ Quedan avisos para revisar a mano: ${esc(rest.join(' · '))}` : '✓ Corregido', rest.length ? 'warn-txt' : 'ok-txt');
        }
    }
    await guardarGuion(idea, guion, 'Edición');
    $('gTexto').value = guion; $('iaGuion').textContent = guion; $('iaGuion').hidden = false;
    log('Guion guardado en la idea.');

    // 3. Paquete para Fliki
    log('Claude prepara el paquete para Fliki (personajes, títulos, descripción)…');
    const pb = playbooks[canalActivo()] || {};
    const pq = await api('/api/paquete', json('POST', {
        guion: soloNarracion(guion), titulo: idea.titulo, short,
        canal: [canalActivo(), tradicion()].filter(Boolean).join(' — '),
        estilo: $('sbEstilo').value || pb.estilo_imagen, personajesCanal: pb.personajes,
        ideaId: MODO_DB ? idea.id : undefined,
    }));
    idea.paquete = pq;
    if (!MODO_DB) store.set('ef_pipeline', pipeline);
    log('Paquete guardado.');

    // 4. Shorts derivados (solo vídeos largos que aún no tengan Shorts)
    const hijos = pipeline.filter((p) => p.padre_id && p.padre_id === idea.id);
    if (!short && derivarShorts && !hijos.length) {
        const n = Math.max(0, +$('srSh').value || 2);
        if (n) {
            log(`Claude deriva ${n} Shorts del guion…`);
            const { shorts } = await api('/api/ia/shorts', json('POST', { guion: soloNarracion(guion), titulo: idea.titulo, n, tradicion: tradicion() }));
            const [dia] = (idea.publicar_en || '').split(' ');
            for (const [j, s] of shorts.entries()) {
                const nuevo = await crearIdea(s.titulo, idea.nicho, 'Edición', `Short derivado de «${idea.titulo}»`, {
                    formato: 'short', serie: idea.serie || '', padre_id: idea.id || null,
                    publicar_en: dia ? fechaShort(dia, j + 1, $('srHoraLargo').value, $('srHoraShort').value) : null,
                });
                await guardarGuion(nuevo, s.guion);
            }
            log(`✓ ${shorts.length} Shorts creados en el pipeline (con guion; pulsa «Producir» en cada uno para su paquete).`, 'ok-txt');
        }
    }
    log(`✔ <b>${esc(idea.titulo)}</b> listo para Fliki. Ábrelo con «Guion» → «Paquete para Fliki».`, 'ok-txt');
    pintarPipeline(); pintarCalendario();
}

async function ejecutar(tarea) {
    if (produciendo) return alert('Ya hay una producción en marcha. Espera a que termine.');
    produciendo = true;
    document.body.classList.add('produciendo');
    try { await tarea(); }
    catch (err) { log(`⚠ ${esc(err.message)}`, 'error'); }
    finally { produciendo = false; document.body.classList.remove('produciendo'); }
}

$('pipeline').addEventListener('click', (e) => {
    const i = e.target.dataset.producir;
    if (i == null) return;
    const idea = pipeline[+i];
    if (idea.guion || idea.tiene_guion) {
        if (!confirm(`«${idea.titulo}» ya tiene guion. Se revisará, se corregirá si hace falta y se rehará el paquete. ¿Continuar?`)) return;
    }
    ejecutar(() => producirIdea(idea));
});

// ---------- Planificar una serie ----------
let planSerie = null;
$('btnSerie').addEventListener('click', () => ejecutar(async () => {
    const tema = $('srTema').value.trim();
    if (!tema) throw new Error('Escribe el tema de la serie.');
    const pb = playbooks[canalActivo()] || {};
    log(`Claude planifica la serie «${esc(tema)}»…`);
    planSerie = await api('/api/ia/serie', json('POST', {
        tema, episodios: +$('srEp').value || 3, shortsPorEpisodio: +$('srSh').value || 0,
        canal: canalActivo(), tradicion: tradicion(), ganadoras: pb.ganadoras || $('ideaGanadoras').value,
    }));
    const cada = Math.max(1, +$('srCada').value || 7), inicio = $('srInicio').value || proximoDomingo();
    const hL = $('srHoraLargo').value || '09:00', hS = $('srHoraShort').value || '19:00';
    planSerie.episodios.forEach((ep, k) => { ep.publicar_en = `${sumarDias(inicio, k * cada)} ${hL}`; });
    const porEp = {};
    planSerie.shorts.forEach((s) => {
        const k = Math.min(Math.max(1, s.episodio), planSerie.episodios.length) - 1;
        const j = porEp[k] = (porEp[k] ?? -1) + 1;
        s.k = k;
        s.publicar_en = fechaShort(planSerie.episodios[k].publicar_en.split(' ')[0], j, hL, hS);
    });
    $('outSerie').innerHTML = `<h4>${esc(planSerie.nombre)}</h4>
        ${planSerie.episodios.map((ep, k) => `<div class="propuesta"><b>${k + 1}. ${esc(ep.titulo)}</b> <small class="hint">📅 ${esc(fechaCorta(ep.publicar_en))}</small>
            <p>${esc(ep.angulo)}</p>
            ${planSerie.shorts.filter((s) => s.k === k).map((s) => `<p>▸ <span class="tag warn">Short</span> ${esc(s.titulo)} <small class="hint">📅 ${esc(fechaCorta(s.publicar_en))}</small></p>`).join('')}
        </div>`).join('')}
        <button id="btnCrearSerie">Crear todo en el pipeline</button>`;
    log('✓ Plan listo: revísalo y pulsa «Crear todo en el pipeline».', 'ok-txt');
}));

$('outSerie').addEventListener('click', (e) => {
    if (e.target.id !== 'btnCrearSerie' || !planSerie) return;
    ejecutar(async () => {
        const nicho = $('ideaNicho').value || (playbooks[canalActivo()] || {}).nicho || '';
        const ids = [];
        for (const ep of planSerie.episodios) {
            const idea = await crearIdea(ep.titulo, nicho, 'Idea', ep.angulo, { formato: 'largo', serie: planSerie.nombre, publicar_en: ep.publicar_en });
            ids.push(idea.id ?? null);
        }
        for (const s of planSerie.shorts) {
            await crearIdea(s.titulo, nicho, 'Idea', s.angulo, {
                formato: 'short', serie: planSerie.nombre, padre_id: ids[s.k], publicar_en: s.publicar_en,
            });
        }
        log(`✓ Serie «${esc(planSerie.nombre)}» creada: ${planSerie.episodios.length} episodios y ${planSerie.shorts.length} Shorts.`, 'ok-txt');
        $('outSerie').insertAdjacentHTML('beforeend', `<p><button class="ia" id="btnProducirSerie" data-serie="${esc(planSerie.nombre)}">Producir toda la serie</button>
            <small class="hint">Escribe y prepara cada pieza en orden. Puede tardar varios minutos por pieza; deja la pestaña abierta.</small></p>`);
        e.target.disabled = true;
        pintarCalendario();
    });
});

$('outSerie').addEventListener('click', (e) => {
    if (e.target.id !== 'btnProducirSerie') return;
    const serie = e.target.dataset.serie;
    const piezas = pipeline.filter((p) => p.serie === serie && !(p.guion || p.tiene_guion))
        .sort((a, b) => (a.publicar_en || '').localeCompare(b.publicar_en || '') || (a.formato === 'short') - (b.formato === 'short'));
    if (!piezas.length) return alert('Todas las piezas de la serie ya tienen guion.');
    if (!confirm(`Se producirán ${piezas.length} piezas con Claude (guion, corrección y paquete). Tardará un rato y consume uso de la API de Claude. ¿Continuar?`)) return;
    ejecutar(async () => {
        for (const [i, idea] of piezas.entries()) {
            log(`— Pieza ${i + 1} de ${piezas.length} —`);
            await producirIdea(idea, { derivarShorts: false }); // los Shorts ya están planificados en la serie
        }
        log(`✔ Serie «${esc(serie)}» producida. Siguiente paso: crear cada vídeo en Fliki con su paquete.`, 'ok-txt');
    });
});

// ---------- Calendario ----------
function pintarCalendario() {
    const items = pipeline.map((p, i) => ({ ...p, i })).filter((p) => p.publicar_en)
        .sort((a, b) => a.publicar_en.localeCompare(b.publicar_en));
    $('calendario').innerHTML = items.length ? `<p class="hint">Fechas y horas de España. Cámbialas aquí; en YouTube, programa con zona horaria «Madrid».</p>
        <table>${items.map((p) => `<tr>
            <td><input type="datetime-local" data-fecha="${p.i}" value="${esc(p.publicar_en.replace(' ', 'T'))}"></td>
            <td>${p.formato === 'short' ? '<span class="tag warn">Short</span> ' : ''}${esc(p.titulo)}${p.serie ? ` <small class="hint">· ${esc(p.serie)}</small>` : ''}</td>
            <td><span class="tag ${p.estado === 'Publicado' ? 'ok' : p.estado === 'Edición' ? 'warn' : 'bad'}">${esc(p.estado)}</span></td></tr>`).join('')}</table>`
        : '<p class="hint">Sin fechas todavía. Planifica una serie o asigna fechas a tus ideas.</p>';
}
$('calendario').addEventListener('change', async (e) => {
    const i = e.target.dataset.fecha;
    if (i == null) return;
    const idea = pipeline[+i], valor = e.target.value ? e.target.value.replace('T', ' ') : null;
    idea.publicar_en = valor;
    try {
        if (MODO_DB && idea.id) await api(`/api/ideas/${idea.id}`, json('PATCH', { publicar_en: valor }));
        else store.set('ef_pipeline', pipeline);
        pintarPipeline(); pintarCalendario();
    } catch (err) { fallo(err); }
});
// Repintar el calendario cuando cambie el pipeline (carga inicial, estados…)
const pintarPipelineBase = pintarPipeline;
pintarPipeline = function () { pintarPipelineBase(); pintarCalendario(); };
pintarCalendario();

// ---------- Capítulos desde .srt ----------
const aSeg = (t) => { const [h, m, s] = t.replace(',', '.').split(':').map(Number); return h * 3600 + m * 60 + s; };
const mmss = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}:${pad2(Math.floor(s / 60) % 60)}` : `${Math.floor(s / 60)}`) + `:${pad2(Math.floor(s % 60))}`;
function leerSrt(texto) {
    const cues = [];
    for (const b of texto.replace(/\r/g, '').split(/\n\n+/)) {
        const m = b.match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/);
        if (!m) continue;
        const txt = b.slice(b.indexOf(m[0]) + m[0].length).trim().replace(/\s+/g, ' ');
        if (txt) cues.push({ ini: aSeg(m[1]), fin: aSeg(m[2]), txt });
    }
    // Une fragmentos en frases completas para que Claude tenga contexto con tiempos
    const frases = [];
    let actual = null;
    for (const c of cues) {
        if (!actual) actual = { ini: c.ini, txt: c.txt };
        else actual.txt += ' ' + c.txt;
        if (/[.!?…»]\s*$/.test(c.txt)) { frases.push(actual); actual = null; }
    }
    if (actual) frases.push(actual);
    return { frases, duracion: cues.length ? cues[cues.length - 1].fin : 0 };
}
// Normas de YouTube: empieza en 0:00, al menos 3 capítulos y cada uno de 10 s o más.
function validarCapitulos(caps, duracion) {
    const ord = caps.map((c) => ({ s: Math.max(0, Math.round(c.segundo)), t: c.titulo.trim() }))
        .filter((c) => c.t && c.s < duracion).sort((a, b) => a.s - b.s);
    if (ord.length) ord[0].s = 0;
    const res = [];
    for (const c of ord) if (!res.length || c.s - res[res.length - 1].s >= 10) res.push(c);
    if (res.length && duracion - res[res.length - 1].s < 10) res.pop();
    return res;
}
$('capSrt').addEventListener('change', () => {
    const f = $('capSrt').files[0];
    if (!f) return;
    ejecutar(async () => {
        const { frases, duracion } = leerSrt(await f.text());
        if (!frases.length) throw new Error('No se han encontrado subtítulos con tiempos en el archivo.');
        $('outCapitulos').innerHTML = '<p class="hint">Claude está preparando los capítulos…</p>';
        const { capitulos } = await api('/api/ia/capitulos', json('POST', {
            duracion, transcripcion: frases.map((x) => `[${Math.round(x.ini)}] ${x.txt}`).join('\n').slice(0, 60000),
        }));
        const caps = validarCapitulos(capitulos, duracion);
        if (caps.length < 3) throw new Error('No han salido al menos 3 capítulos válidos; inténtalo de nuevo.');
        const texto = caps.map((c) => `${mmss(c.s)} ${c.t}`).join('\n');
        $('outCapitulos').innerHTML = `<p class="hint">Vídeo de ${mmss(duracion)} · ${caps.length} capítulos · pégalos al principio de la descripción de YouTube.</p>
            <textarea id="capTexto" rows="${caps.length + 1}" readonly>${esc(texto)}</textarea>
            <button class="mini" id="capCopiar">Copiar capítulos</button>`;
        if (ideaEnGuion) {
            ideaEnGuion.paquete = { ...(ideaEnGuion.paquete || {}), capitulos: texto };
            if (MODO_DB && ideaEnGuion.id) await api(`/api/ideas/${ideaEnGuion.id}`, json('PATCH', { paquete: ideaEnGuion.paquete }));
            else store.set('ef_pipeline', pipeline);
        }
    });
});
$('outCapitulos').addEventListener('click', (e) => { if (e.target.id === 'capCopiar') copiar($('capTexto').value, e.target); });

// Al abrir una idea, muestra sus capítulos si ya se generaron.
const irAGuionBase = irAGuion;
irAGuion = function (datos, navegar = true) {
    irAGuionBase(datos, navegar);
    const caps = datos.idea?.paquete?.capitulos;
    $('capSrt').value = '';
    $('outCapitulos').innerHTML = caps ? `<textarea id="capTexto" rows="${caps.split('\n').length + 1}" readonly>${esc(caps)}</textarea>
        <button class="mini" id="capCopiar">Copiar capítulos</button>` : '';
};
