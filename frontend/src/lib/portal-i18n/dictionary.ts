import { en } from './en';

/**
 * The dictionary type: the en catalog's SHAPE with every leaf widened from a
 * literal to `string`. `sw.ts` declares `satisfies Dictionary`, so:
 *   • a key missing in sw            → tsc error (TS2322, excess/missing check)
 *   • an extra key only in sw        → tsc error (excess property check)
 *   • a non-string value in sw       → tsc error (shape mismatch)
 * en ≡ sw parity is thus enforced at tsc level AND re-asserted at runtime by
 * the catalog parity test in `portal-i18n.test.ts` (defense in depth).
 */
type WidenLeaves<T> = {
  [K in keyof T]: T[K] extends string ? string : WidenLeaves<T[K]>;
};

export type Dictionary = WidenLeaves<typeof en>;

/**
 * Key derivation from usage: the union of every dot-path to a leaf string in
 * the en catalog. `t('balance.cards.overdue.title')` type-checks;
 * `t('balence.cards.overdue.title')` (typo) or `t('gate.retired')` (removed
 * key) is a tsc error at the CALL SITE — missing keys cannot compile.
 */
export type DictionaryKey<ObjectT> = {
  [K in keyof ObjectT & string]: ObjectT[K] extends string
    ? K
    : `${K}.${DictionaryKey<ObjectT[K]>}`;
}[keyof ObjectT & string];

export type LocaleKey = DictionaryKey<Dictionary>;

/**
 * Runtime flatten of a catalog into its dot-path keys. Used by the parity
 * test (en ≡ sw key sets) and available for tooling; not on the render path.
 * Keys stay in the derived union — the result feeds straight back into `t`.
 */
export function flattenDictionary<ObjectT extends Dictionary>(
  dictionary: ObjectT,
): Array<DictionaryKey<ObjectT>> {
  const paths: Array<DictionaryKey<ObjectT>> = [];
  const walk = (node: Dictionary, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix.length === 0 ? key : `${prefix}.${key}`;
      if (typeof value === 'string') {
        paths.push(path as DictionaryKey<ObjectT>);
      } else if (typeof value === 'object' && value !== null) {
        // The shape is trusted by construction (ObjectT extends Dictionary,
        // leaves are strings, everything else is a nested catalog) — the
        // double cast is confined to this internal walker.
        walk(value as unknown as Dictionary, path);
      }
    }
  };
  walk(dictionary, '');
  return paths;
}
