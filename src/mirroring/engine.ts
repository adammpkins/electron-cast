/**
 * Assembles one mirroring session around a capture and encode backend: the UDP environment, the packet router and
 * the session host (`OpenscreenSessionHost`), behind the `MirroringService` boundary of mirroring-activity.ts.
 * Whether it runs in the main process, an Electron `utilityProcess` or a test is the caller's choice.
 */
import type { MirroringBackend } from "./backend.ts";
import type { EncodingSupport } from "./encoding-support.ts";
import type { CastMessageChannel, MirroringService, MirroringSessionObserver } from "./mirroring-activity.ts";
import { SenderPacketRouter } from "./sender/packet-router.ts";
import { OpenscreenSessionHost, type SessionParameters } from "./session-host.ts";
import { UdpEnvironment } from "./transport/udp-environment.ts";

export interface EngineOptions {
  /** Capture and encode for one session; called when the session starts. */
  createBackend(): MirroringBackend;
  encodingSupport: EncodingSupport;
  env?: Record<string, string | undefined>;
}

export function createMirroringServiceFactory(options: EngineOptions): (params: SessionParameters, observer: MirroringSessionObserver, channel: CastMessageChannel) => MirroringService {
  return (params, observer, channel) => {
    const environment = new UdpEnvironment(params.receiverAddress);
    const router = new SenderPacketRouter(environment);
    const backend = options.createBackend();
    backend.log = (message) => observer.logInfo?.(message);
    if (backend.requestWake !== undefined) environment.setWakeSource({ requestWake: (delayMs, wake) => backend.requestWake?.(delayMs, wake) });
    router.debugLog = (message) => observer.logInfo?.(message);
    environment.debugLog = (message) => observer.logInfo?.(message);
    let host: OpenscreenSessionHost | undefined;
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      environment.close();
    };
    environment.onSocketError = (err) => {
      observer.logInfo?.(`UDP socket error: ${err.message}`);
      observer.onError?.("CAST_TRANSPORT_ERROR", err.message);
    };
    // The socket must be bound before the OFFER goes out, as the session only needs the remote port from the ANSWER
    // but the local socket has to exist to send.
    void environment.bind().then(
      () => {
        if (closed) return;
        host = new OpenscreenSessionHost(params, {
          environment,
          router,
          backend,
          encodingSupport: options.encodingSupport,
          env: options.env,
          messagePort: { postMessage: (_destination, namespace, message) => channel.send(namespace, message) },
          observer: {
            ...observer,
            didStop: () => {
              close();
              backend.stopAll?.();
              observer.didStop?.();
            },
          },
        });
        host.start();
      },
      (err: Error) => {
        // No socket, so no session: release the capture that was prepared for it.
        backend.stopAll?.();
        close();
        observer.onError?.("CAST_TRANSPORT_ERROR", err.message);
      },
    );
    return {
      onMessage: (namespace, json) => host?.onMessage(params.destinationId, namespace, json),
      // The browser-side half of `MirroringServiceHost` that does not go through the Mirroring Service in Chrome
      // (`CastMirroringServiceHost::Pause` / `Resume` act on the video capture host directly) is relayed here because the
      // capture agent's port belongs to the engine.
      pause: (onPaused) => {
        backend.suspendVideoDevice();
        onPaused();
      },
      resume: (onResumed) => {
        backend.resumeVideoDevice();
        onResumed();
      },
      // `MirroringService::SwitchMirroringSourceTab`; the new source has already been handed to the backend.
      switchMirroringSourceTab: () => host?.switchSourceTab(),
      getMirroringStats: () => Promise.resolve(host?.getMirroringStats()),
      stop: () => {
        host?.stopSession();
        backend.stopAll?.();
        close();
      },
    };
  };
}
