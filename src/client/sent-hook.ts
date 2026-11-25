/**
 * The observer of the messages a client sends, for `CastMessageLogging` (`CastMessageHandler::Observer::OnMessageSent`). It is
 * kept here, outside the client's types and the package exports, because Chrome's observer is internal and the library has no
 * public API Chrome lacks. Only a client the manager creates itself reports sent messages.
 */
export interface SentMessage {
  namespace: string;
  sourceId: string;
  destinationId: string;
  data: string | Buffer;
}

const hooks = new WeakMap<object, (message: SentMessage) => void>();

/** Observe the messages `client` sends. */
export function setSentHook(client: object, hook: (message: SentMessage) => void): void {
  hooks.set(client, hook);
}

/** Tell the observer of `client`, if any, about a message it sent. */
export function notifySent(client: object, message: SentMessage): void {
  hooks.get(client)?.(message);
}
