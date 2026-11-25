/** The connection to the receiver could not be established or was lost. */
export class CastConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CastConnectionError";
  }
}

/** A connect, request or launch did not finish within its time limit. */
export class CastTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CastTimeoutError";
  }
}

/** The receiver answered a request with an error reply. */
export class CastRequestError extends Error {
  readonly type: string;
  readonly reason: string | undefined;
  readonly response: Record<string, unknown>;

  constructor(response: Record<string, unknown>) {
    const type = typeof response.type === "string" ? response.type : "UNKNOWN";
    const reason = typeof response.reason === "string" ? response.reason : undefined;
    super(reason === undefined ? type : `${type}: ${reason}`);
    this.name = "CastRequestError";
    this.type = type;
    this.reason = reason;
    this.response = response;
  }
}

/** How a LAUNCH failed, as Chrome's `LaunchSessionResponse::Result` tells them apart. */
export type CastLaunchFailure = "user_not_allowed" | "notification_disabled" | "error";

/**
 * The receiver refused or failed a LAUNCH. `description` is the text Chrome gives the page for the same failure
 * (CastActivityManager::HandleLaunchSessionResponse), which is what a presentation request rejects with.
 */
export class CastLaunchError extends CastRequestError {
  readonly failure: CastLaunchFailure;
  readonly description: string;

  constructor(response: Record<string, unknown>, failure: CastLaunchFailure, description: string) {
    super(response);
    this.name = "CastLaunchError";
    this.failure = failure;
    this.description = description;
  }
}

/** Why a device failed authentication; see {@link CastAuthError}. */
export type CastAuthReason =
  | "timeout"
  | "no_tls_certificate"
  | "tls_certificate_invalid"
  | "device_error"
  | "malformed_reply"
  | "unsupported_algorithm"
  | "invalid_certificate"
  | "untrusted_chain"
  | "revoked"
  | "crl_invalid"
  | "bad_signature";

/** The device did not prove it is a genuine, Google-certified Cast device, so it was not used. */
export class CastAuthError extends Error {
  readonly reason: CastAuthReason;
  /** The device's address, when the client added it. */
  readonly host: string | undefined;

  constructor(reason: CastAuthReason, detail: string, options?: { host?: string }) {
    const where = options?.host === undefined ? "" : ` for ${options.host}`;
    super(`Cast device authentication failed${where}: ${detail}`);
    this.name = "CastAuthError";
    this.reason = reason;
    this.host = options?.host;
  }
}
