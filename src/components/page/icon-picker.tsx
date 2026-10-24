"use client";

import dynamic from "next/dynamic";
import { Popover } from "@/components/ui";

// The picker (emoji by category, built-in icons, search) loads when first opened.
const IconPickerPanel = dynamic(() => import("@/components/icon-picker/panel"), {
  ssr: false,
  loading: () => <div className="h-[23rem] w-[21.5rem] max-w-[calc(100vw-1.5rem)]" />,
});

export function IconPicker({
  icon,
  onChange,
  disabled,
  align,
  children,
}: {
  icon: string | null;
  onChange: (icon: string | null) => void;
  disabled?: boolean;
  /** "end" opens the picker leftwards, for a trigger near the right edge. */
  align?: "start" | "end";
  children: (toggle: () => void) => React.ReactNode;
}) {
  return (
    <Popover trigger={({ toggle }) => <>{children(disabled ? () => {} : toggle)}</>} align={align} className="p-0">
      {(close) => (
        <IconGrid
          icon={icon}
          onChange={(next) => {
            onChange(next);
            close();
          }}
        />
      )}
    </Popover>
  );
}

/**
 * The inside of IconPicker, for other popovers: emoji and built-in icons to choose from, search, a
 * random pick, and "Remove" while there is an icon.
 */
export function IconGrid({ icon, onChange }: { icon: string | null; onChange: (icon: string | null) => void }) {
  return <IconPickerPanel icon={icon} onChange={onChange} />;
}
