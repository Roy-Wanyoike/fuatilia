import { describe, expect, it } from 'vitest';
import { DomainError, type Uuid, uuid } from '../shared';
import {
  extractPlaceholders,
  findTemplate,
  latestTemplate,
  nextTemplateVersion,
  registerTemplate,
  renderTemplate,
  type MessageTemplate,
} from './templates';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(1);
const TPL_ID = uid(2);

const T0 = '2026-03-01T08:00:00.000Z';
const clock = { now: () => new Date(T0) };

const key = { orgId: ORG, name: 'dunning_reminder', channel: 'whatsapp' as const, locale: 'en-KE' };

const reg = (rows: Array<Partial<MessageTemplate> & { version: number }>): MessageTemplate[] =>
  rows.map((row) =>
    registerTemplate(
      {
        id: uid(100 + row.version),
        orgId: row.orgId ?? ORG,
        name: row.name ?? key.name,
        channel: row.channel ?? key.channel,
        locale: row.locale ?? key.locale,
        body: row.body ?? 'Hello {{name}}, invoice {{invoice}} is due.',
        version: row.version,
      },
      [],
      clock,
    ),
  );

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
};

// --- placeholder extraction (table-driven) -----------------------------------

describe('extractPlaceholders', () => {
  const cases: Array<{ body: string; want: string[] }> = [
    { body: 'Hello {{name}}', want: ['name'] },
    { body: 'No placeholders here', want: [] },
    { body: '{{a}} then {{b}} then {{a}}', want: ['a', 'b'] },
    { body: 'Spacing {{  name  }} kept', want: ['name'] },
    { body: 'snake_ok {{due_date_2}}', want: ['due_date_2'] },
    { body: '', want: [] },
  ];
  for (const c of cases) {
    it(`extracts ${JSON.stringify(c.want)} from ${JSON.stringify(c.body)}`, () => {
      expect(extractPlaceholders(c.body)).toEqual(c.want);
    });
  }

  const malformed: Array<{ body: string }> = [
    { body: 'unclosed {{name' },
    { body: 'empty {{}}' },
    { body: 'bad name {{due date}}' },
    { body: 'dashes {{a-b}}' },
    { body: 'lone braces }} {{' },
  ];
  for (const c of malformed) {
    it(`rejects malformed body ${JSON.stringify(c.body)} with COMMS_TEMPLATE_BODY_MALFORMED`, () => {
      expectCode(() => extractPlaceholders(c.body), 'COMMS_TEMPLATE_BODY_MALFORMED');
    });
  }
});

// --- registration (versioned, immutable) --------------------------------------

describe('registerTemplate', () => {
  it('registers a frozen v1 row with channel validated and createdAt from the Clock', () => {
    const tpl = reg([{ version: 1 }])[0]!;
    expect(tpl.version).toBe(1);
    expect(tpl.channel).toBe('whatsapp');
    expect(tpl.createdAt).toBe(T0);
    expect(Object.isFrozen(tpl)).toBe(true);
  });

  it('mutating a registered row throws TypeError (immutability)', () => {
    const tpl = reg([{ version: 1 }])[0]!;
    expect(() => {
      (tpl as { body: string }).body = 'rewritten';
    }).toThrow(TypeError);
  });

  it('re-registering the exact version is refused even with an identical body', () => {
    const registry = reg([{ version: 1 }]);
    expectCode(
      () =>
        registerTemplate(
          { id: uid(999), orgId: ORG, name: key.name, channel: key.channel, locale: key.locale, body: 'Hello {{name}}, invoice {{invoice}} is due.', version: 1 },
          registry,
          clock,
        ),
      'COMMS_TEMPLATE_VERSION_EXISTS',
    );
  });

  it('re-registering the version with a DIFFERENT body is also refused (row identity is the audit fact)', () => {
    const registry = reg([{ version: 1 }]);
    expectCode(
      () =>
        registerTemplate(
          { id: uid(999), orgId: ORG, name: key.name, channel: key.channel, locale: key.locale, body: 'Different {{x}}', version: 1 },
          registry,
          clock,
        ),
      'COMMS_TEMPLATE_VERSION_EXISTS',
    );
  });

  it('uniqueness is scoped to (org, name, channel, locale) — other keys may reuse the version', () => {
    const registry = reg([{ version: 1 }]);
    const other = reg([{ version: 1, channel: 'sms', name: 'dunning_reminder' }])[0]!;
    expect(other.channel).toBe('sms');
    expect(registry).toHaveLength(1);
  });

  it('table: invalid registrations throw stable codes', () => {
    const table: Array<{ args: Parameters<typeof registerTemplate>[0]; code: string }> = [
      {
        args: { id: TPL_ID, orgId: ORG, name: 'x', channel: 'push', locale: 'en-KE', body: 'hi', version: 1 },
        code: 'COMMS_CHANNEL_INVALID',
      },
      {
        args: { id: TPL_ID, orgId: ORG, name: ' ', channel: 'sms', locale: 'en-KE', body: 'hi', version: 1 },
        code: 'COMMS_TEMPLATE_NAME_REQUIRED',
      },
      {
        args: { id: TPL_ID, orgId: ORG, name: 'x', channel: 'sms', locale: '', body: 'hi', version: 1 },
        code: 'COMMS_TEMPLATE_LOCALE_REQUIRED',
      },
      {
        args: { id: TPL_ID, orgId: ORG, name: 'x', channel: 'sms', locale: 'en-KE', body: '  ', version: 1 },
        code: 'COMMS_TEMPLATE_BODY_REQUIRED',
      },
      {
        args: { id: TPL_ID, orgId: ORG, name: 'x', channel: 'sms', locale: 'en-KE', body: 'broken {{a', version: 1 },
        code: 'COMMS_TEMPLATE_BODY_MALFORMED',
      },
      {
        args: { id: TPL_ID, orgId: ORG, name: 'x', channel: 'sms', locale: 'en-KE', body: 'hi', version: 0 },
        code: 'COMMS_TEMPLATE_VERSION_INVALID',
      },
      {
        args: { id: TPL_ID, orgId: ORG, name: 'x', channel: 'sms', locale: 'en-KE', body: 'hi', version: 1.5 },
        code: 'COMMS_TEMPLATE_VERSION_INVALID',
      },
    ];
    for (const c of table) {
      expectCode(() => registerTemplate(c.args, [], clock), c.code);
    }
  });

  it('rejects a duplicate row id (registry discipline)', () => {
    const registry = reg([{ version: 1 }]);
    expectCode(
      () =>
        registerTemplate(
          { id: registry[0]!.id, orgId: ORG, name: 'other', channel: 'sms', locale: 'en-KE', body: 'hi', version: 1 },
          registry,
          clock,
        ),
      'COMMS_TEMPLATE_ID_TAKEN',
    );
  });
});

// --- version navigation ---------------------------------------------------------

describe('template versioning', () => {
  it('nextTemplateVersion: empty registry → 1, gaps → max+1', () => {
    expect(nextTemplateVersion([], key)).toBe(1);
    const registry = reg([{ version: 1 }, { version: 3 }, { version: 2 }]);
    expect(nextTemplateVersion(registry, key)).toBe(4);
  });

  it('findTemplate by exact version keeps serving the pinned body after newer versions exist', () => {
    const registry = [
      ...reg([{ version: 1, body: 'V1 body for {{name}}' }]),
      ...reg([{ version: 2, body: 'V2 body for {{name}}' }]),
    ];
    const v1 = findTemplate(registry, { ...key, version: 1 });
    const v2 = findTemplate(registry, { ...key, version: 2 });
    expect(v1?.body).toBe('V1 body for {{name}}');
    expect(v2?.body).toBe('V2 body for {{name}}');
    expect(findTemplate(registry, { ...key, version: 4 })).toBeNull();
  });

  it('latestTemplate returns the highest version', () => {
    const registry = [...reg([{ version: 2 }]), ...reg([{ version: 5 }]), ...reg([{ version: 3 }])];
    expect(latestTemplate(registry, key)?.version).toBe(5);
    expect(latestTemplate([], key)).toBeNull();
  });

  it('rendering a pinned old version is unaffected by later versions (messages pin exact versions)', () => {
    const registry = [
      ...reg([{ version: 1, body: 'Old copy for {{name}}' }]),
      ...reg([{ version: 2, body: 'New copy for {{name}}' }]),
    ];
    const pinned = findTemplate(registry, { ...key, version: 1 })!;
    expect(renderTemplate(pinned, { name: 'Asha' }).body).toBe('Old copy for Asha');
  });
});

// --- rendering -------------------------------------------------------------------

describe('renderTemplate', () => {
  const tpl = reg([{ version: 1, body: 'Hello {{name}}, balance {{balance}} due {{due_date}}.' }])[0]!;

  it('renders deterministically — same inputs, byte-identical output', () => {
    const values = { name: 'Asha', balance: '1,200', due_date: '2026-03-15' };
    const a = renderTemplate(tpl, values);
    const b = renderTemplate(tpl, values);
    expect(a.body).toBe('Hello Asha, balance 1,200 due 2026-03-15.');
    expect(a.body).toBe(b.body);
    expect(a.body).not.toContain('{{');
  });

  it('pins the exact template version on the rendered ref', () => {
    expect(renderTemplate(tpl, { name: 'x', balance: 'y', due_date: 'z' }).templateRef).toEqual({
      templateId: tpl.id,
      version: 1,
    });
  });

  it('rejects missing values, listing every placeholder', () => {
    expectCode(() => renderTemplate(tpl, { name: 'Asha' }), 'COMMS_TEMPLATE_VALUE_MISSING');
    try {
      renderTemplate(tpl, { name: 'Asha' });
    } catch (err) {
      expect((err as DomainError).details).toMatchObject({ missing: ['balance', 'due_date'] });
    }
  });

  it('rejects unknown value keys (typos never silently pass)', () => {
    expectCode(
      () => renderTemplate(tpl, { name: 'Asha', balance: '1', due_date: 'd', balnce: 'typo' }),
      'COMMS_TEMPLATE_VALUE_UNKNOWN',
    );
  });
});
