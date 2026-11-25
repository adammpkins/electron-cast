// A DIAL device on the loopback interface for the dial-test tests: it answers the SSDP search over UDP and serves the
// description, the app info, the launch and the stop over HTTP. It records what it was asked.
import dgram from "node:dgram";
import http from "node:http";
import tls from "node:tls";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { openUdpSsdpSocket } from "../../src/dial/ssdp-socket.ts";
import type { DialTestOptions } from "../../src/dial-test/runner.ts";

export const SECRETS = {
  friendlyName: "Living Room TV",
  serial: "SN-ABC-12345",
  udn: "uuid:AAAA1111-2222-3333-4444-555566667777",
  mac: "00:11:22:33:44:55",
  user: "screen-id-of-a-real-person",
};

export interface Seen { method: string; url: string; origin: string | undefined; contentLength: string | undefined; body: string }

const fx = (f: string): Buffer => readFileSync(new URL(`../fixtures/tls/${f}`, import.meta.url));

export class FakeDialDevice {
  readonly seen: Seen[] = [];
  state: "running" | "stopped" = "stopped";
  allowStop = true;
  /** False serves a description without the Application-URL header, which the library rejects. */
  sendApplicationUrl = true;
  /** The device's description fields, to be overridden per test. */
  manufacturer = "Acme Electronics";
  modelName = "Smart TV 9000";
  httpPort = 0;
  ssdpPort = 0;
  castPort = 0;
  private readonly http: http.Server;
  private readonly udp = dgram.createSocket("udp4");
  private tlsServer: tls.Server | null = null;
  /** Answers the search; false makes the device deaf, as when a firewall drops the answers. */
  answers = true;
  tlsConnections = 0;

  constructor() {
    this.http = http.createServer((req, res) => this.handle(req, res));
  }

  async start(options: { cast?: boolean } = {}): Promise<void> {
    await new Promise<void>((r) => this.http.listen(0, "127.0.0.1", r));
    this.httpPort = (this.http.address() as AddressInfo).port;
    this.udp.on("message", (_msg, rinfo) => {
      if (!this.answers) return;
      const answer = [
        "HTTP/1.1 200 OK",
        `LOCATION: http://127.0.0.1:${this.httpPort}/desc.xml`,
        "CACHE-CONTROL: max-age=1800",
        "ST: urn:dial-multiscreen-org:service:dial:1",
        `USN: ${SECRETS.udn}::urn:dial-multiscreen-org:service:dial:1`,
        "", "",
      ].join("\r\n");
      this.udp.send(answer, rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => this.udp.bind(0, "127.0.0.1", r));
    this.ssdpPort = (this.udp.address() as AddressInfo).port;
    // A port that is closed: bound once to learn a free number, then released.
    const probe = tls.createServer({ key: fx("key.pem"), cert: fx("cert.pem") }, (socket) => socket.on("error", () => undefined));
    // Counted at the TCP level: the client hangs up as soon as its handshake is done, which a TLS server may not report.
    probe.on("connection", (socket) => {
      this.tlsConnections++;
      socket.on("error", () => undefined);
    });
    probe.on("tlsClientError", () => undefined);
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    this.castPort = (probe.address() as AddressInfo).port;
    if (options.cast === true) this.tlsServer = probe;
    else await new Promise<void>((r) => probe.close(() => r()));
  }

  async stop(): Promise<void> {
    this.udp.close();
    await new Promise<void>((r) => {
      this.http.close(() => r());
      this.http.closeAllConnections();
    });
    if (this.tlsServer !== null) await new Promise<void>((r) => this.tlsServer?.close(() => r()));
  }

  /** The discovery and timing options that point the test at this device and make it quick. */
  options(extra: Partial<DialTestOptions> = {}): Partial<DialTestOptions> {
    return {
      discoverMs: 400,
      settleMs: 50,
      holdMs: 0,
      closeMs: 0,
      castPort: this.castPort,
      registry: {
        interfaces: () => [{ name: "lo", address: "127.0.0.1" }],
        openSocket: (iface, handlers) => openUdpSsdpSocket(iface, handlers, { target: { address: "127.0.0.1", port: this.ssdpPort } }),
        requestIntervalMs: 20,
        responseTimeoutMs: 80,
        maxRequests: 2,
      },
      ...extra,
    };
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      this.seen.push({
        method: req.method ?? "", url, origin: req.headers.origin,
        contentLength: req.headers["content-length"], body: Buffer.concat(chunks).toString("utf8"),
      });
      const base = `http://127.0.0.1:${this.httpPort}`;
      if (req.method === "GET" && url === "/desc.xml") {
        res.writeHead(200, {
          "Content-Type": "text/xml", Server: "Acme/1.0 UPnP/1.0", ...(this.sendApplicationUrl ? { "Application-URL": `${base}/apps/` } : {}),
        });
        res.end(this.description());
      } else if (req.method === "GET" && url === "/apps/YouTube") {
        res.writeHead(200, { "Content-Type": "text/xml" });
        res.end(this.appInfo());
      } else if (req.method === "POST" && url === "/apps/YouTube") {
        this.state = "running";
        res.writeHead(201, { Location: `${base}/apps/YouTube/run` });
        res.end();
      } else if (req.method === "DELETE" && url === "/apps/YouTube/run" && this.allowStop) {
        this.state = "stopped";
        res.writeHead(200);
        res.end();
      } else {
        res.writeHead(url.startsWith("/apps/") && req.method === "GET" ? 404 : 405);
        res.end();
      }
    });
  }

  private description(): string {
    return `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion>`
      + `<device><deviceType>urn:dial-multiscreen-org:device:dial:1</deviceType>`
      + `<friendlyName>${SECRETS.friendlyName}</friendlyName><manufacturer>${this.manufacturer}</manufacturer>`
      + `<modelName>${this.modelName}</modelName><modelNumber>ST9000</modelNumber><modelDescription>Acme television</modelDescription>`
      + `<serialNumber>${SECRETS.serial}</serialNumber><softwareVersion>5.6.7</softwareVersion>`
      + `<macAddress>${SECRETS.mac}</macAddress><UDN>${SECRETS.udn}</UDN></device></root>`;
  }

  private appInfo(): string {
    return `<?xml version="1.0" encoding="UTF-8"?><service xmlns="urn:dial-multiscreen-org:schemas:dial" dialVer="2.1">`
      + `<name>YouTube</name><options allowStop="${this.allowStop}"/><state>${this.state}</state>`
      + `${this.state === "running" ? `<link rel="run" href="run"/>` : ""}`
      + `<additionalData><screenId>${SECRETS.user}</screenId></additionalData></service>`;
  }
}
