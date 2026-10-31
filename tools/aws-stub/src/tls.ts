import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** A throwaway CA and a certificate for 127.0.0.1, localhost and `names` (e.g. "*.aws.test"), made with openssl. */
export function makeTls(names: string[] = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "swan-aws-stub-"));
  const f = (n: string) => path.join(dir, n);
  const ssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "pipe" });
  ssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "7", "-subj", "/CN=Swan AWS stub CA", "-keyout", f("ca.key"), "-out", f("ca.pem"), "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  ssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", f("server.key"), "-out", f("server.csr"));
  const san = ["IP:127.0.0.1", "DNS:localhost", ...names.map((n) => `DNS:${n}`)].join(",");
  writeFileSync(f("ext.cnf"), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`);
  ssl("x509", "-req", "-in", f("server.csr"), "-CA", f("ca.pem"), "-CAkey", f("ca.key"), "-CAcreateserial", "-days", "7", "-extfile", f("ext.cnf"), "-out", f("server.pem"));
  return { key: readFileSync(f("server.key"), "utf8"), cert: readFileSync(f("server.pem"), "utf8"), ca: readFileSync(f("ca.pem"), "utf8"), caFile: f("ca.pem") };
}
