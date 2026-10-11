# dicelaescritura

## Estudio Faceless (`plataforma.html`)

Herramienta para canales de YouTube faceless: referentes y factor MRV → ideas → guion → métricas → playbook.

Sin servidor (GitHub Pages) funciona en modo manual. Con el servidor se activan:

- **Importar desde YouTube**: trae los últimos 100 vídeos de un canal (vistas, antigüedad, duración) y detecta outliers.
- **Enviar a Claude**: genera ideas y guiones directamente desde la plataforma.

### Arrancar

```bash
npm install
cp .env.example .env   # rellena ANTHROPIC_API_KEY y YOUTUBE_API_KEY
npm start              # http://localhost:3000/plataforma.html
```

- Clave de Claude: https://platform.claude.com → API Keys.
- Clave de YouTube: Google Cloud Console → habilita "YouTube Data API v3" → Credenciales → Clave de API.
  Importar un canal gasta ~5 unidades de la cuota diaria gratuita (10.000).

Las claves solo viven en el servidor (`.env`, ignorado por git); el navegador nunca las ve.

### Publicar en Render

1. En https://dashboard.render.com → **New → Blueprint** → conecta este repositorio y elige la rama.
   Render lee `render.yaml` y crea la web `estudio-faceless` y la base de datos Postgres `estudio-faceless-db`
   (la conexión entre ambas se configura sola).
2. Te pedirá tres variables secretas:
   - `ANTHROPIC_API_KEY` y `YOUTUBE_API_KEY`
   - `ACCESS_USERS`: usuarios iniciales en formato `usuario:contraseña` separados por comas,
     p. ej. `ana:Clave-larga-1`. **El primero será administrador.** Solo se usa la primera vez
     (cuando la base de datos no tiene usuarios); después se gestionan desde la web.
3. Abre `https://<tu-servicio>.onrender.com/plataforma.html` e inicia sesión.

### Usuarios y equipo

- **Administradores**: pestaña **Equipo** para añadir usuarios, poner una contraseña nueva o eliminarlos.
- **Todos**: botón *Cambiar contraseña* y *Salir* arriba. Las sesiones duran 30 días.
- El pipeline de ideas y los playbooks se guardan en Postgres y los ve todo el equipo
  (cada idea indica quién la creó; cada playbook, quién lo editó por última vez).
- Contraseñas guardadas con scrypt (nunca en claro). Mínimo 8 caracteres.
- Sin `DATABASE_URL` la plataforma funciona como antes: acceso con `ACCESS_USERS`/`ACCESS_PASSWORD`
  (ventana del navegador) y datos guardados en cada navegador.

**Plan gratuito de Render:** la web se duerme tras ~15 min sin uso (~1 min en despertar) y
**la base de datos gratuita caduca a los 30 días** salvo que pases a un plan de pago
(Basic, desde unos pocos $/mes). Exporta tus datos (botón *Exportar JSON*) si te quedas en el gratuito.
En la clave de YouTube, restringe en Google Cloud su uso a "YouTube Data API v3".
