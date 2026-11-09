/** Writes tar archives for tests (lib/import/tar, Joplin's JEX exports). */

const encoder = new TextEncoder();

function header(name: string, size: number, type: string): Uint8Array {
  const block = new Uint8Array(512);
  const put = (text: string, at: number) => block.set(encoder.encode(text), at);
  put(name.slice(0, 100), 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124);
  put("00000000000\0", 136);
  put("        ", 148);
  put(type, 156);
  put("ustar\0", 257);
  put("00", 263);
  let sum = 0;
  for (const b of block) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

/** A tar archive of the files given (text or bytes); names over 100 characters get a GNU long-name entry. */
export function tar(files: Record<string, string | Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  const add = (name: string, data: Uint8Array, type: string) => {
    parts.push(header(name, data.length, type), data, new Uint8Array((512 - (data.length % 512)) % 512));
  };
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? encoder.encode(content) : content;
    if (name.length > 100) add("././@LongLink", encoder.encode(`${name}\0`), "L");
    add(name, data, "0");
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
