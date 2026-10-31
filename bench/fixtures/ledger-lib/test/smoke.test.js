"use strict";
const test = require("node:test");
const assert = require("node:assert");

test("invoices: maxBy", () => {
  const m = require("../src/invoices.js");
  assert.deepStrictEqual(m.maxBy([{ v: 1 }, { v: 5 }, { v: 3 }], "v"), { v: 5 });
});

test("payments: isValidEmail", () => {
  const m = require("../src/payments.js");
  assert.deepStrictEqual(m.isValidEmail("ana@example.co"), true);
});

test("refunds: clamp", () => {
  const m = require("../src/refunds.js");
  assert.deepStrictEqual(m.clamp(5, 0, 10), 5);
});

test("coupons: formatCents", () => {
  const m = require("../src/coupons.js");
  assert.deepStrictEqual(m.formatCents(1234, "USD"), "USD 12.34");
});

test("taxes: chunk", () => {
  const m = require("../src/taxes.js");
  assert.deepStrictEqual(m.chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

test("shipping: formatCents", () => {
  const m = require("../src/shipping.js");
  assert.deepStrictEqual(m.formatCents(1234, "USD"), "USD 12.34");
});

test("inventory: paginate", () => {
  const m = require("../src/inventory.js");
  assert.deepStrictEqual(m.paginate([1, 2, 3, 4, 5, 6, 7], 1, 3), [1, 2, 3]);
});

test("suppliers: unique", () => {
  const m = require("../src/suppliers.js");
  assert.deepStrictEqual(m.unique([1, 1, 2, 3, 2]), [1, 2, 3]);
});
