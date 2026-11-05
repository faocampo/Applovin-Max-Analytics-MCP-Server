export type ApplovinErrorKind =
  | 'validation'
  | 'auth'
  | 'rate_limited'
  | 'http'
  | 'network'
  | 'timeout'
  | 'cancelled';

/**
 * Error raised by the AppLovin layer. `message` must already be safe to show to
 * an agent (no credentials); callers construct it from redacted text only.
 */
export class ApplovinError extends Error {
  readonly kind: ApplovinErrorKind;
  readonly status: number | undefined;
  readonly attempts: number | undefined;

  constructor(
    kind: ApplovinErrorKind,
    message: string,
    options: { status?: number; attempts?: number } = {},
  ) {
    super(message);
    this.name = 'ApplovinError';
    this.kind = kind;
    this.status = options.status;
    this.attempts = options.attempts;
  }
}

export function validationError(message: string): ApplovinError {
  return new ApplovinError('validation', message);
}

/** Guidance appended to tool errors so the agent knows how to recover. */
export function recoveryHint(error: ApplovinError): string {
  switch (error.kind) {
    case 'validation':
      return 'Fix the arguments and call the tool again.';
    case 'auth':
      return 'The AppLovin key was rejected. This needs a human: check the Report Key or Management Key configured for this server. Do not retry.';
    case 'rate_limited':
      return 'AppLovin is rate limiting this account. Wait before retrying, and prefer fewer, more aggregated queries.';
    case 'timeout':
      return 'The query took too long. Narrow the date range, use fewer dimensions, or add filters.';
    case 'network':
      return 'AppLovin could not be reached. Retry later.';
    case 'cancelled':
      return 'The request was cancelled.';
    case 'http':
      return error.status !== undefined && error.status >= 500
        ? 'AppLovin returned a server error. Retry later.'
        : 'AppLovin rejected the request. Review the arguments (columns, filters, date range).';
  }
}
