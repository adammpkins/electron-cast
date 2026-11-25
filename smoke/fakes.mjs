// Stand-ins for the network: no mDNS, no TLS, no device. Everything else in the smoke test is real.
import { EventEmitter } from "node:events";

export const TV = {
  id: "dev-tv",
  name: "Smoke Test TV",
  model: "Chromecast",
  host: "10.0.0.10",
  addresses: ["10.0.0.10"],
  port: 8009,
  capabilities: 5, // video_out + audio_out
  isGroup: false,
  statusText: "",
  instanceName: "Chromecast-dev-tv._googlecast._tcp.local",
  txt: {},
};

export class FakeDiscovery extends EventEmitter {
  devices() {
    return [{ ...TV }];
  }
  async start() {}
  stop() {}
}

const MEDIA_NAMESPACE = "urn:x-cast:com.google.cast.media";

export class FakeClient extends EventEmitter {
  connected = false;
  calls = [];
  apps = [];
  volume = { level: 0.5, muted: false, controlType: "attenuation", stepInterval: 0.05 };
  #n = 0;

  constructor(device) {
    super();
    this.device = device;
  }
  status() {
    return { applications: this.apps.map((a) => ({ ...a })), volume: { ...this.volume } };
  }
  async connect() {
    this.calls.push("connect");
    this.connected = true;
  }
  close() {
    this.calls.push("close");
    if (!this.connected) return;
    this.connected = false;
    this.emit("close");
  }
  send() {}
  async launch(appId) {
    this.calls.push(`launch ${appId}`);
    const k = ++this.#n;
    const app = {
      appId,
      displayName: "Smoke App",
      sessionId: `session-${k}`,
      transportId: `transport-${k}`,
      statusText: "Smoke App",
      // the presentation translator needs the media namespace to be advertised
      namespaces: [{ name: "urn:x-cast:com.example.smoke" }, { name: MEDIA_NAMESPACE }],
      iconUrl: "https://example.test/icon.png",
    };
    this.apps = [app];
    return { ...app };
  }
  async stop(sessionId) {
    this.calls.push(`stop ${sessionId}`);
    this.apps = this.apps.filter((a) => a.sessionId !== sessionId);
    return this.status();
  }
  async setVolume(v) {
    Object.assign(this.volume, v);
    return this.status();
  }
  async getStatus() {
    return this.status();
  }
  connectTransport(id) {
    this.calls.push(`connectTransport ${id}`);
  }
  closeTransport(id) {
    this.calls.push(`closeTransport ${id}`);
  }
}
