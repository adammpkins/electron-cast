/** Thrown when a Cast v2 message or frame violates the protocol. */
export class CastProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CastProtocolError";
  }
}
