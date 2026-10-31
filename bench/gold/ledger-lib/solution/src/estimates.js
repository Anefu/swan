// estimates — helpers for the estimates part of ledger-lib.
// Pure functions only: no I/O, no globals.
"use strict";

const MODULE = "estimates";
const DEFAULT_CURRENCY = "USD";
const MAX_OVERDUE_LISTED = 10;
const STATUSES = ["draft", "open", "paid", "void", "disputed"];

/**
 * Keep `n` within [lo, hi].
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Price after a percentage discount, e.g. applyDiscount(200, 25) is 150.
 * @param {number} price
 * @param {number} pct discount in percent
 * @returns {number}
 */
function applyDiscount(price, pct) {
  return price * (1 - pct / 100);
}

/**
 * URL-safe slug: lowercase words joined by dashes.
 * @param {string} s
 * @returns {string}
 */
function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A light syntax check for email addresses (not a deliverability check).
 * @param {string} s
 * @returns {boolean}
 */
function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

/**
 * Round half away from zero to a number of decimals (money is rounded to cents).
 * @param {number} value
 * @param {number} [decimals=2]
 * @returns {number}
 */
function roundTo(value, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * Mean of a list of numbers; 0 for an empty list.
 * @param {number[]} xs
 * @returns {number}
 */
function average(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Change from `a` to `b` in percent of `a`.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function percentChange(a, b) {
  return ((b - a) / a) * 100;
}

/**
 * One-screen summary of estimates records for the finance dashboard: counts by status, the
 * amount total, the largest record and a short list of overdue ids.
 * @param {{ id: string, status: string, amount: number, dueDate?: string }[]} records
 * @param {Date} [today]
 * @returns {{ count: number, byStatus: Record<string, number>, amount: number, largest?: string, overdue: string[] }}
 */
function summarize(records, today = new Date()) {
  const byStatus = {};
  let amount = 0;
  let largest;
  const overdue = [];
  for (const r of records) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (typeof r.amount === "number") amount += r.amount;
    if (!largest || r.amount > largest.amount) largest = r;
    if (r.dueDate && r.status !== "paid" && new Date(r.dueDate) < today) overdue.push(r.id);
  }
  return {
    count: records.length,
    byStatus,
    amount: Math.round(amount * 100) / 100,
    largest: largest?.id,
    overdue: overdue.slice(0, MAX_OVERDUE_LISTED),
  };
}

/**
 * Problems with one estimate record before it is saved; an empty list means it is valid.
 * Amounts are in the record's currency, at most two decimals, and never negative except for
 * adjustments.
 * @param {{ id?: string, status?: string, amount?: number, currency?: string, kind?: string }} record
 * @returns {string[]}
 */
function validate(record) {
  const problems = [];
  if (!record || typeof record !== "object") return [`${MODULE}: record must be an object`];
  if (!record.id || typeof record.id !== "string") problems.push(`${MODULE}: id is required`);
  if (!STATUSES.includes(record.status)) problems.push(`${MODULE}: unknown status ${JSON.stringify(record.status)}`);
  if (typeof record.amount !== "number" || Number.isNaN(record.amount)) {
    problems.push(`${MODULE}: amount must be a number`);
  } else {
    if (record.amount < 0 && record.kind !== "adjustment") problems.push(`${MODULE}: amount is negative`);
    if (Math.round(record.amount * 100) !== record.amount * 100) problems.push(`${MODULE}: amount has more than two decimals`);
  }
  const currency = record.currency ?? DEFAULT_CURRENCY;
  if (!/^[A-Z]{3}$/.test(currency)) problems.push(`${MODULE}: currency must be a three-letter code`);
  return problems;
}

module.exports = { clamp, applyDiscount, slugify, isValidEmail, roundTo, average, percentChange, summarize, validate, MODULE, DEFAULT_CURRENCY, STATUSES };
