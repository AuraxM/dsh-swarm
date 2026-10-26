/**
 * dsh-swarm — durable mission store.
 *
 * One board per manager session. A board is the machine-written picture of a
 * swarm project:
 *
 *   - lines:   one user request per line, carrying its expert, its optional
 *              verifier, the verification rounds, the reports and the verdicts;
 *   - roles:   every agent the engine started for this project, with its role,
 *              its line, its domain and whether it stays resident across lines;
 *   - domains: the routing registry: one domain name/responsibility per owner
 *              expert, so a later request in the same domain reuses that expert;
 *   - messages: the universal message bus transcript;
 *   - memoryRequests: write requests waiting for the memory keeper's fact check;
 *   - decisions: manager rulings that would otherwise live only in a transcript;
 *   - resources: exclusive leases the manager grants to lines;
 *   - events:  an append-only revision log powering `swarm_status mode=delta`.
 *
 * This module is pure Node and imports nothing from dsh, so it stays
 * standalone-testable and install-safe no matter how the package is linked.
 *
 * @module dsh-swarm/store
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMemoryStore, defaultMemoryRoot } from "./memory.js";
import { readableId, summaryTitle } from "./naming.js";

export { slugify } from "./naming.js";

const DEFAULT_BOARD_TITLE = "Swarm project";

/** Board document schema version. v3: domain registry and persistent experts. */
export const BOARD_VERSION = 3;

/** Line lifecycle states. `blocked` is recoverable; `done` and `cancelled` are terminal. */
export const LINE_STATUS = ["waiting", "working", "verifying", "reworking", "done", "blocked", "cancelled"];

/** Terminal line states. */
export const TERMINAL_STATUS = new Set(["done", "cancelled"]);

/** Roles a board may contain. The manager is depth 0 and is recorded too. */
export const ROLE = ["manager", "expert", "verifier", "memory"];

/** Message bus kinds. Structured lifecycle events are `report` and `verdict`. */
export const MESSAGE_KIND = ["report", "question", "answer", "request", "fyi", "escalation", "verdict", "memory"];

/** Memory entry kinds (kept in sync with lib/memory.js). */
export const MEMORY_KIND = ["token", "gotcha", "recipe", "finding"];

const MAX_MESSAGES = 600;
const MAX_EVENTS = 800;
const MAX_REQUESTS = 200;
const MAX_DECISIONS = 200;
const MAX_REPORTS = 20;
const MAX_VERDICTS = 50;

/** Plugin settings live beside the board directories. */
export const SETTINGS_FILE = "settings.json";

/** Default settings. Role routes start empty: unconfigured means "inherit". */
export function defaultSettings() {
  return {
    version: 1,
    // Role children alive at once (expert + verifier + memory). The runtime's
    // own cap is per activation tree and defaults to 8; stay below it so an
    // expert can still start helpers of its own.
    maxConcurrent: 6,
    // "auto" means a development line gets a verifier and a pure research line
    // does not; the manager may override per line.
    verifier: "auto",
    roles: {
      expert: { provider: "", model: "", reasoningEffort: "" },
      verifier: { provider: "", model: "", reasoningEffort: "" },
      memory: { provider: "", model: "", reasoningEffort: "" },
    },
    updatedAt: 0,
    updatedBy: "",
  };
}

/** Board root: `$DSH_HOME/swarm` (default `~/.dsh/swarm`). */
export function defaultRoot(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME.trim() !== "" ? env.DSH_HOME : path.join(os.homedir(), ".dsh");
  return path.join(home, "swarm");
}

/** Internal correlation id only; never use this value as a display title. */
export function mintId(prefix) {
  return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
}

/** A readable, unique line id: L-<domain or title slug>[-n]. */
function lineIdFor(board, input) {
  const seats = Array.isArray(input.experts) ? input.experts : [];
  const domain = str(input.domainId) || str(seats[0] === undefined ? "" : seats[0].domain);
  return readableId("L", domain || input.title, new Set(Object.keys(board.lines)), "line");
}

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

function bool(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function strArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item !== "") : [];
}

/** Clamp a session id to something safe as one directory name. */
export function safeBoardId(sessionId) {
  const cleaned = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "board" : cleaned.slice(0, 120);
}

/** One expert seat on a line. `status` tracks the collaboration, not the runtime. */
function normalizeExpert(raw, index) {
  const source = isPlainObject(raw) ? raw : {};
  const status = ["pending", "running", "reported", "retired"].includes(str(source.status)) ? str(source.status) : "pending";
  return {
    sessionId: str(source.sessionId),
    label: str(source.label, str(source.name, "Expert " + (index + 1))),
    domain: str(source.domain, str(source.domainId)),
    focus: str(source.focus, str(source.brief)),
    status,
    reused: source.reused === true,
    startedAt: num(source.startedAt),
    reportedAt: num(source.reportedAt),
    promptAt: num(source.promptAt),
  };
}

/** An empty line document. */
export function emptyLine(id, input = {}) {
  const at = nowMs();
  const experts = Array.isArray(input.experts) && input.experts.length > 0
    ? input.experts.map(normalizeExpert)
    : [normalizeExpert({ label: str(input.expertLabel, "Expert"), domain: str(input.domainId), focus: "" }, 0)];
  return {
    id,
    title: str(input.title, id),
    request: str(input.request, str(input.title, id)),
    acceptance: str(input.acceptance),
    boundaries: str(input.boundaries),
    kind: str(input.kind, "task"),
    status: LINE_STATUS.includes(str(input.status)) ? str(input.status) : "waiting",
    verifierPolicy: ["auto", "required", "none"].includes(str(input.verifierPolicy)) ? str(input.verifierPolicy) : "auto",
    useVerifier: bool(input.useVerifier, true),
    experts,
    verifierId: "",
    memoryIds: strArray(input.memoryIds),
    round: 0,
    reports: [],
    verdicts: [],
    blockedReason: "",
    createdAt: at,
    updatedAt: at,
    startedAt: 0,
    endedAt: 0,
    lastActivityAt: at,
  };
}

function normalizeReport(raw) {
  if (!isPlainObject(raw)) return null;
  return {
    at: num(raw.at, nowMs()),
    sessionId: str(raw.sessionId),
    summary: str(raw.summary),
    artifacts: strArray(raw.artifacts),
    evidence: str(raw.evidence),
    blockers: str(raw.blockers),
    facts: strArray(raw.facts),
    questions: strArray(raw.questions),
  };
}

function normalizeCriterion(raw) {
  if (!isPlainObject(raw)) return null;
  return {
    criterion: str(raw.criterion),
    passed: raw.passed === true,
    evidence: str(raw.evidence),
    owner: str(raw.owner),
  };
}

function normalizeVerdict(raw) {
  if (!isPlainObject(raw)) return null;
  const criteria = Array.isArray(raw.criteria) ? raw.criteria.map(normalizeCriterion).filter((item) => item !== null) : [];
  return {
    at: num(raw.at, nowMs()),
    sessionId: str(raw.sessionId),
    round: num(raw.round, 0),
    pass: raw.pass === true,
    criteria,
    failures: strArray(raw.failures),
    notes: str(raw.notes),
    recheck: str(raw.recheck),
    signature: str(raw.signature),
  };
}

function normalizeLine(id, raw) {
  const line = emptyLine(id, raw);
  line.title = str(raw.title, line.title);
  line.request = str(raw.request, line.request);
  line.acceptance = str(raw.acceptance);
  line.boundaries = str(raw.boundaries);
  line.kind = str(raw.kind, line.kind);
  line.status = LINE_STATUS.includes(str(raw.status)) ? str(raw.status) : "waiting";
  line.verifierPolicy = ["auto", "required", "none"].includes(str(raw.verifierPolicy)) ? str(raw.verifierPolicy) : "auto";
  line.useVerifier = bool(raw.useVerifier, line.verifierPolicy !== "none");
  if (Array.isArray(raw.experts) && raw.experts.length > 0) {
    line.experts = raw.experts.map(normalizeExpert);
  } else if (str(raw.expertId) !== "") {
    line.experts = [normalizeExpert({ sessionId: str(raw.expertId), label: "Expert", status: "running" }, 0)];
  }
  line.verifierId = str(raw.verifierId);
  line.memoryIds = strArray(raw.memoryIds);
  line.round = num(raw.round, 0);
  line.blockedReason = str(raw.blockedReason);
  line.createdAt = num(raw.createdAt, line.createdAt);
  line.updatedAt = num(raw.updatedAt, line.updatedAt);
  line.startedAt = num(raw.startedAt);
  line.endedAt = num(raw.endedAt);
  line.lastActivityAt = num(raw.lastActivityAt, line.updatedAt);
  line.reports = Array.isArray(raw.reports) ? raw.reports.map(normalizeReport).filter((item) => item !== null).slice(-MAX_REPORTS) : [];
  line.verdicts = Array.isArray(raw.verdicts) ? raw.verdicts.map(normalizeVerdict).filter((item) => item !== null).slice(-MAX_VERDICTS) : [];
  return line;
}

function normalizeRole(raw, key) {
  const role = str(raw.role);
  return {
    sessionId: str(raw.sessionId, key),
    role: ROLE.includes(role) ? role : "expert",
    label: str(raw.label),
    lineId: str(raw.lineId),
    parentSessionId: str(raw.parentSessionId),
    childId: str(raw.childId),
    provider: str(raw.provider),
    model: str(raw.model),
    reasoningEffort: str(raw.reasoningEffort),
    domain: str(raw.domain),
    persistent: raw.persistent === true,
    startedAt: num(raw.startedAt),
    retiredAt: num(raw.retiredAt),
    turns: num(raw.turns),
  };
}

function normalizeDomain(raw, key) {
  if (!isPlainObject(raw)) return null;
  const id = str(raw.id, key);
  if (id === "") return null;
  return {
    id,
    name: str(raw.name, id),
    responsibility: str(raw.responsibility),
    expertSessionId: str(raw.expertSessionId),
    createdAt: num(raw.createdAt, nowMs()),
    updatedAt: num(raw.updatedAt, nowMs()),
  };
}

function normalizeMessage(raw) {
  if (!isPlainObject(raw)) return null;
  return {
    id: str(raw.id, mintId("msg")),
    at: num(raw.at, nowMs()),
    from: str(raw.from),
    fromRole: str(raw.fromRole),
    to: str(raw.to),
    toRole: str(raw.toRole),
    lineId: str(raw.lineId),
    kind: MESSAGE_KIND.includes(str(raw.kind)) ? str(raw.kind) : "fyi",
    text: str(raw.text).slice(0, 4000),
    mode: str(raw.mode, "queue"),
  };
}

function normalizeRequest(raw) {
  if (!isPlainObject(raw)) return null;
  return {
    id: str(raw.id, readableId("memreq", str(raw.title) || str(raw.text), new Set(), "memory-request")),
    at: num(raw.at, nowMs()),
    lineId: str(raw.lineId),
    title: str(raw.title),
    text: str(raw.text),
    kind: MEMORY_KIND.includes(str(raw.kind)) ? str(raw.kind) : "finding",
    tags: strArray(raw.tags),
    evidence: str(raw.evidence),
    requesterSessionId: str(raw.requesterSessionId),
    status: ["pending", "accepted", "rejected"].includes(str(raw.status)) ? str(raw.status) : "pending",
    decidedAt: num(raw.decidedAt),
    decidedBy: str(raw.decidedBy),
    reason: str(raw.reason),
    entryId: str(raw.entryId),
  };
}

function normalizeEvent(raw) {
  if (!isPlainObject(raw)) return null;
  return {
    rev: num(raw.rev),
    at: num(raw.at, nowMs()),
    kind: str(raw.kind, "change"),
    lineId: str(raw.lineId),
    sessionId: str(raw.sessionId),
    text: str(raw.text).slice(0, 600),
  };
}

function normalizeResource(raw, id) {
  const holder = isPlainObject(raw.holder)
    ? {
        sessionId: str(raw.holder.sessionId),
        label: str(raw.holder.label),
        lineId: str(raw.holder.lineId),
        since: num(raw.holder.since),
      }
    : null;
  return {
    id,
    label: str(raw.label, id),
    note: str(raw.note),
    holder,
    queue: Array.isArray(raw.queue)
      ? raw.queue.filter(isPlainObject).map((entry) => ({
          sessionId: str(entry.sessionId),
          label: str(entry.label),
          lineId: str(entry.lineId),
          since: num(entry.since),
        }))
      : [],
  };
}

/** Build an empty board document for one manager session. */
export function emptyBoard(sessionId, title = "") {
  const at = nowMs();
  const named = summaryTitle(title);
  return {
    version: BOARD_VERSION,
    boardId: safeBoardId(sessionId),
    sessionId,
    // Older boards used the random-looking manager session id as their title.
    // Keep that value out of every display; a project or line title replaces it.
    title: named === "" || named === sessionId ? DEFAULT_BOARD_TITLE : named,
    projectKey: "",
    projectRoot: "",
    createdAt: at,
    updatedAt: at,
    revision: 0,
    seq: 0,
    lines: {},
    order: [],
    roles: {},
    domains: {},
    messages: [],
    memoryRequests: [],
    decisions: [],
    resources: {},
    events: [],
  };
}

/** Normalize a board read from disk, tolerating older or hand-edited files. */
export function normalizeBoard(raw, sessionId) {
  if (!isPlainObject(raw)) return emptyBoard(sessionId);
  const board = emptyBoard(str(raw.sessionId, sessionId), str(raw.title));
  board.boardId = safeBoardId(str(raw.boardId, sessionId));
  board.projectKey = str(raw.projectKey);
  board.projectRoot = str(raw.projectRoot);
  board.createdAt = num(raw.createdAt, board.createdAt);
  board.updatedAt = num(raw.updatedAt, board.updatedAt);
  board.revision = num(raw.revision, 0);
  board.seq = num(raw.seq, 0);
  if (isPlainObject(raw.lines)) {
    for (const [id, line] of Object.entries(raw.lines)) {
      if (!isPlainObject(line)) continue;
      board.lines[id] = normalizeLine(id, line);
    }
  }
  board.order = strArray(raw.order).filter((id) => board.lines[id] !== undefined);
  for (const id of Object.keys(board.lines)) if (!board.order.includes(id)) board.order.push(id);
  if (isPlainObject(raw.roles)) {
    for (const [key, role] of Object.entries(raw.roles)) {
      if (!isPlainObject(role)) continue;
      board.roles[key] = normalizeRole(role, key);
    }
  }
  if (isPlainObject(raw.domains)) {
    for (const [key, domain] of Object.entries(raw.domains)) {
      const normalized = normalizeDomain(domain, key);
      if (normalized !== null) board.domains[normalized.id] = normalized;
    }
  }
  board.messages = Array.isArray(raw.messages) ? raw.messages.map(normalizeMessage).filter((item) => item !== null).slice(-MAX_MESSAGES) : [];
  const requests = Array.isArray(raw.memoryRequests)
    ? raw.memoryRequests.map(normalizeRequest).filter((item) => item !== null)
    : [];
  const requestIds = new Set();
  for (const request of requests) {
    if (request.id === "" || requestIds.has(request.id)) {
      request.id = readableId("memreq", request.title || request.text, requestIds, "memory-request");
    }
    requestIds.add(request.id);
  }
  board.memoryRequests = requests.slice(-MAX_REQUESTS);
  board.decisions = Array.isArray(raw.decisions)
    ? raw.decisions
        .filter(isPlainObject)
        .map((item) => ({ id: str(item.id, mintId("dec")), at: num(item.at), lineId: str(item.lineId), by: str(item.by), text: str(item.text) }))
        .slice(-MAX_DECISIONS)
    : [];
  if (isPlainObject(raw.resources)) {
    for (const [id, resource] of Object.entries(raw.resources)) {
      if (!isPlainObject(resource)) continue;
      board.resources[id] = normalizeResource(resource, id);
    }
  }
  board.events = Array.isArray(raw.events) ? raw.events.map(normalizeEvent).filter((item) => item !== null).slice(-MAX_EVENTS) : [];
  return board;
}

/** Normalize the plugin settings document. */
export function normalizeSettings(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const defaults = defaultSettings();
  const text = (value, fallback) => (typeof value === "string" ? value.trim() : fallback);
  const roles = {};
  for (const role of ["expert", "verifier", "memory"]) {
    const entry = isPlainObject(source.roles) && isPlainObject(source.roles[role]) ? source.roles[role] : {};
    roles[role] = {
      provider: text(entry.provider, ""),
      model: text(entry.model, ""),
      reasoningEffort: text(entry.reasoningEffort, ""),
    };
  }
  const maxConcurrent = num(source.maxConcurrent, defaults.maxConcurrent);
  return {
    version: 1,
    maxConcurrent: Number.isSafeInteger(maxConcurrent) && maxConcurrent >= 1 && maxConcurrent <= 8 ? maxConcurrent : defaults.maxConcurrent,
    verifier: ["auto", "required", "none"].includes(str(source.verifier)) ? str(source.verifier) : defaults.verifier,
    roles,
    updatedAt: num(source.updatedAt, 0),
    updatedBy: str(source.updatedBy),
  };
}

/** Whether a role route is configured. */
export function isRouteConfigured(route) {
  return isPlainObject(route) && str(route.provider).trim() !== "" && str(route.model).trim() !== "";
}

/** One process-wide store over a board root. */
export class SwarmStore {
  constructor(options = {}) {
    this.root = options.root ?? defaultRoot();
    this.memory = options.memory ?? createMemoryStore({
      root: options.memoryRoot ?? (options.root === undefined ? defaultMemoryRoot() : path.join(this.root, "memory")),
      logger: options.logger,
    });
    /** @type {Map<string, object>} */
    this.cache = new Map();
    this.logger = typeof options.logger === "function" ? options.logger : () => {};
  }

  // ── project identity ─────────────────────────────────────────────────────

  /** Record which project this session is about, from its own cwd. */
  tagProject(board, cwd) {
    const value = typeof cwd === "string" ? cwd.trim() : "";
    if (value === "") return { identity: null, changed: false };
    const identity = this.memory.resolveIdentity(value);
    if (identity.key === "") return { identity: null, changed: false };
    const sameProject = board.projectKey === identity.key && board.projectRoot === identity.root;
    const needsTitle = board.title === "" || board.title === board.sessionId || board.title === DEFAULT_BOARD_TITLE;
    if (sameProject && !needsTitle) return { identity, changed: false };
    board.projectKey = identity.key;
    board.projectRoot = identity.root;
    if (needsTitle) board.title = summaryTitle(identity.name || path.basename(identity.root), DEFAULT_BOARD_TITLE);
    board.updatedAt = nowMs();
    return { identity, changed: true };
  }

  /** The project identity for one session, falling back to what the board recorded. */
  projectFor(sessionId, cwd = "") {
    const board = this.get(sessionId);
    if (board === null) return { key: "", root: "", name: "", reason: "no-board", cwd: "" };
    const tagged = this.tagProject(board, cwd);
    if (tagged.identity === null) {
      if (board.projectKey === "") return { key: "", root: "", name: "", reason: "unidentified", cwd: "" };
      return { key: board.projectKey, root: board.projectRoot, name: path.basename(board.projectRoot), reason: "recorded", cwd: "" };
    }
    if (tagged.changed) this.flush(board);
    return tagged.identity;
  }

  // ── board files ──────────────────────────────────────────────────────────

  dirFor(sessionId) {
    return path.join(this.root, safeBoardId(sessionId));
  }

  fileFor(sessionId) {
    return path.join(this.dirFor(sessionId), "board.json");
  }

  listBoardIds() {
    let entries;
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const found = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.root, entry.name, "board.json");
      try {
        const stat = fs.statSync(file);
        found.push({ boardId: entry.name, mtime: stat.mtimeMs, file });
      } catch {
        /* not a board directory */
      }
    }
    return found.sort((a, b) => b.mtime - a.mtime);
  }

  open(sessionId, title) {
    const id = safeBoardId(sessionId);
    const cached = this.cache.get(id);
    if (cached !== undefined) {
      if (title !== undefined && title !== "" && cached.title !== title) cached.title = title;
      return cached;
    }
    let board = null;
    try {
      board = normalizeBoard(JSON.parse(fs.readFileSync(this.fileFor(id), "utf8")), sessionId);
    } catch {
      board = null;
    }
    if (board === null) {
      board = emptyBoard(sessionId, title);
      board.boardId = id;
      this.cache.set(id, board);
      this.flush(board);
      return board;
    }
    if (title !== undefined && title !== "") board.title = title;
    this.cache.set(id, board);
    return board;
  }

  get(boardId) {
    const id = safeBoardId(boardId);
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    try {
      const board = normalizeBoard(JSON.parse(fs.readFileSync(this.fileFor(id), "utf8")), id);
      this.cache.set(id, board);
      return board;
    } catch {
      return null;
    }
  }

  flush(board) {
    board.updatedAt = nowMs();
    const dir = this.dirFor(board.boardId);
    const file = path.join(dir, "board.json");
    const tmp = file + ".tmp-" + process.pid;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(board), "utf8");
      fs.renameSync(tmp, file);
      return true;
    } catch (error) {
      this.logger("warn", "swarm: board flush failed: " + String(error && error.message ? error.message : error));
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
      return false;
    }
  }

  forget(boardId) {
    this.cache.delete(safeBoardId(boardId));
  }

  /** Delete stale boards that have no work in flight. */
  pruneBoards(options = {}) {
    const olderThanMs = num(options.olderThanMs, 30 * 24 * 3600 * 1000);
    const exclude = new Set(Array.isArray(options.excludeIds) ? options.excludeIds : []);
    const cutoff = nowMs() - olderThanMs;
    const pruned = [];
    const skipped = [];
    for (const entry of this.listBoardIds()) {
      if (exclude.has(entry.boardId)) {
        skipped.push({ boardId: entry.boardId, reason: "owned by a live session" });
        continue;
      }
      if (entry.mtime > cutoff) {
        skipped.push({ boardId: entry.boardId, reason: "recently updated" });
        continue;
      }
      const board = this.get(entry.boardId);
      if (board !== null) {
        const open = board.order.some((id) => board.lines[id] !== undefined && !TERMINAL_STATUS.has(board.lines[id].status));
        if (open) {
          skipped.push({ boardId: entry.boardId, reason: "open lines" });
          continue;
        }
      }
      try {
        fs.rmSync(this.dirFor(entry.boardId), { recursive: true, force: true });
        this.cache.delete(entry.boardId);
        pruned.push(entry.boardId);
      } catch (error) {
        skipped.push({ boardId: entry.boardId, reason: "delete failed: " + String(error && error.message ? error.message : error) });
      }
    }
    return { pruned, skipped };
  }

  // ── settings ─────────────────────────────────────────────────────────────

  settingsFile() {
    return path.join(this.root, SETTINGS_FILE);
  }

  settings() {
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.settingsFile(), "utf8"));
    } catch {
      raw = {};
    }
    return normalizeSettings(raw);
  }

  saveSettings(patch) {
    if (!isPlainObject(patch)) throw new Error("settings needs an object");
    const current = this.settings();
    const merged = normalizeSettings({
      ...current,
      ...patch,
      roles: { ...current.roles, ...(isPlainObject(patch.roles) ? patch.roles : {}) },
      updatedAt: nowMs(),
    });
    const file = this.settingsFile();
    const tmp = file + ".tmp-" + process.pid;
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return merged;
  }

  // ── revisions / events ───────────────────────────────────────────────────

  /**
   * Append one revision event. Every mutation funnels through here, so
   * `swarm_status mode=delta since=<revision>` is a cheap, ordered answer to
   * "what changed since I last looked".
   */
  appendEvent(board, event) {
    board.revision += 1;
    const entry = {
      rev: board.revision,
      at: nowMs(),
      kind: str(event.kind, "change"),
      lineId: str(event.lineId),
      sessionId: str(event.sessionId),
      text: str(event.text).slice(0, 600),
    };
    board.events.push(entry);
    if (board.events.length > MAX_EVENTS) board.events.splice(0, board.events.length - MAX_EVENTS);
    board.updatedAt = entry.at;
    return entry;
  }

  // ── lines ────────────────────────────────────────────────────────────────

  createLine(board, input = {}) {
    const title = str(input.title).trim();
    if (title === "") throw new Error("swarm_line create needs a title");
    const id = str(input.id).trim() !== "" ? str(input.id).trim() : lineIdFor(board, input);
    if (board.lines[id] !== undefined) throw new Error(`line id already exists: ${id}`);
    const rawPolicy = ["auto", "required", "none"].includes(str(input.verifierPolicy))
      ? str(input.verifierPolicy)
      : ["auto", "required", "none"].includes(str(input.verifier))
        ? str(input.verifier)
        : "auto";
    const policy = rawPolicy;
    const useVerifier = input.useVerifier === undefined ? policy !== "none" : input.useVerifier === true;
    const line = emptyLine(id, {
      title,
      request: str(input.request, title),
      acceptance: str(input.acceptance),
      boundaries: str(input.boundaries),
      kind: str(input.kind, "task"),
      verifierPolicy: policy,
      useVerifier,
      memoryIds: input.memoryIds,
      experts: input.experts,
      expertLabel: input.expertLabel,
      domainId: input.domainId,
    });
    board.lines[id] = line;
    board.order.push(id);
    if (board.title === DEFAULT_BOARD_TITLE || board.title === board.sessionId || board.title === "") board.title = summaryTitle(title, DEFAULT_BOARD_TITLE);
    this.appendEvent(board, { kind: "line-created", lineId: id, text: title });
    return line;
  }

  lineOf(board, lineId) {
    const id = str(lineId).trim();
    const line = board.lines[id];
    if (line === undefined) throw new Error(`unknown line: ${id || "(empty)"}`);
    return line;
  }

  /** Add one expert seat to an existing line (the manager adjusts the team). */
  addExpert(board, line, input = {}) {
    const label = str(input.label).trim() !== "" ? str(input.label).trim() : "Expert " + (line.experts.length + 1);
    if (line.experts.some((expert) => expert.label === label && expert.status !== "retired")) {
      throw new Error(`line ${line.id} already has a live expert named "${label}"; pick another label`);
    }
    const seat = normalizeExpert({
      label,
      domain: str(input.domain),
      focus: str(input.focus),
      status: str(input.status, "pending"),
      sessionId: str(input.sessionId),
      reused: input.reused === true,
    }, line.experts.length);
    line.experts.push(seat);
    line.updatedAt = nowMs();
    this.appendEvent(board, { kind: "expert-added", lineId: line.id, text: label + (seat.domain ? " (" + seat.domain + ")" : "") });
    return seat;
  }

  /** Move a line to a status, keeping timestamps and writing one event. */
  setLineStatus(board, line, status, detail = "") {
    const next = LINE_STATUS.includes(status) ? status : line.status;
    if (line.status === next) {
      if (detail !== "") this.appendEvent(board, { kind: "line-note", lineId: line.id, text: detail });
      return line;
    }
    line.status = next;
    line.updatedAt = nowMs();
    line.lastActivityAt = line.updatedAt;
    if (next === "working" && line.startedAt === 0) line.startedAt = line.updatedAt;
    if (TERMINAL_STATUS.has(next)) line.endedAt = line.updatedAt;
    if (next === "blocked") line.blockedReason = detail;
    this.appendEvent(board, { kind: "line-" + next, lineId: line.id, text: detail || next });
    return line;
  }

  recordReport(board, line, report) {
    const normalized = normalizeReport({ ...report, at: nowMs() });
    if (normalized === null) throw new Error("report shape is invalid");
    line.reports.push(normalized);
    if (line.reports.length > MAX_REPORTS) line.reports.splice(0, line.reports.length - MAX_REPORTS);
    line.lastActivityAt = normalized.at;
    line.updatedAt = normalized.at;
    this.appendEvent(board, { kind: "report", lineId: line.id, sessionId: normalized.sessionId, text: normalized.summary.slice(0, 200) });
    return normalized;
  }

  recordVerdict(board, line, verdict) {
    const normalized = normalizeVerdict({ ...verdict, at: nowMs() });
    if (normalized === null) throw new Error("verdict shape is invalid");
    line.verdicts.push(normalized);
    if (line.verdicts.length > MAX_VERDICTS) line.verdicts.splice(0, line.verdicts.length - MAX_VERDICTS);
    line.lastActivityAt = normalized.at;
    line.updatedAt = normalized.at;
    this.appendEvent(board, {
      kind: normalized.pass ? "verdict-pass" : "verdict-fail",
      lineId: line.id,
      sessionId: normalized.sessionId,
      text: normalized.pass ? "pass" : (normalized.failures.join("; ") || "fail"),
    });
    return normalized;
  }

  /** The last verdict on a line, or null. */
  lastVerdict(line) {
    const found = line.verdicts[line.verdicts.length - 1];
    return found === undefined ? null : found;
  }

  // ── roles ────────────────────────────────────────────────────────────────

  upsertRole(board, input) {
    const sessionId = str(input.sessionId).trim();
    if (sessionId === "") throw new Error("role needs a sessionId");
    const existing = board.roles[sessionId];
    const role = {
      sessionId,
      role: ROLE.includes(str(input.role)) ? str(input.role) : existing === undefined ? "expert" : existing.role,
      label: str(input.label, existing === undefined ? "" : existing.label),
      lineId: str(input.lineId, existing === undefined ? "" : existing.lineId),
      parentSessionId: str(input.parentSessionId, existing === undefined ? "" : existing.parentSessionId),
      childId: str(input.childId, existing === undefined ? "" : existing.childId),
      provider: str(input.provider, existing === undefined ? "" : existing.provider),
      model: str(input.model, existing === undefined ? "" : existing.model),
      reasoningEffort: str(input.reasoningEffort, existing === undefined ? "" : existing.reasoningEffort),
      domain: str(input.domain, existing === undefined ? "" : existing.domain),
      persistent: input.persistent === undefined ? (existing === undefined ? false : existing.persistent) : input.persistent === true,
      startedAt: num(input.startedAt, existing === undefined ? nowMs() : existing.startedAt),
      retiredAt: num(input.retiredAt, existing === undefined ? 0 : existing.retiredAt),
      turns: num(input.turns, existing === undefined ? 0 : existing.turns),
    };
    board.roles[sessionId] = role;
    return role;
  }

  retireRole(board, sessionId) {
    const role = board.roles[str(sessionId)];
    if (role === undefined) return null;
    role.retiredAt = nowMs();
    this.appendEvent(board, { kind: "role-retired", sessionId: role.sessionId, text: role.label || role.role });
    return role;
  }

  rolesOf(board, role) {
    return Object.values(board.roles).filter((entry) => entry.role === role && entry.retiredAt === 0);
  }

  // ── domains ──────────────────────────────────────────────────────────────

  /** Define or update one routing domain. The owner is bound separately. */
  defineDomain(board, input = {}) {
    const id = str(input.id).trim() || mintId("dom");
    const existing = board.domains[id];
    const domain = {
      id,
      name: str(input.name, existing === undefined ? id : existing.name),
      responsibility: str(input.responsibility, existing === undefined ? "" : existing.responsibility),
      expertSessionId: str(input.expertSessionId, existing === undefined ? "" : existing.expertSessionId),
      createdAt: existing === undefined ? nowMs() : existing.createdAt,
      updatedAt: nowMs(),
    };
    board.domains[id] = domain;
    this.appendEvent(board, { kind: "domain-defined", text: id });
    return domain;
  }

  /** Bind a domain to one live expert; the previous owner is unbound. */
  bindDomain(board, domainId, sessionId) {
    const id = str(domainId).trim();
    const sid = str(sessionId).trim();
    if (id === "" || sid === "") throw new Error("bind needs both a domainId and a sessionId");
    const domain = board.domains[id] ?? this.defineDomain(board, { id, name: id });
    const previous = domain.expertSessionId;
    if (previous !== "" && previous !== sid) {
      const oldRole = board.roles[previous];
      if (oldRole !== undefined) {
        oldRole.domain = "";
        oldRole.persistent = false;
      }
    }
    // An expert owns one domain in this schema; clear any other domain that
    // still points at it so the registry cannot show two owners for one agent.
    for (const other of Object.values(board.domains)) {
      if (other.id !== id && other.expertSessionId === sid) other.expertSessionId = "";
    }
    domain.expertSessionId = sid;
    domain.updatedAt = nowMs();
    const role = board.roles[sid];
    if (role !== undefined) {
      role.domain = id;
      role.persistent = true;
    }
    this.appendEvent(board, { kind: "domain-bound", sessionId: sid, text: id });
    return domain;
  }

  domainOf(board, domainId) {
    const id = str(domainId).trim();
    return id === "" ? null : (board.domains[id] ?? null);
  }

  /** Routing material: every domain with its owner and the owner's live line. */
  domainRows(board) {
    return Object.values(board.domains).map((domain) => {
      const role = board.roles[domain.expertSessionId];
      return {
        id: domain.id,
        name: domain.name,
        responsibility: domain.responsibility,
        expertSessionId: domain.expertSessionId,
        expertLabel: role === undefined ? "" : role.label,
        expertRetired: role === undefined || role.retiredAt > 0,
        expertLineId: role === undefined ? "" : role.lineId,
      };
    });
  }

  // ── message bus ──────────────────────────────────────────────────────────

  appendMessage(board, input) {
    const message = normalizeMessage({ ...input, id: input.id ?? mintId("msg"), at: nowMs() });
    if (message === null) throw new Error("message shape is invalid");
    board.messages.push(message);
    if (board.messages.length > MAX_MESSAGES) board.messages.splice(0, board.messages.length - MAX_MESSAGES);
    this.appendEvent(board, {
      kind: "message",
      lineId: message.lineId,
      sessionId: message.from,
      text: `${message.fromRole || message.from} -> ${message.toRole || message.to}: ${message.text.slice(0, 120)}`,
    });
    return message;
  }

  // ── memory write requests ────────────────────────────────────────────────

  addMemoryRequest(board, input) {
    const request = normalizeRequest({
      ...input,
      id: input.id ?? readableId("memreq", input.title || input.text, new Set(board.memoryRequests.map((request) => request.id)), "memory-request"),
      at: nowMs(),
      status: "pending",
    });
    board.memoryRequests.push(request);
    if (board.memoryRequests.length > MAX_REQUESTS) board.memoryRequests.splice(0, board.memoryRequests.length - MAX_REQUESTS);
    this.appendEvent(board, { kind: "memory-request", lineId: request.lineId, sessionId: request.requesterSessionId, text: request.title });
    return request;
  }

  pendingMemoryRequests(board) {
    return board.memoryRequests.filter((request) => request.status === "pending");
  }

  decideMemoryRequest(board, requestId, input) {
    const request = board.memoryRequests.find((entry) => entry.id === requestId);
    if (request === undefined) throw new Error(`unknown memory request: ${requestId}`);
    if (request.status !== "pending") throw new Error(`memory request ${requestId} was already ${request.status}`);
    const status = input.status === "accepted" ? "accepted" : "rejected";
    request.status = status;
    request.decidedAt = nowMs();
    request.decidedBy = str(input.decidedBy);
    request.reason = str(input.reason);
    request.entryId = str(input.entryId);
    this.appendEvent(board, {
      kind: "memory-" + status,
      lineId: request.lineId,
      sessionId: request.decidedBy,
      text: request.title + (request.reason ? " — " + request.reason : ""),
    });
    return request;
  }

  // ── decisions ────────────────────────────────────────────────────────────

  addDecision(board, input) {
    const decision = {
      id: mintId("dec"),
      at: nowMs(),
      lineId: str(input.lineId),
      by: str(input.by),
      text: str(input.text),
    };
    if (decision.text.trim() === "") throw new Error("decision needs text");
    board.decisions.push(decision);
    if (board.decisions.length > MAX_DECISIONS) board.decisions.splice(0, board.decisions.length - MAX_DECISIONS);
    this.appendEvent(board, { kind: "decision", lineId: decision.lineId, sessionId: decision.by, text: decision.text.slice(0, 200) });
    return decision;
  }

  // ── resources ────────────────────────────────────────────────────────────

  defineResource(board, input) {
    const id = str(input.id).trim();
    if (id === "") throw new Error("resource needs an id");
    const existing = board.resources[id];
    const resource = {
      id,
      label: str(input.label, existing === undefined ? id : existing.label),
      note: str(input.note, existing === undefined ? "" : existing.note),
      holder: existing === undefined ? null : existing.holder,
      queue: existing === undefined ? [] : existing.queue,
    };
    board.resources[id] = resource;
    if (existing === undefined) {
      this.appendEvent(board, { kind: "resource-defined", text: `${id} (${resource.label})` });
    }
    return resource;
  }

  /**
   * Hand a lease to one agent. The manager is the only issuer; `force` is the
   * explicit takeover path when the previous holder has already stopped.
   */
  grantResource(board, input) {
    const id = str(input.id).trim();
    if (id === "") throw new Error("grant needs a resource id");
    const resource = board.resources[id] ?? this.defineResource(board, { id, label: str(input.label, id) });
    const sessionId = str(input.sessionId).trim();
    if (sessionId === "") throw new Error("grant needs a sessionId");
    const force = input.force === true;
    if (resource.holder !== null && resource.holder.sessionId !== sessionId && !force) {
      throw new Error(`${resource.id} is held by ${resource.holder.label || resource.holder.sessionId}; ask it to release, or pass force=true`);
    }
    const previous = resource.holder;
    resource.holder = { sessionId, label: str(input.holderLabel, resource.label), lineId: str(input.lineId), since: nowMs() };
    resource.queue = resource.queue.filter((entry) => entry.sessionId !== sessionId);
    this.appendEvent(board, {
      kind: "resource-grant",
      lineId: str(input.lineId),
      sessionId,
      text: force && previous !== null ? `${id} force-transferred` : `${id} granted`,
    });
    return { resource, previous };
  }

  /**
   * A worker asking for a lease. This only enqueues — issuance stays with the
   * manager, which is what keeps two experts from operating one backend at once.
   */
  requestResource(board, input) {
    const id = str(input.id).trim();
    const sessionId = str(input.sessionId).trim();
    if (id === "") throw new Error("lease request needs a resource id");
    if (sessionId === "") throw new Error("lease request needs a sessionId");
    const resource = board.resources[id];
    if (resource === undefined) {
      throw new Error(`unknown resource: ${id}. The manager must define it first (swarm_line action=define-resource).`);
    }
    if (resource.holder !== null && resource.holder.sessionId === sessionId) {
      return { state: "held", position: 0, resource };
    }
    const queued = resource.queue.findIndex((entry) => entry.sessionId === sessionId);
    if (queued >= 0) return { state: "queued", position: queued + 1, resource };
    resource.queue.push({
      sessionId,
      label: str(input.label, sessionId),
      lineId: str(input.lineId),
      since: nowMs(),
    });
    this.appendEvent(board, {
      kind: "resource-wait",
      lineId: str(input.lineId),
      sessionId,
      text: `${id} requested (queue ${resource.queue.length})`,
    });
    return { state: "queued", position: resource.queue.length, resource };
  }

  /** The holder releases. The queue head is promoted atomically. */
  releaseResource(board, input) {
    const id = str(input.id).trim();
    const resource = board.resources[id];
    if (resource === undefined) throw new Error(`unknown resource: ${id}`);
    const actor = str(input.sessionId);
    if (resource.holder === null) return { resource, released: null, next: null };
    if (actor !== "" && resource.holder.sessionId !== actor) {
      throw new Error(`only the holder can release ${id}; the current holder is ${resource.holder.label || resource.holder.sessionId}`);
    }
    const released = resource.holder;
    resource.holder = null;
    this.appendEvent(board, { kind: "resource-release", sessionId: released.sessionId, text: `${id} released` });
    const queued = resource.queue.shift();
    if (queued !== undefined) {
      resource.holder = { ...queued, since: nowMs() };
      this.appendEvent(board, { kind: "resource-grant", sessionId: queued.sessionId, text: `${id} handed to queue head` });
    }
    return { resource, released, next: resource.holder };
  }

  /** The manager takes a lease back, whatever the holder is doing. */
  revokeResource(board, input) {
    const id = str(input.id).trim();
    const resource = board.resources[id];
    if (resource === undefined) throw new Error(`unknown resource: ${id}`);
    const released = resource.holder;
    if (released === null) return { resource, released: null, next: null };
    resource.holder = null;
    this.appendEvent(board, { kind: "resource-revoke", sessionId: released.sessionId, text: `${id} revoked by the manager` });
    if (input.promote === false) return { resource, released, next: null };
    const queued = resource.queue.shift();
    if (queued !== undefined) {
      resource.holder = { ...queued, since: nowMs() };
      this.appendEvent(board, { kind: "resource-grant", sessionId: queued.sessionId, text: `${id} handed to queue head` });
    }
    return { resource, released, next: resource.holder };
  }

  /** Hand a free lease to the queue head (recovery path). */
  grantNext(board, input) {
    const id = str(input.id).trim();
    const resource = board.resources[id];
    if (resource === undefined) throw new Error(`unknown resource: ${id}`);
    if (resource.holder !== null) {
      throw new Error(`${id} is still held by ${resource.holder.label || resource.holder.sessionId}`);
    }
    const next = resource.queue.shift();
    if (next === undefined) return { resource, granted: false, next: null };
    resource.holder = { ...next, since: nowMs() };
    this.appendEvent(board, { kind: "resource-grant", sessionId: next.sessionId, text: `${id} handed to queue head` });
    return { resource, granted: true, next: resource.holder };
  }

  /**
   * Release every lease one retired role held, and drop it from wait queues.
   * A finished line must not keep a backend instance checked out.
   */
  releaseBySession(board, sessionId) {
    const released = [];
    const promoted = [];
    for (const resource of Object.values(board.resources)) {
      resource.queue = resource.queue.filter((entry) => entry.sessionId !== sessionId);
      if (resource.holder === null || resource.holder.sessionId !== sessionId) continue;
      const previous = resource.holder;
      resource.holder = null;
      this.appendEvent(board, { kind: "resource-release", sessionId, text: `${resource.id} released (role retired)` });
      released.push({ id: resource.id, previous });
      const queued = resource.queue.shift();
      if (queued !== undefined) {
        resource.holder = { ...queued, since: nowMs() };
        this.appendEvent(board, { kind: "resource-grant", sessionId: queued.sessionId, text: `${resource.id} handed to queue head` });
        promoted.push({ id: resource.id, holder: resource.holder });
      }
    }
    return { released, promoted };
  }

  // ── read models ──────────────────────────────────────────────────────────

  /**
   * The compact project picture `swarm_status` returns. Everything here is
   * derived from the board plus a live-status map the runtime supplies; the
   * manager never has to remember state.
   */
  summary(board, live = {}) {
    const at = nowMs();
    const counts = { total: 0, waiting: 0, working: 0, verifying: 0, reworking: 0, done: 0, blocked: 0, cancelled: 0 };
    const lines = [];
    for (const id of board.order) {
      const line = board.lines[id];
      if (line === undefined) continue;
      counts.total += 1;
      counts[line.status] = (counts[line.status] ?? 0) + 1;
      const experts = line.experts.map((expert) => ({
        sessionId: expert.sessionId,
        label: expert.label,
        domain: expert.domain,
        focus: expert.focus,
        reused: expert.reused === true,
        status: expert.sessionId === "" ? "pending" : (live[expert.sessionId] ?? expert.status),
        reported: expert.reportedAt !== 0,
        startedAt: expert.startedAt,
      }));
      const verifier = this.roleView(board, line.verifierId, live);
      const lastVerdict = this.lastVerdict(line);
      const lastReport = line.reports[line.reports.length - 1] ?? null;
      lines.push({
        id: line.id,
        title: line.title,
        request: line.request,
        status: line.status,
        kind: line.kind,
        useVerifier: line.useVerifier,
        experts,
        verifier,
        round: line.round,
        reportsCount: line.reports.length,
        memoryCount: line.memoryIds.length,
        blockedReason: line.blockedReason,
        lastVerdict: lastVerdict === null ? null : {
          pass: lastVerdict.pass,
          at: lastVerdict.at,
          failures: lastVerdict.failures,
          round: lastVerdict.round,
        },
        lastReport: lastReport === null ? null : {
          at: lastReport.at,
          summary: lastReport.summary,
          blockers: lastReport.blockers,
        },
        elapsedMs: line.startedAt === 0 ? 0 : (line.endedAt === 0 ? at : line.endedAt) - line.startedAt,
        updatedAt: line.updatedAt,
      });
    }
    const roles = Object.values(board.roles)
      .filter((role) => role.retiredAt === 0)
      .map((role) => ({
        ...role,
        status: live[role.sessionId] ?? "unknown",
      }));
    const pending = this.pendingMemoryRequests(board);
    return {
      boardId: board.boardId,
      sessionId: board.sessionId,
      title: board.title,
      projectKey: board.projectKey,
      projectRoot: board.projectRoot,
      projectName: board.projectRoot === "" ? "" : path.basename(board.projectRoot),
      counts,
      lines,
      roles,
      domains: this.domainRows(board).map((domain) => ({
        ...domain,
        status: live[domain.expertSessionId] ?? "unknown",
      })),
      memory: {
        pendingRequests: pending.length,
        pending: pending.map((request) => ({ id: request.id, title: request.title, lineId: request.lineId })),
      },
      decisions: board.decisions.slice(-8),
      resources: Object.values(board.resources).map((resource) => ({
        id: resource.id,
        label: resource.label,
        holder: resource.holder === null ? null : { ...resource.holder },
        queue: resource.queue.map((entry) => ({ ...entry })),
      })),
      revision: board.revision,
      updatedAt: board.updatedAt,
    };
  }

  roleView(board, sessionId, live) {
    if (sessionId === "") return null;
    const role = board.roles[sessionId];
    return {
      sessionId,
      label: role === undefined ? "" : role.label,
      role: role === undefined ? "" : role.role,
      status: live[sessionId] ?? "unknown",
    };
  }

  /** Full history of one line: experts, reports, verdicts, messages, decisions. */
  detail(board, lineId, live = {}) {
    const line = this.lineOf(board, lineId);
    return {
      line,
      experts: line.experts.map((expert) => ({
        ...expert,
        status: expert.sessionId === "" ? "pending" : (live[expert.sessionId] ?? expert.status),
      })),
      verifier: this.roleView(board, line.verifierId, live),
      resources: Object.values(board.resources).map((resource) => ({
        id: resource.id,
        label: resource.label,
        holder: resource.holder === null ? null : { ...resource.holder },
        queue: resource.queue.map((entry) => ({ ...entry })),
      })),
      messages: board.messages.filter((message) => message.lineId === line.id).slice(-30),
      decisions: board.decisions.filter((decision) => decision.lineId === line.id),
    };
  }

  /** Flat agent roster, including children reported by the runtime. */
  agentsView(board, live = {}, descendants = []) {
    const agents = [];
    for (const role of Object.values(board.roles)) {
      agents.push({
        sessionId: role.sessionId,
        label: role.label || role.role,
        role: role.role,
        lineId: role.lineId,
        parentSessionId: role.parentSessionId,
        status: role.retiredAt !== 0 ? "retired" : (live[role.sessionId] ?? "unknown"),
        model: [role.provider, role.model].filter(Boolean).join("/"),
        startedAt: role.startedAt,
      });
    }
    for (const child of descendants) {
      if (agents.some((agent) => agent.sessionId === child.sessionId)) continue;
      agents.push({
        sessionId: child.sessionId,
        label: child.label || "subagent",
        role: "subagent",
        lineId: "",
        parentSessionId: child.parentSessionId ?? "",
        status: child.status ?? "unknown",
        model: "",
        startedAt: 0,
      });
    }
    return agents.sort((left, right) => left.startedAt - right.startedAt);
  }

  /** Changes after one revision cursor. */
  delta(board, since) {
    const cursor = num(since, 0);
    return {
      revision: board.revision,
      from: cursor,
      events: board.events.filter((event) => event.rev > cursor),
      counts: this.summary(board, {}).counts,
    };
  }
}
