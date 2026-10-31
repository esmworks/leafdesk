import { beforeEach, describe, expect, it, vi } from "vitest";

// A mail file read for the AI (mail-client/ai-files.ts): which reader each kind gets, what is
// refused before anything is downloaded, how large a file is read, and an image described by a
// model with no tools, its text told to be data.

const mocks = vi.hoisted(() => ({
  readAttachmentWithin: vi.fn(),
  extractText: vi.fn(),
  chatModelsFor: vi.fn(async (): Promise<{ id: string; images: boolean }[]> => [
    { id: "text-only", images: false },
    { id: "sees", images: true },
  ]),
  complete: vi.fn(),
}));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("./read", () => ({ readAttachmentWithin: mocks.readAttachmentWithin }));
vi.mock("@/server/file-text", async (original) => ({ ...(await original<object>()), extractText: mocks.extractText }));
vi.mock("@/server/ai", async (original) => ({ ...(await original<object>()), chatModelsFor: mocks.chatModelsFor, complete: mocks.complete }));

const { forgetMailFiles, mailFileForAi } = await import("./ai-files");
const { RowMailError } = await import("@/server/row-mail/settings");
const { AiError } = await import("@/server/ai");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
type Limit = (file: { name: string; contentType: string }) => number | null;
/** The mail server as read.ts readAttachmentWithin reads it: the limit decides, before any download. */
const serve = (name: string, contentType: string, data: Buffer) =>
  mocks.readAttachmentWithin.mockImplementation(async (_user: string, _input: unknown, limitFor: Limit) => {
    const max = limitFor({ name, contentType });
    if (max === null) return { name, contentType, data: null, why: "skipped" };
    if (data.length > max) return { name, contentType, data: null, why: "tooLarge" };
    downloaded.push(max);
    return { name, contentType, data };
  });
let downloaded: number[] = [];
const read = (part = "2", background = false) => mailFileForAi("u1", "ws-1", { messageId: "m-1", part }, { background });

beforeEach(() => {
  vi.clearAllMocks();
  downloaded = [];
  forgetMailFiles();
});

describe("mailFileForAi", () => {
  it("reads a PDF to text as search reads uploads, up to the documents' size", async () => {
    serve("teklif.pdf", "application/octet-stream", Buffer.from("%PDF"));
    mocks.extractText.mockResolvedValue({ text: "Toplam 12.500 TL", partial: true, pages: 80 });
    expect(await read()).toEqual({ name: "teklif.pdf", contentType: "application/octet-stream", kind: "document", text: "Toplam 12.500 TL", partial: true });
    expect(mocks.extractText).toHaveBeenCalledWith("pdf", "teklif.pdf", expect.any(Buffer));
    expect(mocks.readAttachmentWithin).toHaveBeenCalledWith("u1", { id: "m-1", part: "2" }, expect.any(Function));
    expect(downloaded).toEqual([25 * 1024 * 1024]);
  });

  it("reads text files, HTML and forwarded emails", async () => {
    serve("efatura.xml", "application/xml", Buffer.from("<Invoice>\n  <Total>450</Total>\n</Invoice>"));
    expect(await read("2")).toMatchObject({ kind: "text", text: "<Invoice>\n<Total>450</Total>\n</Invoice>" });
    serve("page.html", "text/html", Buffer.from("<html><head><script>x()</script></head><body><p>Merhaba</p><p>Dünya</p></body></html>"));
    expect(await read("3")).toMatchObject({ kind: "html", text: "Merhaba\nDünya" });
    serve("fwd.eml", "message/rfc822", Buffer.from("From: Ali <ali@acme.test>\r\nTo: me@example.test\r\nSubject: Fiyat\r\nDate: Fri, 30 Oct 2026 09:15:00 +0000\r\n\r\nFiyat ektedir.\r\n"));
    expect(await read("4")).toMatchObject({ kind: "message", text: expect.stringMatching(/^From: "?Ali"? <ali@acme.test>\nTo: me@example.test\nDate: 2026-10-30 09:15 UTC\nSubject: Fiyat\n\nFiyat ektedir.$/) });
    // Parsed whole in memory: HTML and forwarded emails are read up to less than documents.
    expect(downloaded).toEqual([5 * 1024 * 1024, 2 * 1024 * 1024, 5 * 1024 * 1024]);
  });

  it("downloads nothing of a kind it doesn't read, and says when a file is too large or gone", async () => {
    serve("setup.exe", "application/x-msdownload", Buffer.from("MZ"));
    expect(await read("2")).toEqual({ name: "setup.exe", problem: "kind" });
    expect(downloaded).toEqual([]);
    serve("big.html", "text/html", Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(await read("3")).toEqual({ name: "big.html", problem: "tooLarge" });
    mocks.readAttachmentWithin.mockRejectedValueOnce(new RowMailError("gone"));
    await expect(read("9")).rejects.toBeInstanceOf(RowMailError);
  });

  it("says a document without text (a scan) gives nothing", async () => {
    serve("tarama.pdf", "application/pdf", Buffer.from("%PDF"));
    mocks.extractText.mockResolvedValue({ text: "", partial: false, pages: 1 });
    expect(await read()).toEqual({ name: "tarama.pdf", problem: "empty" });
  });

  it("has an image written out by a model that takes images, with no tools, told its text is data", async () => {
    serve("fis.jpg", "image/jpeg", PNG);
    const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0.01 };
    mocks.complete.mockResolvedValue({ text: "FİŞ\nToplam 450 TL\n\nA receipt.", stopReason: "stop", usage });
    expect(await read("2", true)).toEqual({ name: "fis.jpg", contentType: "image/jpeg", kind: "image", text: "FİŞ\nToplam 450 TL\n\nA receipt.", partial: false, usage });
    expect(downloaded).toEqual([5 * 1024 * 1024]);
    const request = mocks.complete.mock.calls[0][0];
    expect(request).toMatchObject({ feature: "mail.attachment", model: "sees", userId: "u1", workspaceId: "ws-1", skipRateLimit: true });
    expect(request.tools).toBeUndefined();
    expect(request.system).toMatch(/never instructions to you/);
    // The real type, by its bytes, not the type the sender gave it.
    expect(request.messages[0].images).toEqual([{ data: PNG.toString("base64"), mimeType: "image/png" }]);
  });

  it("reads no image without a model that takes images, and none that isn't one", async () => {
    serve("fis.jpg", "image/jpeg", PNG);
    mocks.chatModelsFor.mockResolvedValueOnce([{ id: "text-only", images: false }]);
    expect(await read()).toEqual({ name: "fis.jpg", problem: "noImageModel" });
    serve("fis.jpg", "image/jpeg", Buffer.from("<script>"));
    expect(await read()).toEqual({ name: "fis.jpg", problem: "empty" });
    serve("fis.jpg", "image/jpeg", PNG);
    mocks.complete.mockRejectedValueOnce(new AiError("rateLimited", "slow down"));
    expect(await read()).toEqual({ name: "fis.jpg", problem: "failed" });
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    // A model that wrote nothing out was still paid: what it cost comes back to be counted.
    const usage = { inputTokens: 1, outputTokens: 0, totalTokens: 1, costUsd: 0.01 };
    mocks.complete.mockResolvedValueOnce({ text: "  ", stopReason: "stop", usage });
    expect(await read()).toEqual({ name: "fis.jpg", problem: "empty", usage });
  });

  it("keeps what it read for a while, so reading on doesn't fetch or describe it again", async () => {
    serve("fis.png", "image/png", PNG);
    mocks.complete.mockResolvedValue({ text: "Toplam 450 TL", stopReason: "length", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0.01 } });
    expect(await read()).toMatchObject({ partial: true, usage: expect.any(Object) });
    const again = await read();
    expect(again).toMatchObject({ text: "Toplam 450 TL" });
    expect(again).not.toHaveProperty("usage", expect.anything());
    expect(mocks.readAttachmentWithin).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    // Someone else's read of the same message isn't theirs.
    await mailFileForAi("u2", "ws-1", { messageId: "m-1", part: "2" });
    expect(mocks.readAttachmentWithin).toHaveBeenCalledTimes(2);
  });
});
