// DIAL as Chrome's Media Router does it: SSDP discovery, device descriptions, app availability and the DIAL route
// provider, behind one object the cast manager owns.
import { EventEmitter } from "node:events";
import type { CastDevice } from "../discovery/device-cache.ts";
import { DialRegistry, type DialRegistryOptions } from "./dial-registry.ts";
import { DialSinkService, type DialSink } from "./dial-sink-service.ts";
import { createDialHttp, type DialHttp, type DialHttpOptions } from "./http.ts";
import { dialOriginAllowed } from "./origins.ts";
import { DialRouteProvider } from "./route-provider.ts";

export { DialRegistry, type DialRegistryOptions } from "./dial-registry.ts";
export { DialSinkService, type DialSink } from "./dial-sink-service.ts";
export { createDialHttp, defaultDialOrigin, type DialHttp, type DialHttpOptions, type DialHttpResult } from "./http.ts";
export { dialOriginAllowed, dialOriginsFor } from "./origins.ts";
export { DialRouteError, DialRouteProvider, dialEnvelope, parseDialMessage, type DialRouteInfo } from "./route-provider.ts";
export { DIAL_SCHEME, isDialSource, appNameFromDialSource, parseDialLaunchSource } from "./parse.ts";

export interface DialServiceOptions {
  /** Salt of the receiver labels; the presentation handler's token, so a label means one thing per process. */
  hashToken: string;
  /** True when a Cast sink (an open, authenticated channel) has this processed uuid: the device is then listed as Cast only. */
  isCastDevice?: (uuid: string) => boolean;
  registry?: DialRegistryOptions;
  http?: DialHttp;
  httpOptions?: DialHttpOptions;
  /** Delay before changed sinks are published (default 3 s, `MediaSinkServiceBase::kDiscoveryTimeout`). */
  settleMs?: number;
  log?: (message: string) => void;
}

/** A DIAL sink shaped as a device, so pickers and observers treat both kinds alike. */
export function dialSinkToDevice(sink: DialSink): CastDevice {
  return {
    id: sink.id,
    name: sink.name,
    model: sink.modelName,
    host: sink.ipAddress,
    addresses: [sink.ipAddress],
    port: 0,
    capabilities: 0,
    isGroup: false,
    statusText: "",
    instanceName: sink.id,
    txt: {},
    dial: { appUrl: sink.appUrl, modelName: sink.modelName, ipAddress: sink.ipAddress },
  };
}

/** Everything DIAL: discovery, sinks, per-app availability and routes. */
export class DialService extends EventEmitter<{ change: [] }> {
  readonly registry: DialRegistry;
  readonly sinks: DialSinkService;
  readonly provider: DialRouteProvider;
  readonly http: DialHttp;
  private started = false;

  constructor(options: DialServiceOptions) {
    super();
    this.http = options.http ?? createDialHttp(options.httpOptions);
    this.registry = new DialRegistry(options.registry);
    const isCast = options.isCastDevice;
    this.sinks = new DialSinkService({
      source: this.registry,
      http: this.http,
      ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}),
      ...(isCast !== undefined ? { isCastSink: isCast } : {}),
    });
    this.provider = new DialRouteProvider({
      sinks: this.sinks,
      http: this.http,
      hashToken: options.hashToken,
      ...(options.log !== undefined ? { log: options.log } : {}),
    });
    this.sinks.on("change", () => this.emit("change"));
    // DialMediaSinkServiceImpl::OnDialError only logs. Without a listener the registry's "error" would throw out of a
    // timer or a socket callback.
    this.registry.on("error", (code, detail) => {
      options.log?.(`DIAL discovery error: ${code}${detail !== undefined ? ` (${detail.message})` : ""}`);
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.registry.start();
  }

  stop(): void {
    this.started = false;
    this.http.abortAll?.();
    this.registry.stop();
    this.sinks.stop();
    this.provider.dispose();
  }

  /** The Cast sinks changed: remove the DIAL sinks that are Cast sinks now (they return with DIAL discovery). */
  castDevicesChanged(): void {
    this.sinks.refilter();
  }

  /** All DIAL sinks as devices. */
  devices(): CastDevice[] {
    return this.sinks.sinks().map(dialSinkToDevice);
  }

  /** The sinks a page at `origin` would see for `appName`: those with the app, and none if the origin is not allowed. */
  availableFor(appName: string, origin: string): CastDevice[] {
    if (!dialOriginAllowed(appName, origin)) return [];
    return this.sinks.availableSinks(appName).map(dialSinkToDevice);
  }

  /**
   * Starts working out which sinks have `appName` for a page at `origin`; call the result to stop, or null when the
   * origin may not see the app and nothing is started. Nothing is asked of
   * the devices for an origin that could not see the answer anyway: Chrome starts the query whatever the origin and
   * filters on delivery (`MediaSinksObserver::OnSinksUpdated`), which would let any page make the devices answer
   * app-info requests for names of its choosing.
   */
  monitorApp(appName: string, origin: string): (() => void) | null {
    if (!dialOriginAllowed(appName, origin)) return null;
    return this.sinks.monitorApp(appName);
  }
}
