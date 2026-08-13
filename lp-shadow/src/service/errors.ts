/**
 * Errors the service layer shows to users.
 *
 * The bot layer switches on `code` for command-specific copy and may show
 * `message` verbatim — so every message here is written for the person in the
 * chat, not for a log file. Anything that is NOT a ServiceError is a bug and
 * the bot must not display it.
 */
export type ServiceErrorCode =
  | 'HANDOFF_INVALID'
  | 'HANDOFF_EXPIRED'
  | 'CHAT_ALREADY_LINKED'
  | 'ACCOUNT_SUSPENDED'
  | 'NOT_REGISTERED'
  | 'POOL_NOT_FOUND'
  | 'POOL_AMBIGUOUS'
  | 'NO_POOLS'
  | 'DUPLICATE_POOL'
  | 'POOL_UNREACHABLE'
  | 'INVALID_INPUT';

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;

  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}
