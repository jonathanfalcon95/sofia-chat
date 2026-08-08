import { cn } from "@/lib/utils";

export function Badge({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border border-[var(--line)] bg-[var(--accent-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--accent)]",
        className,
      )}
      {...props}
    />
  );
}
