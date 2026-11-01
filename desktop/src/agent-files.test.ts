import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  AgentFilesBridge,
  answerCall,
  appendAudit,
  askWithTimeout,
  auditLine,
  bridgeUrl,
  folderLabels,
  isProtectedName,
  MAX_FILE_BYTES,
  oneAtATime,
  previewOf,
  readAgentFilesSettings,
  readCall,
  reconnectDelay,
  resolvePlace,
  type AuditEntry,
  type Call,
  type FileHost,
  type SocketLike,
} from "./agent-files.ts";

/** A folder agents may use, with a file, a subfolder, credential places and a link leading out. */
function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-files-"));
  const root = path.join(base, "Docs");
  const outside = path.join(base, "Private");
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.mkdirSync(path.join(root, ".ssh"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "plan.md"), "Ship on Friday.\n");
  fs.writeFileSync(path.join(root, ".env.local"), "SECRET=1");
  fs.writeFileSync(path.join(root, ".ssh", "id_ed25519"), "key");
  fs.writeFileSync(path.join(root, ".git", "config"), "[remote]");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
  fs.symlinkSync(outside, path.join(root, "escape"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "secret-link.txt"));
  fs.symlinkSync(path.join(root, ".ssh"), path.join(root, "keys"));
  return { base, root, outside, folders: folderLabels([root]), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

test("settings are off unless turned on, with absolute folders only", () => {
  assert.equal(readAgentFilesSettings(undefined), undefined);
  assert.deepEqual(readAgentFilesSettings({ enabled: "yes", folders: ["/a", "relative", "/a", 3] }), { enabled: false, folders: ["/a"] });
  assert.deepEqual(readAgentFilesSettings({ enabled: true, folders: ["/b"] }), { enabled: true, folders: ["/b"] });
});

test("folders get plain, distinct labels", () => {
  assert.deepEqual(
    folderLabels(["/Users/a/Documents", "/Volumes/Work/Documents", "/"]).map((f) => f.label),
    ["Documents", "Documents (2)", "Folder"],
  );
});

test("credential places are protected", () => {
  for (const name of [".ssh", ".git", ".env", ".env.production", ".aws", "id_rsa", "server.pem", "login.keychain-db", "Keychains", ".netrc", "vault.kdbx"]) {
    assert.equal(isProtectedName(name), true, name);
  }
  for (const name of ["notes.md", "environment.md", "git-notes", "keys.txt"]) assert.equal(isProtectedName(name), false, name);
});

test("places stay inside their folder, through links too", async () => {
  const box = sandbox();
  try {
    const plan = await resolvePlace(box.folders, "Docs/plan.md");
    assert.equal(plan.exists, true);
    assert.equal(plan.real, path.join(fs.realpathSync(box.root), "plan.md"));
    const fresh = await resolvePlace(box.folders, "Docs/new/deeper/file.md");
    assert.equal(fresh.exists, false);
    assert.equal(fresh.real, path.join(fs.realpathSync(box.root), "new", "deeper", "file.md"));

    assert.equal(await refusal(resolvePlace(box.folders, "Docs/../Private/secret.txt")), "outside");
    assert.equal(await refusal(resolvePlace(box.folders, "Docs/sub/../../Private")), "outside");
    assert.equal(await refusal(resolvePlace(box.folders, "Docs\\..\\Private")), "outside");
    assert.equal(await refusal(resolvePlace(box.folders, "Private/secret.txt")), "outside");
    assert.equal(await refusal(resolvePlace(box.folders, "Docs/a\u0000b")), "outside");
    // Links whose target is outside the folder, for what exists and for what would be made under them.
    assert.equal(await refusal(resolvePlace(box.folders, "Docs/escape/secret.txt")), "outside");
    assert.equal(await refusal(resolvePlace(box.folders, "Docs/escape/new.md")), "outside");
    assert.equal(await refusal(resolvePlace(box.folders, "Docs/secret-link.txt")), "outside");

    assert.equal(await refusal(resolvePlace(box.folders, "Docs/.ssh/id_ed25519")), "protected");
    assert.equal(await refusal(resolvePlace(box.folders, "Docs/.git/config")), "protected");
    assert.equal(await refusal(resolvePlace(box.folders, "Docs/.env.local")), "protected");
    // A link inside the folder to a protected place in it.
    assert.equal(await refusal(resolvePlace(box.folders, "Docs/keys/id_ed25519")), "protected");
    // A folder that is itself a credential place.
    assert.equal(await refusal(resolvePlace(folderLabels([path.join(box.root, ".ssh")]), ".ssh/id_ed25519")), "protected");
  } finally {
    box.cleanup();
  }
});

function host(box: ReturnType<typeof sandbox>, answer: boolean | "never" = true) {
  const asked: unknown[] = [];
  const trashed: string[] = [];
  const log: AuditEntry[] = [];
  const h: FileHost = {
    server: "https://leafdesk.example.com",
    folders: () => box.folders,
    ask: async (approval, signal) => {
      asked.push(approval);
      if (answer === "never") return new Promise<boolean>((_, reject) => signal.addEventListener("abort", () => reject(new Error("closed"))));
      return answer;
    },
    trash: async (p) => {
      trashed.push(p);
    },
    audit: async (entry) => {
      log.push(entry);
    },
    now: () => new Date("2026-11-01T10:00:00.000Z"),
    approvalMs: 50,
  };
  return { h, asked, trashed, log };
}

const call = (op: Call["op"], p: string, content?: string): Call => ({ type: "call", id: `${op}-1`, op, path: p, ...(content !== undefined ? { content } : {}), agent: "Filer", workspace: "Acme" });

test("lists without protected entries, reads text, refuses binary and large files", async () => {
  const box = sandbox();
  try {
    const { h, asked, log } = host(box);
    const listed = await answerCall(call("list", "Docs"), h);
    assert.ok(listed.ok);
    const names = (listed.result.entries as { name: string; kind: string }[]).map((e) => `${e.name}:${e.kind}`);
    assert.deepEqual(names, ["escape:link", "keys:link", "plan.md:file", "secret-link.txt:link", "sub:folder"]);

    assert.deepEqual(await answerCall(call("read", "Docs/plan.md"), h), { type: "result", id: "read-1", ok: true, result: { op: "read", text: "Ship on Friday.\n", bytes: 16 } });
    fs.writeFileSync(path.join(box.root, "image.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    fs.writeFileSync(path.join(box.root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    fs.writeFileSync(path.join(box.root, "big.txt"), "x".repeat(MAX_FILE_BYTES + 1));
    assert.deepEqual(await answerCall(call("read", "Docs/image.png"), h), { type: "result", id: "read-1", ok: false, error: "binary" });
    assert.deepEqual(await answerCall(call("read", "Docs/latin1.txt"), h), { type: "result", id: "read-1", ok: false, error: "binary" });
    assert.deepEqual(await answerCall(call("read", "Docs/big.txt"), h), { type: "result", id: "read-1", ok: false, error: "tooLarge" });
    assert.deepEqual(await answerCall(call("read", "Docs/sub"), h), { type: "result", id: "read-1", ok: false, error: "notFile" });
    assert.deepEqual(await answerCall(call("read", "Docs/missing.md"), h), { type: "result", id: "read-1", ok: false, error: "notFound" });
    assert.deepEqual(await answerCall(call("list", "Docs/plan.md"), h), { type: "result", id: "list-1", ok: false, error: "notFolder" });
    assert.equal(asked.length, 0, "reads ask nothing");
    assert.deepEqual(
      log.map((l) => `${l.op} ${l.place} ${l.outcome}`),
      ["list Docs done", "read Docs/plan.md done", "read Docs/image.png binary", "read Docs/latin1.txt binary", "read Docs/big.txt tooLarge", "read Docs/sub notFile", "read Docs/missing.md notFound", "list Docs/plan.md notFolder"],
    );
  } finally {
    box.cleanup();
  }
});

test("writes and trashes only once the person allows, making missing folders inside", async () => {
  const box = sandbox();
  try {
    const allowed = host(box, true);
    const wrote = await answerCall(call("write", "Docs/new/out.md", "Line one\nLine two"), allowed.h);
    assert.deepEqual(wrote, { type: "result", id: "write-1", ok: true, result: { op: "write", bytes: 17, created: true } });
    assert.equal(fs.readFileSync(path.join(box.root, "new", "out.md"), "utf8"), "Line one\nLine two");
    assert.deepEqual(allowed.asked[0], { op: "write", agent: "Filer", workspace: "Acme", place: "Docs/new/out.md", server: "https://leafdesk.example.com", bytes: 17, preview: "Line one\nLine two" });
    const replaced = await answerCall(call("write", "Docs/plan.md", "New plan"), allowed.h);
    assert.ok(replaced.ok && replaced.result.created === false);
    assert.equal(fs.readFileSync(path.join(box.root, "plan.md"), "utf8"), "New plan");
    assert.deepEqual(await answerCall(call("trash", "Docs/plan.md"), allowed.h), { type: "result", id: "trash-1", ok: true, result: { op: "trash" } });
    assert.deepEqual(allowed.trashed, [path.join(fs.realpathSync(box.root), "plan.md")]);

    // Refused before anyone is asked.
    const before = allowed.asked.length;
    assert.deepEqual(await answerCall(call("write", "Docs/escape/x.md", "x"), allowed.h), { type: "result", id: "write-1", ok: false, error: "outside" });
    assert.deepEqual(await answerCall(call("write", "Docs/.env", "x"), allowed.h), { type: "result", id: "write-1", ok: false, error: "protected" });
    assert.deepEqual(await answerCall(call("write", "Docs/sub", "x"), allowed.h), { type: "result", id: "write-1", ok: false, error: "notFile" });
    assert.deepEqual(await answerCall(call("write", "Docs/big.md", "x".repeat(MAX_FILE_BYTES + 1)), allowed.h), { type: "result", id: "write-1", ok: false, error: "tooLarge" });
    assert.deepEqual(await answerCall(call("trash", "Docs"), allowed.h), { type: "result", id: "trash-1", ok: false, error: "protected" });
    assert.deepEqual(await answerCall(call("trash", "Docs/gone.md"), allowed.h), { type: "result", id: "trash-1", ok: false, error: "notFound" });
    assert.equal(allowed.asked.length, before);

    const denied = host(box, false);
    assert.deepEqual(await answerCall(call("write", "Docs/no.md", "x"), denied.h), { type: "result", id: "write-1", ok: false, error: "denied" });
    assert.equal(fs.existsSync(path.join(box.root, "no.md")), false);
    assert.deepEqual(await answerCall(call("trash", "Docs/sub"), denied.h), { type: "result", id: "trash-1", ok: false, error: "denied" });
    assert.deepEqual(denied.trashed, []);

    const silent = host(box, "never");
    assert.deepEqual(await answerCall(call("write", "Docs/late.md", "x"), silent.h), { type: "result", id: "write-1", ok: false, error: "unanswered" });
    assert.equal(fs.existsSync(path.join(box.root, "late.md")), false);
    assert.deepEqual(silent.log.map((l) => l.outcome), ["unanswered"]);
    assert.equal(JSON.stringify(allowed.log).includes("Line one"), false, "the log never keeps what was written");
  } finally {
    box.cleanup();
  }
});

test("a question times out as unanswered, and an error asking is a no", async () => {
  let aborted = false;
  assert.equal(
    await askWithTimeout(
      (signal) =>
        new Promise<boolean>((resolve) =>
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve(true);
          }),
        ),
      20,
    ),
    "unanswered",
  );
  assert.equal(aborted, true, "the question is closed at the deadline");
  assert.equal(await askWithTimeout(async () => true, 1_000), "allowed");
  assert.equal(await askWithTimeout(async () => false, 1_000), "denied");
  assert.equal(await askWithTimeout(() => Promise.reject(new Error("no window")), 1_000), "denied");
});

test("questions come one at a time, and one whose time ran out while waiting isn't shown", async () => {
  const queue = oneAtATime();
  const shown: string[] = [];
  let release!: (yes: boolean) => void;
  const first = queue(() => {
    shown.push("first");
    return new Promise<boolean>((resolve) => (release = resolve));
  });
  const second = queue(async () => {
    shown.push("second");
    return true;
  });
  const late = new AbortController();
  const a = first(new AbortController().signal);
  const b = second(late.signal);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(shown, ["first"]);
  late.abort();
  release(true);
  assert.equal(await a, true);
  assert.equal(await b, false);
  assert.deepEqual(shown, ["first"]);
});

test("the log keeps one JSON line per call, without contents, and rotates", async () => {
  const entry: AuditEntry = { at: "2026-11-01T10:00:00.000Z", server: "https://s.example", agent: "Filer", workspace: "Acme", op: "write", place: "Docs/a.md", outcome: "denied", bytes: 12 };
  const line = auditLine(entry);
  assert.ok(line.endsWith("\n"));
  assert.deepEqual(JSON.parse(line), entry);
  assert.deepEqual(Object.keys(JSON.parse(auditLine({ ...entry, op: "read", bytes: undefined }))), ["at", "server", "agent", "workspace", "op", "place", "outcome"]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-files-log-"));
  try {
    const file = path.join(dir, "logs", "agent-files.log");
    await appendAudit(file, line, line.length * 2 + 1);
    await appendAudit(file, line, line.length * 2 + 1);
    assert.equal(fs.readFileSync(file, "utf8"), line + line);
    await appendAudit(file, line, line.length * 2 + 1);
    assert.equal(fs.readFileSync(file, "utf8"), line);
    assert.equal(fs.readFileSync(`${file}.1`, "utf8"), line + line);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("calls are read strictly, and the first lines previewed", () => {
  assert.deepEqual(readCall({ type: "call", id: "a", op: "read", path: "Docs/a", agent: "A", workspace: "W" }), { type: "call", id: "a", op: "read", path: "Docs/a", agent: "A", workspace: "W" });
  assert.equal(readCall({ type: "call", id: "a", op: "delete", path: "Docs/a" }), null);
  assert.equal(readCall({ type: "call", id: "a", op: "write", path: "Docs/a" }), null);
  assert.equal(readCall({ type: "call", id: "a", op: "exec", path: "rm -rf /" }), null);
  assert.equal(previewOf(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")).split("\n").length, 8);
  assert.ok(previewOf("x".repeat(500)).endsWith("…"));
});

test("the bridge's address and backoff", () => {
  assert.equal(bridgeUrl("https://leafdesk.example.com"), "wss://leafdesk.example.com/desktop-bridge");
  assert.equal(bridgeUrl("http://127.0.0.1:51234"), "ws://127.0.0.1:51234/desktop-bridge");
  assert.deepEqual([0, 1, 2, 5, 6, 20].map(reconnectDelay), [1_000, 2_000, 4_000, 32_000, 60_000, 60_000]);
});

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  headers: Record<string, string>;
  constructor(url: string, headers: Record<string, string>) {
    this.url = url;
    this.headers = headers;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

test("the bridge connects with the cookie and header, announces labels, answers pings and calls, and closes when turned off", async () => {
  const sockets: FakeSocket[] = [];
  const answered: Call[] = [];
  const bridge = new AgentFilesBridge({
    open: (url, headers) => {
      const socket = new FakeSocket(url, headers);
      sockets.push(socket);
      return socket;
    },
    cookie: async () => "better-auth.session_token=abc",
    version: "1.2.3",
    answer: async (c) => {
      answered.push(c);
      return { type: "result", id: c.id, ok: false, error: "denied" };
    },
  });
  const folders = folderLabels(["/Users/a/Docs"]);
  bridge.update({ origin: "https://s.example", folders });
  await new Promise((r) => setTimeout(r, 0));
  const socket = sockets[0];
  assert.equal(socket.url, "wss://s.example/desktop-bridge");
  assert.deepEqual(socket.headers, { "x-leafdesk-desktop": "1", cookie: "better-auth.session_token=abc" });
  socket.open();
  assert.equal(bridge.isConnected, true);
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: "hello", version: "1.2.3", folders: ["Docs"] });
  assert.equal(socket.sent[0].includes("/Users/a"), false, "only labels are announced, never paths");

  socket.onmessage?.({ data: '{"type":"ping"}' });
  assert.equal(socket.sent.at(-1), '{"type":"pong"}');
  socket.onmessage?.({ data: JSON.stringify({ type: "call", id: "c1", op: "trash", path: "Docs/a", agent: "A", workspace: "W" }) });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(answered.length, 1);
  assert.deepEqual(JSON.parse(socket.sent.at(-1)!), { type: "result", id: "c1", ok: false, error: "denied" });

  bridge.update({ origin: "https://s.example", folders: folderLabels(["/Users/a/Docs", "/Users/a/Work"]) });
  assert.deepEqual(JSON.parse(socket.sent.at(-1)!).folders, ["Docs", "Work"]);
  assert.equal(sockets.length, 1, "other folders on the same server only announce again");

  bridge.stop();
  assert.equal(socket.closed, true);
  assert.equal(bridge.isConnected, false);
  bridge.update({ origin: "https://s.example", folders: [] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sockets.length, 1, "no folders, no connection");
});
