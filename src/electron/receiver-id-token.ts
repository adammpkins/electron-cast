// The per-profile token that salts receiver labels: `GetReceiverIdHashToken`
// (chrome/browser/media/router/media_router_feature.cc), read from and written to the profile pref
// `media_router.receiver_id_hash_token` (`prefs::kMediaRouterReceiverIdHashToken`, components/media_router/common/
// pref_names.cc). Pure module: no Electron imports.
import { randomBytes } from "node:crypto";

/**
 * Where the token is kept between runs: Chrome's profile pref. The library has no profile, so the app owns the storage,
 * as it does for {@link import("./access-code.ts").AccessCodeStore}. Both calls are synchronous, like a pref read and
 * write.
 */
export interface ReceiverIdHashTokenStore {
  /** The saved token, or undefined/"" when none was saved yet. */
  load(): string | undefined | null;
  save(token: string): void;
}

/** `kHashTokenSize`. */
const HASH_TOKEN_SIZE = 64;

/**
 * `GetReceiverIdHashToken`: the saved token; when there is none, 64 random bytes, base64 encoded, saved and returned.
 * With no store the token lives as long as the process (electron-cast's earlier behaviour, and Chrome's in a profile that
 * is never saved).
 */
export function getReceiverIdHashToken(store?: ReceiverIdHashTokenStore): string {
  let token = "";
  try {
    const saved = store?.load();
    if (typeof saved === "string") token = saved;
  } catch {
    // a store that cannot be read must not stop casting; a new token is made below
  }
  if (token === "") {
    token = randomBytes(HASH_TOKEN_SIZE).toString("base64");
    try {
      store?.save(token);
    } catch {
      // the token still serves this run
    }
  }
  return token;
}
