import { User } from "lucide-react";
import { avatarColor, avatarInitials } from "@/lib/conversations/contact-avatar";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: "h-10 w-10 text-sm",
  md: "h-12 w-12 text-base",
} as const;

/** Decorative: the contact's name is always shown next to it. */
export function Avatar({
  name,
  seed,
  size = "md",
  className,
}: {
  name: string | null | undefined;
  seed: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const initials = avatarInitials(name);
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white",
        SIZES[size],
        className,
      )}
      style={{ backgroundColor: avatarColor(seed) }}
    >
      {initials ?? <User className="h-1/2 w-1/2" />}
    </span>
  );
}
