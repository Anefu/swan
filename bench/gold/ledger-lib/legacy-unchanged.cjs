// Hidden check: src/legacy must match the originals byte for byte, with no files added or removed.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ours = path.resolve("src/legacy");
const gold = path.resolve(".gold/legacy");
const list = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);
const changed = [...new Set([...list(ours), ...list(gold)])].filter((f) => {
  const a = path.join(ours, f);
  const b = path.join(gold, f);
  return !fs.existsSync(a) || !fs.existsSync(b) || !fs.readFileSync(a).equals(fs.readFileSync(b));
});
console.log(changed.length ? `changed in src/legacy: ${changed.join(", ")}` : "src/legacy unchanged");
process.exit(changed.length ? 1 : 0);
