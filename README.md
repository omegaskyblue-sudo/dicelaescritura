# dicelaescritura

## YAiContenido

Herramienta para canales de YouTube faceless: referentes y factor MRV → ideas → guion → métricas → playbook.
Funciona en **Cloudflare Workers** con base de datos **D1**:

- Inicio de sesión con usuarios; los administradores gestionan el equipo desde la pestaña **Equipo**.
- Pipeline de ideas y playbooks compartidos por todo el equipo.
- **Importar desde YouTube** (YouTube Data API v3) y **Enviar a Claude** (Claude API).
- Las claves son secretos del Worker: el navegador nunca las ve.

En GitHub Pages (`public/`) la web funciona en modo manual, sin login, YouTube ni Claude.

### Estructura

| Ruta | Qué es |
|---|---|
| `public/` | Web (HTML/CSS/JS) |
| `src/worker.js` | Servidor: login, API, proxy a YouTube y Claude |
| `migrations/` | Esquema de la base de datos D1 |
| `wrangler.jsonc` | Configuración de Cloudflare |

### Publicar en Cloudflare (desde el panel, sin terminal)

1. **Crear la base de datos**: dash.cloudflare.com → *Storage & Databases* → *D1 SQL Database* →
   *Create* → nombre `yaicontenido` (ya creada; su ID está en `wrangler.jsonc`).
2. **Crear las tablas**: en esa base de datos → *Console* → pega el contenido de
   `migrations/0001_inicial.sql` → *Execute*; repite con `migrations/0002_configuracion.sql`.
   (Las columnas posteriores, como el guion de cada idea, las añade el Worker solo.)
3. **Poner el ID** en `wrangler.jsonc` (`database_id`) y subirlo al repositorio.
4. **Crear el Worker**: *Workers & Pages* → *Create* → *Import a repository* → este repositorio y la rama.
   Comando de despliegue: `npx wrangler deploy` (el que propone por defecto).
5. **Secreto**: en el Worker → *Settings* → *Variables and Secrets* → añade como **Secret**:
   - `ACCESS_USERS`: usuarios iniciales `usuario:contraseña` separados por comas. **El primero es administrador.**
     Solo se usa mientras la base de datos no tiene usuarios; después se gestionan desde la web.
6. Las claves de Claude y YouTube se ponen desde la web: pestaña **Configuración** (solo administradores).
   Se comprueban antes de guardarse y nunca se vuelven a mostrar completas.
   (También pueden ponerse como secretos `ANTHROPIC_API_KEY` / `YOUTUBE_API_KEY`; la web tiene prioridad.)
7. Abre `https://yaicontenido.<tu-subdominio>.workers.dev/plataforma.html` e inicia sesión.
   Cambia la contraseña nada más entrar.

### Publicar desde la terminal (alternativa)

```bash
npm install
npx wrangler login
npx wrangler d1 create yaicontenido          # copia el database_id a wrangler.jsonc
npm run db:migrar                            # crea las tablas en Cloudflare
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put YOUTUBE_API_KEY
npx wrangler secret put ACCESS_USERS
npm run deploy
```

### Desarrollo local

```bash
npm install
cp .dev.vars.example .dev.vars               # rellena las claves
npm run db:migrar:local
npm run dev                                  # http://localhost:8787/plataforma.html
```

### Notas

- Sesiones de 30 días. Contraseñas con PBKDF2-SHA256 (100 000 iteraciones, con sal), mínimo 8 caracteres.
- Tras 10 intentos de login fallidos desde una IP, se bloquea 15 minutos.
- **Plan gratuito de Cloudflare**: suficiente para un equipo pequeño; no se duerme y la base de datos no caduca.
  Si al iniciar sesión aparece el error *1102 (Worker exceeded resource limits)*, activa *Workers Paid*
  (5 $/mes): verificar contraseñas puede superar el límite de CPU del plan gratuito.
- **Fliki (vídeo):** en *Configuración* pon la clave de API de Fliki (plan Premium), carga y elige una voz en español y,
  opcionalmente, el ID de tu kit de marca. En *Guion → Vídeo con Fliki* se envía el guion (o las escenas del storyboard)
  con imágenes IA (estilo «Bíblico» por defecto).
- **Formato: vídeos de 10 minutos como máximo** (~1.400 palabras). El prompt de guion lo impone, el revisor muestra la
  duración estimada y Fliki no envía guiones más largos (la API admite 10.000 caracteres por vídeo). Límite de Fliki: 10 peticiones cada 10 minutos, por eso el estado se consulta como mucho cada minuto.
- Restringe la clave de YouTube en Google Cloud a "YouTube Data API v3". Importar un canal gasta ~5 unidades
  de la cuota diaria gratuita (10 000).
