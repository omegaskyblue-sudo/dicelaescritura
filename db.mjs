// Base de datos (Postgres): usuarios, sesiones e información compartida del equipo.
import pg from 'pg';
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const SESION_DIAS = 30;

export const pool = process.env.DATABASE_URL
    ? new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        // Render: conexiones internas sin SSL; externas lo requieren.
        ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    })
    : null;

const q = (sql, params) => pool.query(sql, params);

export async function migrar() {
    await q(`
        CREATE TABLE IF NOT EXISTS usuarios (
            nombre      text PRIMARY KEY,
            hash        text NOT NULL,
            admin       boolean NOT NULL DEFAULT false,
            creado_en   timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS sesiones (
            token_hash  text PRIMARY KEY,
            usuario     text NOT NULL REFERENCES usuarios(nombre) ON DELETE CASCADE,
            expira      timestamptz NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ideas (
            id          serial PRIMARY KEY,
            titulo      text NOT NULL,
            nicho       text NOT NULL DEFAULT '',
            estado      text NOT NULL DEFAULT 'Idea',
            creado_por  text,
            creado_en   timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS playbooks (
            canal           text PRIMARY KEY,
            datos           jsonb NOT NULL,
            actualizado_por text,
            actualizado_en  timestamptz NOT NULL DEFAULT now()
        );`);
}

// ---------- Contraseñas (scrypt con sal) ----------
async function hashear(pass) {
    const sal = randomBytes(16);
    return `${sal.toString('hex')}:${(await scrypt(pass, sal, 64)).toString('hex')}`;
}
async function verificar(pass, guardado) {
    const [sal, h] = guardado.split(':');
    return timingSafeEqual(await scrypt(pass, Buffer.from(sal, 'hex'), 64), Buffer.from(h, 'hex'));
}
const normaliza = (n) => String(n || '').trim().toLowerCase();
export function validarAlta(nombre, pass) {
    if (!/^[a-z0-9._-]{2,40}$/.test(nombre)) return 'Usuario: 2–40 caracteres (letras, números, . _ -)';
    if (typeof pass !== 'string' || pass.length < 8) return 'La contraseña debe tener al menos 8 caracteres';
    return null;
}

// Primera puesta en marcha: crea los usuarios de ACCESS_USERS si la tabla está vacía.
// El primero de la lista queda como administrador.
export async function sembrarUsuarios(lista) {
    const { rows } = await q('SELECT count(*)::int AS n FROM usuarios');
    if (rows[0].n > 0 || !lista.length) return 0;
    let i = 0;
    for (const [nombre, pass] of lista) {
        await q('INSERT INTO usuarios (nombre, hash, admin) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [normaliza(nombre), await hashear(pass), i++ === 0]);
    }
    return lista.length;
}

// ---------- Sesiones ----------
const hashToken = (t) => createHash('sha256').update(t).digest('hex');

export async function login(nombre, pass) {
    const { rows } = await q('SELECT nombre, hash FROM usuarios WHERE nombre = $1', [normaliza(nombre)]);
    // Comprobación con hash ficticio si no existe, para no revelar qué usuarios hay por tiempo de respuesta.
    const ok = await verificar(String(pass || ''), rows[0]?.hash || '00:' + '0'.repeat(128));
    if (!rows[0] || !ok) return null;
    const token = randomBytes(32).toString('base64url');
    await q(`INSERT INTO sesiones (token_hash, usuario, expira) VALUES ($1, $2, now() + interval '${SESION_DIAS} days')`,
        [hashToken(token), rows[0].nombre]);
    await q('DELETE FROM sesiones WHERE expira < now()');
    return { token, maxAge: SESION_DIAS * 86400 };
}

export async function usuarioDeSesion(token) {
    if (!token) return null;
    const { rows } = await q(`SELECT u.nombre, u.admin FROM sesiones s JOIN usuarios u ON u.nombre = s.usuario
        WHERE s.token_hash = $1 AND s.expira > now()`, [hashToken(token)]);
    return rows[0] || null;
}

export const logout = (token) => q('DELETE FROM sesiones WHERE token_hash = $1', [hashToken(token || '')]);

// ---------- Usuarios (solo administradores) ----------
export const listarUsuarios = async () =>
    (await q('SELECT nombre, admin, creado_en FROM usuarios ORDER BY nombre')).rows;

export async function crearUsuario(nombre, pass, admin) {
    nombre = normaliza(nombre);
    const err = validarAlta(nombre, pass);
    if (err) return err;
    const r = await q('INSERT INTO usuarios (nombre, hash, admin) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [nombre, await hashear(pass), !!admin]);
    return r.rowCount ? null : 'Ese usuario ya existe';
}

export async function borrarUsuario(nombre, quien) {
    nombre = normaliza(nombre);
    if (nombre === quien) return 'No puedes borrarte a ti mismo';
    await q('DELETE FROM usuarios WHERE nombre = $1', [nombre]);
    return null;
}

// Cambia la contraseña y cierra todas las sesiones de ese usuario salvo la actual.
export async function cambiarPassword(nombre, pass, tokenActual) {
    if (typeof pass !== 'string' || pass.length < 8) return 'La contraseña debe tener al menos 8 caracteres';
    const r = await q('UPDATE usuarios SET hash = $2 WHERE nombre = $1', [normaliza(nombre), await hashear(pass)]);
    if (!r.rowCount) return 'Usuario no encontrado';
    await q('DELETE FROM sesiones WHERE usuario = $1 AND token_hash <> $2', [normaliza(nombre), hashToken(tokenActual || '')]);
    return null;
}

// ---------- Ideas (pipeline compartido) ----------
export const listarIdeas = async () =>
    (await q('SELECT id, titulo, nicho, estado, creado_por, creado_en FROM ideas ORDER BY creado_en DESC')).rows;
export const crearIdea = async ({ titulo, nicho }, usuario) =>
    (await q('INSERT INTO ideas (titulo, nicho, creado_por) VALUES ($1, $2, $3) RETURNING *',
        [String(titulo).slice(0, 300), String(nicho || '').slice(0, 100), usuario])).rows[0];
export const cambiarEstadoIdea = (id, estado) => q('UPDATE ideas SET estado = $2 WHERE id = $1', [id, estado]);
export const borrarIdea = (id) => q('DELETE FROM ideas WHERE id = $1', [id]);

// ---------- Playbooks ----------
export async function listarPlaybooks() {
    const { rows } = await q('SELECT canal, datos, actualizado_por, actualizado_en FROM playbooks ORDER BY canal');
    return Object.fromEntries(rows.map((r) => [r.canal, { ...r.datos, actualizado: r.actualizado_en, actualizado_por: r.actualizado_por }]));
}
export const guardarPlaybook = (canal, datos, usuario) => q(`
    INSERT INTO playbooks (canal, datos, actualizado_por) VALUES ($1, $2, $3)
    ON CONFLICT (canal) DO UPDATE SET datos = EXCLUDED.datos, actualizado_por = EXCLUDED.actualizado_por, actualizado_en = now()`,
    [String(canal).slice(0, 120), datos, usuario]);
