import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertKey, keyOf, type StorageDriver } from "./driver";

/**
 * Files on a local disk (a Docker volume in production), one file per key under `root`. Writes go
 * to a temporary file first and are renamed into place, so a reader never sees half a file.
 */
export function localDriver(root: string): StorageDriver {
  const base = resolve(root);
  const pathOf = (key: string) => {
    assertKey(key);
    const path = resolve(base, key);
    if (!path.startsWith(base + sep)) throw new Error(`Bad storage key: ${key}`);
    return path;
  };

  return {
    kind: "local",

    async put(key, body, { size }) {
      const path = pathOf(key);
      const tmpDir = join(base, ".tmp");
      await mkdir(tmpDir, { recursive: true });
      await mkdir(dirname(path), { recursive: true });
      const tmp = join(tmpDir, randomBytes(12).toString("hex"));
      try {
        await pipeline(body, createWriteStream(tmp, { flags: "wx" }));
        const written = (await stat(tmp)).size;
        if (written !== size) throw new Error(`Stored ${written} bytes, expected ${size}`);
        await rename(tmp, path);
      } catch (error) {
        await rm(tmp, { force: true });
        throw error;
      }
    },

    async get(ref, range) {
      const path = pathOf(keyOf(ref));
      try {
        await stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      const stream = createReadStream(path, range ? { start: range.start, end: range.end } : {});
      return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    },

    async delete(ref) {
      await rm(pathOf(keyOf(ref)), { force: true });
    },
  };
}
