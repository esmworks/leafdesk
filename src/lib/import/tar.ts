/**
 * Reads a tar archive (as Joplin's JEX export is): the plain files in it by name, nothing else.
 * Pure and bounded: `keep` is asked about each file (its name and size) before its bytes are
 * taken, which are views into `data`, never copies; a header that doesn't add up ends the reading
 * with a TarError.
 *
 * Understood: ustar and old-style headers (the name and its ustar prefix), GNU long names (`L`)
 * and the `path` of pax headers (`x`). Links, folders and other entries are passed over.
 */

const BLOCK = 512;

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

export type TarEntry = { name: string; data: Uint8Array };

const utf8 = new TextDecoder();

/** A NUL-ended text field of a header. */
function field(header: Uint8Array, start: number, length: number): string {
  let end = start;
  while (end < start + length && header[end] !== 0) end++;
  return utf8.decode(header.subarray(start, end));
}

/** An octal number field (spaces and NULs around it allowed); null when it isn't one. */
function octal(header: Uint8Array, start: number, length: number): number | null {
  let value = 0;
  let digits = 0;
  for (let i = start; i < start + length; i++) {
    const c = header[i];
    if (c === 0 || c === 32) {
      if (digits) break;
      continue;
    }
    if (c < 48 || c > 55) return null;
    value = value * 8 + (c - 48);
    digits++;
  }
  return digits ? value : null;
}

/** The header's checksum holds: the bytes added up with the checksum field read as spaces. */
function checksumHolds(header: Uint8Array): boolean {
  const stored = octal(header, 148, 8);
  if (stored === null) return false;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  return sum === stored;
}

/** The `path` record of a pax header's records (`<length> path=<value>\n` …), or null. */
function paxPath(data: Uint8Array): string | null {
  let at = 0;
  while (at < data.length) {
    let space = at;
    while (space < data.length && data[space] !== 32) space++;
    const length = Number(utf8.decode(data.subarray(at, space)));
    if (!Number.isInteger(length) || length <= space - at || at + length > data.length) return null;
    const record = utf8.decode(data.subarray(space + 1, at + length - 1));
    if (record.startsWith("path=")) return record.slice(5);
    at += length;
  }
  return null;
}

/** Whether the bytes start like a tar archive: a first header whose checksum holds. */
export function looksLikeTar(data: Uint8Array): boolean {
  return data.length >= BLOCK && checksumHolds(data.subarray(0, BLOCK));
}

/** The archive's plain files that `keep` takes, in the order they come. */
export function readTar(data: Uint8Array, keep: (name: string, size: number) => boolean): TarEntry[] {
  const out: TarEntry[] = [];
  let at = 0;
  let longName: string | null = null;
  while (at + BLOCK <= data.length) {
    const header = data.subarray(at, at + BLOCK);
    // Two blocks of zeros end the archive; one is enough to stop.
    if (header.every((b) => b === 0)) break;
    if (!checksumHolds(header)) throw new TarError("A tar header's checksum doesn't hold");
    const size = octal(header, 124, 12);
    if (size === null) throw new TarError("A tar header has no size");
    const start = at + BLOCK;
    const end = start + size;
    if (end > data.length) throw new TarError("The tar archive ends inside a file");
    const type = header[156];
    const body = data.subarray(start, end);
    at = start + Math.ceil(size / BLOCK) * BLOCK;
    // GNU's long name and pax's extended header name the entry after them.
    if (type === 76 /* L */) {
      longName = field(body, 0, body.length);
      continue;
    }
    if (type === 120 /* x */) {
      longName = paxPath(body) ?? longName;
      continue;
    }
    let name = longName;
    longName = null;
    if (name === null) {
      name = field(header, 0, 100);
      // ustar keeps the start of a long path in its prefix field.
      if (field(header, 257, 5) === "ustar") {
        const prefix = field(header, 345, 155);
        if (prefix) name = `${prefix}/${name}`;
      }
    }
    // Plain files only: `0`, or NUL in old archives.
    if (type !== 48 && type !== 0) continue;
    if (keep(name, size)) out.push({ name, data: body });
  }
  return out;
}
