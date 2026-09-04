import type { HTMLAttributes } from 'react';

export function Skeleton({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded bg-slate-200 ${className}`}
      {...rest}
    />
  );
}

/** Standard metric-card loading arrangement. */
export function SkeletonMetric({ rows = 1 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="presentation">
      <Skeleton className="h-8 w-32" />
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-4 w-full" />
      ))}
    </div>
  );
}

/** Standard table-card loading arrangement. */
export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="presentation">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
    </div>
  );
}
