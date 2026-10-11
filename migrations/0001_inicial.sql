-- Esquema inicial de YAiContenido (Cloudflare D1 / SQLite)
CREATE TABLE IF NOT EXISTS usuarios (
    nombre     TEXT PRIMARY KEY,
    hash       TEXT NOT NULL,
    admin      INTEGER NOT NULL DEFAULT 0,
    creado_en  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS sesiones (
    token_hash TEXT PRIMARY KEY,
    usuario    TEXT NOT NULL REFERENCES usuarios(nombre) ON DELETE CASCADE,
    expira     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sesiones_usuario ON sesiones(usuario);
CREATE TABLE IF NOT EXISTS ideas (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo     TEXT NOT NULL,
    nicho      TEXT NOT NULL DEFAULT '',
    estado     TEXT NOT NULL DEFAULT 'Idea',
    creado_por TEXT,
    creado_en  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS playbooks (
    canal           TEXT PRIMARY KEY,
    datos           TEXT NOT NULL,
    actualizado_por TEXT,
    actualizado_en  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Intentos fallidos de inicio de sesión por IP
CREATE TABLE IF NOT EXISTS intentos (
    ip    TEXT PRIMARY KEY,
    n     INTEGER NOT NULL,
    desde INTEGER NOT NULL
);
