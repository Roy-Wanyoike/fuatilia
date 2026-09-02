/**
 * Outbox — the pure, in-memory contract of the transactional outbox
 * (src/domain/events/README.md "Outbox pattern"): events are appended in the
 * same logical step as the state change that produced them; consumers drain
 * with per-consumer cursors; replay is deterministic.
 *
 * No I/O, no clock, no RNG — persistence adapters (Postgres outbox table, wave
 * 2/3) will implement the same contract over real storage. All cursors are
 * 0-based indexes into the append-only sequence; `-1` means "nothing delivered
 * yet".
 *
 * Semantics:
 * - append(event): ordered — preserves insertion order; dedupes on eventId
 *   (OUTBOX_DUPLICATE) so replays of the same command cannot double-append;
 *   validates the full envelope before it can reach the wire.
 * - drain(consumer, cursor?): at-least-once — returns every event AFTER the
 *   cursor plus the next cursor. Calling without a cursor continues from the
 *   consumer's stored checkpoint; passing an OLDER cursor redelivers that
 *   window (crashed consumer replays its unacked batch). Checkpoints tracked
 *   in a Map never move backwards.
 * - replay(): the whole sequence from genesis, in append order, every time —
 *   the deterministic input for rebuilding projections (docs/07 cross-module
 *   scenario tests).
 */
import { DomainError } from '../shared';
import type { DomainEvent } from './envelope';
import { validateEnvelope } from './envelope';

export interface DrainResult {
  /** The events after the cursor, in append order (possibly empty). */
  readonly events: readonly DomainEvent[];
  /** Index of the last event covered by this drain (`-1` when none). */
  readonly nextCursor: number;
}

const assertConsumer = (consumer: string): void => {
  if (typeof consumer !== 'string' || consumer.length === 0) {
    throw new DomainError('OUTBOX_CONSUMER_INVALID', 'consumer must be a non-empty string', {
      consumer: String(consumer),
    });
  }
};

export class Outbox {
  private readonly events: DomainEvent[] = [];
  private readonly eventIds = new Set<string>();
  private readonly cursors = new Map<string, number>();

  /** Number of events in the outbox (append-only — never shrinks). */
  get size(): number {
    return this.events.length;
  }

  /**
   * Append an event in lock-step with the state change that produced it.
   * Validates the envelope, dedupes on eventId, freezes the fact.
   */
  append(event: DomainEvent): void {
    validateEnvelope(event);
    if (this.eventIds.has(event.eventId)) {
      throw new DomainError(
        'OUTBOX_DUPLICATE',
        `event ${event.eventId} ("${event.name}") is already in the outbox`,
        { eventId: event.eventId, name: event.name },
      );
    }
    this.eventIds.add(event.eventId);
    this.events.push(Object.freeze(event));
  }

  /** The consumer's stored checkpoint (`-1` if it never drained). */
  cursorOf(consumer: string): number {
    assertConsumer(consumer);
    return this.cursors.get(consumer) ?? -1;
  }

  /**
   * Hand the events after `cursor` to `consumer` (at-least-once).
   * Without an explicit cursor, continues from the stored checkpoint.
   * An explicit older cursor redelivers without rewinding the checkpoint.
   */
  drain(consumer: string, cursor?: number): DrainResult {
    assertConsumer(consumer);
    const stored = this.cursors.get(consumer) ?? -1;
    const from = cursor === undefined ? stored : this.assertValidCursor(cursor);
    const batch = Object.freeze(this.events.slice(from + 1));
    const nextCursor = batch.length > 0 ? this.events.length - 1 : from;
    if (nextCursor > stored) {
      this.cursors.set(consumer, nextCursor);
    }
    return { events: batch, nextCursor };
  }

  /** Full history from genesis, in append order — deterministic by construction. */
  replay(): readonly DomainEvent[] {
    return Object.freeze([...this.events]);
  }

  private assertValidCursor(cursor: number): number {
    if (!Number.isSafeInteger(cursor) || cursor < -1 || cursor >= this.events.length) {
      throw new DomainError(
        'OUTBOX_CURSOR_INVALID',
        `cursor ${String(cursor)} is out of range for an outbox holding ${this.events.length} event(s) (valid: -1…${this.events.length - 1})`,
        { cursor: String(cursor), size: this.events.length },
      );
    }
    return cursor;
  }
}
