import type { DnsRecord } from "./dns-packet.ts";

/** A Cast device assembled from PTR, SRV, TXT and address records. */
export interface CastDevice {
  id: string;
  name: string;
  model: string;
  host: string;
  addresses: string[];
  port: number;
  capabilities: number;
  isGroup: boolean;
  statusText: string;
  instanceName: string;
  txt: Record<string, string>;
  /**
   * Present on a DIAL sink (found by SSDP, not mDNS): `id` is then `dial:<uuid>`, `host` the device's address, `port` 0
   * and `capabilities` 0. A device that is a Cast device never shows up as a DIAL sink, as in Chrome.
   */
  dial?: { appUrl: string; modelName: string; ipAddress: string };
}

/** Devices added, updated or removed by one ingest or expire call. */
export interface CacheChange {
  added: CastDevice[];
  updated: CastDevice[];
  removed: CastDevice[];
}

interface StoredRecord {
  record: DnsRecord;
  receivedAt: number;
  expiresAt: number;
  /** Interfaces this record was heard on (see {@link CastDeviceCache.dropSource}). */
  sources: Set<string>;
}

/** Data-identity component of a storage key ("" for TXT, which is keyed by name alone). */
function dataKey(record: DnsRecord): string {
  switch (record.type) {
    case "A":
    case "AAAA":
    case "PTR":
      return record.data.toLowerCase();
    case "SRV":
      return `${record.data.port}:${record.data.target.toLowerCase()}`;
    case "TXT":
      return "";
    case "UNKNOWN":
      return record.data.toString("hex");
  }
}

function keyOf(record: DnsRecord): string {
  return `${record.name.toLowerCase()}\u0000${record.type}\u0000${dataKey(record)}`;
}

function compareDevices(a: CastDevice, b: CastDevice): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function sortDevices(list: CastDevice[]): CastDevice[] {
  return [...list].sort(compareDevices);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k) || !deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

interface Seen { address: string; receivedAt: number }

/** Addresses, most recently heard first: after a DHCP change the new one leads even before the old one expires. */
function newestFirst(list: Seen[]): string[] {
  return [...list].sort((a, b) => b.receivedAt - a.receivedAt).map((a) => a.address);
}

function isLinkLocal(address: string): boolean {
  return /^fe[89ab][0-9a-f]:/i.test(address);
}

/** Parses the TXT `ca` value: a non-negative base-10 integer, or 0 otherwise. */
function parseCapabilities(raw: string | undefined): number {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : 0;
}

/** Deep copy of a device: fresh object, fresh arrays, fresh TXT map. */
function copyDevice(d: CastDevice): CastDevice {
  return {
    ...d,
    addresses: [...d.addresses],
    txt: Object.assign(Object.create(null), d.txt) as Record<string, string>,
  };
}

/**
 * TTL-aware cache that joins mDNS records into Cast devices. Pure: no timers,
 * no network; callers pass the current time to every method.
 */
export class CastDeviceCache {
  readonly serviceName: string;
  private readonly stored: StoredRecord[] = [];

  constructor(serviceName?: string) {
    this.serviceName = serviceName ?? "_googlecast._tcp.local";
  }

  /** Ingests a batch of records (in arrival order) and reports device changes. */
  ingest(records: DnsRecord[], now: number, source?: string): CacheChange {
    const before = this.devices();
    for (const record of records) this.store(record, now, source);
    return this.diff(before);
  }

  /**
   * Forgets that `source` (an interface) heard anything, and removes the records that nothing else heard. Used when
   * an interface goes away: its devices are not reachable any more, so they should not wait out their TTL.
   */
  dropSource(source: string): CacheChange {
    const before = this.devices();
    const kept = this.stored.filter((r) => !r.sources.delete(source) || r.sources.size > 0);
    this.stored.splice(0, this.stored.length, ...kept);
    return this.diff(before);
  }

  /** Removes expired records and reports device changes. */
  expire(now: number): CacheChange {
    const before = this.devices();
    this.stored.splice(0, this.stored.length, ...this.stored.filter((r) => now < r.expiresAt));
    return this.diff(before);
  }

  /** Fresh, sorted copies of all currently known devices. */
  devices(): CastDevice[] {
    return this.snapshot().map(copyDevice);
  }

  private store(record: DnsRecord, now: number, source?: string): void {
    const key = keyOf(record);
    if (record.ttl === 0) {
      // Goodbye: drop the matching stored record, do not store it.
      const idx = this.stored.findIndex((r) => keyOf(r.record) === key);
      if (idx !== -1) this.stored.splice(idx, 1);
      return;
    }
    if (record.cacheFlush) {
      // RFC 6762 10.2: evict same name+type records received more than a second ago.
      const name = record.name.toLowerCase();
      this.stored.splice(
        0,
        this.stored.length,
        ...this.stored.filter(
          (r) => !(r.record.name.toLowerCase() === name && r.record.type === record.type && now - r.receivedAt > 1000),
        ),
      );
    }
    const idx = this.stored.findIndex((r) => keyOf(r.record) === key);
    const sources = new Set(idx !== -1 ? this.stored[idx]?.sources : undefined);
    if (source !== undefined) sources.add(source);
    const entry = { record, receivedAt: now, expiresAt: now + record.ttl * 1000, sources };
    if (idx !== -1) this.stored[idx] = entry;
    else this.stored.push(entry);
  }

  /** Joins the stored records into devices, deduplicated by TXT id. */
  private snapshot(): CastDevice[] {
    const service = this.serviceName.toLowerCase();
    const srvByInstance = new Map<string, { record: Extract<DnsRecord, { type: "SRV" }>; receivedAt: number }>();
    const txtByInstance = new Map<string, { record: Extract<DnsRecord, { type: "TXT" }>; receivedAt: number }>();
    const addrsByHost = new Map<string, { v4: Seen[]; v6: Seen[] }>();
    for (const s of this.stored) {
      const rec = s.record;
      const name = rec.name.toLowerCase();
      if (rec.type === "SRV") {
        const prev = srvByInstance.get(name);
        if (!prev || s.receivedAt >= prev.receivedAt) srvByInstance.set(name, { record: rec, receivedAt: s.receivedAt });
      } else if (rec.type === "TXT") {
        const prev = txtByInstance.get(name);
        if (!prev || s.receivedAt >= prev.receivedAt) txtByInstance.set(name, { record: rec, receivedAt: s.receivedAt });
      } else if (rec.type === "A" || rec.type === "AAAA") {
        let list = addrsByHost.get(name);
        if (!list) {
          list = { v4: [], v6: [] };
          addrsByHost.set(name, list);
        }
        (rec.type === "A" ? list.v4 : list.v6).push({ address: rec.data, receivedAt: s.receivedAt });
      }
    }
    const byId = new Map<string, { device: CastDevice; recency: number }>();
    for (const s of this.stored) {
      const ptr = s.record;
      if (ptr.type !== "PTR" || ptr.name.toLowerCase() !== service) continue;
      const instance = ptr.data;
      const ik = instance.toLowerCase();
      const srv = srvByInstance.get(ik);
      const txt = txtByInstance.get(ik);
      if (!srv || !txt) continue;
      const id = txt.record.data["id"];
      if (!id) continue;
      const addrs = addrsByHost.get(srv.record.data.target.toLowerCase());
      if (!addrs || (addrs.v4.length + addrs.v6.length) === 0) continue;
      const v4 = newestFirst(addrs.v4);
      const v6 = newestFirst(addrs.v6);
      // IPv4 first (Chromium's Cast discovery only resolves A records), then global IPv6, then link-local.
      const ordered = [...v4, ...v6.filter((a) => !isLinkLocal(a)), ...v6.filter(isLinkLocal)];
      const txtData = txt.record.data;
      const fn = txtData["fn"];
      const dot = instance.indexOf(".");
      const label = dot === -1 ? instance : instance.slice(0, dot);
      const capabilities = parseCapabilities(txtData["ca"]);
      const device: CastDevice = {
        id,
        name: fn && fn !== "" ? fn : label,
        model: txtData["md"] ?? "",
        host: ordered[0] ?? "",
        addresses: ordered,
        port: srv.record.data.port,
        capabilities,
        isGroup: (capabilities & 32) !== 0,
        statusText: txtData["rs"] ?? "",
        instanceName: instance,
        txt: Object.assign(Object.create(null), txtData) as Record<string, string>,
      };
      const recency = Math.max(s.receivedAt, srv.receivedAt, txt.receivedAt);
      const existing = byId.get(id);
      if (!existing || recency >= existing.recency) byId.set(id, { device, recency });
    }
    return sortDevices([...byId.values()].map((e) => e.device));
  }

  private diff(before: CastDevice[]): CacheChange {
    const after = this.devices();
    const beforeById = new Map<string, CastDevice>(before.map((d): [string, CastDevice] => [d.id, d]));
    const afterById = new Map<string, CastDevice>(after.map((d): [string, CastDevice] => [d.id, d]));
    const added: CastDevice[] = [];
    const removed: CastDevice[] = [];
    const updated: CastDevice[] = [];
    for (const d of after) if (!beforeById.has(d.id)) added.push(d);
    for (const d of before) if (!afterById.has(d.id)) removed.push(d);
    for (const d of after) {
      const prev = beforeById.get(d.id);
      if (prev && !deepEqual(prev, d)) updated.push(d);
    }
    return { added: sortDevices(added), updated: sortDevices(updated), removed: sortDevices(removed) };
  }
}
