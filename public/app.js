// Instalación como app (PWA): registra el service worker y ofrece el botón «Instalar app».
(function () {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    const instalada = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (instalada) return;
    let oculto = false;
    try { oculto = localStorage.getItem('yai_instalar_oculto') === '1'; } catch { /* sin almacenamiento */ }
    if (oculto) return;

    const barra = document.createElement('div');
    barra.className = 'instalar';
    barra.hidden = true;
    barra.innerHTML = '<img src="/icons/icon-192.png" alt=""><span></span><button class="si">Instalar</button><button class="no" aria-label="Cerrar">✕</button>';
    document.body.appendChild(barra);
    const texto = barra.querySelector('span'), si = barra.querySelector('.si');
    barra.querySelector('.no').onclick = () => {
        barra.hidden = true;
        try { localStorage.setItem('yai_instalar_oculto', '1'); } catch { /* sin almacenamiento */ }
    };

    let aviso = null;
    addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        aviso = e;
        texto.textContent = 'Instala YAiContenido como app';
        si.hidden = false;
        barra.hidden = false;
    });
    si.onclick = async () => {
        if (!aviso) return;
        aviso.prompt();
        await aviso.userChoice;
        aviso = null;
        barra.hidden = true;
    };
    addEventListener('appinstalled', () => { barra.hidden = true; });

    // iPhone/iPad: Safari no tiene botón de instalar; se explica cómo hacerlo.
    if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
        texto.textContent = 'Para instalar: pulsa Compartir ⎋ y luego «Añadir a pantalla de inicio»';
        si.hidden = true;
        barra.hidden = false;
    }
})();
