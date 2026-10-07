import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Seals secrets kept in the database (a connection's tokens, its event signing secret) with
 * AES-256-GCM. A sealed value names the key that sealed it, so a new key (LEAFDESK_ENCRYPTION_KEY)
 * can take over while old ones (LEAFDESK_ENCRYPTION_OLD_KEYS) still open what they sealed. Without
 * LEAFDESK_ENCRYPTION_KEY the key is derived from BETTER_AUTH_SECRET, under a label of its own, so
 * it is never the secret that signs sessions; that derived key keeps opening older values after an
 * explicit key is set.
 *
 * A sealed value: `sb1.<key id>.<iv>.<ciphertext>.<tag>`, base64url parts.
 */

const VERSION = "sb1";
const MIN_KEY_CHARS = 32;

export class SecretBoxError extends Error {
  constructor(
    readonly code: "badKey" | "unknownKey" | "malformed" | "tampered",
    message: string,
  ) {
    super(message);
  }
}

type Key = { id: string; bytes: Buffer };

function deriveKey(material: string, label: string): Key {
  const bytes = Buffer.from(hkdfSync("sha256", material, "leafdesk-secret-box", label, 32));
  const id = createHash("sha256").update(bytes).digest("base64url").slice(0, 10);
  return { id, bytes };
}

function explicitKey(material: string): Key {
  if (material.length < MIN_KEY_CHARS) throw new SecretBoxError("badKey", `LEAFDESK_ENCRYPTION_KEY must be at least ${MIN_KEY_CHARS} characters`);
  return deriveKey(material, "key");
}

/** The key that seals new values, then every key that may open one. */
function keys(): { current: Key; all: Key[] } {
  const derived = deriveKey(env.authSecret, "auth-secret");
  const explicit = env.encryptionKey;
  const current = explicit ? explicitKey(explicit) : derived;
  const old = env.oldEncryptionKeys.map((k) => deriveKey(k, "key"));
  const all = [current, ...old, derived].filter((k, i, list) => list.findIndex((o) => o.id === k.id) === i);
  return { current, all };
}

/** Seals `plain`; each call gives a different value. */
export function seal(plain: string): string {
  const { current } = keys();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", current.bytes, iv);
  cipher.setAAD(Buffer.from(`${VERSION}.${current.id}`));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, current.id, iv.toString("base64url"), body.toString("base64url"), tag.toString("base64url")].join(".");
}

/** Opens a sealed value; throws a SecretBoxError when no known key sealed it or it was changed. */
export function open(sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) throw new SecretBoxError("malformed", "Not a sealed value");
  const [, keyId, iv, body, tag] = parts;
  const key = keys().all.find((k) => k.id === keyId);
  if (!key) throw new SecretBoxError("unknownKey", "Sealed with a key this server doesn't have");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.bytes, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(`${VERSION}.${keyId}`));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretBoxError("tampered", "The sealed value was changed or the key is wrong");
  }
}

/** Seals a JSON value. */
export const sealJson = (value: unknown) => seal(JSON.stringify(value));

/** Opens a sealed JSON value. */
export const openJson = <T>(sealed: string): T => JSON.parse(open(sealed)) as T;

/** Whether a sealed value was sealed with a key other than the current one (to seal it again). */
export function sealedWithOldKey(sealed: string): boolean {
  return sealed.split(".")[1] !== keys().current.id;
}
