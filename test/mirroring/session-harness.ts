import { CAST_WEBRTC_NAMESPACE } from "../../src/mirroring/protocol/constants.ts";
import { createEncodingSupport } from "../../src/mirroring/encoding-support.ts";
import { OpenscreenSessionHost, type MirroringError, type SessionType } from "../../src/mirroring/session-host.ts";
import { SenderPacketRouter } from "../../src/mirroring/sender/packet-router.ts";
import { UdpEnvironment } from "../../src/mirroring/transport/udp-environment.ts";
import { FakeBackend } from "./fake-backend.ts";
import { FakeReceiver, type FakeReceiverOptions } from "./fake-receiver.ts";

/** A whole mirroring session, sender and fake receiver, over real localhost UDP. */
export interface Harness {
  host: OpenscreenSessionHost;
  receiver: FakeReceiver;
  backend: FakeBackend;
  env: UdpEnvironment;
  router: SenderPacketRouter;
  errors: { error: MirroringError; message: string }[];
  log: string[];
  stopped: () => boolean;
  close(): void;
}

export async function startHarness(opts: { receiver?: FakeReceiverOptions; type?: SessionType; env?: Record<string, string | undefined> } = {}): Promise<Harness> {
  const receiver = await FakeReceiver.create(opts.receiver);
  const env = new UdpEnvironment("127.0.0.1");
  await env.bind();
  const router = new SenderPacketRouter(env);
  env.setPacketHandler((t, p) => router.onReceivedPacket(t, p));
  const backend = new FakeBackend(() => env.now());
  const errors: Harness["errors"] = [];
  const log: string[] = [];
  let stopped = false;
  const host = new OpenscreenSessionHost(
    { type: opts.type ?? "audio_video", receiverAddress: "127.0.0.1", sourceId: "sender-0", destinationId: "receiver-0" },
    {
      environment: env,
      router,
      backend,
      encodingSupport: createEncodingSupport({ hardware: new Set(), software: new Set(["vp8"]) }),
      env: opts.env ?? {},
      messagePort: { postMessage: (_dest, ns, message) => setImmediate(() => receiver.onControlMessage(ns, message)) },
      observer: {
        onError: (error, message) => errors.push({ error, message }),
        didStop: () => {
          stopped = true;
        },
        logInfo: (m) => log.push(m),
      },
    },
  );
  receiver.sendControl = (json) => setImmediate(() => host.onMessage("receiver-0", CAST_WEBRTC_NAMESPACE, json));
  host.start();
  return {
    host,
    receiver,
    backend,
    env,
    router,
    errors,
    log,
    stopped: () => stopped,
    close() {
      host.stopSession();
      backend.stopAll();
      receiver.close();
      env.close();
    },
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
