/**
 * dsh-swarm — orchestration engine.
 *
 * The engine owns everything the manager model must not have to remember:
 *
 *   - the line lifecycle (waiting -> working -> verifying -> reworking -> done),
 *   - starting and retiring role agents through the subagent registry,
 *   - the verify/rework state loop (no round cap; see `handleVerdict`),
 *   - the universal message bus (`sendMessage` through the runtime adapter),
 *   - NO autonomous messages: agents coordinate with tools; the harness sends
 *     child-completion notices (pm-mode alignment),
 *   - the memory write-request queue and the bootstrap trigger.
 *
 * It is pure JavaScript over an injected `runtime` object, so the whole state
 * machine is testable offline with a fake runtime (scripts/smoke.mjs).
 *
 * The runtime interface (implemented in lib/index.js):
 *   liveStatus() -> { [sessionId]: string }
 *   resolveAgent(sessionId) -> Promise<agent | undefined>
 *   startChild({ parentAgent, preset, prompt, label, agentOptions, maxDepth })
 *        -> Promise<{ childId, result, dispose }>
 *   sendSubagent(senderAgent, targetId, parts, options) -> Promise<string>
 *   sendToManager(managerAgent, parts, source) -> Promise<void>
 *   listDescendants(rootSessionId) -> Promise<Array<{sessionId,label,parentSessionId,status}>>
 *   log(level, message) -> void
 *
 * @module dsh-swarm/engine
 */
import { LINE_STATUS, TERMINAL_STATUS, isRouteConfigured, mintId } from "./store.js";
/** What to call a seat in a label: its focus, else its domain, else its seat name. */
function seatWho(seat) {
  const focus = str(seat.focus).trim();
  if (focus !== "") return focus;
  const domain = str(seat.domain).trim();
  return domain !== "" ? domain : seat.label;
}

/** A short human label for a role session: "<who> - <line title>". */
function seatLabel(line, who) {
  const text = String(who) + " · " + String(line.title ?? "").replace(/\s+/g, " ").trim();
  return text.length <= 60 ? text : text.slice(0, 59) + "…";
}

const EXPERT_PRESET = "swarm-expert";
const VERIFIER_PRESET = "swarm-verifier";
const MEMORY_PRESET = "swarm-memory";
const EXPERT_MAX_DEPTH = 2;
const LEAF_MAX_DEPTH = 1;

function str(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function num(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stamp(ms) {
  if (!ms) return "-";
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function shortId(id) {
  const text = str(id);
  return text.length > 12 ? text.slice(0, 12) : text;
}

function hashSignature(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  return hash.toString(16);
}

/** Build a task book block listing the memory entries the manager relayed. */
export function memoryBlock(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  const lines = ["## Project facts relayed by the manager (you may re-check them, but do not treat them as your own findings)"];
  for (const entry of entries) {
    lines.push(`- ${entry.title}: ${entry.text}` + (entry.evidence ? ` (evidence: ${entry.evidence})` : ""));
  }
  return lines.join("\n") + "\n\n";
}

export class SwarmEngine {
  constructor({ store, runtime, logger = () => {}, clock = () => Date.now() }) {
    this.store = store;
    this.runtime = runtime;
    this.logger = logger;
    this.clock = clock;
    /** Lazy dispatches already scheduled per line, to avoid double starts. */
    this.starting = new Set();
    /** Roles whose prompt already carried a "you forgot to report" reminder. */
    this.reminded = new Set();
    /** childId -> { dispose } handles for role activations. */
    this.handles = new Map();
  }

  log(level, message) {
    try {
      this.runtime.log?.(level, message);
    } catch {
      /* a logger that throws must not break a tool call */
    }
  }

  // ── session attachment ───────────────────────────────────────────────────

  /**
   * Resolve the board a tool call belongs to and record the caller's role.
   *
   * The manager's session owns the board. A role agent reaches it through its
   * session header's parent session; the store-backed scan is the fallback for
   * a deployment whose header shape differs.
   */
  async attach(exec, role, options = {}) {
    const sessionId = str(exec?.agent?.id);
    if (sessionId === "") throw new Error("swarm: the tool call has no agent context");
    const header = exec?.agent?.session?.header ?? {};
    const cwd = str(header.cwd);
    const parentCandidates = [header.parentSession, header.parentSessionId, header.parent_session, header.subagentParent, header.origin?.parentSession];
    let parentId = "";
    for (const candidate of parentCandidates) {
      if (typeof candidate === "string" && candidate !== "" && candidate !== sessionId) {
        parentId = candidate;
        break;
      }
    }

    let board;
    if (role === "manager") {
      board = this.store.open(sessionId);
    } else if (parentId !== "") {
      board = this.store.open(parentId);
    } else {
      board = this.findBoardWithRole(sessionId);
      if (board === null) {
        throw new Error(
          "swarm: cannot locate the manager board for this role session " +
            "(no parent session in the header and no board records this session). " +
            "Start the agent through the swarm line tools rather than by hand.",
        );
      }
    }

    if (role === "manager") {
      const tagged = this.store.tagProject(board, cwd);
      if (tagged.changed) this.store.flush(board);
      this.store.upsertRole(board, { sessionId, role: "manager", label: "Manager", lineId: "", parentSessionId: "" });
    } else {
      const existing = board.roles[sessionId];
      if (existing === undefined) {
        throw new Error(`swarm: this session (${shortId(sessionId)}) is not registered as a ${role} on the project board`);
      }
      if (existing.role !== role) throw new Error(`swarm: this session is registered as ${existing.role}, not ${role}`);
    }

    return { board, sessionId, cwd, project: board.projectKey === "" ? null : { key: board.projectKey, root: board.projectRoot, name: board.projectRoot === "" ? board.projectKey : board.projectRoot.split(/[\\/]/).pop() } };
  }

  findBoardWithRole(sessionId) {
    for (const board of this.store.cache.values()) {
      if (board.roles?.[sessionId] !== undefined) return board;
    }
    for (const entry of this.store.listBoardIds()) {
      const board = this.store.get(entry.boardId);
      if (board !== null && board.roles?.[sessionId] !== undefined) return board;
    }
    return null;
  }

  settings() {
    return this.store.settings();
  }

  /** Role route to pass to the child, or undefined to inherit the manager's. */
  routeOf(role) {
    const settings = this.settings();
    const route = settings.roles[role];
    if (!isRouteConfigured(route)) return undefined;
    const options = { provider: route.provider, model: route.model };
    if (route.reasoningEffort !== "") options.reasoningEffort = route.reasoningEffort;
    return options;
  }

  async managerAgent(board) {
    const agent = await this.runtime.resolveAgent(board.sessionId);
    if (agent === undefined || agent === null) {
      throw new Error("swarm: the manager session is not resolvable (is the session still loaded?)");
    }
    return agent;
  }

  live() {
    try {
      return this.runtime.liveStatus?.() ?? {};
    } catch {
      return {};
    }
  }

  // ── lines ────────────────────────────────────────────────────────────────

  /**
   * Create a line and dispatch its expert. The manager supplies the user's
   * words; the engine adds the reporting contract.
   */
  async createLine(board, input, agent) {
    const settings = this.settings();
    const policy = input.verifier !== undefined ? input.verifier : settings.verifier;
    const domainId = str(input.domain);
    const lineInput = { ...input, verifier: policy };
    if (domainId !== "") {
      if (!Array.isArray(input.experts)) {
        lineInput.domainId = domainId;
      } else if (input.experts.length === 1 && str(input.experts[0].domain) === "") {
        lineInput.experts = [{ ...input.experts[0], domain: domainId }];
      }
    }
    const domains = (Array.isArray(lineInput.experts) ? lineInput.experts : [])
      .map((seat) => str(seat.domain))
      .filter((domain) => domain !== "");
    if (domains.length !== new Set(domains).size) {
      throw new Error("a joint line cannot seat the same domain twice; one domain has one expert");
    }
    const line = this.store.createLine(board, lineInput);
    this.store.flush(board);
    for (const expert of line.experts) {
      try {
        await this.routeSeat(board, line, expert);
      } catch (error) {
        this.failLine(board, line, `could not start expert ${expert.label}: ` + String(error && error.message ? error.message : error));
        break;
      }
    }
    return line;
  }

  // ── domain routing ───────────────────────────────────────────────────────

  /**
   * Route one seat. A seat with a domain is owned by that domain: if the
   * domain's expert is live and idle, reuse it with a new task book; if it is
   * busy, park this line until the expert frees (one task at a time); if there
   * is no live owner, start a new expert and bind the domain to it.
   */
  async routeSeat(board, line, seat) {
    const domainId = str(seat.domain);
    if (domainId === "") {
      await this.startExpert(board, line, seat);
      return;
    }
    this.store.defineDomain(board, { id: domainId, name: domainId });
    const domain = board.domains[domainId];
    const ownerId = domain === undefined ? "" : domain.expertSessionId;
    const owner = ownerId === "" ? undefined : board.roles[ownerId];
    if (owner !== undefined && owner.retiredAt === 0) {
      owner.domain = domainId;
      owner.persistent = true;
      seat.reused = true;
      const ownerLine = owner.lineId === "" ? undefined : board.lines[owner.lineId];
      if (owner.lineId === "" || ownerLine === undefined || TERMINAL_STATUS.has(ownerLine.status)) {
        await this.dispatchReusedSeat(board, line, seat, owner);
      } else {
        seat.sessionId = owner.sessionId;
        seat.status = "pending";
        if (line.status === "waiting") {
          this.store.setLineStatus(board, line, "waiting", `${seat.label} waits for ${owner.label || shortId(owner.sessionId)} on ${owner.lineId}`);
        } else {
          this.store.appendEvent(board, { kind: "domain-queued", lineId: line.id, sessionId: owner.sessionId, text: seat.label });
        }
        this.store.flush(board);
      }
      return;
    }
    await this.startExpert(board, line, seat, { domainId });
  }

  /** Reuse a live domain expert: send the new task book, no new activation. */
  async dispatchReusedSeat(board, line, seat, role) {
    const manager = await this.managerAgent(board);
    const memoryEntries = this.relayedMemory(board, line);
    const prompt = this.expertPrompt(board, line, seat, memoryEntries);
    role.lineId = line.id;
    role.label = seatLabel(line, seatWho(seat));
    seat.sessionId = role.sessionId;
    seat.status = "running";
    seat.reused = true;
    seat.startedAt = Date.now();
    seat.promptAt = Date.now();
    if (line.status === "waiting") line.round = 0;
    this.store.setLineStatus(board, line, "working", `reused ${seat.label} (${shortId(role.sessionId)})`);
    this.store.flush(board);
    try {
      await this.runtime.sendSubagent(manager, role.sessionId, [{ type: "text", text: prompt }], { signal: undefined });
    } catch (error) {
      role.lineId = "";
      seat.sessionId = "";
      seat.status = "pending";
      this.store.flush(board);
      throw error;
    }
  }

  /** Give an idle domain expert the next task parked for it. */
  async dispatchDomainQueue(board, domainId) {
    const id = str(domainId);
    const domain = board.domains[id];
    if (domain === undefined) return;
    const owner = board.roles[domain.expertSessionId];
    if (owner === undefined || owner.retiredAt !== 0 || owner.lineId !== "") return;
    for (const lineId of board.order) {
      const line = board.lines[lineId];
      if (line === undefined || TERMINAL_STATUS.has(line.status) || line.status === "blocked") continue;
      const seat = line.experts.find((entry) => entry.sessionId === owner.sessionId && entry.status !== "retired" && entry.status !== "running" && entry.reused === true);
      if (seat === undefined) continue;
      try {
        await this.dispatchReusedSeat(board, line, seat, owner);
      } catch (error) {
        this.failLine(board, line, "could not deliver the task to the domain expert: " + String(error && error.message ? error.message : error));
      }
      return;
    }
  }

  /**
   * Advisorily report whether the project memory is still empty. The manager
   * doctrine asks it to bootstrap before development work; this makes the state
   * impossible to miss without blocking a line the user asked for.
   */
  memoryHint(board) {
    const project = board.projectKey === "" ? null : { key: board.projectKey, root: board.projectRoot };
    if (project === null) return "Project memory is unavailable: this session has no identifiable project.";
    try {
      if (!this.store.memory.isEmpty(project)) return "";
    } catch {
      return "";
    }
    return "Project memory is NOT initialized. Consider `swarm_memory action=bootstrap` before development work.";
  }

  /** Routing material for the manager: domains, owners, live consultants. */
  domainReport(board) {
    const live = this.runtime.liveStatus?.() ?? {};
    const rows = this.store.domainRows(board);
    const lines = [];
    lines.push("# Domain routing material");
    lines.push("Judge ownership yourself; the plugin does no keyword matching. Reuse the owner when the domain fits.");
    lines.push("");
    if (rows.length === 0) {
      lines.push("(no domains defined yet)");
    } else {
      for (const domain of rows) {
        const owner = domain.expertSessionId === "" ? null : board.roles[domain.expertSessionId];
        const ownerText = owner === undefined || owner === null || owner.retiredAt > 0
          ? "no live owner"
          : `${owner.label || owner.role} (${shortId(owner.sessionId)}) [${live[owner.sessionId] ?? "unknown"}]` +
            (owner.lineId === "" ? "" : ` on ${owner.lineId}`);
        lines.push(`- ${domain.id}${domain.name !== domain.id ? " (" + domain.name + ")" : ""}: ${domain.responsibility || "(no responsibility recorded)"} — ${ownerText}`);
      }
    }
    const unassigned = Object.values(board.roles).filter((role) => role.role === "expert" && role.retiredAt === 0 && role.domain === "");
    if (unassigned.length > 0) {
      lines.push("");
      lines.push("Live experts without a domain: " + unassigned.map((role) => `${role.label || role.role} (${shortId(role.sessionId)})`).join(", "));
    }
    const resources = Object.values(board.resources);
    if (resources.length > 0) {
      lines.push("");
      lines.push("Shared resources: " + resources.map((resource) => {
        const holder = resource.holder === null ? "free" : `${resource.holder.label || shortId(resource.holder.sessionId)} holds`;
        return `${resource.id} (${holder}${resource.queue.length > 0 ? ", queue " + resource.queue.length : ""})`;
      }).join("; "));
    }
    return lines.join("\n");
  }

  defineDomain(board, input) {
    const domain = this.store.defineDomain(board, input);
    this.store.flush(board);
    return domain;
  }

  bindDomain(board, domainId, sessionId) {
    const id = str(domainId).trim();
    const sid = str(sessionId).trim();
    const role = board.roles[sid];
    if (role === undefined || role.retiredAt !== 0) throw new Error(`bind target must be a live role session; ${sid || "(empty)"} is not`);
    if (role.role !== "expert") throw new Error(`only an expert can own a domain; ${sid} is a ${role.role}`);
    const domain = this.store.bindDomain(board, id, sid);
    this.store.flush(board);
    return domain;
  }
  activeRoles(board) {
    return Object.values(board.roles).filter((role) =>
      role.retiredAt === 0 &&
      role.role !== "manager" &&
      !(role.role === "expert" && role.persistent === true && role.lineId === "")
    ).length;
  }

  /** Start every pending expert seat that capacity allows. */
  async pump(board) {
    const settings = this.settings();
    for (const id of board.order) {
      const line = board.lines[id];
      if (line === undefined || TERMINAL_STATUS.has(line.status) || line.status === "blocked") continue;
      for (const expert of line.experts) {
        if (expert.sessionId !== "" || expert.status === "retired") continue;
        if (this.activeRoles(board) >= settings.maxConcurrent) return;
        await this.startExpert(board, line, expert).catch((error) => {
          this.failLine(board, line, `could not start expert ${expert.label}: ` + String(error && error.message ? error.message : error));
        });
      }
    }
  }

  async startExpert(board, line, expert, options = {}) {
    if (expert === undefined || expert.sessionId !== "" || expert.status === "retired") return;
    const domainId = str(options.domainId, str(expert.domain));
    const key = line.id + "|" + expert.label;
    if (this.starting.has(key)) return;
    this.starting.add(key);
    try {
      const settings = this.settings();
      if (this.activeRoles(board) >= settings.maxConcurrent) {
        expert.status = "pending";
        this.store.flush(board);
        return;
      }
      if (this.store.get(board.boardId) === null) return;
      const memoryEntries = this.relayedMemory(board, line);
      const prompt = this.expertPrompt(board, line, expert, memoryEntries);
      const manager = await this.managerAgent(board);
      const label = seatLabel(line, seatWho(expert));
      const started = await this.runtime.startChild({
        parentAgent: manager,
        preset: EXPERT_PRESET,
        label,
        prompt,
        agentOptions: this.routeOf("expert"),
        maxDepth: EXPERT_MAX_DEPTH,
      });
      if (started !== null && started !== undefined) this.handles.set(started.childId, started);
      this.store.upsertRole(board, {
        sessionId: started.childId,
        role: "expert",
        label,
        lineId: line.id,
        parentSessionId: board.sessionId,
        childId: started.childId,
        provider: this.routeOf("expert")?.provider ?? "",
        model: this.routeOf("expert")?.model ?? "",
        domain: domainId,
        persistent: domainId !== "",
      });
      if (domainId !== "") {
        this.store.defineDomain(board, { id: domainId, name: domainId });
        this.store.bindDomain(board, domainId, started.childId);
      }
      expert.sessionId = started.childId;
      expert.status = "running";
      expert.startedAt = Date.now();
      expert.promptAt = Date.now();
      if (line.status === "waiting" || line.status === "verifying") {
        if (line.status === "waiting") line.round = 0;
        this.store.setLineStatus(board, line, "working", `expert ${label} started (${shortId(started.childId)})`);
      }
      this.store.flush(board);
      this.trackResult(board, board.roles[started.childId], line, started.result);
    } finally {
      this.starting.delete(key);
    }
  }

  /** The memory entries the manager chose to relay, resolved to live text. */
  relayedMemory(board, line) {
    if (line.memoryIds.length === 0) return [];
    const project = board.projectKey === "" ? null : { key: board.projectKey, root: board.projectRoot };
    if (project === null) return [];
    const doc = this.store.memory.view(project);
    if (doc === null) return [];
    return doc.entries.filter((entry) => line.memoryIds.includes(entry.id));
  }

  expertPrompt(board, line, expert, memoryEntries) {
    const project = board.projectKey === "" ? "(unidentified)" : board.projectKey;
    const siblings = line.experts.filter((entry) => entry !== expert);
    const siblingText = siblings.length === 0
      ? ""
      : [
          "## The other experts on this line",
          "This line is a joint delivery. Its other seats:",
          ...siblings.map((entry) => `- ${entry.label}${entry.domain ? " (" + entry.domain + ")" : ""}${entry.focus ? " — " + entry.focus : ""}${entry.sessionId ? " [session " + entry.sessionId + "]" : " [not started yet]"}`),
          "Coordinate with them directly with `swarm_message` (to: their session id or label) instead of routing every exchange through the manager. The verifier judges the COMBINED delivery, so agree on the interface/contract between your parts before you both report.",
          "",
        ];
    const lines = [
      `# ${line.title}${expert.domain ? " · " + expert.domain : ""}`,
      "",
      `You are the EXPERT (executor) — seat ${expert.label}${expert.domain ? " (" + expert.domain + ")" : ""} — on this line. You own your part end to end: investigate, implement and deliver. How you split your own work is yours to decide; you may start subagents.`,
      expert.focus !== "" ? "Your focus for this line: " + expert.focus : "",
      "",
      "## The user's request (verbatim)",
      line.request,
      "",
      "## Acceptance criteria",
      line.acceptance !== "" ? line.acceptance : "(the user did not state criteria; derive them from the request and state them in your report)",
      "",
      "## Boundaries",
      `- Project: ${project}`,
      `- Line id: ${line.id}. Work only within this line's scope; do not touch other lines' work.`,
      line.boundaries !== "" ? "- " + line.boundaries.replace(/\n/g, "\n- ") : "",
      "- How you split this work internally is your decision; do not wait for the manager to script steps.",
      "- The manager issues leases for shared environments (a running service, a build slot, a device). Request one with `swarm_lease action=request resourceId=...` and tell the manager with `swarm_message`; wait for the grant. Do not start, stop or reconfigure a shared service on your own.",
      "- Never modify files outside what the task requires. Be able to explain every write.",
      "",
      siblingText,
      memoryBlock(memoryEntries),
      "## Reporting contract (this is how the board learns anything)",
      "Call `swarm_report` once each time you deliver or are blocked. It takes: summary, artifacts, evidence, blockers, facts, questions.",
      "- summary: what you did and how it meets the acceptance criteria that belong to your part.",
      "- evidence: paths with line numbers, commands, log excerpts, reproduction steps. A conclusion without evidence is not delivered.",
      "- facts: non-obvious things another agent would get wrong (the manager decides whether they belong in project memory; do not call any memory tool yourself).",
      "- blockers: if you cannot finish, say exactly what you need.",
      "The engine waits until EVERY expert on the line has reported, then starts the independent verifier. The report tool wakes the verifier after a rework report and notifies the manager on a blocker or a no-verifier delivery; do not duplicate those messages. After calling `swarm_report`, end your turn.",
      "",
      "You may message any agent with `swarm_message` (ask the verifier for its evidence, coordinate with a sibling expert). Keep it purposeful; every message is recorded.",
      "",
    ];
    return lines.join("\n");
  }

  async startVerifier(board, line) {
    if (!line.useVerifier) return null;
    const last = this.store.lastVerdict(line);
    const rounds = line.verdicts.length;
    line.round = rounds + 1;
    const manager = await this.managerAgent(board);
    const reuse = line.verifierId !== "" && board.roles[line.verifierId] !== undefined && board.roles[line.verifierId].retiredAt === 0;
    if (reuse) {
      // No prompt, no message: the verifier is woken by the experts'
      // swarm_message and reads the latest reports with swarm_status detail.
      this.store.setLineStatus(board, line, "verifying", `verifier re-check (round ${line.round}); wait for an agent message`);
      this.store.flush(board);
      return line.verifierId;
    }
    const prompt = this.verifierPrompt(board, line, last);
    const started = await this.runtime.startChild({
      parentAgent: manager,
      preset: VERIFIER_PRESET,
      label: seatLabel(line, "verifier"),
      prompt,
      agentOptions: this.routeOf("verifier"),
      maxDepth: LEAF_MAX_DEPTH,
    });
    if (started !== null && started !== undefined) this.handles.set(started.childId, started);
    this.store.upsertRole(board, {
      sessionId: started.childId,
      role: "verifier",
      label: seatLabel(line, "verifier"),
      lineId: line.id,
      parentSessionId: board.sessionId,
      childId: started.childId,
      provider: this.routeOf("verifier")?.provider ?? "",
      model: this.routeOf("verifier")?.model ?? "",
    });
    line.verifierId = started.childId;
    this.store.setLineStatus(board, line, "verifying", `verifier started (${shortId(started.childId)})`);
    this.store.flush(board);
    this.trackResult(board, board.roles[started.childId], line, started.result);
    return started.childId;
  }

  verifierPrompt(board, line, previous) {
    const reportText = line.experts
      .filter((expert) => expert.sessionId !== "" && expert.status !== "retired")
      .map((expert) => {
        const report = [...line.reports].reverse().find((entry) => entry.sessionId === expert.sessionId);
        if (report === undefined) return `### ${expert.label}${expert.domain ? " (" + expert.domain + ")" : ""}\n(no report yet)`;
        return [
          `### ${expert.label}${expert.domain ? " (" + expert.domain + ")" : ""} — report ${stamp(report.at)}`,
          report.summary,
          report.artifacts.length > 0 ? "Artifacts: " + report.artifacts.join(", ") : "",
          report.evidence !== "" ? "Evidence: " + report.evidence : "",
          report.blockers !== "" ? "Blockers: " + report.blockers : "",
        ].filter(Boolean).join("\n");
      })
      .join("\n\n");
    const prior = previous === null ? "(this is the first verification round)" : [
      `Round ${previous.round}: ${previous.pass ? "PASS" : "FAIL"}`,
      previous.failures.length > 0 ? "Failures: " + previous.failures.join("; ") : "",
      previous.recheck !== "" ? "What to re-check: " + previous.recheck : "",
    ].filter(Boolean).join("\n");
    const seats = line.experts.map((expert) => `- ${expert.label}${expert.domain ? " (" + expert.domain + ")" : ""}${expert.sessionId ? " [session " + expert.sessionId + "]" : ""}`).join("\n");
    const lines = [
      `# ${line.title} — verification (round ${line.round})`,
      "",
      "You are the INDEPENDENT VERIFIER for this line. You do not trust the experts' narrative: read the artifacts, run the checks yourself, and judge against the acceptance criteria. This is a joint delivery — the reports below belong to different experts.",
      "",
      "## The user's request (verbatim)",
      line.request,
      "",
      "## Acceptance criteria",
      line.acceptance !== "" ? line.acceptance : "(not stated by the user — judge whether the request is met and say which criteria you used)",
      "",
      "## The experts on this line",
      seats,
      "",
      "## Their latest reports",
      reportText !== "" ? reportText : "(no expert has reported yet)",
      "",
      "## Previous verdict",
      prior,
      "",
      "## Your job",
      "1. Verify every criterion against the actual project state (read files, run tests/builds, inspect output). Do not modify the deliverable or its sources.",
      "2. If a piece of evidence is missing, ask the responsible expert directly with `swarm_message` (to: their session id or label) — do not guess.",
      "3. Call `swarm_verdict` exactly once per round with: pass, criteria (criterion / passed / evidence / owner), failures, notes, recheck.",
      "   - Set `owner` on each failed criterion to the expert label (or session id) whose part failed; unowned failures go to every expert.",
      "   - The verdict tool delivers the rework brief to each responsible expert automatically; do not duplicate it with swarm_message.",
      "   - fail means the named experts must fix the listed items; make every failure concrete and re-checkable.",
      "   - If the same failure appears again after a rework, say so explicitly in `notes` and set `recheck` to the reproduction step.",
      "4. If the work cannot be judged because the task itself is ambiguous, fail and say which decision the manager must make.",
      "5. When the expert's report tool wakes you that a fix is ready, read `swarm_status detail <lineId>` for the latest reports, then re-verify.",
      "",
      "You are read-only: there are no write/edit tools in this preset. Running tests and builds is allowed; the artifacts they produce are not deliverables.",
      "",
    ];
    return lines.join("\n");
  }

  // ── results and lifecycle ────────────────────────────────────────────────

  /**
   * Watch one activation result. A settled turn is not necessarily delivery:
   * the report arrives through a tool call. A stall is recorded on the board;
   * the engine never wakes the role or the manager (pm-mode alignment).
   */
  trackResult(board, role, line, result) {
    if (result === undefined || result === null || typeof result.then !== "function") return;
    result.then(
      () => this.onRoleSettled(board, role, line),
      (error) => {
        this.log("warn", "swarm: role " + role.role + " ended with an error: " + String(error && error.message ? error.message : error));
        this.onRoleSettled(board, role, line);
      },
    );
  }

  /**
   * A settled turn is RECORDED, never messaged. The manager reads the board;
   * the engine does not wake agents (pm-mode alignment).
   */
  onRoleSettled(board, role, line) {
    if (role === undefined || role.retiredAt !== 0) return;
    const current = this.store.get(board.boardId);
    if (current === null) return;
    const liveLine = current.lines[line.id];
    if (liveLine === undefined || TERMINAL_STATUS.has(liveLine.status)) return;
    if (role.role === "expert" && (liveLine.status === "working" || liveLine.status === "reworking")) {
      const seat = liveLine.experts.find((entry) => entry.sessionId === role.sessionId);
      if (seat === undefined || seat.status === "retired" || seat.reportedAt !== 0) return;
      const lastReport = [...liveLine.reports].reverse().find((entry) => entry.sessionId === role.sessionId);
      const since = seat.promptAt !== 0 ? seat.promptAt : seat.startedAt;
      if ((lastReport === undefined || lastReport.at < since) && !this.reminded.has(role.sessionId)) {
        this.reminded.add(role.sessionId);
        this.store.appendEvent(current, { kind: "stalled", lineId: liveLine.id, sessionId: role.sessionId, text: `${seat.label} ended its turn without reporting` });
        this.store.flush(current);
      }
    } else if (role.role === "verifier" && liveLine.status === "verifying" && liveLine.verifierId === role.sessionId) {
      const lastVerdict = this.store.lastVerdict(liveLine);
      if ((lastVerdict === undefined || lastVerdict === null || lastVerdict.round < liveLine.round) && !this.reminded.has(role.sessionId)) {
        this.reminded.add(role.sessionId);
        this.store.appendEvent(current, { kind: "stalled", lineId: liveLine.id, sessionId: role.sessionId, text: `verifier ended round ${liveLine.round} without a verdict` });
        this.store.flush(current);
      }
    }
  }

  async handleReport(board, line, sessionId, payload) {
    const seat = line.experts.find((entry) => entry.sessionId === sessionId);
    if (seat === undefined) throw new Error("only an expert seat on this line may report on it");
    if (TERMINAL_STATUS.has(line.status)) throw new Error(`line ${line.id} is already ${line.status}`);
    if (seat.status === "retired") throw new Error(`expert seat ${seat.label} was retired from line ${line.id}`);
    this.store.recordReport(board, line, { ...payload, sessionId });
    seat.reportedAt = Date.now();
    seat.status = "reported";
    this.store.flush(board);
    // Verification already started for this round: record the late report for
    // the board, but do not restart the verifier mid-judgement.
    if (line.status === "verifying") {
      this.store.appendEvent(board, { kind: "line-note", lineId: line.id, text: `${seat.label} reported again while verification was running` });
      this.store.flush(board);
      return this.store.get(board.boardId)?.lines[line.id] ?? line;
    }
    if (payload.blockers !== undefined && String(payload.blockers).trim() !== "") {
      this.store.setLineStatus(board, line, "blocked", `${seat.label} is blocked: ${String(payload.blockers).slice(0, 300)}`);
      this.store.flush(board);
      return this.store.get(board.boardId)?.lines[line.id] ?? line;
    }
    if (line.status === "blocked") {
      // A blocked line becomes active again once an expert reports progress.
      this.store.setLineStatus(board, line, "working", `${seat.label} reported; line resumed`);
    }
    const activeSeats = line.experts.filter((entry) => entry.status !== "retired" && entry.sessionId !== "");
    const waitingSeats = line.experts.filter((entry) => entry.status !== "retired" && entry.sessionId === "");
    const allReported = waitingSeats.length === 0 && activeSeats.length > 0 && activeSeats.every((entry) => entry.reportedAt !== 0);
    if (line.useVerifier) {
      if (!allReported) {
        this.store.appendEvent(board, { kind: "line-note", lineId: line.id, text: `${seat.label} reported; waiting for the other experts` });
        this.store.flush(board);
        return line;
      }
      this.store.setLineStatus(board, line, "verifying", "all experts reported; verifying");
      this.store.flush(board);
      await this.startVerifier(board, line).catch((error) => {
        this.failLine(board, line, "could not start the verifier: " + String(error && error.message ? error.message : error));
      });
    } else if (allReported) {
      this.store.setLineStatus(board, line, "done", "all experts reported (no verifier assigned)");
      this.store.flush(board);
      this.retireLineRoles(board, line);
    } else {
      this.store.appendEvent(board, { kind: "line-note", lineId: line.id, text: `${seat.label} reported; waiting for the other experts` });
      this.store.flush(board);
    }
    return this.store.get(board.boardId)?.lines[line.id] ?? line;
  }

  async handleVerdict(board, line, sessionId, payload) {
    if (line.verifierId !== sessionId) throw new Error("only the line's verifier may issue a verdict");
    if (line.status !== "verifying") throw new Error(`line ${line.id} is ${line.status}; a verdict is only accepted while verifying`);
    const signature = hashSignature([...payload.criteria.filter((item) => item.passed !== true).map((item) => item.criterion), ...(payload.failures ?? [])].join("|"));
    const verdict = this.store.recordVerdict(board, line, {
      ...payload,
      sessionId,
      round: line.round,
      signature,
    });
    if (verdict.pass) {
      this.store.setLineStatus(board, line, "done", "verifier passed");
      this.store.flush(board);
      this.retireLineRoles(board, line);
      return verdict;
    }

    const previous = line.verdicts[line.verdicts.length - 2] ?? null;
    this.store.setLineStatus(board, line, "reworking", "verifier rejected the delivery");

    // Reset the seats that own a failed criterion so their next report closes
    // the rework round. The verdict is delivered by the VERIFIER with
    // swarm_message — the engine never messages an agent (pm-mode alignment).
    const failedCriteria = verdict.criteria.filter((item) => !item.passed);
    const owned = new Set(failedCriteria.map((item) => item.owner).filter((owner) => owner !== ""));
    const seats = line.experts.filter((entry) => entry.status !== "retired" && entry.sessionId !== "");
    let targets = seats;
    if (owned.size > 0) {
      const matched = seats.filter((entry) => owned.has(entry.label) || owned.has(entry.sessionId));
      if (matched.length > 0) targets = matched;
    }
    if (targets.length === 0) {
      this.failLine(board, line, "the verifier rejected the delivery but no expert is available to rework it");
      return verdict;
    }
    for (const seat of targets) {
      seat.reportedAt = 0;
      seat.status = "running";
    }
    this.store.appendEvent(board, {
      kind: "verdict-fail",
      lineId: line.id,
      text: `round ${verdict.round}: ${verdict.failures.join("; ") || verdict.notes}`,
    });
    if (previous !== null && previous.pass === false && previous.signature !== "" && previous.signature === verdict.signature) {
      this.store.appendEvent(board, {
        kind: "escalation",
        lineId: line.id,
        text: `round ${verdict.round} repeated the failure signature of round ${previous.round}`,
      });
    }
    this.store.flush(board);
    return verdict;
  }

  /** Retire a line's role agents; persistent domain experts stay resident. */
  retireLineRoles(board, line) {
    const now = this.clock();
    const disposers = [];
    const freedDomains = new Set();
    for (const seat of line.experts) {
      if (seat.status !== "retired") seat.status = "retired";
    }
    for (const role of Object.values(board.roles)) {
      if (role.lineId !== line.id || role.retiredAt !== 0 || role.role === "manager") continue;
      // A finished line must not keep a shared backend checked out. Release and
      // queue promotion are state changes only; the engine never messages.
      const leases = this.store.releaseBySession(board, role.sessionId);
      for (const released of leases.released) {
        this.store.appendEvent(board, { kind: "lease-released", lineId: line.id, text: `${released.id} released when the line closed` });
      }
      for (const promoted of leases.promoted) {
        this.store.appendEvent(board, { kind: "lease-promoted", lineId: promoted.holder.lineId, text: `${promoted.id} promoted to ${promoted.holder.label || promoted.holder.sessionId}` });
      }
      const domain = role.domain === "" ? null : board.domains[role.domain];
      if (role.role === "expert" && role.persistent === true && domain !== undefined && domain !== null && domain.expertSessionId === role.sessionId) {
        // pm-mode alignment: a domain owner stays resident and takes the next
        // same-domain task with its context intact.
        role.lineId = "";
        freedDomains.add(role.domain);
        this.store.appendEvent(board, { kind: "expert-idle", lineId: line.id, sessionId: role.sessionId, text: role.label || role.role });
        continue;
      }
      role.retiredAt = now;
      const handle = this.handles?.get(role.sessionId);
      this.handles?.delete(role.sessionId);
      if (handle !== undefined) disposers.push(handle);
      this.store.appendEvent(board, { kind: "role-retired", sessionId: role.sessionId, lineId: line.id, text: role.label || role.role });
    }
    this.store.flush(board);
    // Dispose AFTER the tool call that closed the line has returned its result:
    // the verdict/report was issued from inside the child's own turn, and
    // cancelling the activation synchronously would kill that turn before the
    // model sees the receipt. Retiring the slot now still frees capacity.
    if (disposers.length > 0) {
      const timer = setTimeout(() => {
        for (const handle of disposers) {
          try {
            handle.dispose();
          } catch {
            /* the child may already be gone */
          }
        }
      }, 3000);
      timer.unref?.();
    }
    for (const domainId of freedDomains) {
      this.dispatchDomainQueue(board, domainId).catch(() => {});
    }
    // A finished line frees capacity: start whatever is waiting behind it.
    this.pump(board).catch(() => {});
  }

  /** The manager adds an expert seat to an existing line (joint delivery). */
  async assignExpert(board, line, input) {
    if (TERMINAL_STATUS.has(line.status)) throw new Error(`line ${line.id} is ${line.status}`);
    const domain = str(input.domain);
    if (domain !== "" && line.experts.some((entry) => entry.status !== "retired" && entry.domain === domain)) {
      throw new Error(`line ${line.id} already has a seat for domain "${domain}"`);
    }
    const seat = this.store.addExpert(board, line, input);
    if (line.status === "blocked") this.store.setLineStatus(board, line, "working", "expert added by the manager");
    this.store.flush(board);
    await this.routeSeat(board, line, seat).catch((error) => {
      this.failLine(board, line, `could not start expert ${seat.label}: ` + String(error && error.message ? error.message : error));
    });
    this.pump(board).catch(() => {});
    return seat;
  }

  /** The manager removes one expert seat; its leases are released. */
  removeExpert(board, line, wanted) {
    const key = str(wanted).trim();
    const seat = line.experts.find((entry) => entry.status !== "retired" && (entry.sessionId === key || entry.label === key));
    if (seat === undefined) throw new Error(`line ${line.id} has no live expert "${key}"`);
    seat.status = "retired";
    let freedDomain = "";
    if (seat.sessionId !== "") {
      const role = board.roles[seat.sessionId];
      // A queued reuse seat points at an expert that is still on ANOTHER line:
      // removing the seat must only detach it, never release that line's leases
      // or retire/free its owner.
      const queuedForOtherLine = seat.reused === true && role !== undefined && role.lineId !== line.id;
      if (role !== undefined && role.retiredAt === 0 && !queuedForOtherLine) {
        const leases = this.store.releaseBySession(board, seat.sessionId);
        for (const released of leases.released) {
          this.store.appendEvent(board, { kind: "lease-released", lineId: line.id, text: `${released.id} released when ${seat.label} was removed` });
        }
        for (const promoted of leases.promoted) {
          this.store.appendEvent(board, { kind: "lease-promoted", lineId: promoted.holder.lineId, text: `${promoted.id} promoted to ${promoted.holder.label || promoted.holder.sessionId}` });
        }
        const domain = role.domain === "" ? null : board.domains[role.domain];
        if (role.role === "expert" && role.persistent === true && domain !== undefined && domain !== null && domain.expertSessionId === role.sessionId) {
          role.lineId = "";
          freedDomain = role.domain;
          this.store.appendEvent(board, { kind: "expert-idle", lineId: line.id, sessionId: role.sessionId, text: role.label || role.role });
        } else {
          role.retiredAt = this.clock();
          const handle = this.handles?.get(seat.sessionId);
          this.handles?.delete(seat.sessionId);
          if (handle !== undefined) {
            const timer = setTimeout(() => {
              try {
                handle.dispose();
              } catch {
                /* already gone */
              }
            }, 3000);
            timer.unref?.();
          }
        }
      }
    }
    const remaining = line.experts.filter((entry) => entry.status !== "retired" && entry.sessionId !== "");
    if (remaining.length === 0) {
      this.store.setLineStatus(board, line, "blocked", `all experts were removed from this line`);
    }
    this.store.flush(board);
    if (freedDomain !== "") this.dispatchDomainQueue(board, freedDomain).catch(() => {});
    this.pump(board).catch(() => {});
    return seat;
  }

  /** The manager forces verification even if not every seat has reported. */
  async forceVerify(board, line) {
    if (TERMINAL_STATUS.has(line.status)) throw new Error(`line ${line.id} is ${line.status}`);
    if (line.reports.length === 0) throw new Error("no expert has reported yet; there is nothing to verify");
    this.store.setLineStatus(board, line, "verifying", "verification requested by the manager");
    this.store.flush(board);
    await this.startVerifier(board, line);
    return line;
  }

  // ── shared-resource leases ───────────────────────────────────────────────

  defineLease(board, input) {
    const resource = this.store.defineResource(board, input);
    this.store.flush(board);
    return resource;
  }

  /** Manager hands a lease to one agent. State only: tell the holder yourself. */
  async grantLease(board, input) {
    const target = str(input.sessionId);
    if (target !== board.sessionId && board.roles[target] === undefined) {
      throw new Error(`grant target must be a role session on this board (expert/verifier/memory); got ${target || "(empty)"}`);
    }
    const result = this.store.grantResource(board, input);
    this.store.flush(board);
    return result;
  }

  /** Manager takes a lease back; the queue head may be promoted. State only. */
  async revokeLease(board, resourceId) {
    const result = this.store.revokeResource(board, { id: resourceId });
    this.store.flush(board);
    return result;
  }

  async grantNextLease(board, resourceId) {
    const result = this.store.grantNext(board, { id: resourceId });
    this.store.flush(board);
    return result;
  }

  /** A worker asks for a lease: enqueue only; the worker tells the manager. */
  async requestLease(board, seat, lineId, resourceId, note) {
    const result = this.store.requestResource(board, {
      id: resourceId,
      sessionId: seat.sessionId,
      lineId: str(lineId),
      label: seat.label,
    });
    this.store.flush(board);
    return result;
  }

  /** The holder releases a lease; state only, no notification. */
  async releaseLease(board, seat, lineId, resourceId) {
    const result = this.store.releaseResource(board, { id: resourceId, sessionId: seat.sessionId });
    this.store.flush(board);
    return result;
  }

  failLine(board, line, reason) {
    this.store.setLineStatus(board, line, "blocked", reason);
    this.store.flush(board);
  }

  // ── message bus ──────────────────────────────────────────────────────────

  /**
   * Resolve a message target. Accepted forms: `manager`, a role name
   * (`expert` / `verifier` / `memory`, scoped to lineId when given), a line id
   * (its expert), or a session id.
   */
  resolveTarget(board, to, lineId = "") {
    const wanted = str(to).trim();
    if (wanted === "") throw new Error("swarm_message needs a target (manager, expert, verifier, memory, a line id, or a session id)");
    const lower = wanted.toLowerCase();
    if (lower === "manager" || wanted === board.sessionId) return { kind: "manager", sessionId: board.sessionId, label: "Manager", role: "manager" };
    if (board.roles[wanted] !== undefined) {
      const role = board.roles[wanted];
      return { kind: "role", sessionId: role.sessionId, label: role.label || role.role, role: role.role };
    }
    // A seat label ("frontend") is a natural way to address a joint-line expert;
    // accept it when exactly one live seat carries that label.
    const seats = Object.values(board.lines)
      .flatMap((line) => line.experts)
      .filter((expert) => expert.status !== "retired" && expert.sessionId !== "" && expert.label === wanted);
    if (seats.length === 1) {
      return { kind: "role", sessionId: seats[0].sessionId, label: seats[0].label, role: "expert" };
    }
    if (seats.length > 1) {
      throw new Error(`more than one live expert is labelled "${wanted}"; address one by session id: ${seats.map((seat) => seat.sessionId).join(", ")}`);
    }
    if (lower === "expert" || lower === "verifier" || lower === "memory") {
      let candidates = Object.values(board.roles).filter((role) => role.role === lower && role.retiredAt === 0);
      if (lineId !== "") candidates = candidates.filter((role) => role.lineId === lineId);
      if (candidates.length === 1) {
        const role = candidates[0];
        return { kind: "role", sessionId: role.sessionId, label: role.label || role.role, role: role.role };
      }
      if (candidates.length === 0) throw new Error(`no live ${lower} on this board${lineId ? " for line " + lineId : ""}`);
      throw new Error(`more than one live ${lower}; name one by session id: ${candidates.map((role) => `${role.sessionId}(${role.lineId})`).join(", ")}`);
    }
    if (board.lines[wanted] !== undefined) {
      const target = board.lines[wanted];
      const seats = target.experts.filter((expert) => expert.sessionId !== "" && expert.status !== "retired");
      if (seats.length === 1) {
        const seat = seats[0];
        return { kind: "role", sessionId: seat.sessionId, label: seat.label, role: "expert" };
      }
      if (seats.length === 0) throw new Error(`line ${wanted} has no live expert yet`);
      throw new Error(
        `line ${wanted} has ${seats.length} experts; address one by session id or label: ` +
          seats.map((seat) => `${seat.label}=${seat.sessionId}`).join(", "),
      );
    }
    throw new Error(`unknown target: ${wanted}. Use manager, a role name, a line id, or a session id.`);
  }

  /**
   * Fallback target resolution: a session id anywhere under the manager,
   * including the experts' own subagents. The bus is all-to-all, so a role can
   * message one of those helpers by id; the engine delivers through the
   * helper's direct parent (the only legal adjacent sender).
   */
  async resolveDescendantTarget(board, wanted) {
    const id = str(wanted).trim();
    if (id === "") return null;
    let rows = [];
    try {
      rows = await this.runtime.listDescendants(board.sessionId);
    } catch {
      return null;
    }
    const found = rows.find((row) => row.sessionId === id || (row.label !== "" && row.label === id));
    if (found === undefined) return null;
    return {
      kind: "subagent",
      sessionId: found.sessionId,
      label: found.label || "subagent",
      role: "subagent",
      parentSessionId: found.parentSessionId ?? "",
    };
  }

  /** Deliver a free-form message and record it on the board. */
  async deliverMessage(board, from, to, text, options = {}) {
    let target;
    try {
      target = this.resolveTarget(board, to, str(options.lineId));
    } catch (error) {
      target = await this.resolveDescendantTarget(board, to);
      if (target === null) throw error;
    }
    const fromSession = str(from.sessionId);
    const fromRole = str(from.role);
    const fromLabel = str(from.label, fromSession);
    const body = str(text).trim();
    if (body === "") throw new Error("swarm_message needs text");
    if (target.sessionId === fromSession) throw new Error("cannot send a message to yourself");
    const envelope = `[swarm] from ${fromLabel} (${fromRole}${from.lineId ? ", line " + from.lineId : ""})\n${body}`;
    const mode = options.mode === "steer" ? "steer" : "queue";
    const message = this.store.appendMessage(board, {
      from: fromSession,
      fromRole,
      to: target.sessionId,
      toRole: target.role,
      lineId: str(options.lineId),
      kind: str(options.kind, "fyi"),
      text: body,
      mode,
    });
    this.store.flush(board);
    if (target.kind === "manager") {
      const manager = await this.managerAgent(board);
      await this.runtime.sendToManager(manager, [{ type: "text", text: envelope }], { kind: "agent-message", form: "relay", senderSessionId: fromSession });
    } else if (target.kind === "subagent") {
      if (target.parentSessionId === "") throw new Error(`cannot deliver to ${target.sessionId}: its parent session is unknown`);
      const parent = await this.runtime.resolveAgent(target.parentSessionId);
      if (parent === undefined || parent === null) throw new Error(`cannot deliver to ${target.sessionId}: its parent session ${shortId(target.parentSessionId)} is not live`);
      await this.runtime.sendSubagent(parent, target.sessionId, [{ type: "text", text: envelope }], { signal: undefined });
    } else {
      const manager = await this.managerAgent(board);
      await this.runtime.sendSubagent(manager, target.sessionId, [{ type: "text", text: envelope }], { signal: undefined });
    }
    return { messageId: message.id, to: target.sessionId, toRole: target.role };
  }

  // ── memory ───────────────────────────────────────────────────────────────

  /** The memory keeper session for this board, if one is live. */
  memoryKeeper(board) {
    return Object.values(board.roles).find((role) => role.role === "memory" && role.retiredAt === 0) ?? null;
  }

  /** Start the memory keeper (bootstrap or later maintenance). */
  async startMemoryKeeper(board, scope = "") {
    if (board.projectKey === "") {
      throw new Error("this session has no identifiable project, so project memory has no home; start the session inside a project directory (or one carrying a marker)");
    }
    const existing = this.memoryKeeper(board);
    if (existing !== null) return existing;
    const project = board.projectKey === "" ? null : { key: board.projectKey, root: board.projectRoot };
    const name = project === null ? "(unidentified project)" : (project.root.split(/[\\/]/).pop() || project.key);
    const prompt = [
      `# Memory keeper — project ${name}`,
      `Project root: ${project === null ? "(unidentified)" : project.root}`,
      `Project key: ${project === null ? "(none)" : project.key}`,
      "",
      "You are the project's MEMORY KEEPER. You are the only writer of project memory and the only fact checker.",
      "",
      "## Your standing job",
      "- The project memory is empty (bootstrap) or the manager asked you to explore. Bootstrap is NOT a project survey: look only for the non-obvious traps. Zero entries is a valid bootstrap; an empty memory is better than a common-sense dump.",
      "- The manager may send you write requests by `swarm_message`: fact-check each one, then write it or reject it with a reason; after the decision, message the manager with the outcome. The engine does not notify you or the manager.",
      "",
      "## What belongs in memory (the delete test)",
      "Only what a competent agent would get WRONG without being told:",
      "- credentials or tokens valid only here, and where they unlock something;",
      "- a domain's required ordering, the step everyone skips, a format something downstream string-matches;",
      "- a measured fact that contradicts the obvious reading (a command that reports success while doing nothing, a cache that lies);",
      "- a conclusion already proven with evidence.",
      "NOT: how a repository is laid out, build/test commands, how a common tool is used, board or session history, status narration, anything a competent agent arrives at unaided.",
      "Also NOT a chosen approach, an architecture preference or a plan (\"this project uses X\"): the entry is relayed into later task books and would pin the next expert to the previous expert's idea. Record what FAILED and why, not what was chosen.",
      "Evidence is necessary, not sufficient: a well-evidenced fact that the next agent would arrive at unaided still does not go in. When in doubt, leave it out.",
      "Reject a manager request that fails the delete test even if its evidence is impeccable.",
      "",
      "## The write contract",
      "For every entry: verify it YOURSELF (read files, run commands, inspect logs), then call `swarm_memory_admin` with action=write, title, text, kind (token/gotcha/recipe/finding), tags, evidence, and verifiedAt (now, epoch ms). An entry without evidence does not get written.",
      "Never modify project source files. Read-only exploration plus test commands is your whole toolbox.",
      "",
      "## Reporting",
      "When the bootstrap is complete, send the manager a short `swarm_message` (to: manager) with the number of entries, their topics, and anything you could not verify. If nothing survived the gate, say so plainly — \"0 entries\" is a correct bootstrap result. Do not report process.",
      scope !== "" ? "\n## Additional scope from the manager\n" + scope : "",
      "",
    ].join("\n");
    const manager = await this.managerAgent(board);
    const started = await this.runtime.startChild({
      parentAgent: manager,
      preset: MEMORY_PRESET,
      label: "Memory Keeper",
      prompt,
      agentOptions: this.routeOf("memory"),
      maxDepth: LEAF_MAX_DEPTH,
    });
    if (started !== null && started !== undefined) this.handles.set(started.childId, started);
    this.store.upsertRole(board, {
      sessionId: started.childId,
      role: "memory",
      label: "Memory Keeper",
      lineId: "",
      parentSessionId: board.sessionId,
      childId: started.childId,
      provider: this.routeOf("memory")?.provider ?? "",
      model: this.routeOf("memory")?.model ?? "",
    });
    this.store.appendEvent(board, { kind: "memory-keeper-started", sessionId: started.childId, text: "bootstrapping project memory" });
    this.store.flush(board);
    this.trackResult(board, board.roles[started.childId], { id: "" }, started.result);
    return board.roles[started.childId];
  }

  /** Manager requests one memory write; the keeper fact-checks it. */
  async requestMemoryWrite(board, input, managerSessionId) {
    const title = str(input.title).trim();
    const text = str(input.text).trim();
    if (title === "" || text === "") throw new Error("a memory write request needs both a title and a body");
    const evidence = str(input.evidence).trim();
    if (evidence === "") {
      throw new Error("a memory write request needs evidence (paths, commands, logs) — the keeper will not accept an unverifiable claim");
    }
    const request = this.store.addMemoryRequest(board, {
      title,
      text,
      kind: str(input.kind, "finding"),
      tags: input.tags,
      evidence,
      lineId: str(input.lineId),
      requesterSessionId: managerSessionId,
    });
    this.store.flush(board);
    return request;
  }

  // ── read models ──────────────────────────────────────────────────────────

  /**
   * `snapshot` (default), `delta`, `detail`, `agents`.
   *
   * The snapshot is deliberately compact: the manager can always re-fetch it,
   * so the model never needs to keep project state in its head.
   */
  async status(board, input = {}) {
    const mode = str(input.mode, "snapshot");
    const live = this.live();
    if (mode === "delta") {
      const delta = this.store.delta(board, num(input.since, 0));
      return { mode, ...delta, counts: this.store.summary(board, live).counts };
    }
    if (mode === "detail") {
      const lineId = str(input.lineId);
      if (lineId === "") throw new Error("swarm_status mode=detail needs lineId");
      return { mode, ...this.store.detail(board, lineId, live) };
    }
    if (mode === "agents") {
      let descendants = [];
      try {
        descendants = await this.runtime.listDescendants(board.sessionId);
      } catch {
        descendants = [];
      }
      return { mode, agents: this.store.agentsView(board, live, descendants), revision: board.revision };
    }
    const summary = this.store.summary(board, live);
    const project = board.projectKey === "" ? null : { key: board.projectKey, root: board.projectRoot };
    let memory = { initialized: false, total: 0, entries: [] };
    if (project !== null) {
      try {
        const doc = this.store.memory.view(project);
        memory = {
          initialized: doc !== null && doc.entries.length > 0,
          total: doc === null ? 0 : doc.entries.length,
          entries: doc === null ? [] : doc.entries.slice(-8).map((entry) => ({ id: entry.id, title: entry.title, kind: entry.kind })),
        };
      } catch {
        memory = { initialized: false, total: 0, entries: [] };
      }
    }
    return {
      mode,
      ...summary,
      memory: {
        initialized: memory.initialized,
        total: memory.total,
        entries: memory.entries,
        pendingRequests: summary.memory?.pendingRequests ?? 0,
        pending: summary.memory?.pending ?? [],
      },
      revision: board.revision,
    };
  }

  /** Render a compact snapshot as text for the model. */
  renderSnapshot(snapshot) {
    const lines = [];
    const counts = snapshot.counts ?? {};
    const project = snapshot.projectKey || "(unidentified project)";
    const memory = snapshot.memory ?? { initialized: false, total: 0 };
    lines.push(
      `SWARM — ${snapshot.title} | project ${project} | lines ${counts.total ?? 0} (working ${counts.working ?? 0}, verifying ${counts.verifying ?? 0}, reworking ${counts.reworking ?? 0}, blocked ${counts.blocked ?? 0}, done ${counts.done ?? 0}) | revision ${snapshot.revision}`,
    );
    lines.push(`Memory: ${memory.initialized ? memory.total + " entries" : "NOT INITIALIZED — dispatch the memory keeper before development work"} | pending write requests: ${snapshot.memory?.pendingRequests ?? 0}`);
    if (Array.isArray(snapshot.domains) && snapshot.domains.length > 0) {
      lines.push("Domains: " + snapshot.domains.map((domain) =>
        `${domain.id} → ${domain.expertRetired ? "unowned" : (domain.expertLabel || shortId(domain.expertSessionId)) + "[" + (domain.status || "unknown") + "]"}`,
      ).join(" | "));
    }
    lines.push("You are the dispatcher: report this board; do not execute the work yourself. Dispatch substantive requests with swarm_line.");
    if (snapshot.lines.length === 0) {
      lines.push("(no task lines yet)");
    } else {
      for (const line of snapshot.lines) {
        const experts = line.experts.length === 0
          ? "experts: -"
          : "experts " + line.experts.map((expert) => `${expert.label}[${expert.status}${expert.reported ? ",reported" : ""}]${expert.sessionId ? "@" + shortId(expert.sessionId) : ""}`).join(" + ");
        const verifier = line.useVerifier ? (line.verifier === null ? "verifier: -" : `verifier ${line.verifier.label || shortId(line.verifier.sessionId)} [${line.verifier.status}]`) : "verifier: -";
        const verdict = line.lastVerdict === null ? "" : ` | last verdict ${line.lastVerdict.pass ? "PASS" : "FAIL"}` + (line.lastVerdict.failures?.length ? ": " + line.lastVerdict.failures.join("; ") : "");
        const report = line.lastReport === null ? "" : ` | report: ${line.lastReport.summary.slice(0, 120)}`;
        lines.push(`- ${line.id} [${line.status}] ${line.title} | ${experts} | ${verifier} | round ${line.round}${verdict}${report}${line.blockedReason ? " | BLOCKED: " + line.blockedReason : ""}`);
      }
    }
    if (snapshot.memory?.pending?.length > 0) {
      lines.push("Pending memory requests: " + snapshot.memory.pending.map((item) => `${item.id} ${item.title}`).join(" | "));
    }
    if (snapshot.resources?.length > 0) {
      lines.push(
        "Resources: " +
          snapshot.resources
            .map((resource) => `${resource.id}: ${resource.holder ? (resource.holder.label || shortId(resource.holder.sessionId)) + " holds" : "free"}` + (resource.queue.length > 0 ? ` (queue ${resource.queue.length})` : ""))
            .join(" | "),
      );
    }
    return lines.join("\n");
  }

  /** Render one line's history for the model. */
  renderDetail(detail) {
    const line = detail.line;
    const labelOfSession = (sessionId) => line.experts.find((expert) => expert.sessionId === sessionId)?.label || shortId(sessionId);
    const rows = [];
    rows.push(`Line ${line.id} [${line.status}] ${line.title}`);
    rows.push(`Request: ${line.request}`);
    rows.push(`Acceptance: ${line.acceptance || "(not stated)"}`);
    rows.push(
      "Experts: " +
        (line.experts.length === 0 ? "-" : line.experts.map((expert) => `${expert.label}${expert.domain ? " (" + expert.domain + ")" : ""} [${expert.status}]${expert.sessionId ? " @ " + expert.sessionId : ""}`).join(" + ")),
    );
    rows.push(`Round: ${line.round} | verifier: ${line.useVerifier ? "assigned" : "none"} | relayed memory: ${line.memoryIds.length}`);
    if (line.blockedReason !== "") rows.push(`Blocked: ${line.blockedReason}`);
    for (const expert of line.experts) {
      if (expert.focus !== "") rows.push(`  ${expert.label} focus: ${expert.focus}`);
    }
    for (const report of line.reports.slice(-4)) {
      rows.push(`\nReport ${stamp(report.at)} — ${labelOfSession(report.sessionId)}: ${report.summary}`);
      if (report.artifacts.length > 0) rows.push(`  artifacts: ${report.artifacts.join(", ")}`);
      if (report.evidence !== "") rows.push(`  evidence: ${report.evidence}`);
      if (report.blockers !== "") rows.push(`  blockers: ${report.blockers}`);
      if (report.facts.length > 0) rows.push(`  facts: ${report.facts.join(" | ")}`);
    }
    for (const verdict of line.verdicts.slice(-3)) {
      rows.push(`\nVerdict round ${verdict.round} ${stamp(verdict.at)}: ${verdict.pass ? "PASS" : "FAIL"}`);
      for (const criterion of verdict.criteria) {
        rows.push(`  [${criterion.passed ? "x" : " "}] ${criterion.criterion}${criterion.owner ? " (" + criterion.owner + ")" : ""}${criterion.evidence ? " — " + criterion.evidence : ""}`);
      }
      if (verdict.failures.length > 0) rows.push(`  failures: ${verdict.failures.join("; ")}`);
      if (verdict.recheck !== "") rows.push(`  recheck: ${verdict.recheck}`);
    }
    if (detail.messages.length > 0) {
      rows.push("\nRecent messages:");
      for (const message of detail.messages.slice(-8)) rows.push(`  ${stamp(message.at)} ${message.fromRole || shortId(message.from)} -> ${message.toRole || shortId(message.to)} [${message.kind}] ${message.text.slice(0, 200)}`);
    }
    if (detail.decisions.length > 0) {
      rows.push("\nDecisions:");
      for (const decision of detail.decisions) rows.push(`  ${stamp(decision.at)} ${decision.text}`);
    }
    if (detail.resources !== undefined && detail.resources.length > 0) {
      rows.push("\nResources:");
      for (const resource of detail.resources) {
        rows.push(`  ${resource.id}: ${resource.holder ? (resource.holder.label || shortId(resource.holder.sessionId)) + " holds" : "free"}` + (resource.queue.length > 0 ? ` | queue ${resource.queue.map((entry) => entry.label || shortId(entry.sessionId)).join(" -> ")}` : ""));
      }
    }
    return rows.join("\n");
  }
}
