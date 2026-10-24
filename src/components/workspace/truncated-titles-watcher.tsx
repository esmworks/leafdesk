"use client";

import { useEffect } from "react";

/** Tooltips for text cut short (see truncated-titles), loaded after the page is up. */
export function TruncatedTitles() {
  useEffect(() => {
    let stop: (() => void) | undefined;
    let gone = false;
    void import("./truncated-titles").then(({ watchTruncatedText }) => {
      if (!gone) stop = watchTruncatedText();
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, []);
  return null;
}
