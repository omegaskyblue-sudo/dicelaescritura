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
