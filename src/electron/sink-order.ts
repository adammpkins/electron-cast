// The order Chrome lists sinks in: `MediaSink::CompareUsingCollator` (components/media_router/common/media_sink.cc),
// used by `MediaRouterUI::OnSinksUpdated` (chrome/browser/ui/media_router/media_router_ui.cc) to sort the dialog's list.
// Pure module: no Electron imports.
import type { CastDevice } from "../discovery/index.ts";

/** `media_router::SinkIconType` values, in the order of the enum (media_sink.h): the primary sort key. */
const ICON_RANK = { cast: 0, cast_audio_group: 1, cast_audio: 2, wired_display: 6, generic: 7 } as const;

/** What the comparison reads of a sink. */
export interface SortableSink {
  iconType: keyof typeof ICON_RANK;
  name: string;
  id: string;
}

/**
 * `GetCastSinkIconType` (discovery/mdns/media_sink_util.cc): `cast` with video out, else `cast_audio_group` for a
 * multizone group, else `cast_audio`. A DIAL sink is `generic` (dial_media_sink_service_impl.cc).
 */
export function castIconType(capabilities: number): "cast" | "cast_audio_group" | "cast_audio" {
  if ((capabilities & 1) !== 0) return "cast";
  return (capabilities & 32) !== 0 ? "cast_audio_group" : "cast_audio";
}

// `MediaRouterUI::Init` builds the collator from the application locale with ICU's default strength. Intl.Collator with no
// locale is the runtime's default locale, which Electron takes from the application's; ICU's tertiary strength is
// Intl.Collator's default `variant` sensitivity.
let collator: Intl.Collator | undefined;

/**
 * `MediaSink::CompareUsingCollator`: true when `a` sorts before `b`. By icon type, then by locale-collated name, then by
 * sink id (a byte-wise `std::string` comparison, here by UTF-16 code unit).
 */
export function sinkLess(a: SortableSink, b: SortableSink, c: Intl.Collator | null = (collator ??= new Intl.Collator())): boolean {
  if (a.iconType !== b.iconType) return ICON_RANK[a.iconType] < ICON_RANK[b.iconType];
  if (c !== null) {
    const result = c.compare(a.name, b.name);
    if (result !== 0) return result < 0;
  } else if (a.name !== b.name) {
    // the no-collator fallback of CompareUsingCollator: simple string comparison
    return a.name < b.name;
  }
  return a.id < b.id;
}

/** A copy of `sinks` sorted as `MediaRouterUI::OnSinksUpdated` sorts them. */
export function sortSinks<T extends SortableSink>(sinks: readonly T[]): T[] {
  return [...sinks].sort((x, y) => (sinkLess(x, y) ? -1 : sinkLess(y, x) ? 1 : 0));
}

/** The sink a discovered device is to the dialog: a DIAL device is `generic`, a Cast device by {@link castIconType}. */
export function deviceAsSortable(device: Pick<CastDevice, "id" | "name" | "capabilities" | "dial">): SortableSink {
  return { id: device.id, name: device.name, iconType: device.dial !== undefined ? "generic" : castIconType(device.capabilities) };
}

/** `devices` in the order {@link sortSinks} gives their sinks. */
export function sortDevicesAsSinks<T extends Pick<CastDevice, "id" | "name" | "capabilities" | "dial">>(devices: readonly T[]): T[] {
  const keyed = devices.map((device) => ({ device, ...deviceAsSortable(device) }));
  return sortSinks(keyed).map((k) => k.device);
}
