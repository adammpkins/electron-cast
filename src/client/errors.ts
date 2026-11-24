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
