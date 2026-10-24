"use client";

import { useEffect, useState } from "react";

type Code = { value: string; path: string; modules: number };

/**
 * A QR code drawn as one SVG path, dark on white whatever the theme (scanners need the contrast).
 * The encoder loads with the first code shown, not with the settings and account pages it sits on.
 */
export function QrCode({ value, label, size = 176 }: { value: string; label: string; size?: number }) {
  const [code, setCode] = useState<Code | null>(null);
  useEffect(() => {
    let live = true;
    void import("uqr").then(({ encode }) => {
      if (!live) return;
      const { data } = encode(value, { ecc: "M", border: 2 });
      let d = "";
      data.forEach((row, y) =>
        row.forEach((dark, x) => {
          if (dark) d += `M${x} ${y}h1v1h-1z`;
        }),
      );
      setCode({ value, path: d, modules: data.length });
    });
    return () => {
      live = false;
    };
  }, [value]);
  if (!code || code.value !== value) {
    return <div role="img" aria-label={label} aria-busy="true" style={{ width: size, height: size, background: "#fff" }} className="shrink-0 rounded-md border border-border" />;
  }
  return (
    <svg
      viewBox={`0 0 ${code.modules} ${code.modules}`}
      width={size}
      height={size}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-md border border-border"
    >
      <rect width={code.modules} height={code.modules} fill="#fff" />
      <path d={code.path} fill="#000" />
    </svg>
  );
}
