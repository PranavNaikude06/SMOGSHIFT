// Typed errors whose message is safe to show to users. `status` is the HTTP status to answer with.

export class AppError extends Error {
  /**
   * @param {string} message user-safe message
   * @param {number} status HTTP status
   * @param {{ cause?: unknown }} [options] internal cause, logged server-side but never sent to clients
   */
  constructor(message, status, options) {
    super(message, options);
    this.name = new.target.name;
    this.status = status;
  }
}

export class ValidationError extends AppError {
  /** @param {string[]} errors */
  constructor(errors) {
    super(errors.join(' '), 400);
    this.errors = errors;
  }
}

export class NotFoundError extends AppError {
  /** @param {string} message */
  constructor(message) {
    super(message, 404);
  }
}

export class UpstreamError extends AppError {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options) {
    super(message, 502, options);
  }
}
