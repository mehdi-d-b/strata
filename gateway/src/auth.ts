/**
 * Authentification & contrôle d'accès Strata (Phase 7).
 *
 * - Hashing : scrypt natif de Node (pas de dépendance à compiler).
 * - Sessions : jeton opaque en base (révocable), porté par un cookie httpOnly.
 * - Permissions : un droit = (rôle, scope = préfixe de tag, action). Le check est
 *   un *prefix match* sur le nom de tag, fidèle à la convention site.ligne.machine.mesure.
 */
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";

const scrypt = promisify(_scrypt);

const SESSION_COOKIE = "strata_session";
const SESSION_TTL_DAYS = 7;

// ─── Hashing ───────────────────────────────────────────────────────────────

/** Produit "scrypt$<saltHex>$<hashHex>". */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Vérifie un mot de passe contre un hash stocké, en temps constant. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ─── Type de l'utilisateur authentifié, attaché à la requête ────────────────

export type Grant = { scope: string; action: "read" | "write" | "admin" };
export type AuthUser = {
  id: number;
  username: string;
  display_name: string | null;
  roles: string[];
  grants: Grant[];
};

// On enrichit FastifyRequest avec l'utilisateur courant (ou null).
declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export async function createSession(
  pool: pg.Pool,
  userId: number,
): Promise<string> {
  const id = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000);
  await pool.query(
    "INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)",
    [id, userId, expires],
  );
  return id;
}

export async function destroySession(pool: pg.Pool, id: string): Promise<void> {
  await pool.query("DELETE FROM sessions WHERE id = $1", [id]);
}

/** Charge l'utilisateur (avec rôles + droits agrégés) depuis un jeton de session. */
export async function loadUserFromSession(
  pool: pg.Pool,
  sessionId: string,
): Promise<AuthUser | null> {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now() AND u.enabled`,
    [sessionId],
  );
  if (rows.length === 0) return null;
  const u = rows[0];

  const rolesRes = await pool.query(
    "SELECT role FROM user_roles WHERE user_id = $1",
    [u.id],
  );
  const roles = rolesRes.rows.map((r) => r.role);

  let grants: Grant[] = [];
  if (roles.length) {
    const grantsRes = await pool.query(
      "SELECT DISTINCT scope, action FROM grants WHERE role = ANY($1)",
      [roles],
    );
    grants = grantsRes.rows as Grant[];
  }
  return { id: u.id, username: u.username, display_name: u.display_name, roles, grants };
}

// ─── Cookies (helpers minimalistes, pas de dépendance) ──────────────────────

export function setSessionCookie(reply: FastifyReply, sessionId: string): void {
  reply.header(
    "set-cookie",
    `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_DAYS * 86400}`,
  );
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header("set-cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export function readSessionCookie(req: FastifyRequest): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return v.join("=");
  }
  return null;
}

// ─── Permissions ─────────────────────────────────────────────────────────────

/** Un scope de droit couvre-t-il un tag ? '*' ou '' = tout ; sinon préfixe. */
function scopeCovers(scope: string, tag: string): boolean {
  if (scope === "*" || scope === "") return true;
  return tag === scope || tag.startsWith(scope + ".");
}

/** L'utilisateur peut-il `action` sur `tag` ? (admin implique tout) */
export function can(
  user: AuthUser | null,
  action: "read" | "write" | "admin",
  tag = "*",
): boolean {
  if (!user) return false;
  for (const g of user.grants) {
    if (g.action === "admin" && scopeCovers(g.scope, tag)) return true;
    if (g.action === action && scopeCovers(g.scope, tag)) return true;
  }
  return false;
}

export function isAdmin(user: AuthUser | null): boolean {
  return !!user?.grants.some((g) => g.action === "admin");
}
