export interface EmptyStateProps {
  title: string;
  description: string;
  /** Optional hint, e.g. what would make this view non-empty. */
  hint?: string;
}

export function EmptyState({ title, description, hint }: EmptyStateProps) {
  return (
    <div
      className="flex flex-col items-start gap-1 rounded-md border border-dashed border-slate-300 bg-surface-sunk/40 px-4 py-6"
      data-testid="empty-state"
    >
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="text-xs text-ink-soft">{description}</p>
      {hint !== undefined && <p className="text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}
