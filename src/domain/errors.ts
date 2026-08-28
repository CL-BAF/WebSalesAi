export class AppError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class InvalidTransitionError extends AppError {
  constructor(from: string, to: string, reason?: string) {
    super('INVALID_TRANSITION', `illegal workflow transition ${from} -> ${to}${reason ? `: ${reason}` : ''}`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super('NOT_FOUND', `${entity} not found: ${id}`);
  }
}

export class ValidationError extends AppError {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super('VALIDATION_ERROR', issues.length > 0 ? `${message}: ${issues.join('; ')}` : message);
    this.issues = issues;
  }
}

export class ExternalActionError extends AppError {
  constructor(message: string) {
    super('EXTERNAL_ACTION_ERROR', message);
  }
}

export class InjectionGuardError extends AppError {
  constructor(message: string) {
    super('INJECTION_GUARD', message);
  }
}
