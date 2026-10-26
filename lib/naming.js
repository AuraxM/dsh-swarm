/**
 * Human-readable names and content-derived identifiers.
 *
 * Display titles stay verbatim (apart from whitespace and length). Identifiers
 * use the same words so an id that leaks into a tool result still names the
 * work. A numeric suffix, never a random token, resolves collisions.
 *
 * @module dsh-swarm/naming
 */

/** Normalize one human-readable summary title without destroying CJK text. */
export function summaryTitle(value, fallback = "", maxLength = 80) {
  const limit = Number.isSafeInteger(maxLength) && maxLength > 1 ? maxLength : 80;
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  const text = normalized || String(fallback ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1).trimEnd() + "…";
}

/** Turn free text into an id-safe, Unicode-aware summary slug. */
export function slugify(value, maxWords = 4) {
  return summaryTitle(value, "", 160)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, maxWords)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

/** A readable id with deterministic numeric collision suffixes. */
export function readableId(prefix, title, existing = new Set(), fallback = "item") {
  const base = String(prefix) + "-" + (slugify(title) || slugify(fallback) || "item");
  let id = base;
  for (let suffix = 2; existing.has(id); suffix += 1) id = base + "-" + suffix;
  return id;
}
