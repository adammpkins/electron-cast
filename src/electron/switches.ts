import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import type { CastDevice } from "../discovery/index.ts";
import { parseCertificate } from "../client/auth/x509.ts";

/**
 * The Chrome switches and features that change what the media router does, read from the app's command line
 * (`app.commandLine`, which also sees `appendSwitch`). The names and defaults are those of
 * chrome/browser/media/router/media_router_feature.cc. Chrome's enterprise policies have no counterpart here: an
 * Electron app has no policy store, so what a policy sets is an option of `createCastManager` (see docs/DESIGN.md,
 * "Policies and switches").
 */

/** The part of Chrome's `base::CommandLine` that is read; Electron's `app.commandLine` has both. */
export interface CommandLineLike {
  hasSwitch(name: string): boolean;
  getSwitchValue(name: string): string;
}

/** `--enable-features=A,B:params` / `--disable-features=...`: the feature names. */
function featureNames(commandLine: CommandLineLike | undefined, name: string): Set<string> {
  const names = new Set<string>();
  if (commandLine === undefined || !commandLine.hasSwitch(name)) return names;
  for (const item of commandLine.getSwitchValue(name).split(",")) {
    const feature = item.trim().split(/[:<]/)[0]!.replace(/^[*!]/, "");
    if (feature !== "") names.add(feature);
  }
  return names;
}

/**
 * `base::FeatureList::IsEnabled` for a feature given on the command line: a feature named in both `--enable-features`
 * and `--disable-features` is disabled; one named in neither has its default.
 */
export function featureEnabled(commandLine: CommandLineLike | undefined, feature: string, enabledByDefault: boolean): boolean {
  if (featureNames(commandLine, "disable-features").has(feature)) return false;
  if (featureNames(commandLine, "enable-features").has(feature)) return true;
  return enabledByDefault;
}

/**
 * `media_router::MediaRouterEnabled`, without the enterprise policy: `kMediaRouter`, enabled by default
 * (`--disable-features=MediaRouter` turns the media router off).
 */
export function mediaRouterFeatureEnabled(commandLine: CommandLineLike | undefined): boolean {
  return featureEnabled(commandLine, "MediaRouter", true);
}

/**
 * `GetCastAllowAllIPsPref`, the part that is not the policy: `kCastAllowAllIPsFeature`, named `CastAllowAllIPs`, disabled by
 * default. Chrome uses the feature only when the `MediaRouterCastAllowAllIPs` policy is not set, so the
 * `sinks.allowAllIps` option, which stands for the policy, wins when it is given.
 */
export function castAllowAllIpsFeature(commandLine: CommandLineLike | undefined): boolean {
  return featureEnabled(commandLine, "CastAllowAllIPs", false);
}

/** `kShowCastPermissionRejectedError`, enabled by default. */
export function showCastPermissionRejectedError(commandLine: CommandLineLike | undefined): boolean {
  return featureEnabled(commandLine, "ShowCastPermissionRejectedError", true);
}

/**
 * `kCastMessageLogging` (media_router_feature.cc; `IsCastMessageLoggingEnabled`), disabled by default: the messages of a Cast
 * route go to the media router log (see message-logging.ts).
 */
export function castMessageLogging(commandLine: CommandLineLike | undefined): boolean {
  return featureEnabled(commandLine, "CastMessageLogging", false);
}

/**
 * `kCastDesktopMirroringKeepLocalAudio`, enabled by default (Windows only: `GetDesktopAudioLoopbackDeviceId` reads it
 * there and uses the muting loopback everywhere else).
 */
export function castDesktopMirroringKeepLocalAudio(commandLine: CommandLineLike | undefined): boolean {
  return featureEnabled(commandLine, "CastDesktopMirroringKeepLocalAudio", true);
}

/**
 * `kAllowAllSitesToInitiateMirroring` (media_router_feature.cc), disabled by default: any origin, not only
 * `kPresentationApiAllowlist`, may start mirroring through a Cast Streaming presentation URL.
 */
export function allowAllSitesToInitiateMirroring(commandLine: CommandLineLike | undefined): boolean {
  return featureEnabled(commandLine, "AllowAllSitesToInitiateMirroring", false);
}

/**
 * The parameters `--enable-features=Feature:name/value/name/value` gives `feature`, as `FeatureList::ParseEnableFeatureString`
 * and `AssociateFieldTrialParamsFromString` read them (values are URL-escaped; a comma ends the feature, so it is written
 * `%2C`). Empty when the feature has no parameters, is not named in `--enable-features`, or is also named in
 * `--disable-features` (the disable override is registered first and the first override of a feature wins, so its field
 * trial, which carries the parameters, is never associated), and for a malformed entry (a name without a value, or a second
 * `:`), which Chrome rejects whole. The first entry naming the feature wins, as `FeatureList::RegisterOverride` keeps the
 * first.
 */
export function featureParams(commandLine: CommandLineLike | undefined, feature: string): ReadonlyMap<string, string> {
  const none = new Map<string, string>();
  if (commandLine === undefined || !commandLine.hasSwitch("enable-features") || featureNames(commandLine, "disable-features").has(feature)) return none;
  const decode = (text: string): string => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  };
  for (const item of commandLine.getSwitchValue("enable-features").split(",")) {
    const entry = item.trim();
    if (entry === "") continue;
    const colons = entry.split(":");
    const name = colons[0]!.split(".")[0]!.split("<")[0]!.replace(/^[*!]/, "").trim();
    if (name !== feature) continue;
    if (colons.length !== 2) return none;
    const parts = colons[1]!.split("/").map((p) => p.trim());
    if (parts.length % 2 !== 0) return none;
    const params = new Map<string, string>();
    for (let i = 0; i < parts.length; i += 2) params.set(decode(parts[i]!), decode(parts[i + 1]!));
    return params;
  }
  return none;
}

/** `mirroring::features::CongestionSignal`, named by `kCongestionSignalOptions`. */
export type CongestionSignal = "before_or_after_encoding" | "before_encoding" | "after_encoding";
const CONGESTION_SIGNALS: readonly CongestionSignal[] = ["before_or_after_encoding", "before_encoding", "after_encoding"];

/**
 * `kCastStreamingCongestionSignal` (components/mirroring/service/mirroring_features.cc), the `congestion_signal` parameter of
 * `kCastStreamingGradualBandwidthBackoff`: which video frame drops tell `OpenscreenSessionHost::UpdateBandwidthEstimate`
 * that the network is congested. Given as `--enable-features=CastStreamingGradualBandwidthBackoff:congestion_signal/before_encoding`.
 * Anything else, an empty value included, is the default `before_or_after_encoding`; a non-empty value that names no option
 * is reported to `warn`, as `GetFieldTrialParamByFeatureAsEnum` logs it.
 */
export function castStreamingCongestionSignal(commandLine: CommandLineLike | undefined, warn: (message: string) => void = () => {}): CongestionSignal {
  const value = featureParams(commandLine, "CastStreamingGradualBandwidthBackoff").get("congestion_signal");
  if (value === undefined || value === "") return "before_or_after_encoding";
  const found = CONGESTION_SIGNALS.find((s) => s === value);
  if (found !== undefined) return found;
  warn(`Failed to parse field trial param congestion_signal with string value ${value} under feature CastStreamingGradualBandwidthBackoff into an enum. Falling back to default value of 0`);
  return "before_or_after_encoding";
}

/**
 * `media::kCastStreamingPerformanceOverlay` (media/base/media_switches.cc), disabled by default: `VideoSender` draws the
 * performance metrics overlay on each frame before it is encoded.
 */
export function castStreamingPerformanceOverlay(commandLine: CommandLineLike | undefined): boolean {
  return featureEnabled(commandLine, "CastStreamingPerformanceOverlay", false);
}

/**
 * `media::kPulseaudioLoopbackForCast` (media/base/media_switches.cc), disabled by default and read on Linux only
 * (`media_router::IsSystemAudioCaptureSupported`, `DesktopMediaPickerController`): whether Cast offers system audio with a
 * desktop capture. Elsewhere the OS decides and the answer is yes.
 */
export function systemAudioCaptureSupported(commandLine: CommandLineLike | undefined, platform: string = process.platform): boolean {
  return platform !== "linux" || featureEnabled(commandLine, "PulseaudioLoopbackForCast", false);
}

/** `base::StringToInt`: an optional sign and digits only, no whitespace, within `int`. */
function stringToInt(text: string): number | undefined {
  if (!/^[+-]?\d+$/.test(text)) return undefined;
  const n = Number(text);
  return n >= -(2 ** 31) && n <= 2 ** 31 - 1 ? n : undefined;
}

/**
 * `GetCastMirroringPlayoutDelay`: the `--cast-mirroring-target-playout-delay` switch in milliseconds, when it parses and is
 * from 1 to 1000 (`IsValidMirroringPlayoutDelayMs`); `undefined` otherwise, as Chrome ignores a bad value.
 */
export function castMirroringPlayoutDelayMs(commandLine: CommandLineLike | undefined): number | undefined {
  if (commandLine === undefined || !commandLine.hasSwitch("cast-mirroring-target-playout-delay")) return undefined;
  const n = stringToInt(commandLine.getSwitchValue("cast-mirroring-target-playout-delay"));
  return n !== undefined && n >= 1 && n <= 1000 ? n : undefined;
}

/**
 * `GetFixedIPSinksFromCommandLine` (media_sink_util.cc): the devices `--cast-device-ips` names, a comma separated list of
 * `address` or `address:port` (an IPv6 address in brackets), each made into the sink Chrome makes: an `md=Chromecast` device
 * with `ca=5` named `Receiver-<address with dots as underscores>`. An entry that is not an IP literal is skipped.
 */
export function fixedCastDevices(commandLine: CommandLineLike | undefined): CastDevice[] {
  if (commandLine === undefined || !commandLine.hasSwitch("cast-device-ips")) return [];
  const devices: CastDevice[] = [];
  for (const raw of commandLine.getSwitchValue("cast-device-ips").split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    // net::ParseHostAndPort
    let host = entry;
    let port = -1;
    const bracket = /^\[([^\]]*)\](?::(\d+))?$/.exec(entry);
    if (bracket !== null) {
      host = bracket[1]!;
      if (bracket[2] !== undefined) port = Number(bracket[2]);
    } else if (entry.includes("[") || entry.includes("]")) {
      continue;
    } else {
      const colons = entry.split(":").length - 1;
      if (colons === 1) {
        const [h, p] = entry.split(":") as [string, string];
        if (!/^\d+$/.test(p)) continue;
        host = h;
        port = Number(p);
      } else if (colons > 1) {
        continue;
      }
    }
    if (port > 65535) continue;
    if (isIP(host) === 0) continue;
    if (port === -1) port = 8009; // kCastControlPort
    const instanceName = `Receiver-${host.replaceAll(".", "_")}`;
    const txt = { id: `mdns:${instanceName}`, ve: "02", ca: "5", st: "1", fn: instanceName, md: "Chromecast" };
    devices.push({
      id: txt.id,
      name: instanceName,
      model: "Chromecast",
      host,
      addresses: [host],
      port,
      capabilities: 5,
      isGroup: false,
      statusText: "",
      instanceName: `${instanceName}._googlecast._tcp.local`,
      txt: Object.assign(Object.create(null), txt) as Record<string, string>,
    });
  }
  return devices;
}

/**
 * `ReadCertificateChainFromString` and `PopulateStoreWithCertsFromPath` for `--cast-developer-certificate-path`: the
 * `CERTIFICATE` blocks of the PEM file, as DER. Like Chrome, a certificate that does not parse ends the list (the ones before
 * it stay) with a warning, and a file that cannot be read adds nothing. A relative path is relative to the working directory.
 */
export function developerCertificates(commandLine: CommandLineLike | undefined, warn: (message: string) => void = () => {}): Buffer[] {
  if (commandLine === undefined || !commandLine.hasSwitch("cast-developer-certificate-path")) return [];
  const path = commandLine.getSwitchValue("cast-developer-certificate-path");
  if (path === "") return [];
  let text: string;
  try {
    text = readFileSync(resolve(path), "utf8");
  } catch {
    warn(`Failed to read certificate chain from file: ${path}`);
    return [];
  }
  const found: Buffer[] = [];
  for (const m of text.matchAll(/-----BEGIN CERTIFICATE-----([^-]*)-----END CERTIFICATE-----/g)) {
    found.push(Buffer.from(m[1]!.replace(/\s+/g, ""), "base64"));
  }
  if (found.length === 0) warn("Certificate chain is empty.");
  const ok: Buffer[] = [];
  for (const der of found) {
    try {
      parseCertificate(der);
    } catch (err) {
      warn(`Unable to add Cast developer certificates at ${path} to Cast root store; only Google-provided Cast root certificates will be used. (${err instanceof Error ? err.message : String(err)})`);
      break;
    }
    ok.push(der);
  }
  return ok;
}
