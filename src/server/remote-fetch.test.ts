import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchRemoteFile, isBlockedAddress, readRemoteText, RemoteFetchError } from "./remote-fetch";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "2002:c0a8:0101::1",
    "fe80::1",
    "fe80::1%en0",
    "fd00::1",
    "fc12:3456::1",
    "ff02::1",
    "2001:db8::1",
    "64:ff9b:1::a00:1",
    "::ffff:0:127.0.0.1",
    "::ffff:0:a9fe:a9fe",
    "3fff::1",
    "[::1]",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "2606:4700:4700::1111", "2a00:1450:4001:81d::200e", "::ffff:8.8.8.8"])(
    "allows %s",
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe("fetchRemoteFile", () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/file.png") {
        res.writeHead(200, { "content-type": "image/png", "content-length": "4" }).end("\x89PNG");
      } else if (req.url === "/named") {
        res.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.txt" }).end("hi");
      } else if (req.url === "/redirect-ok") {
        res.writeHead(302, { location: "/file.png" }).end();
      } else if (req.url === "/redirect-private") {
        // Loopback, but a different address than the one the test allows.
        res.writeHead(302, { location: `http://127.0.0.2:${port}/file.png` }).end();
      } else if (req.url === "/loop") {
        res.writeHead(302, { location: "/loop" }).end();
      } else if (req.url === "/big") {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "1000000" }).end(Buffer.alloc(1_000_000));
      } else if (req.url === "/big-unsized") {
        // No Content-Length: only counting what arrives can stop it.
        res.writeHead(200, { "content-type": "application/json" });
        res.write(Buffer.alloc(600));
        res.end(Buffer.alloc(600));
      } else if (req.url === "/slow") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("a");
        // Never ends.
      } else if (req.url === "/missing") {
        res.writeHead(404).end();
      } else {
        res.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const onlyTestServer = (address: string) => address !== "127.0.0.1";
  const read = async (body: NodeJS.ReadableStream) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error instanceof RemoteFetchError ? error.code : String(error);
    }
  };

  it("refuses loopback, private and metadata addresses by default", async () => {
    expect(await failure(fetchRemoteFile(`http://127.0.0.1:${port}/file.png`, { maxBytes: 100 }))).toBe("blocked");
    expect(await failure(fetchRemoteFile(`http://localhost:${port}/file.png`, { maxBytes: 100 }))).toBe("blocked");
    expect(await failure(fetchRemoteFile("http://169.254.169.254/latest/meta-data/", { maxBytes: 100 }))).toBe("blocked");
    expect(await failure(fetchRemoteFile("http://[::1]/", { maxBytes: 100 }))).toBe("blocked");
  });

  it("refuses other schemes and URLs with credentials", async () => {
    expect(await failure(fetchRemoteFile("file:///etc/passwd", { maxBytes: 100 }))).toBe("badUrl");
    expect(await failure(fetchRemoteFile("ftp://example.com/x", { maxBytes: 100 }))).toBe("badUrl");
    expect(await failure(fetchRemoteFile("http://user:pw@example.com/x", { maxBytes: 100 }))).toBe("badUrl");
    expect(await failure(fetchRemoteFile("not a url", { maxBytes: 100 }))).toBe("badUrl");
  });

  it("fetches an allowed host, following redirects, with type and name", async () => {
    const file = await fetchRemoteFile(`http://127.0.0.1:${port}/redirect-ok`, { maxBytes: 100, isBlocked: onlyTestServer });
    expect(file.contentType).toBe("image/png");
    expect(file.name).toBe("file.png");
    expect(file.size).toBe(4);
    expect((await read(file.body)).length).toBe(4);
    const named = await fetchRemoteFile(`http://127.0.0.1:${port}/named`, { maxBytes: 100, isBlocked: onlyTestServer });
    expect(named.name).toBe("résumé.txt");
    named.body.destroy();
  });

  it("refuses redirects to blocked addresses, and redirect loops", async () => {
    expect(await failure(fetchRemoteFile(`http://127.0.0.1:${port}/redirect-private`, { maxBytes: 100, isBlocked: onlyTestServer }))).toBe(
      "blocked",
    );
    expect(await failure(fetchRemoteFile(`http://127.0.0.1:${port}/loop`, { maxBytes: 100, isBlocked: onlyTestServer }))).toBe(
      "tooManyRedirects",
    );
  });

  it("refuses files over the limit and error answers", async () => {
    expect(await failure(fetchRemoteFile(`http://127.0.0.1:${port}/big`, { maxBytes: 1000, isBlocked: onlyTestServer }))).toBe("tooLarge");
    expect(await failure(fetchRemoteFile(`http://127.0.0.1:${port}/missing`, { maxBytes: 1000, isBlocked: onlyTestServer }))).toBe(
      "httpError",
    );
  });

  it("cuts off a body over the limit that came without its size", async () => {
    const file = await fetchRemoteFile(`http://127.0.0.1:${port}/big-unsized`, { maxBytes: 1000, isBlocked: onlyTestServer });
    expect(file.size).toBe(null);
    expect(await failure(readRemoteText(file, 1000))).toBe("tooLarge");
    expect(file.body.destroyed).toBe(true);
    const small = await fetchRemoteFile(`http://127.0.0.1:${port}/named`, { maxBytes: 1000, isBlocked: onlyTestServer });
    expect(await readRemoteText(small, 1000)).toBe("hi");
  });

  it("stops a transfer that takes too long", async () => {
    const file = await fetchRemoteFile(`http://127.0.0.1:${port}/slow`, { maxBytes: 1000, timeoutMs: 300, isBlocked: onlyTestServer });
    expect(await failure(read(file.body))).toBe("timeout");
  });
});
