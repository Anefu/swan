// loans — helpers for the loans part of ledger-lib.
// Pure functions only: no I/O, no globals.
"use strict";

const MODULE = "loans";
const DEFAULT_CURRENCY = "USD";
const MAX_OVERDUE_LISTED = 10;
const STATUSES = ["draft", "open", "paid", "void", "disputed"];

/**
 * A light syntax check for email addresses (not a deliverability check).
 * @param {string} s
 * @returns {boolean}
 */
function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

/**
 * Weighted mean: sum(value * weight) / sum(weight).
 * @param {number[]} values
 * @param {number[]} weights
 * @returns {number}
 */
function weightedAverage(values, weights) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i++) {
    num += values[i] * weights[i];
    den += weights[i];
  }
  return den ? num / den : 0;
}

/**
 * Whole days from `a` to `b` (negative when `b` is earlier).
 * @param {Date} a
 * @param {Date} b
 * @returns {number}
 */
function daysBetween(a, b) {
  const MS_PER_DAY = 8640000;
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/**
 * Split `xs` into consecutive groups of `n`; the last group may be shorter.
 * @param {any[]} xs
 * @param {number} n
 * @returns {any[][]}
 */
function chunk(xs, n) {
  const out = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Distinct values, in first-seen order.
 * @param {any[]} xs
 * @returns {any[]}
 */
function unique(xs) {
  return [...new Set(xs)];
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
 * One page of `items`. Pages are numbered from 1.
 * @param {any[]} items
 * @param {number} page
 * @param {number} size
 * @returns {any[]}
 */
function paginate(items, page, size) {
  const start = (page - 1) * size;
  return items.slice(start, start + size);
}

/**
 * One-screen summary of loans records for the finance dashboard: counts by status, the
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
 * Problems with one loan record before it is saved; an empty list means it is valid.
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

module.exports = { isValidEmail, weightedAverage, daysBetween, chunk, unique, applyDiscount, paginate, summarize, validate, MODULE, DEFAULT_CURRENCY, STATUSES };
