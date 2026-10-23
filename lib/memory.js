/**
 * dsh-swarm — project experience memory.
 *
 * Keyed by PROJECT, not by session: a project's lessons outlive the session
 * that learned them. Three rules carry this store:
 *
 *   1. Only the memory keeper writes, and only after a fact check. The write
 *      gate is still the delete test: "would the next agent get this wrong?"
 *      If not, it does not belong here.
 *   2. Only the manager reads. Workers are never given a memory tool and never
 *      told that memory exists; the manager relays the few entries that would
 *      change how a line is executed.
 *   3. A wrong entry must be cheap to remove, and every entry carries the
 *      evidence and the moment it was verified.
 *
 * Files are plain JSON under `$DSH_HOME/swarm/memory/`: `index.json` is the
 * project registry and `<key>.json` holds one project's entries. Both are
 * written atomically and are readable/editable by a human.
 *
 * Pure Node, no dsh imports.
 *
 * @module dsh-swarm/memory
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MEMORY_VERSION = 1;
export const MEMORY_INDEX_FILE = "index.json";
export const MEMORY_KINDS = ["token", "gotcha", "recipe", "finding"];

const MAX_ENTRIES = 300;
const MAX_PROJECTS = 200;

/** Root of the memory store: `$DSH_HOME/swarm/memory`. */
export function defaultMemoryRoot(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME.trim() !== "" ? env.DSH_HOME : path.join(os.homedir(), ".dsh");
  return path.join(home, "swarm", "memory");
}

/**
 * Markers that identify a project root. A directory is a project when it holds
 * at least one marker; the walk keeps the OUTERMOST such directory so a
 * monorepo stays one project instead of fragmenting per package.
 *
 * Weak markers (a file whose mere existence proves nothing) must carry
 * content; `contentMin` is the minimum trimmed length.
 */
const PROJECT_MARKERS = [
  { name: ".git", kind: "any" },
  { name: ".hg", kind: "any" },
  { name: ".svn", kind: "any" },
  { name: ".jj", kind: "any" },
  { name: "p4config.txt", kind: "file", contentMin: 1 },
  { name: ".p4env", kind: "any" },
  { name: "package.json", kind: "file", contentMin: 2 },
  { name: "pnpm-workspace.yaml", kind: "file", contentMin: 1 },
  { name: "Cargo.toml", kind: "file", contentMin: 1 },
  { name: "go.mod", kind: "file", contentMin: 1 },
  { name: "pyproject.toml", kind: "file", contentMin: 1 },
  { name: "CMakeLists.txt", kind: "file", contentMin: 1 },
  { name: "Makefile", kind: "file", contentMin: 1 },
  { name: ".dsh", kind: "dir" },
];

const SKIP_WALK = new Set(["node_modules", ".git", "dist", "build", "out", "target", "vendor", ".venv", "venv"]);

function nowMs() {
  return Date.now();
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function num(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** Whether a directory is a user's home (never a project). */
export function isHomeDir(dir, env = process.env) {
  try {
    return path.resolve(dir) === path.resolve(os.homedir());
  } catch {
    return false;
  }
}

/** Whether one directory carries a project marker. */
function hasMarker(dir) {
  for (const marker of PROJECT_MARKERS) {
    const target = path.join(dir, marker.name);
    if (marker.kind === "dir") {
      if (isDir(target)) return true;
      continue;
    }
    if (marker.kind === "any") {
      try {
        fs.statSync(target);
        return true;
      } catch {
        continue;
      }
    }
    if (!isFile(target)) continue;
    try {
      const text = fs.readFileSync(target, "utf8");
      if (text.trim().length >= (marker.contentMin ?? 1)) return true;
    } catch {
      /* unreadable marker */
    }
  }
  return false;
}

/** The nearest ancestor (including `cwd`) carrying `.dsh/project.json` with a name. */
function namedProjectAt(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    const file = path.join(dir, ".dsh", "project.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const name = str(parsed && parsed.name).trim();
      if (name !== "") return { root: dir, name };
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The OUTERMOST directory at or above `cwd` that carries a project marker. */
export function resolveProjectRoot(cwd) {
  let dir;
  try {
    dir = path.resolve(cwd);
  } catch {
    return "";
  }
  if (!isDir(dir) || isHomeDir(dir)) return "";
  let found = "";
  let current = dir;
  for (;;) {
    if (hasMarker(current) && !isHomeDir(current)) found = current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return found;
}

/** A stable, readable project key: `<slug>-<short hash of the absolute root>`. */
export function projectKeyOf(root) {
  const resolved = path.resolve(root);
  const base = path.basename(resolved).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  let hash = 0;
  for (let index = 0; index < resolved.length; index += 1) {
    hash = (hash * 31 + resolved.charCodeAt(index)) >>> 0;
  }
  return (base + "-" + hash.toString(16).padStart(8, "0")).slice(0, 80);
}

/** Key for a directory that has no marker but was explicitly named as a project. */
function keyOfDirectory(dir) {
  return projectKeyOf(dir);
}

/**
 * Resolve a working directory to a project identity.
 * @returns {{key:string,root:string,name:string,cwd:string,reason:string}}
 */
export function resolveProjectIdentity(cwd, env = process.env) {
  const raw = typeof cwd === "string" ? cwd.trim() : "";
  if (raw === "" || !isDir(raw)) return { key: "", root: "", name: "", cwd: raw, reason: "no-cwd" };
  const named = namedProjectAt(raw);
  if (named !== null && !isHomeDir(named.root)) {
    return { key: projectKeyOf(named.root), root: named.root, name: named.name, cwd: raw, reason: "declared" };
  }
  const root = resolveProjectRoot(raw);
  if (root === "") return { key: "", root: "", name: "", cwd: raw, reason: "unidentified" };
  return { key: projectKeyOf(root), root, name: path.basename(root), cwd: raw, reason: "marker" };
}

/**
 * Resolve a directory the caller NAMED as a project. Naming a directory is
 * itself the statement "this is the project", so a directory without a marker
 * is accepted (filed under exactly that path). Naming a subdirectory of a known
 * project still lands on the project. A home directory is refused.
 */
export function resolveNamedProject(dir, env = process.env) {
  const raw = typeof dir === "string" ? dir.trim() : "";
  if (raw === "" || !isDir(raw)) return { key: "", root: "", name: "", cwd: raw, reason: "not-a-directory" };
  if (isHomeDir(raw)) return { key: "", root: "", name: "", cwd: raw, reason: "home" };
  const named = namedProjectAt(raw);
  if (named !== null && !isHomeDir(named.root)) {
    return { key: projectKeyOf(named.root), root: named.root, name: named.name, cwd: raw, reason: "declared" };
  }
  const root = resolveProjectRoot(raw);
  if (root !== "") return { key: projectKeyOf(root), root, name: path.basename(root), cwd: raw, reason: "marker" };
  return { key: keyOfDirectory(raw), root: raw, name: path.basename(raw), cwd: raw, reason: "named" };
}

/** Normalize one memory entry. */
export function normalizeEntry(raw, fallbackId = "") {
  const at = nowMs();
  return {
    id: str(raw.id, fallbackId || mintMemoryId()),
    title: str(raw.title),
    text: str(raw.text),
    kind: MEMORY_KINDS.includes(str(raw.kind)) ? str(raw.kind) : "finding",
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === "string" && tag.trim() !== "").map((tag) => tag.trim()) : [],
    evidence: str(raw.evidence),
    sourceLineId: str(raw.sourceLineId),
    sourceSessionId: str(raw.sourceSessionId),
    verifiedBy: str(raw.verifiedBy),
    verifiedAt: num(raw.verifiedAt),
    hits: num(raw.hits),
    createdAt: num(raw.createdAt, at),
    updatedAt: num(raw.updatedAt, at),
  };
}

function mintMemoryId() {
  return "m-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
}

/** Tokenize a query for scoring. Latin words plus single CJK characters. */
function queryTokens(query) {
  const text = str(query).toLowerCase();
  const words = text.split(/[^a-z0-9_]+/).filter((word) => word.length >= 2);
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).slice(0, 24);
  return [...new Set([...words, ...cjk])];
}

/**
 * Rank entries against a query. Title and tag hits outweigh body hits; an
 * entry that merely mentions a word is not as good as one named after it.
 */
export function rankEntries(entries, query = "", options = {}) {
  const tokens = queryTokens(query);
  const wantedKind = str(options.kind);
  const wantedTags = Array.isArray(options.tags) ? options.tags.map((tag) => String(tag).toLowerCase()) : [];
  const limit = Math.max(1, Math.min(200, num(options.limit, 10)));
  const matches = [];
  for (const entry of entries) {
    if (wantedKind !== "" && entry.kind !== wantedKind) continue;
    if (wantedTags.length > 0 && !wantedTags.every((tag) => entry.tags.some((own) => own.toLowerCase() === tag))) continue;
    const hits = [];
    let score = 0;
    if (tokens.length === 0) {
      score = 1;
    } else {
      const title = entry.title.toLowerCase();
      const text = entry.text.toLowerCase();
      const tags = entry.tags.map((tag) => tag.toLowerCase());
      const evidence = entry.evidence.toLowerCase();
      for (const token of tokens) {
        if (title.includes(token)) {
          score += 6;
          if (!hits.includes("title")) hits.push("title");
        }
        if (tags.some((tag) => tag.includes(token))) {
          score += 4;
          if (!hits.includes("tags")) hits.push("tags");
        }
        if (text.includes(token)) {
          score += 1;
          if (!hits.includes("text")) hits.push("text");
        }
        if (evidence.includes(token)) {
          score += 2;
          if (!hits.includes("evidence")) hits.push("evidence");
        }
      }
    }
    if (score === 0) continue;
    matches.push({ entry, score, hits });
  }
  matches.sort((left, right) => right.score - left.score || right.entry.hits - left.entry.hits || right.entry.updatedAt - left.entry.updatedAt);
  return { total: entries.length, matches: matches.slice(0, limit) };
}

function writeJsonAtomic(file, value) {
  const tmp = file + ".tmp-" + process.pid;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function normalizeProjectDocument(raw, key) {
  const source = isPlainObject(raw) ? raw : {};
  const entries = Array.isArray(source.entries)
    ? source.entries.filter(isPlainObject).map((entry) => normalizeEntry(entry)).filter((entry) => entry.title !== "" || entry.text !== "").slice(-MAX_ENTRIES)
    : [];
  return {
    version: MEMORY_VERSION,
    key: str(source.key, key),
    root: str(source.root),
    name: str(source.name),
    entries,
    createdAt: num(source.createdAt, nowMs()),
    updatedAt: num(source.updatedAt, nowMs()),
  };
}

function normalizeRegistry(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const projects = Array.isArray(source.projects)
    ? source.projects.filter(isPlainObject).map((project) => ({
        key: str(project.key),
        root: str(project.root),
        name: str(project.name),
        createdAt: num(project.createdAt),
        updatedAt: num(project.updatedAt),
        entries: num(project.entries),
      })).filter((project) => project.key !== "").slice(-MAX_PROJECTS)
    : [];
  return { version: MEMORY_VERSION, projects };
}

/**
 * The project memory store.
 *
 * `remember` is the only write path; `recall` never throws for an unknown
 * project (it answers "nothing here yet"), and a write is refused when the
 * project cannot be identified — guessing files a session's lessons under
 * somebody else's project.
 */
export function createMemoryStore(options = {}) {
  const root = options.root ?? defaultMemoryRoot();
  const logger = typeof options.logger === "function" ? options.logger : () => {};
  /** key -> pending hit increments, flushed with the next write. */
  const pendingHits = new Map();

  function indexFile() {
    return path.join(root, MEMORY_INDEX_FILE);
  }

  function projectFile(key) {
    return path.join(root, key + ".json");
  }

  function readRegistry() {
    return normalizeRegistry(readJson(indexFile()));
  }

  function writeRegistry(registry) {
    writeJsonAtomic(indexFile(), registry);
  }

  function touchRegistry(identity, count) {
    const registry = readRegistry();
    const at = nowMs();
    const existing = registry.projects.find((project) => project.key === identity.key);
    if (existing === undefined) {
      registry.projects.push({
        key: identity.key,
        root: identity.root,
        name: identity.name || path.basename(identity.root),
        createdAt: at,
        updatedAt: at,
        entries: count,
      });
    } else {
      existing.root = identity.root || existing.root;
      existing.name = identity.name || existing.name;
      existing.updatedAt = at;
      existing.entries = count;
    }
    if (registry.projects.length > MAX_PROJECTS) registry.projects.splice(0, registry.projects.length - MAX_PROJECTS);
    writeRegistry(registry);
  }

  function readDocument(identity) {
    const key = str(identity.key);
    if (key === "") return null;
    const doc = normalizeProjectDocument(readJson(projectFile(key)), key);
    if (doc.root === "" && str(identity.root) !== "") doc.root = identity.root;
    if (doc.name === "" && str(identity.name) !== "") doc.name = identity.name;
    return doc;
  }

  function writeDocument(identity, doc) {
    const key = str(identity.key);
    if (key === "") throw new Error("cannot write memory without a project identity");
    doc.key = key;
    doc.root = doc.root || str(identity.root);
    doc.name = doc.name || str(identity.name);
    doc.updatedAt = nowMs();
    // Flush pending recall hits: a read is just a read everywhere else, and
    // rewriting the document on every recall would turn orientation into a
    // disk write.
    const pending = pendingHits.get(key);
    if (pending !== undefined) {
      for (const entry of doc.entries) {
        const bump = pending.get(entry.id);
        if (bump !== undefined) entry.hits += bump;
      }
      pendingHits.delete(key);
    }
    writeJsonAtomic(projectFile(key), doc);
    touchRegistry({ key, root: doc.root, name: doc.name }, doc.entries.length);
    return doc;
  }

  function projectIdentity(project) {
    const key = str(project && project.key).trim();
    if (key === "") return null;
    const root = str(project && project.root);
    if (root !== "") return { key, root, name: str(project.name, path.basename(root)) };
    const registry = readRegistry();
    const known = registry.projects.find((entry) => entry.key === key);
    if (known !== undefined) return { key, root: known.root, name: known.name };
    // A key with no root must already exist on disk; re-deriving a key FROM a
    // key silently files writes into a document nobody reads.
    const doc = readJson(projectFile(key));
    if (doc === null) throw new Error(`unknown project key: ${key} — pass the absolute project path instead`);
    return { key, root: str(doc.root), name: str(doc.name) };
  }

  function pruneEntries(doc) {
    if (doc.entries.length <= MAX_ENTRIES) return 0;
    const overflow = doc.entries.length - MAX_ENTRIES;
    const sorted = [...doc.entries].sort((left, right) => left.hits - right.hits || left.updatedAt - right.updatedAt);
    const drop = new Set(sorted.slice(0, overflow).map((entry) => entry.id));
    doc.entries = doc.entries.filter((entry) => !drop.has(entry.id));
    return drop.size;
  }

  return {
    root,

    /** Whether the store can name a project from a cwd. */
    resolveIdentity(cwd) {
      return resolveProjectIdentity(cwd);
    },

    /** Resolve a directory (or key) the caller explicitly named. */
    resolveNamed(name) {
      const wanted = str(name).trim();
      if (wanted === "") return { key: "", root: "", name: "", cwd: "", reason: "empty" };
      const registry = readRegistry();
      const byKey = registry.projects.find((project) => project.key === wanted);
      if (byKey !== undefined) return { key: byKey.key, root: byKey.root, name: byKey.name, cwd: "", reason: "explicit-key" };
      return resolveNamedProject(wanted);
    },

    /** Whether a project holds any entries (the bootstrap trigger). */
    isEmpty(project) {
      const identity = projectIdentity(project);
      if (identity === null) return true;
      const doc = readDocument(identity);
      return doc === null || doc.entries.length === 0;
    },

    /** The project registry. */
    projects() {
      return readRegistry().projects;
    },

    /** Entry index for one project (no bodies). */
    list(project, options = {}) {
      const identity = projectIdentity(project);
      if (identity === null) return { project: null, total: 0, matches: [] };
      const doc = readDocument(identity);
      const entries = doc === null ? [] : doc.entries;
      const limit = Math.max(1, Math.min(200, num(options.limit, 60)));
      const sorted = [...entries].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
      return {
        project: { key: identity.key, root: identity.root, name: identity.name },
        total: entries.length,
        matches: sorted.map((entry) => ({ entry })),
      };
    },

    /** Full-text recall, ranking title/tags/evidence above body. */
    recall(project, options = {}) {
      const identity = projectIdentity(project);
      if (identity === null) return { project: null, total: 0, matches: [] };
      const doc = readDocument(identity);
      const entries = doc === null ? [] : doc.entries;
      const found = rankEntries(entries, options.query, options);
      if (found.matches.length > 0) {
        const pending = pendingHits.get(identity.key) ?? new Map();
        for (const match of found.matches) {
          pending.set(match.entry.id, (pending.get(match.entry.id) ?? 0) + 1);
        }
        pendingHits.set(identity.key, pending);
      }
      return { project: { key: identity.key, root: identity.root, name: identity.name }, ...found };
    },

    /** One project's document, as read from disk. */
    view(project) {
      const identity = projectIdentity(project);
      if (identity === null) return null;
      return readDocument(identity);
    },

    /**
     * Write or update one entry. The caller (the memory keeper) has already
     * verified the facts; `verifiedBy` and `verifiedAt` are recorded here so a
     * later reader can tell a checked fact from a remembered guess.
     */
    remember(project, input = {}) {
      const identity = projectIdentity(project);
      if (identity === null) throw new Error("cannot write memory: no project identity (name the project path explicitly)");
      const doc = readDocument(identity);
      const document = doc === null
        ? { version: MEMORY_VERSION, key: identity.key, root: identity.root, name: identity.name, entries: [], createdAt: nowMs(), updatedAt: nowMs() }
        : doc;
      const title = str(input.title).trim();
      const text = str(input.text).trim();
      const id = str(input.id).trim();
      let entry = id !== "" ? document.entries.find((item) => item.id === id) : undefined;
      if (entry === undefined && title !== "") {
        entry = document.entries.find((item) => item.title.toLowerCase() === title.toLowerCase());
      }
      const at = nowMs();
      const created = entry === undefined;
      if (entry === undefined) {
        if (title === "" || text === "") throw new Error("a new memory entry needs both a title and a body");
        entry = normalizeEntry({ id: mintMemoryId(), title, text, createdAt: at, updatedAt: at });
        document.entries.push(entry);
      }
      if (input.title !== undefined && str(input.title).trim() !== "") entry.title = str(input.title).trim();
      if (input.text !== undefined && str(input.text).trim() !== "") entry.text = str(input.text).trim();
      if (input.kind !== undefined) entry.kind = MEMORY_KINDS.includes(str(input.kind)) ? str(input.kind) : entry.kind;
      if (input.tags !== undefined) entry.tags = Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).trim()).filter((tag) => tag !== "") : [];
      if (input.evidence !== undefined) entry.evidence = str(input.evidence);
      if (input.sourceLineId !== undefined) entry.sourceLineId = str(input.sourceLineId);
      if (input.sourceSessionId !== undefined) entry.sourceSessionId = str(input.sourceSessionId);
      if (input.verifiedBy !== undefined) entry.verifiedBy = str(input.verifiedBy);
      if (input.verifiedAt !== undefined) entry.verifiedAt = num(input.verifiedAt, at);
      entry.updatedAt = at;
      const pruned = pruneEntries(document);
      writeDocument(identity, document);
      return { created, entry, document, pruned };
    },

    /** Delete one entry by id. */
    forget(project, input = {}) {
      const identity = projectIdentity(project);
      if (identity === null) throw new Error("cannot forget: no project identity");
      const doc = readDocument(identity);
      if (doc === null) throw new Error("this project has no memory yet");
      const id = str(input.id).trim();
      const before = doc.entries.length;
      doc.entries = doc.entries.filter((entry) => entry.id !== id);
      if (doc.entries.length === before) throw new Error(`unknown memory entry: ${id}`);
      writeDocument(identity, doc);
      return { removed: 1, remaining: doc.entries.length };
    },
  };
}
