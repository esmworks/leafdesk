import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupError, backupArchive, planBackup, recordBackup, snapshotWorkspace } from "@/server/backup/export";
import { listWorkspaces } from "@/server/workspaces";
import { backupFileName, backupsIn, backUpWorkspaces, pruneBackups } from "./local-backups";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/workspaces", () => ({ listWorkspaces: vi.fn() }));
vi.mock("@/server/backup/export", async () => {
  const { BackupError } = await vi.importActual<typeof import("@/server/backup/export")>("@/server/backup/export");
  return {
    BackupError,
    planBackup: vi.fn(),
    snapshotWorkspace: vi.fn(),
    recordBackup: vi.fn(),
    startBackupWork: vi.fn(() => () => {}),
    backupArchive: vi.fn(),
  };
});

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
let folder: string;

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "leafdesk backups "));
  vi.mocked(planBackup).mockImplementation(async (_userId, workspaceId) => ({ workspaceId, name: workspaceId, files: 0, fileBytes: 0 }));
  vi.mocked(snapshotWorkspace).mockImplementation(async (plan) => ({ plan }) as never);
  vi.mocked(backupArchive).mockImplementation(
    () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("zip"));
          controller.close();
        },
      }),
  );
});
afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(folder, { recursive: true, force: true });
});

describe("backupFileName", () => {
  const at = new Date(2026, 9, 18, 9, 5, 7);

  it("names the workspace, the local time to the second and the start of its id", () => {
    expect(backupFileName("Notes", A, at)).toBe("Notes 2026-10-18 09.05.07 [aaaaaaaa].zip");
  });

  it("leaves out what file systems refuse, and never starts with a dot", () => {
    expect(backupFileName('..a/b:c*d?"e<f>g|h\u0001', A, at)).toBe("a b c d e f g h 2026-10-18 09.05.07 [aaaaaaaa].zip");
    expect(backupFileName(" / ", A, at)).toBe("Workspace 2026-10-18 09.05.07 [aaaaaaaa].zip");
  });
});

describe("backupsIn and pruneBackups", () => {
  const touch = (name: string, minutesAgo: number) => {
    const file = path.join(folder, name);
    fs.writeFileSync(file, "zip");
    const time = new Date(Date.now() - minutesAgo * 60_000);
    fs.utimesSync(file, time, time);
  };

  it("finds a workspace's backups newest first, and keeps the newest", () => {
    for (let i = 0; i < 9; i++) touch(`A ${i} [aaaaaaaa].zip`, i);
    touch("B [bbbbbbbb].zip", 100);
    touch("notes.zip", 0);
    expect(backupsIn(folder, A).map(({ file }) => path.basename(file))[0]).toBe("A 0 [aaaaaaaa].zip");
    expect(backupsIn(folder)).toHaveLength(10);

    pruneBackups(folder, A, 7);
    expect(backupsIn(folder, A).map(({ file }) => path.basename(file))).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => `A ${i} [aaaaaaaa].zip`));
    // Another workspace's backups, and files that aren't backups, stay.
    expect(fs.existsSync(path.join(folder, "B [bbbbbbbb].zip"))).toBe(true);
    expect(fs.existsSync(path.join(folder, "notes.zip"))).toBe(true);
  });

  it("finds nothing in a folder that isn't there", () => {
    expect(backupsIn(path.join(folder, "missing"))).toEqual([]);
  });
});

describe("backUpWorkspaces", () => {
  it("writes each owned workspace whole, and records it", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { id: A, name: "Mine", icon: null, role: "owner" },
      { id: B, name: "Theirs", icon: null, role: "member" },
    ] as never);
    fs.writeFileSync(path.join(folder, "Old 2026-01-01 00.00.00 [aaaaaaaa].zip.partial"), "half");

    const result = await backUpWorkspaces("user", folder, new Date(2026, 9, 18, 12, 0, 0));
    expect(result.errors).toEqual([]);
    expect(result.files.map((file) => path.basename(file))).toEqual(["Mine 2026-10-18 12.00.00 [aaaaaaaa].zip"]);
    expect(fs.readFileSync(result.files[0], "utf8")).toBe("zip");
    expect(fs.readdirSync(folder)).toEqual(["Mine 2026-10-18 12.00.00 [aaaaaaaa].zip"]);
    expect(recordBackup).toHaveBeenCalledOnce();
  });

  it("skips a workspace whose export is off, and reports one that fails without leaving half a file", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { id: A, name: "Off", icon: null, role: "owner" },
      { id: B, name: "Broken", icon: null, role: "owner" },
    ] as never);
    vi.mocked(planBackup).mockImplementation(async (_userId, workspaceId) => {
      if (workspaceId === A) throw new BackupError("disabled");
      return { workspaceId, name: "Broken", files: 0, fileBytes: 0 };
    });
    vi.mocked(backupArchive).mockImplementation(
      () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("z"));
            controller.error(new Error("disk full"));
          },
        }),
    );

    const result = await backUpWorkspaces("user", folder);
    expect(result.files).toEqual([]);
    expect(result.errors).toEqual(["Broken: disk full"]);
    expect(fs.readdirSync(folder)).toEqual([]);
    expect(recordBackup).not.toHaveBeenCalled();
  });
});
