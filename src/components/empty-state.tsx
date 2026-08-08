export function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--line)] bg-[var(--surface)] px-6 py-14 text-center">
      <p className="font-semibold">{title}</p>
      {description ? (
        <p className="max-w-sm text-sm text-[var(--muted)]">{description}</p>
      ) : null}
    </div>
  );
}
