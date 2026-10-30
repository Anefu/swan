import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import forge from "node-forge";
import { paths } from "../settings.js";
import { exists, writeFileAtomic } from "../util.js";

const newRsaKey = () =>
  forge.pki.privateKeyFromPem(
    generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }) as string,
  ) as forge.pki.rsa.PrivateKey;

const serial = () => "01" + randomBytes(15).toString("hex"); // positive, 128-bit

/**
 * Local CA used only to terminate TLS for hosts that need credential injection.
 * The CA cert is baked into the sandbox image; the key never leaves PH_HOME/ca.
 */
export class CertAuthority {
  private cache = new Map<string, tls.SecureContext>();
  private leafKey = newRsaKey();
  private leafKeyPem = forge.pki.privateKeyToPem(this.leafKey);

  private constructor(
    private caCert: forge.pki.Certificate,
    private caKey: forge.pki.rsa.PrivateKey,
    readonly certPem: string,
  ) {}

  static async load(): Promise<CertAuthority> {
    const certFile = path.join(paths.ca, "ca.crt");
    const keyFile = path.join(paths.ca, "ca.key");
    if ((await exists(certFile)) && (await exists(keyFile))) {
      const certPem = await fs.readFile(certFile, "utf8");
      const cert = forge.pki.certificateFromPem(certPem);
      const key = forge.pki.privateKeyFromPem(await fs.readFile(keyFile, "utf8")) as forge.pki.rsa.PrivateKey;
      if (cert.validity.notAfter.getTime() > Date.now() + 30 * 86400_000) return new CertAuthority(cert, key, certPem);
    }
    const key = newRsaKey();
    const cert = forge.pki.createCertificate();
    cert.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 86400_000);
    cert.validity.notAfter = new Date(Date.now() + 5 * 365 * 86400_000);
    const subject = [
      { name: "commonName", value: "persona-harness local egress CA" },
      { name: "organizationName", value: "persona-harness" },
    ];
    cert.setSubject(subject);
    cert.setIssuer(subject);
    cert.setExtensions([
      { name: "basicConstraints", cA: true, critical: true, pathLenConstraint: 0 },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      { name: "subjectKeyIdentifier" },
    ]);
    cert.sign(key, forge.md.sha256.create());
    const certPem = forge.pki.certificateToPem(cert);
    await writeFileAtomic(keyFile, forge.pki.privateKeyToPem(key), 0o600);
    await writeFileAtomic(certFile, certPem, 0o644);
    return new CertAuthority(cert, key, certPem);
  }

  /** Short fingerprint, used to tag the sandbox image so a new CA forces a rebuild. */
  get fingerprint(): string {
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(this.caCert)).getBytes();
    return createHash("sha256").update(Buffer.from(der, "binary")).digest("hex").slice(0, 12);
  }

  contextFor(host: string): tls.SecureContext {
    const hit = this.cache.get(host);
    if (hit) return hit;
    const cert = forge.pki.createCertificate();
    cert.publicKey = forge.pki.setRsaPublicKey(this.leafKey.n, this.leafKey.e);
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 86400_000);
    cert.validity.notAfter = new Date(Date.now() + 300 * 86400_000);
    cert.setSubject([{ name: "commonName", value: host }]);
    cert.setIssuer(this.caCert.subject.attributes);
    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [net.isIP(host) ? { type: 7, ip: host } : { type: 2, value: host }] },
    ]);
    cert.sign(this.caKey, forge.md.sha256.create());
    const ctx = tls.createSecureContext({
      key: this.leafKeyPem,
      cert: forge.pki.certificateToPem(cert) + this.certPem,
    });
    this.cache.set(host, ctx);
    return ctx;
  }
}
