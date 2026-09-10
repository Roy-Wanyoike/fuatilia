import type { Dictionary, LocaleKey } from './dictionary';

/**
 * The portal i18n translate function. Missing keys are refused LOUDLY, at
 * two levels:
 *
 * 1. tsc level (the documented pattern): `t`'s first parameter is the
 *    derived key union `LocaleKey` (see `dictionary.ts`) — any key not
 *    present in the en catalog is a compile error at the call site, and the
 *    sw catalog is `satisfies Dictionary`, so a key missing from sw breaks
 *    the build in `sw.ts` itself.
 * 2. runtime level (defense in depth): if a key still fails to resolve —
 *    e.g. an untyped caller forcing `key as LocaleKey`, or a mid-path value
 *    that is not a leaf string — `translate` THROWS `MissingPortalStringError`
 *    instead of rendering `undefined`, "[object Object]", or the raw key as
 *    if it were copy. A portal must never show a fabricated blank.
 */
export class MissingPortalStringError extends Error {
  constructor(detail: string) {
    super(`portal-i18n: ${detail}`);
    this.name = 'MissingPortalStringError';
  }
}

const VARIABLE_TOKEN = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

export type TemplateVars = Readonly<Record<string, string | number>>;

function interpolate(template: string, key: string, vars: TemplateVars | undefined): string {
  if (vars === undefined) {
    const stray = template.match(VARIABLE_TOKEN);
    if (stray !== null) {
      throw new MissingPortalStringError(
        `key "${key}" needs variable(s) ${stray.join(', ')} but none were provided`,
      );
    }
    return template;
  }

  const rendered = template.replace(VARIABLE_TOKEN, (token, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new MissingPortalStringError(`key "${key}" is missing its "{${name}}" variable`);
    }
    return String(value);
  });

  // A token the catalog references but the caller never passed (or a
  // literal brace typo) must not leak into the payer's UI.
  if (VARIABLE_TOKEN.test(rendered)) {
    throw new MissingPortalStringError(`key "${key}" still contains an unfilled placeholder`);
  }
  return rendered;
}

/**
 * Resolve one dot-path key against a catalog and fill its `{var}` tokens.
 * Throws `MissingPortalStringError` on: unknown key, non-leaf (mid-path)
 * key, or a template variable that was not supplied. en is the source of
 * truth for KEYS; passing a key that exists only in sw is impossible — both
 * catalogs are held to the same derived key union by tsc.
 */
export function translate(
  dictionary: Dictionary,
  key: LocaleKey,
  vars?: TemplateVars,
): string {
  let node: unknown = dictionary;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null || !(segment in node)) {
      throw new MissingPortalStringError(`missing key "${key}"`);
    }
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node !== 'string') {
    throw new MissingPortalStringError(`key "${key}" is not a leaf string`);
  }
  return interpolate(node, key, vars);
}
