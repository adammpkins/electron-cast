import type { KeyObject } from "node:crypto";
import {
  criticalPoliciesHandled,
  isSelfIssued,
  keyUsageAsserts,
  KEY_USAGE_BIT,
  OID,
  parseAcceptablePublicKey,
  parseSignatureAlgorithm,
  sameSignatureAlgorithm,
  verifySignedData,
  type ParsedCertificate,
} from "./x509.ts";
import { DerReader } from "./der.ts";
import { namesEqual } from "./names.ts";
import type { NameConstraints } from "./names.ts";

/**
 * RFC 5280 certificate path validation as BoringSSL implements it (pki/verify_certificate_chain.cc, PathVerifier),
 * which is what Chromium's Cast verification runs (cast_cert_validator.cc builds a bssl::CertPathBuilder over it).
 * The delegate is Chromium's CastPathBuilderDelegate (RSA moduli of at least 2048 bits, SHA-1 allowed), the trust
 * anchors are added "with constraints" and without expiry enforcement (CastTrustStore::AddAnchor), and the user
 * initial policy set is {anyPolicy} with no inhibit flags.
 */

export type KeyPurpose = "client-auth" | "any";

/** The errors a path accumulated; `date` marks kValidityFailedNotBefore/NotAfter, which Chromium reports separately. */
export interface PathErrors {
  messages: string[];
  date: boolean;
}

// --- The valid policy graph (RFC 5280 6.1.2's valid_policy_tree) -----------------------------------------------

interface PolicyNode {
  parents: string[];
  mapped: boolean;
  reachable: boolean;
}

interface LevelDetails {
  expected: Map<string, string[]>;
  hasAny: boolean;
}

class ValidPolicyGraph {
  private levels: Map<string, PolicyNode>[] = [];
  private current: LevelDetails = { expected: new Map(), hasAny: false };

  init(): void {
    this.setNull();
    this.startLevel();
    this.addAnyPolicyNode();
  }

  isNull(): boolean {
    const last = this.levels[this.levels.length - 1];
    return !this.current.hasAny && (last === undefined || last.size === 0);
  }

  setNull(): void {
    this.levels = [];
    this.current = { expected: new Map(), hasAny: false };
  }

  startLevel(): LevelDetails {
    const last = this.levels[this.levels.length - 1];
    if (last !== undefined) {
      for (const [policy, node] of last) {
        if (!node.mapped) this.expect(policy, policy);
      }
    }
    const previous = this.current;
    this.levels.push(new Map());
    this.current = { expected: new Map(), hasAny: false };
    return previous;
  }

  private expect(subjectPolicy: string, issuerPolicy: string): void {
    const list = this.current.expected.get(subjectPolicy);
    if (list === undefined) this.current.expected.set(subjectPolicy, [issuerPolicy]);
    else list.push(issuerPolicy);
  }

  /** GetUserConstrainedPolicySet with the initial policy set {anyPolicy}. */
  userConstrainedPolicySetIsEmpty(): boolean {
    if (this.levels.length === 0) return true;
    if (this.current.hasAny) return false;
    const last = this.levels[this.levels.length - 1] as Map<string, PolicyNode>;
    for (const node of last.values()) node.reachable = true;
    let count = 0;
    for (let i = this.levels.length - 1; i >= 0; i--) {
      for (const node of (this.levels[i] as Map<string, PolicyNode>).values()) {
        if (!node.reachable) continue;
        if (node.parents.length === 0) {
          count++;
        } else if (i > 0) {
          for (const parent of node.parents) {
            const p = (this.levels[i - 1] as Map<string, PolicyNode>).get(parent);
            if (p !== undefined) p.reachable = true;
          }
        }
      }
    }
    return count === 0;
  }

  addAnyPolicyNode(): void {
    this.current.hasAny = true;
  }

  addNode(policy: string, parents: string[]): void {
    const last = this.levels[this.levels.length - 1];
    if (last !== undefined && !last.has(policy)) last.set(policy, { parents, mapped: false, reachable: false });
  }

  addPolicyMapping(issuerPolicy: string, subjectPolicy: string): void {
    const last = this.levels[this.levels.length - 1];
    if (last === undefined) return;
    let node = last.get(issuerPolicy);
    if (node === undefined) {
      if (!this.current.hasAny) return;
      node = { parents: [], mapped: false, reachable: false };
      last.set(issuerPolicy, node);
    }
    node.mapped = true;
    this.expect(subjectPolicy, issuerPolicy);
  }

  deleteNode(policy: string): void {
    this.levels[this.levels.length - 1]?.delete(policy);
  }
}

// --- The verifier ---------------------------------------------------------------------------------------------

class PathVerifier {
  private readonly graph = new ValidPolicyGraph();
  private nameConstraints: NameConstraints[] = [];
  private explicitPolicy = 0;
  private inhibitAnyPolicy = 0;
  private policyMapping = 0;
  private maxPathLength = 0;
  private workingIssuer: ParsedCertificate | undefined;
  private workingKey: KeyObject | undefined;

  private readonly errors: PathErrors;
  private readonly time: number;
  private readonly purpose: KeyPurpose;

  constructor(errors: PathErrors, time: number, purpose: KeyPurpose) {
    this.errors = errors;
    this.time = time;
    this.purpose = purpose;
  }

  private error(message: string): void {
    this.errors.messages.push(message);
  }

  /** VerifyTimeValidity. */
  private verifyTime(cert: ParsedCertificate): void {
    if (this.time < cert.notBefore) {
      this.error("certificate is not yet valid");
      this.errors.date = true;
    }
    if (cert.notAfter < this.time) {
      this.error("certificate has expired");
      this.errors.date = true;
    }
  }

  /** VerifyExtendedKeyUsage, for the key purposes Cast uses (ANY_EKU skips the check). */
  private verifyEku(cert: ParsedCertificate): void {
    if (this.purpose === "any") return;
    const eku = cert.extendedKeyUsage;
    if (eku === undefined) return;
    // KeyPurpose::CLIENT_AUTH: an EKU without clientAuth or anyExtendedKeyUsage is an error. (Prohibited-purpose and
    // anyEKU-without-clientAuth findings are warnings for the non-strict purposes.)
    if (!eku.includes(OID.CLIENT_AUTH) && !eku.includes(OID.ANY_EKU)) this.error("extended key usage lacks clientAuth");
  }

  /** VerifyNoUnconsumedCriticalExtensions. */
  private verifyNoUnconsumedCritical(cert: ParsedCertificate): void {
    for (const ext of cert.extensions.values()) {
      if (!ext.critical) continue;
      if (ext.oid === OID.MS_APPLICATION_POLICIES && cert.extendedKeyUsage !== undefined) continue;
      const handled =
        ext.oid === OID.BASIC_CONSTRAINTS ||
        ext.oid === OID.KEY_USAGE ||
        ext.oid === OID.EXT_KEY_USAGE ||
        ext.oid === OID.NAME_CONSTRAINTS ||
        ext.oid === OID.SUBJECT_ALT_NAME ||
        (ext.oid === OID.CERTIFICATE_POLICIES && criticalPoliciesHandled(ext.value)) ||
        ext.oid === OID.POLICY_MAPPINGS ||
        ext.oid === OID.POLICY_CONSTRAINTS ||
        ext.oid === OID.INHIBIT_ANY_POLICY;
      if (!handled) this.error(`unconsumed critical extension ${ext.oid}`);
    }
  }

  /** ParseAndCheckPublicKey. */
  private checkPublicKey(cert: ParsedCertificate): KeyObject | undefined {
    const key = parseAcceptablePublicKey(cert.spkiTlv);
    if (key === undefined) this.error("public key is unparseable or unacceptable (RSA of at least 2048 bits, or P-256/384/521)");
    return key;
  }

  private verifyPolicies(cert: ParsedCertificate, isTarget: boolean): void {
    if (cert.policyOids !== undefined && !this.graph.isNull()) {
      const previous = this.graph.startLevel();
      let certHasAny = false;
      for (const oid of cert.policyOids) {
        if (oid === OID.ANY_POLICY) {
          certHasAny = true;
          continue;
        }
        const parents = previous.expected.get(oid);
        if (parents !== undefined) {
          this.graph.addNode(oid, parents);
          previous.expected.delete(oid);
        } else if (previous.hasAny) {
          this.graph.addNode(oid, []);
        }
      }
      if (certHasAny && (this.inhibitAnyPolicy > 0 || (!isTarget && isSelfIssued(cert)))) {
        for (const [oid, parents] of previous.expected) this.graph.addNode(oid, parents);
        if (previous.hasAny) this.graph.addAnyPolicyNode();
      }
    }
    if (cert.policyOids === undefined) this.graph.setNull();
    if (!(this.explicitPolicy > 0 || !this.graph.isNull())) this.error("no valid policy");
  }

  private verifyPolicyMappings(cert: ParsedCertificate): void {
    const mappings = cert.policyMappings;
    if (mappings === undefined) return;
    for (const m of mappings) {
      if (m.issuerDomainPolicy === OID.ANY_POLICY || m.subjectDomainPolicy === OID.ANY_POLICY) {
        this.graph.setNull();
        this.error("policy mapping involves anyPolicy");
        return;
      }
    }
    if (this.policyMapping > 0) {
      for (const m of mappings) this.graph.addPolicyMapping(m.issuerDomainPolicy, m.subjectDomainPolicy);
    }
    if (this.policyMapping === 0) {
      for (const m of mappings) this.graph.deleteNode(m.issuerDomainPolicy);
    }
  }

  private applyPolicyConstraints(cert: ParsedCertificate): void {
    const pc = cert.policyConstraints;
    if (pc !== undefined) {
      if (pc.requireExplicitPolicy !== undefined && pc.requireExplicitPolicy < this.explicitPolicy) this.explicitPolicy = pc.requireExplicitPolicy;
      if (pc.inhibitPolicyMapping !== undefined && pc.inhibitPolicyMapping < this.policyMapping) this.policyMapping = pc.inhibitPolicyMapping;
    }
    if (cert.inhibitAnyPolicy !== undefined && cert.inhibitAnyPolicy < this.inhibitAnyPolicy) this.inhibitAnyPolicy = cert.inhibitAnyPolicy;
  }

  /** ProcessRootCertificate + ApplyTrustAnchorConstraints (anchor expiry is not enforced). */
  private processRoot(cert: ParsedCertificate): void {
    if (cert.policyOids !== undefined) this.verifyPolicies(cert, false);
    this.verifyPolicyMappings(cert);
    this.applyPolicyConstraints(cert);
    if (cert.keyUsage !== undefined && !keyUsageAsserts(cert.keyUsage, KEY_USAGE_BIT.KEY_CERT_SIGN)) this.error("keyCertSign not set");
    this.verifyEku(cert);
    if (cert.nameConstraints !== undefined) this.nameConstraints.push(cert.nameConstraints);
    if (cert.basicConstraints !== undefined) {
      if (!cert.basicConstraints.isCa) this.error("basicConstraints indicates not a CA");
      if (cert.basicConstraints.pathLen !== undefined) this.maxPathLength = cert.basicConstraints.pathLen;
    }
    this.verifyNoUnconsumedCritical(cert);
    this.workingIssuer = cert;
    this.workingKey = this.checkPublicKey(cert);
  }

  /** BasicCertificateProcessing. Returns true when verification of the rest of the path should stop. */
  private basicProcessing(cert: ParsedCertificate, isTarget: boolean): boolean {
    let shortCircuit = false;
    // RFC 5280 4.1.1.2 / 4.1.2.3: Certificate.signatureAlgorithm must match TBSCertificate.signature.
    if (!cert.signatureAlgorithmTlv.equals(cert.tbsSignatureAlgorithmTlv)) {
      const tbsAlg = parseAlg(cert.tbsSignatureAlgorithmTlv);
      if (cert.signatureAlgorithm === undefined || tbsAlg === undefined) {
        this.error("unacceptable signature algorithm");
        shortCircuit = true;
      } else if (!sameSignatureAlgorithm(cert.signatureAlgorithm, tbsAlg)) {
        this.error("signature algorithms do not match");
        shortCircuit = true;
      }
    }
    if (cert.signatureAlgorithm === undefined) {
      this.error("unacceptable signature algorithm");
      return true;
    }
    if (this.workingKey !== undefined) {
      if (!verifySignedData(cert.signatureAlgorithm, cert.tbsTlv, cert.signatureValue, this.workingKey)) {
        this.error("signature verification failed");
        shortCircuit = true;
      }
    } else {
      shortCircuit = true;
    }
    if (shortCircuit) return true;

    this.verifyTime(cert);
    if (!namesEqual(cert.normalizedIssuer, (this.workingIssuer as ParsedCertificate).normalizedSubject)) {
      this.error("subject does not match issuer");
    }
    if (this.nameConstraints.length > 0 && (!isSelfIssued(cert) || isTarget)) {
      for (const nc of this.nameConstraints) {
        if (!nc.isPermittedCert(cert.normalizedSubject, cert.subjectContent, cert.subjectAltNames)) this.error("not permitted by name constraints");
      }
    }
    this.verifyPolicies(cert, isTarget);
    this.verifyEku(cert);
    return false;
  }

  /** PrepareForNextCertificate (an intermediate). */
  private prepareForNext(cert: ParsedCertificate): void {
    this.verifyPolicyMappings(cert);
    this.workingIssuer = cert;
    this.workingKey = this.checkPublicKey(cert);
    if (cert.nameConstraints !== undefined) this.nameConstraints.push(cert.nameConstraints);
    if (!isSelfIssued(cert)) {
      if (this.explicitPolicy > 0) this.explicitPolicy -= 1;
      if (this.policyMapping > 0) this.policyMapping -= 1;
      if (this.inhibitAnyPolicy > 0) this.inhibitAnyPolicy -= 1;
    }
    this.applyPolicyConstraints(cert);
    if (cert.basicConstraints === undefined) this.error("missing basicConstraints");
    else if (!cert.basicConstraints.isCa) this.error("basicConstraints indicates not a CA");
    if (!isSelfIssued(cert)) {
      if (this.maxPathLength === 0) this.error("maximum path length violated");
      else this.maxPathLength -= 1;
    }
    if (cert.basicConstraints?.pathLen !== undefined && cert.basicConstraints.pathLen < this.maxPathLength) {
      this.maxPathLength = cert.basicConstraints.pathLen;
    }
    if (cert.keyUsage !== undefined && !keyUsageAsserts(cert.keyUsage, KEY_USAGE_BIT.KEY_CERT_SIGN)) this.error("keyCertSign not set");
    this.verifyNoUnconsumedCritical(cert);
  }

  /** WrapUp (the target). */
  private wrapUp(cert: ParsedCertificate): void {
    if (this.explicitPolicy > 0) this.explicitPolicy -= 1;
    if (cert.policyConstraints?.requireExplicitPolicy === 0) this.explicitPolicy = 0;
    this.verifyNoUnconsumedCritical(cert);
    if (this.explicitPolicy === 0 && this.graph.userConstrainedPolicySetIsEmpty()) this.error("no valid policy");
    // VerifyTargetCertIsNotCA is only a warning for CLIENT_AUTH.
    this.checkPublicKey(cert);
  }

  /** PathVerifier::Run for `path` ordered target first, trust anchor last. */
  run(path: ParsedCertificate[]): void {
    const n = path.length - 1;
    this.graph.init();
    this.explicitPolicy = n + 1;
    this.inhibitAnyPolicy = n + 1;
    this.policyMapping = n + 1;
    this.maxPathLength = n;
    for (let i = 0; i < path.length; i++) {
      const cert = path[path.length - i - 1] as ParsedCertificate;
      const isTarget = i === path.length - 1;
      if (i === 0) {
        this.processRoot(cert);
        continue;
      }
      if (this.basicProcessing(cert, isTarget)) return;
      if (!isTarget) this.prepareForNext(cert);
      else this.wrapUp(cert);
    }
  }
}

function parseAlg(bytes: Buffer) {
  try {
    return parseSignatureAlgorithm(new DerReader(bytes).read());
  } catch {
    return undefined;
  }
}

/** Verify one candidate path (target first, trust anchor last) at `time`. */
export function verifyCertificatePath(path: ParsedCertificate[], time: number, purpose: KeyPurpose): PathErrors {
  const errors: PathErrors = { messages: [], date: false };
  new PathVerifier(errors, time, purpose).run(path);
  return errors;
}

// --- Path building --------------------------------------------------------------------------------------------

export interface PathBuildResult {
  /** The first valid path, target first and the trust anchor last. */
  path: ParsedCertificate[] | undefined;
  /** Whether any candidate path reached a trust anchor (so failures are about the chain, not about trust). */
  reachedAnchor: boolean;
  /** Errors of the last anchored candidate that failed. */
  errors: PathErrors | undefined;
}

const MAX_PATH_DEPTH = 20;
const MAX_CANDIDATES = 1000;

/**
 * CertPathBuilder::Run: depth-first search from the target through the supplied intermediates (matched on normalized
 * issuer and subject names) to a trust anchor, verifying each complete candidate and stopping at the first valid one.
 */
export function buildAndVerifyPath(
  target: ParsedCertificate,
  intermediates: ParsedCertificate[],
  anchors: ParsedCertificate[],
  time: number,
  purpose: KeyPurpose,
): PathBuildResult {
  const result: PathBuildResult = { path: undefined, reachedAnchor: false, errors: undefined };
  let candidates = 0;

  const search = (path: ParsedCertificate[]): boolean => {
    if (candidates >= MAX_CANDIDATES || path.length > MAX_PATH_DEPTH) return false;
    const head = path[path.length - 1] as ParsedCertificate;
    for (const anchor of anchors) {
      if (!namesEqual(anchor.normalizedSubject, head.normalizedIssuer)) continue;
      if (path.some((c) => c.der.equals(anchor.der))) continue;
      candidates++;
      const full = [...path, anchor];
      result.reachedAnchor = true;
      const errors = verifyCertificatePath(full, time, purpose);
      if (errors.messages.length === 0) {
        result.path = full;
        return true;
      }
      result.errors = errors;
    }
    for (const candidate of intermediates) {
      if (!namesEqual(candidate.normalizedSubject, head.normalizedIssuer)) continue;
      if (path.some((c) => c.der.equals(candidate.der))) continue;
      if (anchors.some((a) => a.der.equals(candidate.der))) continue;
      if (search([...path, candidate])) return true;
    }
    return false;
  };

  search([target]);
  return result;
}
