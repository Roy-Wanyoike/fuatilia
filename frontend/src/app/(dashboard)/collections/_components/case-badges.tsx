'use client';

import { Badge } from '@/components/ui/badge';
import type { CaseView } from '@/lib/api/wire-types';
import { usePortalT } from '@/lib/portal-i18n/context';
import {
  derivedStatusBadgeTone,
  priorityBadgeTone,
  statusBadgeTone,
} from '@/lib/collections/state-machine';
import { CASE_STATUS_LABEL_KEYS } from './case-labels';

/**
 * State-machine badges for the collections workspace (issue #135). The
 * stored status, the DERIVED overlay and the priority each render a badge
 * with tone semantics shared by the list and the detail screen:
 *
 *   status    — open/info, in_progress/info, resolved/success,
 *               closed_inactive/neutral
 *   derived   — promised/warning, disputed/danger, waiting/neutral
 *               (stored values fall through to the status semantics)
 *   priority  — low/neutral, normal/info, high/warning, urgent/danger
 *
 * Every badge exposes a data-testid so component tests can pin the state
 * machine semantics per state. The stored status renders its HUMAN label
 * from the shared catalog (Record<CaseStatus, LocaleKey> map, issue #180);
 * the derived overlay and the priority stay WIRE VALUES — an operator
 * correlates them with logs and the /v1 spec.
 */

export function CaseStatusBadge({ status }: { status: CaseView['status'] }) {
  const t = usePortalT();
  return (
    <Badge tone={statusBadgeTone(status)} data-testid="case-status-badge">
      {t(CASE_STATUS_LABEL_KEYS[status])}
    </Badge>
  );
}

export function DerivedStatusBadge({ derived }: { derived: CaseView['derivedStatus'] }) {
  return (
    <Badge tone={derivedStatusBadgeTone(derived)} data-testid="case-derived-badge">
      {derived}
    </Badge>
  );
}

export function CasePriorityBadge({ priority }: { priority: CaseView['priority'] }) {
  return (
    <Badge tone={priorityBadgeTone(priority)} data-testid="case-priority-badge">
      {priority}
    </Badge>
  );
}
