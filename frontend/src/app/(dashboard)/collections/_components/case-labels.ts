import type { CaseActionType, CaseStatus } from '@/lib/api/wire-types';
import type { LocaleKey } from '@/lib/portal-i18n/dictionary';

/**
 * Enum → derived catalog key maps for the collections state machine
 * (issue #180) — the portal's documented pattern: adding a wire enum value
 * without a catalog entry is a compile error at the map, and the catalog
 * itself refuses unknown keys at every call site.
 */

export const CASE_STATUS_LABEL_KEYS: Record<CaseStatus, LocaleKey> = {
  open: 'dashboard.collections.statusLabels.open',
  in_progress: 'dashboard.collections.statusLabels.in_progress',
  resolved: 'dashboard.collections.statusLabels.resolved',
  closed_inactive: 'dashboard.collections.statusLabels.closed_inactive',
};

export const CASE_ACTION_TYPE_LABEL_KEYS: Record<CaseActionType, LocaleKey> = {
  call: 'dashboard.collections.actionTypeLabels.call',
  sms: 'dashboard.collections.actionTypeLabels.sms',
  whatsapp: 'dashboard.collections.actionTypeLabels.whatsapp',
  letter: 'dashboard.collections.actionTypeLabels.letter',
  fieldVisit: 'dashboard.collections.actionTypeLabels.fieldVisit',
  escalation: 'dashboard.collections.actionTypeLabels.escalation',
};
