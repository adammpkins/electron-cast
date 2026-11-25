/**
 * What a Cast presentation URL contributes to the LAUNCH and to the virtual connection of the app, taken from
 * `CastMediaSource` (supported_app_types, app_params, connection_type). These are the fields the session service
 * consumes; whatever parses the URL fills them in. `launchTimeout` is not here: it already travels as `timeoutMs`.
 */
export interface LaunchFields {
  /** `supportedAppTypes` from the URL, already split and with unknown names dropped; empty or absent means `["WEB"]`. */
  supportedAppTypes?: readonly string[];
  /** The URL's `appParams`, the raw JSON text (`CastMediaSource::app_params`); parsed when the launch starts. */
  appParams?: string;
  /** `connection_type() == kInvisible` (the URL's `invisibleSender=true`): the app's virtual connection is invisible rather than strong. */
  invisibleSender?: boolean;
}

/**
 * The launch fields of a request's parameters. The parameters carry the fields of the `CastMediaSource` parse
 * (`parseCastMediaSource`) under its names: `supportedAppTypes`, `appParams` and `connectionType`. That parse is
 * the one place the URL is read; this only checks the types that cross the bridge. `connectionType: "invisible"`
 * (`invisibleSender=true`) becomes `invisibleSender`; a request without it (or `"strong"`) is a strong connection.
 */
export function launchFieldsOf(params: unknown): LaunchFields {
  const out: LaunchFields = {};
  if (typeof params !== "object" || params === null) return out;
  const p = params as Record<string, unknown>;
  if (Array.isArray(p.supportedAppTypes) && p.supportedAppTypes.every((t) => typeof t === "string")) {
    out.supportedAppTypes = p.supportedAppTypes as string[];
  }
  if (typeof p.appParams === "string") out.appParams = p.appParams;
  if (p.connectionType === "invisible") out.invisibleSender = true;
  return out;
}
