import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    authSecret: "test-secret",
    get automationWebhookAllowedHosts() {
      return (process.env.TEST_ALLOWED ?? "").split(",").filter(Boolean);
    },
  },
}));

const { allowedHost, parseWebhookUrl, sendWebhook, signWebhook, WebhookError, webhookSecret } = await import("./webhook");

describe("webhook secrets and signatures", () => {
  it("derives a stable secret per salt", () => {
    expect(webhookSecret("a")).toBe(webhookSecret("a"));
    expect(webhookSecret("a")).not.toBe(webhookSecret("b"));
    expect(webhookSecret("a")).toMatch(/^whsec_[\w-]{43}$/);
  });

  it("signs <t>.<body> with HMAC-SHA256", () => {
    const expected = createHmac("sha256", "s").update('1.{"x":1}').digest("hex");
    expect(signWebhook("s", 1, '{"x":1}')).toBe(`t=1,v1=${expected}`);
  });
});

describe("parseWebhookUrl", () => {
  it("takes http(s) addresses without credentials", () => {
    expect(parseWebhookUrl(" https://example.com/hook ").toString()).toBe("https://example.com/hook");
    expect(() => parseWebhookUrl("ftp://example.com")).toThrow(WebhookError);
    expect(() => parseWebhookUrl("https://u:p@example.com")).toThrow(WebhookError);
    expect(() => parseWebhookUrl("not a url")).toThrow(WebhookError);
    expect(() => parseWebhookUrl("")).toThrow(WebhookError);
  });
});

describe("allowedHost", () => {
  it("matches a host, or a host and port", () => {
    expect(allowedHost(new URL("http://n8n.internal:5678/x"), ["n8n.internal"])).toBe(true);
    expect(allowedHost(new URL("http://localhost:4000/x"), ["localhost:4000"])).toBe(true);
    expect(allowedHost(new URL("http://localhost:4001/x"), ["localhost:4000"])).toBe(false);
    expect(allowedHost(new URL("https://localhost/x"), ["localhost:443"])).toBe(true);
    expect(allowedHost(new URL("http://example.com/x"), [])).toBe(false);
  });
});

describe("sendWebhook", () => {
  let server: http.Server;
  let port = 0;
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  let answer = 200;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        if (answer === 302) res.writeHead(302, { location: "http://example.com" });
        else res.writeHead(answer);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  const delivery = { id: "d1", event: "row.created", body: '{"hello":"world"}', secret: "whsec_x" };

  it("refuses private addresses unless the host is allowed", async () => {
    process.env.TEST_ALLOWED = "";
    await expect(sendWebhook(`http://127.0.0.1:${port}/hook`, delivery)).rejects.toMatchObject({ code: "blocked" });
    await expect(sendWebhook(`http://localhost:${port}/hook`, delivery)).rejects.toMatchObject({ code: "blocked" });
    expect(received).toHaveLength(0);
  });

  it("posts the signed body to an allowed host", async () => {
    process.env.TEST_ALLOWED = `127.0.0.1:${port}`;
    answer = 204;
    await expect(sendWebhook(`http://127.0.0.1:${port}/hook`, delivery)).resolves.toBe(204);
    const got = received.at(-1)!;
    expect(got.body).toBe(delivery.body);
    expect(got.headers["content-type"]).toBe("application/json");
    expect(got.headers["x-leafdesk-event"]).toBe("row.created");
    expect(got.headers["x-leafdesk-delivery"]).toBe("d1");
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(got.headers["x-leafdesk-signature"]))!;
    expect(v1).toBe(createHmac("sha256", "whsec_x").update(`${t}.${delivery.body}`).digest("hex"));
    expect(Math.abs(Number(t) - Date.now() / 1000)).toBeLessThan(5);
  });

  it("reports error statuses and redirects with the status", async () => {
    process.env.TEST_ALLOWED = `127.0.0.1:${port}`;
    answer = 503;
    await expect(sendWebhook(`http://127.0.0.1:${port}/hook`, delivery)).rejects.toMatchObject({ code: "http", httpStatus: 503 });
    answer = 302;
    await expect(sendWebhook(`http://127.0.0.1:${port}/hook`, delivery)).rejects.toMatchObject({ code: "redirect", httpStatus: 302 });
  });

  it("reports an address nothing listens on as unreachable", async () => {
    process.env.TEST_ALLOWED = "127.0.0.1:1";
    await expect(sendWebhook("http://127.0.0.1:1/hook", delivery)).rejects.toMatchObject({ code: "unreachable" });
  });
});
