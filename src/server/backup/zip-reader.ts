/**
 * Reads a ZIP from a file by its central directory, which says where each entry starts and how
 * long it is. A backup is read this way rather than front to back: reading front to back has to
 * find each entry's end by looking for the next header's signature when the sizes come after the
 * data (as fflate's streaming writer puts them), and a stored file that is a ZIP itself, or bytes
 * that happen to look like a signature, would cut an entry short.
 *
 * Only what backups use: stored and deflated entries, no encryption, no ZIP64 (which fflate never
 * writes; a backup is capped below its limits).
 */
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { createInflateRaw, crc32 } from "node:zlib";

export type ZipEntry = {
  name: string;
  method: 0 | 8;
  compressedSize: number;
  size: number;
  crc: number;
  /** Where the entry's local header starts. */
  offset: number;
};

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The entries of the ZIP at `path`, in the central directory's order. */
export async function zipEntries(path: string): Promise<ZipEntry[]> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    // The end record is 22 bytes plus a comment of at most 65,535.
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let end = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new ZipFormatError("not a ZIP file");
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new ZipFormatError("ZIP64 isn't supported");
    if (directoryOffset + directorySize > size) throw new ZipFormatError("damaged ZIP file");

    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);
    const entries: ZipEntry[] = [];
    let at = 0;
    for (let i = 0; i < count; i++) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL) throw new ZipFormatError("damaged ZIP file");
      const flags = directory.readUInt16LE(at + 8);
      const method = directory.readUInt16LE(at + 10);
      const crc = directory.readUInt32LE(at + 16);
      const compressedSize = directory.readUInt32LE(at + 20);
      const uncompressed = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const offset = directory.readUInt32LE(at + 42);
      if (flags & 1) throw new ZipFormatError("encrypted ZIP entries aren't supported");
      if (method !== 0 && method !== 8) throw new ZipFormatError(`compression method ${method} isn't supported`);
      if (offset + 30 + compressedSize > directoryOffset) throw new ZipFormatError("damaged ZIP file");
      const name = directory.subarray(at + 46, at + 46 + nameLength).toString("utf8");
      entries.push({ name, method, compressedSize, size: uncompressed, crc, offset });
      at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/** Where `entry`'s data starts, after its local header. */
async function dataStart(path: string, entry: ZipEntry): Promise<number> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.offset);
    if (header.readUInt32LE(0) !== LOCAL) throw new ZipFormatError("damaged ZIP file");
    return entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }
}

/**
 * The entry's contents as a stream, checked against the central directory's size and checksum:
 * the stream fails when they differ, or when it grows past them.
 */
export async function entryStream(path: string, entry: ZipEntry): Promise<Readable> {
  const start = await dataStart(path, entry);
  const raw = entry.compressedSize
    ? createReadStream(path, { start, end: start + entry.compressedSize - 1 })
    : Readable.from([]);
  const body = entry.method === 8 ? raw.pipe(createInflateRaw()) : raw;
  raw.on("error", (error: Error) => body.destroy(error));
  let length = 0;
  let crc = 0;
  const check = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      length += chunk.length;
      if (length > entry.size) return done(new ZipFormatError(`${entry.name} is longer than the ZIP says`));
      crc = crc32(chunk, crc);
      done(null, chunk);
    },
    flush(done) {
      if (length !== entry.size || crc >>> 0 !== entry.crc >>> 0) return done(new ZipFormatError(`${entry.name} is damaged`));
      done();
    },
  });
  body.on("error", (error: Error) => check.destroy(error));
  return body.pipe(check);
}

/** The entry's contents in memory; refuses one larger than `limit` bytes. */
export async function readEntry(path: string, entry: ZipEntry, limit: number): Promise<Buffer> {
  if (entry.size > limit) throw new ZipFormatError(`${entry.name} is too large`);
  const chunks: Buffer[] = [];
  for await (const chunk of await entryStream(path, entry)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
