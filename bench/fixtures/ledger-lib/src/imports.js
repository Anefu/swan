// imports — helpers for the imports part of ledger-lib.
// Pure functions only: no I/O, no globals.
"use strict";

const MODULE = "imports";
const DEFAULT_CURRENCY = "USD";
const MAX_OVERDUE_LISTED = 10;
const STATUSES = ["draft", "open", "paid", "void", "disputed"];

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
 * Median of a list of numbers; undefined for an empty list.
 * @param {number[]} xs
 * @returns {number | undefined}
 */
function median(xs) {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The item with the largest `field`, or undefined for an empty list.
 * @param {object[]} items
 * @param {string} field
 * @returns {object | undefined}
 */
function maxBy(items, field) {
  let best;
  for (const item of items) {
    if (!best || item[field] > best[field]) best = item;
  }
  return best;
}

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
 * Display an amount held in cents, e.g. formatCents(1234, "USD") is "USD 12.34".
 * @param {number} cents
 * @param {string} currency
 * @returns {string}
 */
function formatCents(cents, currency) {
  return `${currency} ${(cents / 100).toFixed(2)}`;
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
 * One-screen summary of imports records for the finance dashboard: counts by status, the
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
 * Problems with one import record before it is saved; an empty list means it is valid.
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

module.exports = { average, median, maxBy, clamp, applyDiscount, formatCents, slugify, summarize, validate, MODULE, DEFAULT_CURRENCY, STATUSES };
