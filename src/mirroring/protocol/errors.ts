/**
 * The openscreen `Error::Code` values the Cast Streaming session reports, from `platform/base/error.h`, and the
 * `ReceiverError::ToError` conversion of `cast/streaming/public/receiver_message.cc`.
 */
import type { ReceiverError } from "./answer.ts";

/** error.h `Error::Code` (only the codes the session layer produces or maps). */
export const ErrorCode = {
  None: 0,
  JsonParseError: 39,
  UnknownError: 89,
  ParameterInvalid: 92,
  RemotingNotSupported: 106,
  NoStreamSelected: 107,
  AnswerTimeout: 108,
  InvalidAnswer: 109,
  MessageTimeout: 110,
} as const;

/** receiver_message.h `ReceiverError::kOpenscreenErrorOffset`. */
export const OPENSCREEN_ERROR_OFFSET = 10000;

export class SessionError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "SessionError";
    this.code = code;
  }
}

/** `ReceiverError::ToError`: a code at or above the offset is an openscreen code, anything else is an unknown error. */
export function receiverErrorToError(error: ReceiverError): SessionError {
  if (error.code >= OPENSCREEN_ERROR_OFFSET) return new SessionError(error.code - OPENSCREEN_ERROR_OFFSET, error.description);
  return new SessionError(ErrorCode.UnknownError, `Error code: ${error.code}, description: ${error.description}`);
}
