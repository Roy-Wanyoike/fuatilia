import { Badge } from '@/components/ui/badge';
import type { CaseView } from '@/lib/api/wire-types';
import {
  derivedStatusBadgeTone,
  priorityBadgeTone,
  statusBadgeTone,
  TRANSITION_LABELS,
} from '@/lib/collections/state-machine';

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
 * machine semantics per state.
 */

export function CaseStatusBadge({ status }: { status: CaseView['status'] }) {
  return (
    <Badge tone={statusBadgeTone(status)} data-testid="case-status-badge">
      {TRANSITION_LABELS[status]}
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
