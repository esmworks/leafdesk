"use client";

import { useTranslations } from "next-intl";
import { Popover } from "@/components/ui";

const EMOJIS = [
  "📄", "📝", "📚", "📌", "📎", "🗂️", "📁", "🗃️", "📊", "📈", "🧾", "🗒️",
  "✅", "☑️", "⭐", "🔥", "💡", "🎯", "🚀", "🧭", "🛠️", "⚙️", "🔒", "🔑",
  "🏠", "🏢", "🌍", "🗺️", "📅", "⏰", "💬", "📣", "🤝", "👥", "🧑‍💻", "🎨",
  "🧪", "🐛", "📦", "🧩", "💰", "🛒", "🍀", "🌱", "☀️", "🌙", "❤️", "🙂",
];

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
  const t = useTranslations("page.icon");
  return (
    <Popover trigger={({ toggle }) => <>{children(disabled ? () => {} : toggle)}</>} align={align} className="w-72">
      {(close) => (
        <div className="p-1">
          <div className="grid grid-cols-8 gap-0.5">
            {EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => {
                  onChange(e);
                  close();
                }}
                className="flex h-8 w-8 items-center justify-center rounded text-lg hover:bg-bg-hover"
              >
                {e}
              </button>
            ))}
          </div>
          {icon && (
            <button
              type="button"
              onClick={() => {
                onChange(null);
                close();
              }}
              className="mt-1 w-full rounded px-2 py-1.5 text-left text-sm text-fg-muted hover:bg-bg-hover"
            >
              {t("remove")}
            </button>
          )}
        </div>
      )}
    </Popover>
  );
}
