// Applies Chrome's rule on which Cast device addresses are connected to (see ../discovery/ip-policy.ts) to a device
// source. In Chromium a sink whose address is refused never becomes a sink (CastMediaSinkServiceImpl::OpenChannel
// reports the channel as not opened), so here such a device is simply not visible: not listed, not offered to the
// picker, not a route target.
import { EventEmitter } from "node:events";
import type { CastDevice } from "../discovery/index.ts";
import { isCastAddressAllowed } from "../discovery/ip-policy.ts";
import type { DeviceSource } from "./session-service.ts";

type DeviceEvent = "deviceUp" | "deviceDown" | "deviceChanged";

/**
 * The device as Chrome would see it: only its allowed addresses, `host` the first of them; null when none remains.
 * (Chrome learns one address per sink; a device with several is kept as long as one of them may be used.)
 */
export function restrictDevice(device: CastDevice, allowAllIPs: boolean): CastDevice | null {
  if (allowAllIPs) return device;
  const candidates = device.addresses.length > 0 ? device.addresses : [device.host];
  const addresses = candidates.filter((a) => isCastAddressAllowed(a, false));
  if (addresses.length === 0) return null;
  const host = addresses.includes(device.host) ? device.host : (addresses[0] as string);
  return { ...device, host, addresses };
}

/**
 * Wraps a device source so devices at refused addresses are hidden. Events are derived from the filtered list, so a
 * device whose address changes to or from a refused one comes and goes like any other. With `allowAllIPs` the source is
 * returned as is.
 */
export function withAddressPolicy<S extends DeviceSource>(source: S, allowAllIPs: boolean): S {
  if (allowAllIPs) return source;
  const events = new EventEmitter();
  const sourceEvents: DeviceEvent[] = ["deviceUp", "deviceDown", "deviceChanged"];
  let last = new Map<string, CastDevice>();
  let listening = false;

  const current = (gone?: CastDevice): Map<string, CastDevice> => {
    const next = new Map<string, CastDevice>();
    for (const d of source.devices()) {
      const allowed = restrictDevice(d, false);
      if (allowed !== null && d.id !== gone?.id) next.set(d.id, allowed);
    }
    return next;
  };
  const onSourceEvent = (event: DeviceEvent) => (changed: CastDevice): void => {
    const next = current(event === "deviceDown" ? changed : undefined);
    const before = last;
    last = next;
    for (const [id, d] of before) if (!next.has(id)) events.emit("deviceDown", d);
    for (const [id, d] of next) {
      const was = before.get(id);
      if (was === undefined) events.emit("deviceUp", d);
      else if (JSON.stringify(was) !== JSON.stringify(d)) events.emit("deviceChanged", d);
    }
  };
  const handlers = new Map(sourceEvents.map((e) => [e, onSourceEvent(e)] as const));
  const sync = (): void => {
    const wanted = sourceEvents.some((e) => events.listenerCount(e) > 0);
    if (wanted === listening) return;
    listening = wanted;
    if (wanted) last = current();
    for (const e of sourceEvents) {
      const h = handlers.get(e) as (d: CastDevice) => void;
      if (wanted) source.on(e, h);
      else source.off(e, h);
    }
  };

  // Everything else (start, stop, ...) runs on the real source, so its own state is untouched.
  const overrides: Record<string | symbol, unknown> = {
    devices: (): CastDevice[] => [...current().values()],
    on: (e: DeviceEvent, l: (d: CastDevice) => void): unknown => (events.on(e, l), sync(), proxy),
    off: (e: DeviceEvent, l: (d: CastDevice) => void): unknown => (events.off(e, l), sync(), proxy),
  };
  const proxy: S = new Proxy(source, {
    get(target, prop) {
      if (prop in overrides) return overrides[prop];
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return proxy;
}
