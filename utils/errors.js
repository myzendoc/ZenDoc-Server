import { logError } from "./logging.js";

export class PublicError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "PublicError";
    this.status = status;
    this.isPublic = true;
  }
}

export function publicError(message, status = 400) {
  return new PublicError(message, status);
}

export function getPublicErrorMessage(error, fallback = "Request failed") {
  return error?.isPublic === true && typeof error.message === "string"
    ? error.message
    : fallback;
}

export function getPublicErrorStatus(error, fallback = 500) {
  return error?.isPublic === true && Number.isInteger(error.status)
    ? error.status
    : fallback;
}

export function sendErrorResponse(res, error, { fallback = "Request failed", status = 500, event } = {}) {
  if (error?.isPublic !== true && event) logError(event, error);
  if (Number.isFinite(error?.retryAfterSeconds) && error.retryAfterSeconds > 0) {
    res.setHeader("Retry-After", String(Math.ceil(error.retryAfterSeconds)));
  }
  res
    .status(getPublicErrorStatus(error, status))
    .json({ error: getPublicErrorMessage(error, fallback) });
}
