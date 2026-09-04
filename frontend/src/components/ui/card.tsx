import type { HTMLAttributes } from 'react';

export function Card({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-lg border border-slate-200 bg-surface-raised shadow-sm ${className}`}
      {...rest}
    />
  );
}

export function CardHeader({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`border-b border-slate-100 px-4 py-3 ${className}`} {...rest} />;
}

export function CardTitle({ className = '', ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={`text-sm font-semibold text-ink ${className}`} {...rest} />;
}

export function CardDescription({ className = '', ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={`mt-0.5 text-xs text-ink-soft ${className}`} {...rest} />;
}

export function CardContent({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`px-4 py-3 ${className}`} {...rest} />;
}

export function CardFooter({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`border-t border-slate-100 px-4 py-2 text-xs text-ink-faint ${className}`}
      {...rest}
    />
  );
}
