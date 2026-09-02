/**
 * Domain error — the only error type the domain core throws.
 * Every failure carries a stable machine code so adapters can map
 * it to API responses without string matching.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
