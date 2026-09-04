import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';

export function Table({ className = '', ...rest }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={`w-full border-collapse text-left text-sm ${className}`} {...rest} />
    </div>
  );
}

export function THead({ className = '', ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={`bg-surface-sunk ${className}`} {...rest} />;
}

export function TBody({ className = '', ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={`divide-y divide-slate-100 ${className}`} {...rest} />;
}

export function TR({ className = '', ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={`align-middle ${className}`} {...rest} />;
}

export function TH({ className = '', ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-soft ${className}`}
      {...rest}
    />
  );
}

export function TD({ className = '', ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={`px-3 py-2 text-ink ${className}`} {...rest} />;
}
