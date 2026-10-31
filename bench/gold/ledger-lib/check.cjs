// Hidden checks for the ledger-lib case. Run from the workspace root inside the check container.
"use strict";
const assert = require("node:assert");
const path = require("node:path");

const BUGS = [
  ["assets", "applyDiscount", (m) => m.applyDiscount(200, 25), 150],
  ["bundles", "average", (m) => m.average([]), 0],
  ["credit-notes", "percentChange", (m) => m.percentChange(50, 75), 50],
  ["estimates", "clamp", (m) => m.clamp(5, 0, 10), 5],
  ["fees", "taxFor", (m) => m.taxFor(100, 0.2), 20],
  ["leases", "maxBy", (m) => m.maxBy([{ v: 1 }, { v: 5 }, { v: 3 }], "v"), { v: 5 }],
  ["loans", "daysBetween", (m) => m.daysBetween(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-11T00:00:00Z")), 10],
  ["projects", "total", (m) => m.total([{ amount: 1 }, { amount: 2 }, { amount: 3 }], "amount"), 6],
  ["purchase-orders", "weightedAverage", (m) => m.weightedAverage([10, 20], [1, 3]), 17.5],
  ["subscriptions", "paginate", (m) => m.paginate([1, 2, 3, 4, 5, 6, 7], 1, 3), [1, 2, 3]],
  ["timesheets", "formatCents", (m) => m.formatCents(1234, "USD"), "USD 12.34"],
  ["warehouses", "roundTo", (m) => m.roundTo(1.237, 2), 1.24],
];
const KEEP = [
  ["contracts", "chunk", (m) => m.chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]],
  ["imports", "maxBy", (m) => m.maxBy([{ v: 1 }, { v: 5 }, { v: 3 }], "v"), { v: 5 }],
  ["carts", "formatCents", (m) => m.formatCents(1234, "USD"), "USD 12.34"],
  ["dashboards", "taxFor", (m) => m.taxFor(100, 0.2), 20],
  ["depreciation", "addDays", (m) => m.addDays(new Date("2026-01-01T00:00:00Z"), 2).toISOString(), "2026-01-03T00:00:00.000Z"],
  ["disputes", "slugify", (m) => m.slugify("  Hello, World!  "), "hello-world"],
  ["banking", "groupBy", (m) => m.groupBy([{ k: "a" }, { k: "b" }, { k: "a" }], "k"), { a: [{ k: "a" }, { k: "a" }], b: [{ k: "b" }] }],
  ["collections", "unique", (m) => m.unique([1, 1, 2, 3, 2]), [1, 2, 3]],
  ["payroll", "unique", (m) => m.unique([1, 1, 2, 3, 2]), [1, 2, 3]],
  ["payouts", "clamp", (m) => m.clamp(5, 0, 10), 5],
  ["shipping", "maxBy", (m) => m.maxBy([{ v: 1 }, { v: 5 }, { v: 3 }], "v"), { v: 5 }],
  ["reconciliation", "total", (m) => m.total([{ amount: 1 }, { amount: 2 }, { amount: 3 }], "amount"), 6],
];
const REQUIRED = 9;

function holds([file, fn, call, expected]) {
  try {
    const m = require(path.resolve("src", `${file}.js`));
    assert.deepStrictEqual(call(m), expected);
    return true;
  } catch {
    return false;
  }
}

const fixed = BUGS.filter(holds);
const broken = KEEP.filter((k) => !holds(k));
const missed = BUGS.filter((b) => !fixed.includes(b)).map(([f, fn]) => `${f}.${fn}`);
console.log(`fixed ${fixed.length}/${BUGS.length}; broke ${broken.length}/${KEEP.length}${missed.length ? `; missed ${missed.join(", ")}` : ""}`);
process.exit(fixed.length >= REQUIRED && broken.length === 0 ? 0 : 1);
