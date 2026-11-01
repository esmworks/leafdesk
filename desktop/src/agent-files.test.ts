import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  activeFolders,
  AgentFilesBridge,
  answerCall,
  appendAudit,
  askWithTimeout,
  auditLine,
  bridgeUrl,
  folderLabels,
  hasProtectedParts,
  isProtectedName,
  isUnsafePart,
  MAX_FILE_BYTES,
  moveToServer,
  oneAtATime,
  PING_MS,
  previewOf,
  problemOf,
  readAgentFilesByServer,
  readAgentFilesSettings,
  readCall,
  reconnectDelay,
  refusedRoot,
  resolvePlace,
  startsAtSignIn,
  type AuditEntry,
  type BridgeProblem,
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
  assert.ok(previewOf("x".repeat(500)).endsWith("…"));
});

test("a long preview shows its first and last lines, and how many are left out between", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  assert.deepEqual(previewOf(twenty, (count) => `[${count} more]`).split("\n"), ["line 0", "line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "[8 more]", "line 16", "line 17", "line 18", "line 19"]);
  // Up to the first and last lines and one more, everything is shown.
  assert.equal(previewOf(Array.from({ length: 13 }, (_, i) => `l${i}`).join("\n")).split("\n").length, 13);
  assert.equal(previewOf("a\r\nb\n\n\n"), "a\nb");
  // Characters that turn text around or hide it are taken out; tabs show as spaces.
  assert.equal(previewOf("rm ‮txt.exe​\tx"), "rm txt.exe  x");
});

test("names shown in the question lose characters that turn or hide text", () => {
  const read = readCall({ type: "call", id: "a", op: "trash", path: "Docs/a", agent: "Fil‮er\u0007", workspace: "⁦Acme⁩ " });
  assert.equal(read?.agent, "Filer");
  assert.equal(read?.workspace, "Acme");
  assert.deepEqual(
    folderLabels(["/Users/a/Re‮ports"]).map((f) => f.label),
    ["Reports"],
  );
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
  onclose: ((event?: { code?: number }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
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

/** A bridge on fake sockets that records what it reports. */
function fakeBridge(onStatus?: (bridge: AgentFilesBridge, connected: boolean, problem?: BridgeProblem) => void) {
  const sockets: FakeSocket[] = [];
  const statuses: string[] = [];
  const bridge: AgentFilesBridge = new AgentFilesBridge({
    open: (url, headers) => {
      const socket = new FakeSocket(url, headers);
      sockets.push(socket);
      return socket;
    },
    cookie: async () => "c=1",
    version: "1",
    answer: async (c) => ({ type: "result", id: c.id, ok: false, error: "denied" }),
    onStatus: (connected, problem) => {
      statuses.push(connected ? "connected" : `off${problem ? `:${problem}` : ""}`);
      onStatus?.(bridge, connected, problem);
    },
  });
  return { bridge, sockets, statuses };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

test("the bridge connects again after a close, though the app hands it a new but equal target on every status", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  // main.ts redraws its menu on every status change, which makes a new target object each time.
  const target = () => ({ origin: "https://s.example", folders: folderLabels(["/Users/a/Docs"]) });
  const { bridge, sockets } = fakeBridge((b) => b.update(target()));
  bridge.update(target());
  await settle();
  assert.equal(sockets.length, 1);
  sockets[0].open();
  sockets[0].readyState = 3;
  sockets[0].onclose?.({ code: 1006 });
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(sockets.length, 2, "a new connection after the backoff");
  sockets[1].open();
  assert.equal(bridge.isConnected, true);
  bridge.stop();
});

test("the bridge takes the connection as lost when the server's pings stop, and keeps it while they come", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const { bridge, sockets, statuses } = fakeBridge();
  bridge.update({ origin: "https://s.example", folders: folderLabels(["/Users/a/Docs"]) });
  await settle();
  sockets[0].open();
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(PING_MS);
    sockets[0].onmessage?.({ data: '{"type":"ping"}' });
  }
  assert.equal(sockets[0].closed, false, "pings keep it");
  assert.equal(bridge.isConnected, true);
  // No ping for over twice the interval: closed and tried again.
  t.mock.timers.tick(3 * PING_MS);
  assert.equal(sockets[0].closed, true);
  assert.equal(bridge.isConnected, false);
  assert.equal(statuses.at(-1), "off:unreachable");
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(sockets.length, 2);
  bridge.stop();
});

test("the bridge says why it isn't connected: signed out, an untrusted certificate, or no answer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const { bridge, sockets, statuses } = fakeBridge();
  bridge.update({ origin: "https://s.example", folders: folderLabels(["/Users/a/Docs"]) });
  await settle();
  sockets[0].open();
  sockets[0].onclose?.({ code: 4401 });
  assert.equal(statuses.at(-1), "off:signedOut");
  t.mock.timers.tick(1_000);
  await settle();
  const certificate = new TypeError("Received network error or non-101 status code.", { cause: new TypeError("fetch failed", { cause: Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }) }) });
  sockets[1].onerror?.({ type: "error", error: certificate });
  sockets[1].onclose?.({ code: 1006 });
  assert.equal(statuses.at(-1), "off:certificate");
  bridge.stop();

  assert.equal(problemOf({ error: Object.assign(new Error("x"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) }), "certificate");
  assert.equal(problemOf({ error: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }), "unreachable");
  assert.equal(problemOf(undefined), "unreachable");
});

test("links: a write or a trash follows none, a read only those that end inside the folder", async () => {
  const box = sandbox();
  try {
    fs.mkdirSync(path.join(box.root, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(box.root, "important.txt"), "keep");
    fs.symlinkSync(".", path.join(box.root, "self"));
    fs.symlinkSync("..", path.join(box.root, "a", "b", "up"));
    fs.symlinkSync("important.txt", path.join(box.root, "link.txt"));
    fs.symlinkSync("sub", path.join(box.root, "inner"));
    const allowed = host(box, true);

    // The folder itself through a link, and a folder in it through `..`: refused, nobody asked.
    for (const [op, place] of [
      ["trash", "Docs/self"],
      ["trash", "Docs/a/b/up"],
      ["trash", "Docs/link.txt"],
      ["write", "Docs/link.txt"],
      ["write", "Docs/inner/new.md"],
      ["write", "Docs/self/new.md"],
    ] as const) {
      const result = await answerCall(call(op, place, op === "write" ? "x" : undefined), allowed.h);
      assert.equal(result.ok, false, `${op} ${place}`);
      assert.ok(!result.ok && result.error === "outside", `${op} ${place}: ${!result.ok && result.error}`);
    }
    assert.equal(allowed.asked.length, 0);
    assert.deepEqual(allowed.trashed, []);
    assert.equal(fs.readFileSync(path.join(box.root, "important.txt"), "utf8"), "keep");
    assert.equal(fs.existsSync(path.join(box.root, "sub", "new.md")), false);

    // Reads may follow a link that stays inside, but not one back to the folder itself.
    assert.deepEqual(await answerCall(call("read", "Docs/link.txt"), allowed.h), { type: "result", id: "read-1", ok: true, result: { op: "read", text: "keep", bytes: 4 } });
    assert.ok((await answerCall(call("list", "Docs/inner"), allowed.h)).ok);
    assert.equal(await refusal(resolvePlace(box.folders, "Docs/self")), "outside");
  } finally {
    box.cleanup();
  }
});

test("a write or a trash never touches hidden names or places things start from at sign-in", async () => {
  const box = sandbox();
  try {
    fs.mkdirSync(path.join(box.root, ".notes"));
    fs.writeFileSync(path.join(box.root, ".notes", "a.md"), "a");
    const allowed = host(box, true);
    for (const [op, place] of [
      ["write", "Docs/.notes/a.md"],
      ["trash", "Docs/.notes/a.md"],
      ["write", "Docs/.zshrc"],
      ["write", "Docs/Library/LaunchAgents/run.plist"],
      ["write", "Docs/x/.config/autostart/run.desktop"],
      ["write", "Docs/Start Menu/Programs/Startup/run.lnk"],
    ] as const) {
      const result = await answerCall(call(op, place, op === "write" ? "x" : undefined), allowed.h);
      assert.ok(!result.ok && result.error === "protected", `${op} ${place}: ${JSON.stringify(result)}`);
    }
    assert.equal(allowed.asked.length, 0);
    // Reading them is fine.
    assert.ok((await answerCall(call("read", "Docs/.notes/a.md"), allowed.h)).ok);
  } finally {
    box.cleanup();
  }
});

test("parts that differ between systems, and invisible characters, are refused", async () => {
  for (const part of ["a:b", "file.txt:stream", "CON", "con.txt", "Aux", "NUL.md", "com1", "LPT9.log", "id_rsa.", "server.pem "]) assert.equal(isUnsafePart(part), true, part);
  for (const part of ["console.md", "auxiliary", "plan.md", "com10x"]) assert.equal(isUnsafePart(part), false, part);
  const box = sandbox();
  try {
    for (const place of ["Docs/a:b.md", "Docs/CON", "Docs/sub/nul.txt", "Docs/id_rsa.", "Docs/x\u202Etxt.md", "Docs/a\u200Bb.md", "Docs/\uFEFFplan.md"]) {
      assert.equal(await refusal(resolvePlace(box.folders, place)), "outside", place);
    }
  } finally {
    box.cleanup();
  }
});

test("more places of keys, passwords and histories are protected, letter case aside", () => {
  for (const name of [".zsh_history", ".bash_history", ".python_history", ".node_repl_history", ".psql_history", ".mysql_history", ".vault-token", "terraform.tfstate", "prod.tfstate.backup", ".terraform.d", "Keyrings", ".NPMRC", ".Password-Store"]) {
    assert.equal(isProtectedName(name), true, name);
  }
  assert.equal(hasProtectedParts([".config", "gh", "hosts.yml"]), true);
  assert.equal(hasProtectedParts([".Config", "GCloud"]), true);
  assert.equal(hasProtectedParts([".cargo", "credentials.toml"]), true);
  assert.equal(hasProtectedParts([".docker", "config.json"]), true);
  assert.equal(hasProtectedParts(["notes", "gh"]), false);
  assert.equal(hasProtectedParts([".config", "nvim", "init.lua"]), false);
  assert.equal(startsAtSignIn("/Users/a/library/LaunchAgents/x.plist"), true);
  assert.equal(startsAtSignIn("C:\\Users\\a\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.lnk"), true);
  assert.equal(startsAtSignIn("/Users/a/Documents/Library/notes.md"), false);
});

test("the disk, the home folder and the system's settings for apps can't be picked", () => {
  const mac = (p: string) => refusedRoot(p, "/Users/a", "darwin");
  assert.equal(mac("/"), true);
  assert.equal(mac("/Users/a"), true);
  assert.equal(mac("/Users/A/"), true);
  assert.equal(mac("/Users"), true, "a folder holding the home folder");
  assert.equal(mac("/Users/a/Library"), true);
  assert.equal(mac("/Users/a/library/Mobile Documents"), true);
  assert.equal(mac("/Users/a/.ssh"), true);
  assert.equal(mac("/Users/a/Documents"), false);
  assert.equal(mac("/Volumes/Work"), false);
  const win = (p: string) => refusedRoot(p, "C:\\Users\\a", "win32");
  assert.equal(win("C:\\"), true);
  assert.equal(win("D:\\"), true);
  assert.equal(win("c:\\users\\A"), true);
  assert.equal(win("C:\\Users\\a\\AppData\\Roaming"), true);
  assert.equal(win("C:\\Users\\a\\Documents"), false);
  assert.equal(win("D:\\Work"), false);
  const linux = (p: string) => refusedRoot(p, "/home/a", "linux");
  assert.equal(linux("/home/a/.config/app"), true);
  assert.equal(linux("/home/a/Notes"), false);
});

test("a trash question shows the file's size", async () => {
  const box = sandbox();
  try {
    const allowed = host(box, true);
    await answerCall(call("trash", "Docs/plan.md"), allowed.h);
    assert.deepEqual(allowed.asked[0], { op: "trash", agent: "Filer", workspace: "Acme", place: "Docs/plan.md", server: "https://leafdesk.example.com", bytes: 16 });
  } finally {
    box.cleanup();
  }
});

test("each server has its own settings, off while turned off, and old settings go to the server open", () => {
  assert.deepEqual(readAgentFilesByServer({ "https://a.example": { enabled: true, folders: ["/x"] }, local: { enabled: "no" }, "": { enabled: true } }), {
    "https://a.example": { enabled: true, folders: ["/x"] },
    local: { enabled: false, folders: [] },
  });
  assert.equal(readAgentFilesByServer([]), undefined);
  const legacy = { enabled: true, folders: ["/Users/a/Docs"] };
  assert.deepEqual(moveToServer(legacy, undefined, "https://a.example"), { "https://a.example": legacy });
  assert.deepEqual(moveToServer(legacy, { "https://a.example": { enabled: false, folders: [] } }, "https://a.example"), { "https://a.example": { enabled: false, folders: [] } });
  assert.equal(moveToServer(legacy, undefined, undefined), undefined);
  assert.deepEqual(activeFolders({ enabled: false, folders: ["/Users/a/Docs"] }), []);
  assert.deepEqual(activeFolders(undefined), []);
  assert.deepEqual(activeFolders(legacy).map((f) => f.label), ["Docs"]);
});

test("turned off while the person is asked: the question closes as a no, and a yes given anyway does nothing", async () => {
  const box = sandbox();
  try {
    // Like main.ts: one controller for "access is on", aborted when it is turned off.
    const off = new AbortController();
    let enabled = true;
    const { h, log } = host(box, true);
    h.folders = () => (enabled ? box.folders : []);
    h.ask = (_approval, signal) =>
      new Promise<boolean>((resolve) => {
        const both = AbortSignal.any([signal, off.signal]);
        both.addEventListener("abort", () => resolve(false));
      });
    const pending = answerCall(call("write", "Docs/off.md", "x"), h);
    await new Promise((r) => setTimeout(r, 5));
    enabled = false;
    off.abort();
    assert.deepEqual(await pending, { type: "result", id: "write-1", ok: false, error: "denied" });

    // The person said yes, but access was turned off meanwhile: no folders, nothing written.
    const late = host(box, true);
    late.h.ask = async () => {
      enabled = false;
      return true;
    };
    late.h.folders = () => (enabled ? box.folders : []);
    enabled = true;
    assert.deepEqual(await answerCall(call("write", "Docs/off.md", "x"), late.h), { type: "result", id: "write-1", ok: false, error: "outside" });
    assert.equal(fs.existsSync(path.join(box.root, "off.md")), false);
    assert.deepEqual(log.map((l) => l.outcome), ["denied"]);
  } finally {
    box.cleanup();
  }
});
