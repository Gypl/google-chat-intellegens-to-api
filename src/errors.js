export class SessionExpiredError extends Error {
  constructor(message = 'Session expired. Manual authentication required.') {
    super(message);
    this.name = 'SessionExpiredError';
    this.statusCode = 401;
  }
}

export class QueueFullError extends Error {
  constructor(message = 'Queue is full') {
    super(message);
    this.name = 'QueueFullError';
    this.statusCode = 429;
  }
}

export class BrowserWorkerError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'BrowserWorkerError';
    this.statusCode = statusCode;
  }
}
