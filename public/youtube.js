// Conexión con YouTube (OAuth) y subida/programación de vídeos.
(function () {
    const pintarConexion = async () => {
        try {
            const e = await api('/api/youtube/estado');
            $('ytRedirect').textContent = e.redirect;
            $('ytConexion').textContent = e.conectado ? `✓ Conectado a «${e.canal?.titulo || 'tu canal'}»`
                : e.configurado ? 'Sin conectar: pulsa «Conectar canal de YouTube».' : 'Guarda el ID y el secreto de cliente.';
            $('btnYtDesconectar').hidden = !e.conectado;
        } catch { /* no admin o sin servidor */ }
    };
    $('btnYtConectar').addEventListener('click', () => { location.href = '/api/youtube/oauth/inicio'; });
    $('btnYtDesconectar').addEventListener('click', async () => {
        if (!confirm('¿Desconectar el canal de YouTube?')) return;
        await api('/api/youtube/desconectar', { method: 'POST' }).catch((e) => alert(e.message));
        pintarConexion();
    });
    const aviso = new URLSearchParams(location.search).get('youtube');
    if (aviso) {
        const textos = { conectado: '✓ Canal de YouTube conectado.', cancelado: 'Conexión cancelada.',
            'sin-refresh': 'Google no devolvió permiso permanente. Quita el acceso en myaccount.google.com/permissions y vuelve a conectar.',
            'error-estado': 'La conexión caducó; inténtalo de nuevo.', error: 'No se pudo conectar con YouTube.' };
        alert(textos[aviso] || aviso);
        history.replaceState(null, '', location.pathname);
        document.querySelector('[data-tab="configuracion"]')?.click();
    }
    pintarConexion();

    // Rellena el formulario al abrir una idea en Guion.
    const base = irAGuion;
    irAGuion = function (datos, navegar = true) {
        base(datos, navegar);
        const i = datos.idea || {};
        const pq = i.paquete || {};
        $('ytTitulo').value = pq.titulos?.[0] || i.titulo || datos.titulo || '';
        $('ytLista').value = i.serie || '';
        $('ytFecha').value = (i.publicar_en || '').replace(' ', 'T').slice(0, 16);
        $('ytVideo').value = $('ytMini').value = $('ytSrt').value = '';
        $('ytProgreso').hidden = true;
        $('outYt').innerHTML = i.youtube ? resumen(i.youtube) : '';
    };
    const resumen = (y) => `<p>✓ <a href="${esc(y.url)}" target="_blank" rel="noopener">${esc(y.url)}</a> ·
        ${y.publishAt ? 'programado para ' + new Date(y.publishAt).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' }) + ' (España)' : esc(y.privacidad || '')}
        ${y.hecho?.length ? ' · ' + esc(y.hecho.join(', ')) : ''}</p>${(y.avisos || []).map((a) => `<p class="hint">⚠ ${esc(a)}</p>`).join('')}`;

    $('btnYtSubir').addEventListener('click', async () => {
        const out = $('outYt'), btn = $('btnYtSubir'), video = $('ytVideo').files[0];
        if (!ideaEnGuion?.id) return (out.textContent = 'Abre primero una idea del pipeline (botón «Guion»).');
        if (!video) return (out.textContent = 'Elige el archivo de vídeo.');
        btn.disabled = true;
        try {
            out.textContent = 'Preparando…';
            const { token, metadatos } = await api('/api/youtube/iniciar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ideaId: ideaEnGuion.id, titulo: $('ytTitulo').value.trim(), categoria: $('ytCat').value,
                    programar: $('ytProgramar').checked, publicar_en: $('ytFecha').value, sintetico: $('ytSintetico').checked }) });
            const ini = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8',
                    'X-Upload-Content-Type': video.type || 'video/mp4', 'X-Upload-Content-Length': String(video.size) },
                body: JSON.stringify(metadatos),
            });
            if (!ini.ok) throw new Error('YouTube: ' + ((await ini.json().catch(() => ({}))).error?.message || ini.status));
            const destino = ini.headers.get('Location');
            const prog = $('ytProgreso'); prog.hidden = false; prog.value = 0;
            const subido = await new Promise((ok, mal) => {
                const x = new XMLHttpRequest();
                x.open('PUT', destino);
                x.setRequestHeader('Content-Type', video.type || 'video/mp4');
                x.upload.onprogress = (e) => { if (e.lengthComputable) { prog.value = e.loaded / e.total * 100; out.textContent = `Subiendo… ${Math.round(prog.value)} %`; } };
                x.onload = () => { try { const d = JSON.parse(x.responseText); x.status < 300 ? ok(d) : mal(new Error('YouTube: ' + (d.error?.message || x.status))); } catch { mal(new Error('Respuesta no válida de YouTube')); } };
                x.onerror = () => mal(new Error('Se cortó la subida. Inténtalo de nuevo.'));
                x.send(video);
            });
            out.textContent = 'Vídeo subido. Añadiendo miniatura, subtítulos y lista…';
            const fd = new FormData();
            fd.append('ideaId', ideaEnGuion.id); fd.append('videoId', subido.id); fd.append('lista', $('ytLista').value.trim());
            if ($('ytMini').files[0]) fd.append('miniatura', $('ytMini').files[0]);
            if ($('ytSrt').files[0]) fd.append('subtitulos', $('ytSrt').files[0]);
            const y = await api('/api/youtube/finalizar', { method: 'POST', body: fd });
            out.innerHTML = resumen(y);
            const p = pipeline.find((x) => x.id === ideaEnGuion.id); if (p) { p.estado = 'Programado'; p.youtube = y; pintarPipeline(); }
        } catch (e) {
            out.textContent = '✗ ' + e.message;
        } finally { btn.disabled = false; }
    });
})();
