import { children, contextTag, DerError, DerReader, oidString, Tag, type Tlv } from "./der.ts";

/**
 * Distinguished-name comparison, GeneralNames and name constraints, ported from BoringSSL's pki library:
 * verify_name_match.cc (NormalizeName, VerifyNameInSubtree, FindEmailAddressesInName), general_names.cc,
 * ip_util.cc and name_constraints.cc. Chromium's Cast certificate verification runs on that library
 * (components/media_router/common/providers/cast/certificate/cast_cert_validator.cc builds a bssl::CertPathBuilder).
 */

const OID_EMAIL_ADDRESS = "1.2.840.113549.1.9.1";

/** A normalized RDN sequence: one comparison key per RDN, in order. */
export type NormalizedName = string[];

const NORMALIZABLE = new Set<number>([Tag.PRINTABLE_STRING, Tag.UTF8_STRING, Tag.IA5_STRING, Tag.UNIVERSAL_STRING, Tag.BMP_STRING]);

/** ValueAsStringUnsafe: the attribute value as text, for the string types a Name may use. */
function valueAsString(tag: number, value: Buffer): string | undefined {
  switch (tag) {
    case Tag.PRINTABLE_STRING:
    case Tag.IA5_STRING:
    case Tag.T61_STRING:
      return value.toString("latin1");
    case Tag.UTF8_STRING:
      return value.toString("utf8");
    case Tag.BMP_STRING: {
      if (value.length % 2 !== 0) return undefined;
      let s = "";
      for (let i = 0; i < value.length; i += 2) s += String.fromCharCode(value.readUInt16BE(i));
      return s;
    }
    case Tag.UNIVERSAL_STRING: {
      if (value.length % 4 !== 0) return undefined;
      let s = "";
      for (let i = 0; i < value.length; i += 4) {
        const cp = value.readUInt32BE(i);
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return undefined;
        s += String.fromCodePoint(cp);
      }
      return s;
    }
    default:
      return undefined;
  }
}

/** NormalizeDirectoryString: trim and collapse spaces, fold ASCII case, enforce the charset of the string type. */
function normalizeDirectoryString(input: string, enforce: "none" | "printable" | "ascii"): string | undefined {
  let out = "";
  let i = 0;
  while (i < input.length && input[i] === " ") i++;
  for (; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c === 0x20) {
      const next = input[i + 1];
      if (next !== undefined && next !== " ") out += " ";
    } else if (c >= 0x41 && c <= 0x5a) {
      out += String.fromCharCode(c + 0x20);
    } else {
      if (enforce === "printable" && !((c >= 0x61 && c <= 0x7a) || (c >= 0x27 && c <= 0x3a) || c === 0x3d || c === 0x3f)) return undefined;
      if (enforce === "ascii" && c > 0x7f) return undefined;
      out += input[i];
    }
  }
  return out;
}

interface Ava {
  oid: string;
  tag: number;
  value: Buffer;
}

function readRdns(nameContent: Buffer): Ava[][] {
  const reader = new DerReader(nameContent);
  const rdns: Ava[][] = [];
  while (reader.hasMore) {
    const set = reader.expect(Tag.SET);
    const avas: Ava[] = [];
    const inner = new DerReader(set.value);
    while (inner.hasMore) {
      const seq = new DerReader(inner.expect(Tag.SEQUENCE).value);
      const oid = oidString(seq.expect(Tag.OID).value);
      const value = seq.read();
      seq.end();
      avas.push({ oid, tag: value.tag, value: value.value });
    }
    if (avas.length === 0) throw new DerError("empty RelativeDistinguishedName");
    rdns.push(avas);
  }
  return rdns;
}

/** NormalizeName. Throws {@link DerError} when a value cannot be normalized. */
export function normalizeName(nameContent: Buffer): NormalizedName {
  return readRdns(nameContent).map((avas) =>
    avas
      .map((ava) => {
        if (NORMALIZABLE.has(ava.tag)) {
          const text = valueAsString(ava.tag, ava.value);
          const enforce = ava.tag === Tag.PRINTABLE_STRING ? "printable" : ava.tag === Tag.IA5_STRING ? "ascii" : "none";
          const normalized = text === undefined ? undefined : normalizeDirectoryString(text, enforce);
          if (normalized === undefined) throw new DerError("attribute value cannot be normalized");
          return `${ava.oid}=S:${normalized}`;
        }
        return `${ava.oid}=${ava.tag}:${ava.value.toString("hex")}`;
      })
      .sort()
      .join("+"),
  );
}

export function namesEqual(a: NormalizedName, b: NormalizedName): boolean {
  return a.length === b.length && a.every((rdn, i) => rdn === b[i]);
}

/** VerifyNameInSubtree: `name` equals `parent` or extends it with more RDNs. */
export function nameInSubtree(name: NormalizedName, parent: NormalizedName): boolean {
  return name.length >= parent.length && parent.every((rdn, i) => rdn === name[i]);
}

/** FindEmailAddressesInName. Returns undefined if the name is not parseable. */
export function findEmailAddresses(nameContent: Buffer): string[] | undefined {
  try {
    const out: string[] = [];
    for (const rdn of readRdns(nameContent)) {
      for (const ava of rdn) {
        if (ava.oid !== OID_EMAIL_ADDRESS) continue;
        const text = valueAsString(ava.tag, ava.value);
        if (text === undefined) return undefined;
        out.push(text);
      }
    }
    return out;
  } catch {
    return undefined;
  }
}

// --- GeneralNames ---------------------------------------------------------------------------------------------

export const GeneralNameType = {
  OTHER_NAME: 1 << 0,
  RFC822_NAME: 1 << 1,
  DNS_NAME: 1 << 2,
  X400_ADDRESS: 1 << 3,
  DIRECTORY_NAME: 1 << 4,
  EDI_PARTY_NAME: 1 << 5,
  URI: 1 << 6,
  IP_ADDRESS: 1 << 7,
  REGISTERED_ID: 1 << 8,
} as const;
const ALL_NAME_TYPES = 0x1ff;
/** The name types the constraint matcher implements; a constraint of any other type only binds when critical. */
const SUPPORTED_NAME_TYPES =
  GeneralNameType.RFC822_NAME | GeneralNameType.DNS_NAME | GeneralNameType.DIRECTORY_NAME | GeneralNameType.IP_ADDRESS;

export interface GeneralNames {
  presentTypes: number;
  rfc822: string[];
  dns: string[];
  directory: NormalizedName[];
  ipAddresses: Buffer[];
  /** Constraint form: address and netmask. */
  ipRanges: { address: Buffer; mask: Buffer }[];
}

function emptyGeneralNames(): GeneralNames {
  return { presentTypes: 0, rfc822: [], dns: [], directory: [], ipAddresses: [], ipRanges: [] };
}

const isAscii = (b: Buffer): boolean => b.every((x) => x < 0x80);

function isValidNetmask(mask: Buffer): boolean {
  if (mask.length !== 4 && mask.length !== 16) return false;
  for (let i = 0; i < mask.length; i++) {
    const b = mask[i] as number;
    if (b !== 0xff) {
      const inv = ~b & 0xff;
      if ((inv & (inv + 1)) !== 0) return false;
      for (let j = i + 1; j < mask.length; j++) if (mask[j] !== 0) return false;
      return true;
    }
  }
  return true;
}

/** ParseGeneralName. Throws {@link DerError} for malformed or unknown general names. */
function parseGeneralName(tlv: Tlv, into: GeneralNames, ipForm: "address" | "constraint"): void {
  const { tag, value } = tlv;
  if (tag === contextTag(0, true)) {
    into.presentTypes |= GeneralNameType.OTHER_NAME;
  } else if (tag === contextTag(1, false)) {
    if (!isAscii(value)) throw new DerError("rfc822Name is not ASCII");
    into.rfc822.push(value.toString("latin1"));
    into.presentTypes |= GeneralNameType.RFC822_NAME;
  } else if (tag === contextTag(2, false)) {
    if (!isAscii(value)) throw new DerError("dNSName is not ASCII");
    into.dns.push(value.toString("latin1"));
    into.presentTypes |= GeneralNameType.DNS_NAME;
  } else if (tag === contextTag(3, true)) {
    into.presentTypes |= GeneralNameType.X400_ADDRESS;
  } else if (tag === contextTag(4, true)) {
    const reader = new DerReader(value);
    const name = reader.expect(Tag.SEQUENCE);
    reader.end();
    into.directory.push(normalizeName(name.value));
    into.presentTypes |= GeneralNameType.DIRECTORY_NAME;
  } else if (tag === contextTag(5, true)) {
    into.presentTypes |= GeneralNameType.EDI_PARTY_NAME;
  } else if (tag === contextTag(6, false)) {
    if (!isAscii(value)) throw new DerError("uniformResourceIdentifier is not ASCII");
    into.presentTypes |= GeneralNameType.URI;
  } else if (tag === contextTag(7, false)) {
    if (ipForm === "address") {
      if (value.length !== 4 && value.length !== 16) throw new DerError("bad iPAddress");
      into.ipAddresses.push(value);
    } else {
      if (value.length !== 8 && value.length !== 32) throw new DerError("bad iPAddress constraint");
      const half = value.length / 2;
      const mask = value.subarray(half);
      if (!isValidNetmask(mask)) throw new DerError("bad netmask");
      into.ipRanges.push({ address: value.subarray(0, half), mask });
    }
    into.presentTypes |= GeneralNameType.IP_ADDRESS;
  } else if (tag === contextTag(8, false)) {
    into.presentTypes |= GeneralNameType.REGISTERED_ID;
  } else {
    throw new DerError("unknown GeneralName type");
  }
}

/** GeneralNames::Create from an extension value (a SEQUENCE OF GeneralName, non-empty). */
export function parseGeneralNames(extnValue: Buffer): GeneralNames {
  const reader = new DerReader(extnValue);
  const seq = reader.expect(Tag.SEQUENCE);
  reader.end();
  const out = emptyGeneralNames();
  const items = children(seq);
  if (items.length === 0) throw new DerError("GeneralNames is empty");
  for (const item of items) parseGeneralName(item, out, "address");
  return out;
}

// --- NameConstraints ------------------------------------------------------------------------------------------

function parseSubtrees(value: Buffer): GeneralNames {
  const out = emptyGeneralNames();
  const reader = new DerReader(value);
  if (!reader.hasMore) throw new DerError("empty subtrees");
  while (reader.hasMore) {
    const subtree = new DerReader(reader.expect(Tag.SEQUENCE).value);
    parseGeneralName(subtree.read(), out, "constraint");
    // minimum and maximum are not allowed to be present (RFC 5280 4.2.1.10); BoringSSL rejects trailing fields.
    subtree.end();
  }
  return out;
}

function dnsNameMatches(nameIn: string, constraintIn: string, wildcard: "partial" | "full"): boolean {
  let name = nameIn;
  let constraint = constraintIn;
  if (constraint === "") return true;
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (constraint.endsWith(".")) constraint = constraint.slice(0, -1);
  if (wildcard === "partial" && name.length > 2 && name.startsWith("*.")) {
    const dot = constraint.indexOf(".");
    if (dot !== -1 && name.slice(2).toLowerCase() === constraint.slice(dot + 1).toLowerCase()) return true;
  }
  if (!name.toLowerCase().endsWith(constraint.toLowerCase())) return false;
  if (name.length === constraint.length) return true;
  if (constraint.startsWith(".")) constraint = constraint.slice(1);
  return name.length > constraint.length && name[name.length - constraint.length - 1] === ".";
}

const isAlnum = (c: string): boolean => /^[0-9A-Za-z]$/.test(c);
const allowedLocalPart = (s: string): boolean => s !== "" && [...s].every((c) => isAlnum(c) || "!#$%&'*+-/=?^_`{|}~.".includes(c));
const allowedDomain = (s: string): boolean => s !== "" && [...s].every((c) => isAlnum(c) || c === "-" || c === ".");

function rfc822NameMatches(local: string, domain: string, constraint: string, kind: "permitted" | "excluded", caseInsensitiveLocal: boolean): boolean {
  const errorValue = kind === "excluded";
  const parts = constraint.split("@");
  let constraintLocal = "";
  let constraintDomain: string;
  if (parts.length === 1) {
    constraintDomain = parts[0] as string;
  } else if (parts.length === 2) {
    constraintLocal = parts[0] as string;
    if (!allowedLocalPart(constraintLocal)) return errorValue;
    constraintDomain = parts[1] as string;
  } else {
    return errorValue;
  }
  if (!allowedDomain(constraintDomain)) return errorValue;
  if (constraintLocal !== "") {
    const localEqual = caseInsensitiveLocal ? local.toLowerCase() === constraintLocal.toLowerCase() : local === constraintLocal;
    return localEqual && domain.toLowerCase() === constraintDomain.toLowerCase();
  }
  if (constraintDomain.startsWith(".")) return domain.toLowerCase().endsWith(constraintDomain.toLowerCase());
  return domain.toLowerCase() === constraintDomain.toLowerCase();
}

function ipMatches(addr: Buffer, other: Buffer, mask: Buffer): boolean {
  if (addr.length !== other.length || addr.length !== mask.length) return false;
  for (let i = 0; i < addr.length; i++) if (((addr[i] as number) & (mask[i] as number)) !== ((other[i] as number) & (mask[i] as number))) return false;
  return true;
}

const MAX_NAME_CONSTRAINT_CHECKS = 1 << 20;

/** The result of checking a certificate against name constraints. */
export class NameConstraints {
  private readonly permitted: GeneralNames;
  private readonly excluded: GeneralNames;
  private readonly constrainedTypes: number;

  private constructor(permitted: GeneralNames, excluded: GeneralNames, critical: boolean) {
    this.permitted = permitted;
    this.excluded = excluded;
    const mask = critical ? ALL_NAME_TYPES : SUPPORTED_NAME_TYPES;
    this.constrainedTypes = (permitted.presentTypes & mask) | (excluded.presentTypes & mask);
  }

  /** NameConstraints::Create. Throws {@link DerError} when the extension is malformed. */
  static parse(extnValue: Buffer, critical: boolean): NameConstraints {
    const reader = new DerReader(extnValue);
    const seq = new DerReader(reader.expect(Tag.SEQUENCE).value);
    reader.end();
    let permitted = emptyGeneralNames();
    let excluded = emptyGeneralNames();
    const p = seq.optional(contextTag(0, true));
    if (p !== undefined) permitted = parseSubtrees(p.value);
    const e = seq.optional(contextTag(1, true));
    if (e !== undefined) excluded = parseSubtrees(e.value);
    if (p === undefined && e === undefined) throw new DerError("NameConstraints has no subtrees");
    seq.end();
    return new NameConstraints(permitted, excluded, critical);
  }

  /**
   * IsPermittedCert. Returns false when the certificate's names violate the constraints. `subjectContent` is the
   * subject Name's content octets (for email addresses); `subjectAltNames` is undefined when the extension is absent.
   */
  isPermittedCert(subject: NormalizedName, subjectContent: Buffer, subjectAltNames: GeneralNames | undefined): boolean {
    let nameCount: number;
    let constraintCount = 0;
    if (subjectAltNames !== undefined) {
      nameCount = subjectAltNames.rfc822.length + subjectAltNames.dns.length + subjectAltNames.directory.length + subjectAltNames.ipAddresses.length;
      constraintCount =
        this.excluded.rfc822.length + this.permitted.rfc822.length + this.excluded.dns.length + this.permitted.dns.length +
        this.excluded.directory.length + this.permitted.directory.length + this.excluded.ipRanges.length + this.permitted.ipRanges.length;
    } else {
      constraintCount += this.excluded.directory.length + this.permitted.directory.length;
      nameCount = subjectContent.length;
    }
    if (constraintCount * nameCount > MAX_NAME_CONSTRAINT_CHECKS) return false;

    let subjectEmails: string[] = [];
    if (subjectAltNames === undefined && (this.constrainedTypes & GeneralNameType.RFC822_NAME) !== 0) {
      const found = findEmailAddresses(subjectContent);
      if (found === undefined) return false;
      subjectEmails = found;
    }

    if (subjectAltNames !== undefined) {
      if ((this.constrainedTypes & subjectAltNames.presentTypes & ~SUPPORTED_NAME_TYPES) !== 0) return false;
      if ((this.constrainedTypes & GeneralNameType.RFC822_NAME) !== 0) {
        for (const name of subjectAltNames.rfc822) if (!this.isPermittedRfc822(name, false)) return false;
      }
      for (const name of subjectAltNames.dns) if (!this.isPermittedDns(name)) return false;
      for (const name of subjectAltNames.directory) if (!this.isPermittedDirectory(name)) return false;
      for (const ip of subjectAltNames.ipAddresses) if (!this.isPermittedIp(ip)) return false;
    }

    for (const email of subjectEmails) if (!this.isPermittedRfc822(email, true)) return false;

    // With a SAN and an empty subject the subject DN is not checked (RFC 5280 4.2.1.10).
    if (subjectAltNames !== undefined && subject.length === 0) return true;
    return this.isPermittedDirectory(subject);
  }

  private isPermittedRfc822(name: string, caseInsensitiveExcludeLocal: boolean): boolean {
    const parts = name.split("@");
    if (parts.length !== 2) return false;
    const [local, domain] = parts as [string, string];
    if (!allowedLocalPart(local) || !allowedDomain(domain)) return false;
    for (const excluded of this.excluded.rfc822) {
      if (rfc822NameMatches(local, domain, excluded, "excluded", caseInsensitiveExcludeLocal)) return false;
    }
    if ((this.permitted.presentTypes & GeneralNameType.RFC822_NAME) === 0) return true;
    return this.permitted.rfc822.some((p) => rfc822NameMatches(local, domain, p, "permitted", false));
  }

  private isPermittedDns(name: string): boolean {
    for (const excluded of this.excluded.dns) if (dnsNameMatches(name, excluded, "partial")) return false;
    if ((this.permitted.presentTypes & GeneralNameType.DNS_NAME) === 0) return true;
    return this.permitted.dns.some((p) => dnsNameMatches(name, p, "full"));
  }

  private isPermittedDirectory(name: NormalizedName): boolean {
    for (const excluded of this.excluded.directory) if (nameInSubtree(name, excluded)) return false;
    if ((this.permitted.presentTypes & GeneralNameType.DIRECTORY_NAME) === 0) return true;
    return this.permitted.directory.some((p) => nameInSubtree(name, p));
  }

  private isPermittedIp(ip: Buffer): boolean {
    for (const excluded of this.excluded.ipRanges) if (ipMatches(ip, excluded.address, excluded.mask)) return false;
    if ((this.permitted.presentTypes & GeneralNameType.IP_ADDRESS) === 0) return true;
    return this.permitted.ipRanges.some((p) => ipMatches(ip, p.address, p.mask));
  }
}
