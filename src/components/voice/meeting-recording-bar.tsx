"use client";

import { CircleStop, Mic, Pause, Play } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { IconButton } from "@/components/ui";
import { formatStamp } from "@/lib/meeting-clock";
import type { MeetingRecording } from "./meeting-recorder";

/** The meeting being recorded, while the person is somewhere else in the app: time, pause, stop. */
export default function MeetingRecordingBar({
  recording,
  workspaceId,
  onPause,
  onResume,
  onStop,
}: {
  recording: MeetingRecording;
  workspaceId: string;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}) {
  const t = useTranslations("meetings");
  const pathname = usePathname();
  const href = `/w/${workspaceId}/p/${recording.pageId}`;
  // On the meeting's own page its block has the controls.
  if (pathname === href) return null;
  const busy = recording.status === "starting" || recording.status === "finishing";
  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-md items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-sm shadow-lg sm:inset-x-auto sm:inset-e-6"
    >
      <span className={recording.status === "recording" ? "h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-danger" : "h-2.5 w-2.5 shrink-0 rounded-full bg-fg-faint"} aria-hidden />
      <Link href={href} className="min-w-0 flex-1 truncate hover:underline">
        {recording.title.trim() || t("untitled")}
      </Link>
      <span className="shrink-0 tabular-nums text-fg-muted">{busy ? t("block.finishing") : formatStamp(recording.seconds)}</span>
      {!busy &&
        (recording.status === "paused" ? (
          <IconButton label={t("block.resume")} onClick={onResume}>
            <Play className="h-4 w-4" />
          </IconButton>
        ) : (
          <IconButton label={t("block.pause")} onClick={onPause}>
            <Pause className="h-4 w-4" />
          </IconButton>
        ))}
      {!busy && (
        <IconButton label={t("block.stop")} onClick={onStop}>
          <CircleStop className="h-4 w-4 text-danger" />
        </IconButton>
      )}
      {busy && <Mic className="h-4 w-4 shrink-0 text-fg-faint" aria-hidden />}
    </div>
  );
}
