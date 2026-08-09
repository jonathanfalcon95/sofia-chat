"use client";

import { useEffect, useRef, useState } from "react";
import { Smile } from "lucide-react";
import { Button } from "@/components/ui/button";

const EMOJIS = [
  "😀", "😃", "😄", "😁", "😅", "😂", "🤣", "😊", "😇", "🙂",
  "😉", "😍", "🥰", "😘", "😗", "😋", "😛", "😜", "🤪", "😝",
  "🤗", "🤭", "🤫", "🤔", "😐", "😑", "😶", "🙄", "😏", "😣",
  "😥", "😮", "🤐", "😯", "😪", "😫", "🥱", "😴", "😌", "😛",
  "😒", "😓", "😔", "😕", "🙃", "🤑", "😲", "☹️", "🙁", "😖",
  "😞", "😟", "😤", "😢", "😭", "😦", "😧", "😨", "😩", "🤯",
  "😬", "😰", "😱", "🥵", "🥶", "😳", "🤪", "😵", "😡", "😠",
  "👍", "👎", "👏", "🙌", "🤝", "🙏", "💪", "✌️", "🤞", "🤟",
  "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💔", "❣️",
  "✅", "❌", "⭐", "🔥", "🎉", "💯", "📌", "✨", "👋", "🙏",
];

export function EmojiPicker({
  disabled,
  onPick,
}: {
  disabled?: boolean;
  onPick: (emoji: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        aria-label="Emojis"
        className="h-9 w-9 shrink-0 rounded-full border-0 text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
        onClick={() => setOpen((v) => !v)}
      >
        <Smile className="h-4 w-4" />
      </Button>
      {open ? (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-[280px] rounded-xl border border-[var(--line)] bg-[var(--surface)] p-2 shadow-lg">
          <div className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
            Emojis
          </div>
          <div className="grid max-h-[200px] grid-cols-8 gap-0.5 overflow-y-auto">
            {EMOJIS.map((emoji, i) => (
              <button
                key={`${emoji}-${i}`}
                type="button"
                className="rounded-md p-1.5 text-lg leading-none hover:bg-[var(--surface-2)]"
                onClick={() => {
                  onPick(emoji);
                  setOpen(false);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
