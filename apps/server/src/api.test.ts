import { describe, expect, it } from "vitest";
import { hostAllowed, originAllowed } from "./api.js";

describe("API guards", () => {
  it("accepts only loopback Host names (DNS rebinding)", () => {
    for (const h of ["127.0.0.1:4317", "localhost:4317", "[::1]:4317", "127.0.0.1"]) expect(hostAllowed(h)).toBe(true);
    for (const h of [undefined, "", "evil.example", "evil.example:4317", "127.0.0.1.evil.example", "localhost.evil.example:4317"]) expect(hostAllowed(h)).toBe(false);
  });

  it("accepts the app's pages and local development pages, nothing else (CSRF)", () => {
    for (const o of [undefined, "swan://app", "http://127.0.0.1:4317", "http://localhost:5173"]) expect(originAllowed(o)).toBe(true);
    for (const o of ["null", "https://evil.example", "http://127.0.0.1.evil.example", "swan://app.evil", "swan://other", "file://", "chrome-extension://abc"])
      expect(originAllowed(o)).toBe(false);
  });
});
