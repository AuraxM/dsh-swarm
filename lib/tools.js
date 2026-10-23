/**
 * dsh-swarm — model-facing tools.
 *
 * Every definition is raw JSON Schema. Hand-written schemas are deliberate:
 * this package must load as a workspace link (a junction) where
 * `@deepseek-ai/*` imports do not resolve, and the tool registry consumes raw
 * JSON Schema anyway. The registry validates the OUTPUT schema; the PARAMETER
 * schema must already carry a root `"type": "object"`, which these do.
 *
 * Tools are split by role. A preset registers only its own role's toolset, so a
 * worker never even sees the manager's dispatch surface, and the manager never
 * sees a shell.
 *
 * @module dsh-swarm/tools
 */
import { MESSAGE_KIND, MEMORY_KIND } from "./store.js";

function str(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function stamp(ms) {
  if (!ms) return "-";
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function shortId(id) {
  const text = str(id);
  return text.length > 12 ? text.slice(0, 12) : text;
}

function lineOutput(text) {
  return {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: String(value ?? "") }],
  };
}

/** One tool definition in the shape the runtime consumes. */
function tool(name, description, parameters, execute, output = lineOutput("")) {
  return { name, description, parameters: { type: "object", additionalProperties: false, ...parameters }, output, execute };
}

/** Resolve the project a memory action is about. */
function projectOf(store, board, explicit = "") {
  const named = str(explicit).trim();
  if (named !== "") {
    const resolved = store.memory.resolveNamed(named);
    if (resolved.key !== "") return resolved;
  }
  if (board.projectKey !== "") {
    return { key: board.projectKey, root: board.projectRoot, name: board.projectRoot === "" ? board.projectKey : board.projectRoot.split(/[\\/]/).pop() };
  }
  throw new Error(
    "this session is not attached to an identifiable project, so project memory has no home. " +
      "Start the session in a project directory that carries a marker (.git, package.json, Cargo.toml, p4config.txt, ...) " +
      "or pass project=<absolute path>.",
  );
}

/** Render a project memory index. */
function renderMemoryIndex(result) {
  if (result.project === null) return "No project identity — memory is unavailable for this session.";
  const lines = [`Project ${result.project.name || result.project.key} (${result.project.root || result.project.key}) — ${result.total} entries.`];
  if (result.total === 0) {
    lines.push("(empty — dispatch the memory keeper with swarm_memory action=bootstrap)");
    return lines.join("\n");
  }
  for (const match of result.matches) {
    const entry = match.entry;
    lines.push(`- [${entry.id}]${entry.kind ? " [" + entry.kind + "]" : ""} ${entry.title}` + (entry.tags.length > 0 ? " #" + entry.tags.join(" #") : "") + (entry.hits > 0 ? ` (used ${entry.hits}x)` : ""));
  }
  lines.push("");
  lines.push("Use swarm_memory action=recall query=<words> to read a body; relay only the entries that would change how the line is executed.");
  return lines.join("\n");
}

/** Render full recall hits. */
function renderMemoryHits(result, query) {
  if (result.project === null) return "No project identity — memory is unavailable for this session.";
  const lines = [`Project ${result.project.name || result.project.key} — ${result.total} entries.`];
  if (result.total === 0) return lines.concat("(empty — dispatch the memory keeper with swarm_memory action=bootstrap)").join("\n");
  if (result.matches.length === 0) return lines.concat(`No entry matched "${str(query)}". Try swarm_memory action=list.`).join("\n");
  lines.push(`${result.matches.length} match(es):`);
  for (const match of result.matches) {
    const entry = match.entry;
    lines.push("");
    lines.push(`[${entry.id}]${entry.kind ? " [" + entry.kind + "]" : ""} ${entry.title}` + (entry.tags.length > 0 ? " #" + entry.tags.join(" #") : ""));
    lines.push(entry.text);
    if (entry.evidence !== "") lines.push(`  evidence: ${entry.evidence}`);
    if (entry.verifiedAt !== 0) lines.push(`  verified: ${stamp(entry.verifiedAt)} by ${entry.verifiedBy || "memory keeper"}`);
  }
  lines.push("");
  lines.push("These are recorded conclusions, not current observations: when they conflict with what you observe, trust the observation and ask the memory keeper to correct the entry.");
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// Manager tools
// ────────────────────────────────────────────────────────────────────────────

function managerStatusTool(engine) {
  return tool(
    "swarm_status",
    "Read the project picture. mode=snapshot (default) returns the whole project: lines with their expert seats and verifier, status, round, last verdict and last report, plus the role roster, memory state and leases. " +
      "mode=delta returns only events after a revision cursor (use this to follow changes instead of re-reading everything). " +
      "mode=detail lineId=... returns one line's per-seat reports, verdicts and messages. mode=agents returns every agent incl. the experts' own subagents.",
    {
      properties: {
        mode: { type: "string", enum: ["snapshot", "delta", "detail", "agents"], description: "View to read; defaults to snapshot." },
        lineId: { type: "string", description: "detail mode: the line to inspect." },
        since: { type: "number", description: "delta mode: last revision the caller saw." },
      },
      required: ["mode"],
    },
    async (args, exec) => {
      const { board } = await engine.attach(exec, "manager");
      const result = await engine.status(board, args);
      if (result.mode === "delta") {
        const rows = [`Changes after revision ${result.from} (now ${result.revision}):`];
        if (result.events.length === 0) rows.push("(nothing changed)");
        for (const event of result.events) rows.push(`- r${event.rev} ${stamp(event.at)} ${event.kind}${event.lineId ? " " + event.lineId : ""}${event.text ? ": " + event.text : ""}`);
        return rows.join("\n");
      }
      if (result.mode === "detail") return engine.renderDetail(result);
      if (result.mode === "agents") {
        if (result.agents.length === 0) return "(no agents)";
        return result.agents.map((agent) => `- ${agent.role} ${agent.label} (${shortId(agent.sessionId)})${agent.lineId ? " line " + agent.lineId : ""} | ${agent.status}${agent.model ? " | " + agent.model : ""}`).join("\n");
      }
      return engine.renderSnapshot(result);
    },
  );
}

function managerLineTool(engine) {
  return tool(
    "swarm_line",
    "DISPATCH ONLY — you never perform the request yourself. " +
      "Create and steer task lines. Before the first line, start the memory keeper and wait for its report (see swarm_memory). One user request = one line; a line may have ONE OR SEVERAL expert seats (a joint delivery, e.g. frontend + backend), and an optional independent verifier judges the combined delivery. The engine loops rework until it passes. " +
      "action=create: title + request (the user's words, verbatim) + acceptance + boundaries; experts=[{label,domain,focus}] for a joint line (omit for one expert); verifier=auto|required|none. " +
      "domain (or experts[].domain) routes the seat: a live expert bound to that domain is reused with its context; a busy one queues this line; an unowned domain starts a new expert and binds it. " +
      "memoryIds: the project-memory entries you chose to relay — the engine injects their text into every expert's task book, so pass ids, never pasted text. " +
      "action=add-expert / remove-expert: adjust the team after creation (the manager decides the collaboration shape). action=verify: force verification before every seat reports. " +
      "action=assign role=verifier: restart/replace the line's single verifier (never adds a second). action=verify: force verification before every seat reports. " +
      "Shared resources (a backend instance, a build slot, a device): action=define-resource once, then action=grant to an agent session; workers request a lease with swarm_lease, action=revoke takes it back, action=grant-next hands a free lease to the queue head.",
    {
      properties: {
        action: {
          type: "string",
          enum: ["create", "add-expert", "remove-expert", "assign", "verify", "abort", "decide", "note", "define-resource", "grant", "grant-next", "revoke", "release"],
          description: "Operation.",
        },
        title: { type: "string", description: "create: short line title." },
        request: { type: "string", description: "create: the user's request, verbatim. This becomes the experts' task book; do not rewrite it into your own implementation plan." },
        acceptance: { type: "string", description: "create: acceptance criteria in the user's terms." },
        boundaries: { type: "string", description: "create: boundaries the expert must respect (what may be changed, whether the environment may be used, whether to commit)." },
        domain: { type: "string", description: "create: routing domain id. A live expert bound to this domain is reused with its context; a busy one queues the line; an unowned domain starts and binds a new expert." },
        kind: { type: "string", description: "create: free-form kind (dev, bugfix, research, verify, ops)." },
        verifier: { type: "string", enum: ["auto", "required", "none"], description: "create: whether this line gets an independent verifier. Defaults to the plugin setting." },
        memoryIds: { type: "array", items: { type: "string" }, description: "create: ids of memory entries that change how this line executes (typically 0–3); not a project overview." },
        experts: {
          type: "array",
          description: "create: expert seats for a joint line. Omit for a single expert. Each seat gets its own task book focus and can message its siblings.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: { type: "string", description: "Seat name, e.g. frontend, backend, data." },
              domain: { type: "string", description: "Optional domain tag for routing; the engine reuses the expert bound to it." },
              focus: { type: "string", description: "What this seat owns on the shared line." },
            },
            required: ["label"],
          },
        },
        id: { type: "string", description: "Line id for abort/decide/note." },
        lineId: { type: "string", description: "Line id for add-expert/remove-expert/assign/verify/grant/grant-next/revoke; optional for decide." },
        role: { type: "string", enum: ["verifier"], description: "assign: restart/replace the line's single verifier (never adds a second)." },
        label: { type: "string", description: "add-expert: seat name; remove-expert: seat label; define-resource: display label." },
        domain: { type: "string", description: "add-expert: optional domain tag." },
        focus: { type: "string", description: "add-expert: what this seat owns." },
        text: { type: "string", description: "decide/note: the ruling or note text." },
        reason: { type: "string", description: "abort: why the line is cancelled." },
        resourceId: { type: "string", description: "define-resource/grant/grant-next/revoke/release: the resource id (shared-env, build-slot, ...)." },
        sessionId: { type: "string", description: "grant/remove-expert: which agent (session id) receives the lease, or the seat to remove." },
        force: { type: "boolean", description: "grant: force transfer from the previous holder." },
      },
      required: ["action"],
    },
    async (args, exec) => {
      const { board, sessionId } = await engine.attach(exec, "manager");
      switch (args.action) {
        case "create": {
          const line = await engine.createLine(board, args, null);
          const current = engine.store.lineOf(board, line.id);
          if (current.status === "blocked") {
            return `Line ${line.id} created but an expert could not start: ${current.blockedReason}`;
          }
          const hint = engine.memoryHint(board);
          const seats = line.experts.map((seat) => `${seat.label}${seat.domain ? " (" + seat.domain + ")" : ""}`).join(", ");
          return (
            `Line ${line.id} created: ${line.title}\n` +
            `experts: ${seats}${line.useVerifier ? "; an independent verifier will check the combined delivery" : "; no verifier (reports accepted as delivered)"}.\n` +
            (line.memoryIds.length > 0 ? `relayed memory entries: ${line.memoryIds.join(", ")}\n` : "") +
            (hint !== "" ? hint + "\n" : "") +
            `Use swarm_status to follow it. The engine does not notify you; the verifier/expert may message you, and the harness sends child-completion notices.\n` +
            `Dispatch complete for this request. STOP: do not write its solution/plan or do the work in this turn; report the line id and status, then end your turn.`
          );
        }
        case "add-expert": {
          const line = engine.store.lineOf(board, args.lineId ?? args.id);
          const seat = await engine.assignExpert(board, line, { label: args.label, domain: args.domain, focus: args.focus });
          return `Seat ${seat.label} added to ${line.id}${seat.sessionId ? " (started)" : " (queued for capacity)"}. Do not do the seat's work; end your turn.`;
        }
        case "remove-expert": {
          const line = engine.store.lineOf(board, args.lineId ?? args.id);
          const seat = engine.removeExpert(board, line, args.sessionId || args.label);
          return `Seat ${seat.label} retired from ${line.id}.`;
        }
        case "assign": {
          const line = engine.store.lineOf(board, args.lineId ?? args.id);
          line.useVerifier = true;
          await engine.startVerifier(board, line);
          return `Verifier started for ${line.id}.`;
        }
        case "verify": {
          const line = engine.store.lineOf(board, args.lineId ?? args.id);
          await engine.forceVerify(board, line);
          return `Verification requested for ${line.id}.`;
        }
        case "abort": {
          const line = engine.store.lineOf(board, args.id ?? args.lineId);
          engine.store.setLineStatus(board, line, "cancelled", str(args.reason, "cancelled by the manager"));
          engine.retireLineRoles(board, line);
          engine.store.flush(board);
          return `Line ${line.id} cancelled.`;
        }
        case "decide": {
          const decision = engine.store.addDecision(board, { lineId: str(args.lineId ?? args.id), by: sessionId, text: str(args.text) });
          engine.store.flush(board);
          return `Decision recorded (${decision.id}).`;
        }
        case "note": {
          const decision = engine.store.addDecision(board, { lineId: str(args.id ?? args.lineId), by: sessionId, text: "NOTE " + str(args.text) });
          engine.store.flush(board);
          return `Note recorded on the board (${decision.id}).`;
        }
        case "define-resource": {
          const resource = engine.defineLease(board, { id: args.resourceId, label: args.label, note: args.text });
          return `Resource ${resource.id} (${resource.label}) defined. Workers can now request it; grant it with swarm_line action=grant.`;
        }
        case "grant": {
          const granted = await engine.grantLease(board, { id: args.resourceId, sessionId: args.sessionId, lineId: args.lineId, force: args.force === true });
          return `Lease ${granted.resource.id} granted to ${shortId(args.sessionId)}${granted.previous ? " (previous holder: " + shortId(granted.previous.sessionId) + ")" : ""}. The engine does not message agents: tell the holder (and any previous holder) with swarm_message.`;
        }
        case "grant-next": {
          const granted = await engine.grantNextLease(board, args.resourceId);
          return granted.granted ? `Lease ${args.resourceId} handed to ${shortId(granted.next.sessionId)}. Tell it with swarm_message.` : `No one is queued for ${args.resourceId}.`;
        }
        case "revoke": {
          const revoked = await engine.revokeLease(board, args.resourceId);
          return revoked.released === null ? `Lease ${args.resourceId} was free.` : `Lease ${args.resourceId} revoked${revoked.next ? " and handed to " + shortId(revoked.next.sessionId) : ""}. Tell the affected holder(s) with swarm_message.`;
        }
        case "release": {
          const released = engine.store.releaseResource(board, { id: args.resourceId });
          engine.store.flush(board);
          return released.released === null ? `Lease ${args.resourceId} was free.` : `Lease ${args.resourceId} released${released.next ? " and handed to " + shortId(released.next.sessionId) : ""}. Tell the next holder with swarm_message.`;
        }
        default:
          return "Unknown action: " + String(args.action);
      }
    },
  );
}

function managerMessageTool(engine) {
  return tool(
    "swarm_message",
    "Send a message to any agent in this project. Targets: manager, expert, verifier, memory, a line id (when the line has one expert), a seat label, or a session id. " +
      "Use it for questions, evidence requests and coordination — it does not replace swarm_line for substantive work. " +
      "A working target receives it at its next step (mode=steer) or at its next turn (mode=queue); an idle target starts a turn. " +
      "Returns a delivery receipt, never the answer. Every message is recorded on the board. Use it sparingly: swarm_status answers most questions without waking anyone.",
    {
      properties: {
        to: { type: "string", description: "Target: manager | expert | verifier | memory | <line id> | <session id>." },
        text: { type: "string", description: "Message body." },
        mode: { type: "string", enum: ["queue", "steer"], description: "Delivery mode; defaults to queue." },
        kind: { type: "string", enum: MESSAGE_KIND, description: "Message kind (question, answer, request, fyi, escalation, ...)." },
        lineId: { type: "string", description: "Line this message belongs to, when relevant." },
      },
      required: ["to", "text"],
    },
    async (args, exec) => {
      const { board, sessionId } = await engine.attach(exec, "manager");
      const result = await engine.deliverMessage(board, { sessionId, role: "manager", label: "Manager", lineId: "" }, args.to, args.text, args);
      return `Delivered to ${result.toRole || "agent"} (${shortId(result.to)}) — message ${result.messageId}.`;
    },
  );
}

function managerAgentTool(engine) {
  return tool(
    "swarm_agent",
    "Route work by domain. `recommend request=...` or `list` returns every domain, its responsibility, its owner expert and live status — judge ownership yourself; the plugin does no keyword matching. " +
      "`domain` defines or updates a domain (id, name, responsibility). `bind` gives a live expert ownership of a domain. " +
      "When a request fits an existing domain, create the line with `swarm_line domain=<id>`; the engine reuses the owner (or queues if busy). Do not spawn a second expert for the same domain.",
    {
      properties: {
        action: { type: "string", enum: ["recommend", "list", "domain", "bind"], description: "Operation." },
        request: { type: "string", description: "recommend: the user's request words; returned as context, not used for matching." },
        domainId: { type: "string", description: "domain/bind: domain id." },
        name: { type: "string", description: "domain: human name." },
        responsibility: { type: "string", description: "domain: one sentence — what it owns and what it does not." },
        sessionId: { type: "string", description: "bind: live expert session id." },
      },
      required: ["action"],
    },
    async (args, exec) => {
      const { board } = await engine.attach(exec, "manager");
      switch (args.action) {
        case "recommend":
        case "list": {
          const material = engine.domainReport(board);
          return str(args.request).trim() === "" ? material : `Request to route: "${str(args.request)}"\n\n${material}`;
        }
        case "domain": {
          if (str(args.domainId).trim() === "") throw new Error("domain needs a domainId");
          const domain = engine.defineDomain(board, { id: args.domainId, name: args.name, responsibility: args.responsibility });
          return `Domain ${domain.id}${domain.name !== domain.id ? " (" + domain.name + ")" : ""} defined. Bind an expert with swarm_agent action=bind, or create a line with domain=${domain.id} to start one.`;
        }
        case "bind": {
          const domain = engine.bindDomain(board, args.domainId, args.sessionId);
          return `Domain ${domain.id} bound to ${shortId(args.sessionId)}. Future lines in this domain reuse that expert.`;
        }
        default:
          return "Unknown action: " + String(args.action);
      }
    },
  );
}

function managerMemoryTool(engine) {
  return tool(
    "swarm_memory",
    "Project memory — you are the ONLY reader. Before dispatching a line, recall the relevant entries; relay only non-obvious, project-specific facts that change how the line is executed (typically 0–3). " +
      "The write gate applies before you queue a claim too: delete it — would the next agent get this WRONG? Repository layout, build/test commands and common tool usage do not qualify. A chosen approach or an architecture preference does not qualify either: the entry is relayed into later task books and would pin the next expert to the previous expert's idea — record what failed and why, not what was chosen. " +
      "list shows the index; recall returns full bodies for a query; request-write queues a claim (with evidence) for the memory keeper to fact-check and write or reject. " +
      "bootstrap starts the memory keeper; end your turn and wait for its report (entry count and topics; zero is a valid result) before creating the first line. " +
      "Relay entries into a line with swarm_line memoryIds=[...] — pass ids, not text. Do not dump the whole store into a task book.",
    {
      properties: {
        action: { type: "string", enum: ["list", "recall", "request-write", "bootstrap"], description: "Operation." },
        query: { type: "string", description: "recall: words to search (title, body, tags, evidence)." },
        kind: { type: "string", enum: MEMORY_KIND, description: "Filter by entry kind." },
        tags: { type: "array", items: { type: "string" }, description: "Filter by tags (all must match)." },
        limit: { type: "number", description: "Maximum entries to return (default 10 for recall, 60 for list)." },
        title: { type: "string", description: "request-write: one-line index statement." },
        text: { type: "string", description: "request-write: the fact and the conditions under which it holds." },
        evidence: { type: "string", description: "request-write: REQUIRED — paths, commands, logs that let the keeper verify it." },
        lineId: { type: "string", description: "request-write: source line." },
        project: { type: "string", description: "Optional absolute project path or project key; normally resolved from the session." },
      },
      required: ["action"],
    },
    async (args, exec) => {
      const { board, sessionId } = await engine.attach(exec, "manager");
      const project = projectOf(engine.store, board, args.project);
      switch (args.action) {
        case "list": {
          const result = engine.store.memory.list(project, { kind: args.kind, tags: args.tags, limit: args.limit });
          return renderMemoryIndex(result);
        }
        case "recall": {
          if (str(args.query).trim() === "") throw new Error("recall needs a query");
          const result = engine.store.memory.recall(project, { query: args.query, kind: args.kind, tags: args.tags, limit: args.limit });
          return renderMemoryHits(result, args.query);
        }
        case "request-write": {
          const request = await engine.requestMemoryWrite(board, args, sessionId);
          const keeper = engine.memoryKeeper(board);
          return `Memory write request ${request.id} queued (${request.title}). ` +
            (keeper === null
              ? "No memory keeper is running: start one with action=bootstrap, then tell it with swarm_message."
              : `Tell the keeper (${shortId(keeper.sessionId)}) with swarm_message so it fact-checks and writes or rejects it.`);
        }
        case "bootstrap": {
          const keeper = await engine.startMemoryKeeper(board, str(args.text));
          return `Memory keeper ${keeper === null ? "already running" : "started (" + shortId(keeper.sessionId) + ")"}. It will message you when its review is done (0 entries is valid); end your turn and wait for that message before creating the first line.`;
        }
        default:
          return "Unknown action: " + String(args.action);
      }
    },
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Expert tools
// ────────────────────────────────────────────────────────────────────────────

function expertReportTool(engine) {
  return tool(
    "swarm_report",
    "Report your delivery (or your blocker) for the line you own. Call this once per delivery: the engine records it on the board and starts verification once every expert seat has reported. " +
      "The report tool wakes the verifier automatically after a rework report, and notifies the manager on a blocker or a no-verifier delivery; do not duplicate those messages yourself. " +
      "A conclusion without evidence is not a delivery: give paths with line numbers, commands, log excerpts or reproduction steps.",
    {
      properties: {
        summary: { type: "string", description: "What you did and how it meets each acceptance criterion." },
        artifacts: { type: "array", items: { type: "string" }, description: "Files/directories/URLs that constitute the delivery." },
        evidence: { type: "string", description: "Commands, test output, logs, reproduction steps." },
        blockers: { type: "string", description: "If you cannot finish: exactly what you need and from whom." },
        facts: { type: "array", items: { type: "string" }, description: "Non-obvious facts another agent would get wrong. The manager decides whether they belong in project memory." },
        questions: { type: "array", items: { type: "string" }, description: "Open questions for the manager or the verifier." },
      },
      required: ["summary"],
    },
    async (args, exec) => {
      const { board, sessionId } = await engine.attach(exec, "expert");
      const role = board.roles[sessionId];
      const line = engine.store.lineOf(board, role.lineId);
      const wasVerifying = line.status === "verifying";
      const hadVerifier = line.verifierId !== "";
      const updated = await engine.handleReport(board, line, sessionId, args);
      const from = { sessionId, role: "expert", label: role?.label || "Expert", lineId: line.id };
      async function tell(target, text, kind) {
        try {
          await engine.deliverMessage(board, from, target, text, { lineId: line.id, kind });
          return true;
        } catch {
          return false;
        }
      }
      if (updated.status === "blocked") {
        const sent = await tell("manager", `Line ${line.id} is BLOCKED by ${role?.label || role?.role || sessionId}: ${str(args.blockers).slice(0, 300)}. Decide whether to fix the task or change the team.`, "report");
        return `Report recorded for line ${line.id}; the line is BLOCKED.` + (sent ? " The manager was notified." : " The manager notification failed; send it a swarm_message.");
      }
      if (!updated.useVerifier && updated.status === "done") {
        const sent = await tell("manager", `Line ${line.id} is delivered (no verifier): ${str(args.summary).slice(0, 300)}`, "report");
        return `Report recorded for line ${line.id}; the delivery is accepted.` + (sent ? " The manager was notified." : " The manager notification failed; send it a swarm_message.");
      }
      if (updated.useVerifier && updated.status === "verifying" && hadVerifier && !wasVerifying) {
        const sent = await tell("verifier", `Line ${line.id}: rework reported by ${role?.label || role?.role || sessionId}. Re-check the latest reports and issue a new verdict.`, "report");
        return `Report recorded for line ${line.id}; re-check requested.` + (sent ? " The verifier was notified and will re-verify." : " The verifier notification failed; send it a swarm_message.");
      }
      return `Report recorded for line ${line.id} (status: ${updated.status}). The verifier will judge the combined delivery.`;
    },
  );
}

function leaseTool(engine, role) {
  return tool(
    "swarm_lease",
    "Shared-resource leases. Some resources exist once on this machine (a backend instance, a build slot, a device) and only one agent may operate them at a time. " +
      "action=request resourceId=... queues you for the lease; the engine does not notify the manager, so send it a swarm_message with the resource id and why you need it. " +
      "Do not start, stop or reconfigure the resource until you hold the lease. action=release hands it back and may promote the queue head; tell the manager with swarm_message. action=status lists holders and waiters.",
    {
      properties: {
        action: { type: "string", enum: ["request", "release", "status"], description: "Operation." },
        resourceId: { type: "string", description: "request/release: the resource id (shared-env, build-slot, ...)." },
        note: { type: "string", description: "request: why you need it and for how long." },
      },
      required: ["action"],
    },
    async (args, exec) => {
      const { board, sessionId } = await engine.attach(exec, role);
      const entry = board.roles[sessionId];
      if (entry === undefined || entry.lineId === "") throw new Error("this session is not attached to a task line");
      const line = engine.store.lineOf(board, entry.lineId);
      const seat = line.experts.find((expert) => expert.sessionId === sessionId) ?? {
        sessionId,
        label: entry.label || role,
      };
      if (args.action === "status") {
        const resources = Object.values(board.resources);
        if (resources.length === 0) return "No shared resources are defined for this project.";
        const at = Date.now();
        return resources.map((resource) => {
          const holder = resource.holder === null ? "free" : `${resource.holder.label || shortId(resource.holder.sessionId)} holds` + (resource.holder.since ? ` (${Math.max(1, Math.round((at - resource.holder.since) / 60000))}m)` : "");
          const queue = resource.queue.length === 0 ? "" : " | queue: " + resource.queue.map((item) => item.label || shortId(item.sessionId)).join(" -> ");
          return `- ${resource.id} (${resource.label}): ${holder}${queue}`;
        }).join("\n");
      }
      if (args.action === "request") {
        if (str(args.resourceId).trim() === "") throw new Error("request needs a resourceId");
        const result = await engine.requestLease(board, seat, line.id, args.resourceId, args.note);
        if (result.state === "held") return `You already hold lease ${args.resourceId}.`;
        return `Lease request for ${args.resourceId} queued (#${result.position}). The engine does not notify the manager: send it a swarm_message (to: manager) with the resource id and why. Until granted, do the static part of your work and do not touch the shared resource.`;
      }
      if (args.action === "release") {
        if (str(args.resourceId).trim() === "") throw new Error("release needs a resourceId");
        const result = await engine.releaseLease(board, seat, line.id, args.resourceId);
        if (result.released === null) return `You do not hold lease ${args.resourceId}.`;
        return `Lease ${args.resourceId} released${result.next ? " and handed to " + shortId(result.next.sessionId) : ""}. Tell the manager (and the next holder, if listed) with swarm_message.`;
      }
      return "Unknown action: " + String(args.action);
    },
  );
}

function busMessageTool(engine, role) {
  return tool(
    "swarm_message",
    "Send a message to any agent in this project (manager, another role, a line id, or a session id). " +
      "A working target receives it at its next step (mode=steer) or next turn (mode=queue); an idle target starts a turn. Returns a receipt, not an answer. " +
      "Normal reporting goes through the structured tools; use this for questions, evidence requests and coordination.",
    {
      properties: {
        to: { type: "string", description: "Target: manager | expert | verifier | memory | <line id> | <session id>." },
        text: { type: "string", description: "Message body." },
        mode: { type: "string", enum: ["queue", "steer"], description: "Delivery mode; defaults to queue." },
        kind: { type: "string", enum: MESSAGE_KIND, description: "Message kind." },
        lineId: { type: "string", description: "Line this message belongs to, when relevant." },
      },
      required: ["to", "text"],
    },
    async (args, exec) => {
      const { board, sessionId } = await engine.attach(exec, role);
      const entry = board.roles[sessionId] ?? { label: role, lineId: "" };
      const result = await engine.deliverMessage(
        board,
        { sessionId, role, label: entry.label || role, lineId: entry.lineId || "" },
        args.to,
        args.text,
        args,
      );
      return `Delivered to ${result.toRole || "agent"} (${shortId(result.to)}) — message ${result.messageId}.`;
    },
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Verifier tools
// ────────────────────────────────────────────────────────────────────────────

function verifierVerdictTool(engine) {
  return tool(
    "swarm_verdict",
    "issue the independent verdict for the line you are verifying. Judge against the acceptance criteria by inspecting the actual project state; do not trust the experts' narrative and do not modify the deliverable. " +
      "This may be a joint delivery: set criterion.owner to the expert label whose part failed; unowned failures go to every expert. " +
      "pass=false means the named experts must fix the failures; the tool delivers the rework brief to each owner automatically. pass=true notifies the manager. Do not duplicate those messages with swarm_message. " +
      "When the same failure survives a rework, say so in notes and put the reproduction step in recheck — the board records the repeat signature for the manager.",
    {
      properties: {
        pass: { type: "boolean", description: "Whether the delivery meets the acceptance criteria." },
        criteria: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              criterion: { type: "string", description: "One acceptance criterion." },
              passed: { type: "boolean", description: "Whether it passed." },
              evidence: { type: "string", description: "What you observed that proves it (path:line, command output, ...)." },
              owner: { type: "string", description: "Which expert seat owns this criterion (label or session id); you will message that owner. Omit for shared failures." },
            },
            required: ["criterion", "passed", "evidence"],
          },
          description: "Per-criterion results. Empty only for a task with no stated criteria.",
        },
        failures: { type: "array", items: { type: "string" }, description: "Concrete, re-checkable failures (required when pass=false)." },
        notes: { type: "string", description: "Judgement notes, including repeat-failure observations." },
        recheck: { type: "string", description: "What the next round must re-run to prove the fix." },
      },
      required: ["pass", "criteria"],
    },
    async (args, exec) => {
      const { board, sessionId } = await engine.attach(exec, "verifier");
      const role = board.roles[sessionId];
      const line = engine.store.lineOf(board, role.lineId);
      if (args.pass === false && (!Array.isArray(args.failures) || args.failures.length === 0)) {
        throw new Error("a failed verdict needs at least one concrete failure; say what is missing or broken");
      }
      const verdict = await engine.handleVerdict(board, line, sessionId, args);
      const from = { sessionId, role: "verifier", label: role?.label || "Verifier", lineId: line.id };
      if (verdict.pass) {
        const summary = line.reports[line.reports.length - 1]?.summary ?? "(no summary)";
        let sent = false;
        try {
          await engine.deliverMessage(board, from, "manager", `Line ${line.id} PASSED verification (round ${verdict.round}). Delivery: ${summary}`, { lineId: line.id, kind: "verdict" });
          sent = true;
        } catch {
          sent = false;
        }
        return `Verdict recorded: PASS for ${line.id}. The line is delivered.` + (sent ? " The manager was notified." : " The manager notification failed; send it a swarm_message.");
      }
      const failed = verdict.criteria.filter((item) => !item.passed);
      const seats = line.experts.filter((entry) => entry.status !== "retired" && entry.sessionId !== "");
      const owners = [...new Set(failed.map((item) => item.owner).filter((owner) => owner !== ""))];
      const matched = seats.filter((entry) => owners.includes(entry.label) || owners.includes(entry.sessionId));
      const targets = owners.length === 0 || matched.length === 0 ? seats : matched;
      const briefFor = (seat) => {
        const mine = failed.filter((item) => item.owner === "" || item.owner === seat.label || item.owner === seat.sessionId);
        return [
          `Verdict for line ${line.id} — round ${verdict.round}: FAIL (your seat: ${seat.label}).`,
          ...mine.map((item) => `- FAILED: ${item.criterion}` + (item.evidence ? ` (evidence: ${item.evidence})` : "")),
          verdict.failures.length > 0 ? "Failures:\n" + verdict.failures.map((failure) => "- " + failure).join("\n") : "",
          verdict.recheck !== "" ? "Re-check required: " + verdict.recheck : "",
          verdict.notes !== "" ? "Notes: " + verdict.notes : "",
          "Fix your part and call `swarm_report`; the report tool will notify me to re-verify.",
        ].filter(Boolean).join("\n");
      };
      const delivered = [];
      const failedSend = [];
      for (const seat of targets) {
        try {
          await engine.deliverMessage(board, from, seat.sessionId, briefFor(seat), { lineId: line.id, kind: "verdict" });
          delivered.push(seat.label);
        } catch {
          failedSend.push(seat.label);
        }
      }
      return (
        `Verdict recorded: FAIL for ${line.id} (round ${verdict.round}). ` +
        (delivered.length > 0 ? `Rework briefs delivered to: ${delivered.join(", ")}. ` : "") +
        (failedSend.length > 0 ? `Could not notify: ${failedSend.join(", ")}; tell the manager. ` : "") +
        (targets.length === 0 ? "No live expert to notify; tell the manager. " : "") +
        "Stop. The report tool will notify you when the experts report back."
      );
    },
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Memory keeper tools
// ────────────────────────────────────────────────────────────────────────────

function memoryAdminTool(engine) {
  return tool(
    "swarm_memory_admin",
    "Project memory administration — the memory keeper is the only writer and the only fact checker. " +
      "The write gate: delete it — would the next agent get this WRONG? If not, it does not go in. Only non-obvious, project-specific facts (tokens valid only here, required orderings, skipped steps, format couplings, counterintuitive measured facts, proven conclusions). NOT repository layout, build/test commands, common tool usage, board/session history, or a chosen approach/architecture preference (relayed into later task books, it would pin the next expert to the previous expert's idea). " +
      "Evidence is necessary but not sufficient: reject an obvious claim even with impeccable evidence. Bootstrap is not a project survey; zero entries is a valid result. " +
      "pending lists write requests from the manager; write records an entry you verified yourself (evidence REQUIRED; verifiedAt defaults to now); reject dismisses a request with a reason; update/forget maintain existing entries; list/recall read the store. " +
      "Never serve memory bodies to other roles: if another agent asks, tell it to ask the manager to relay.",
    {
      properties: {
        action: { type: "string", enum: ["pending", "write", "update", "forget", "reject", "list", "recall"], description: "Operation." },
        requestId: { type: "string", description: "write/reject: the request being decided (write uses its title/text/evidence)." },
        id: { type: "string", description: "update/forget: the entry id." },
        title: { type: "string", description: "write/update: one-line index statement." },
        text: { type: "string", description: "write/update: the fact and when it holds." },
        kind: { type: "string", enum: MEMORY_KIND, description: "Entry kind." },
        tags: { type: "array", items: { type: "string" }, description: "Tags for retrieval." },
        evidence: { type: "string", description: "REQUIRED for write: paths/commands/logs proving the fact. Evidence is necessary, not sufficient — reject obvious claims anyway." },
        verifiedAt: { type: "number", description: "Epoch ms when you verified it; defaults to now." },
        query: { type: "string", description: "recall: words to search." },
        reason: { type: "string", description: "reject: why the claim was not accepted." },
        limit: { type: "number", description: "list/recall: maximum entries." },
      },
      required: ["action"],
    },
    async (args, exec) => {
      const { board, sessionId } = await engine.attach(exec, "memory");
      const project = projectOf(engine.store, board, "");
      const memory = engine.store.memory;
      switch (args.action) {
        case "pending": {
          const pending = engine.store.pendingMemoryRequests(board);
          if (pending.length === 0) return "No pending memory write requests.";
          return pending.map((request) => `- ${request.id}${request.lineId ? " (" + request.lineId + ")" : ""}: ${request.title}\n  claim: ${request.text}\n  evidence: ${request.evidence}`).join("\n");
        }
        case "write": {
          let request = null;
          if (str(args.requestId).trim() !== "") {
            request = board.memoryRequests.find((entry) => entry.id === args.requestId);
            if (request === undefined) throw new Error(`unknown memory request: ${args.requestId}`);
            if (request.status !== "pending") throw new Error(`request ${request.id} was already ${request.status}`);
          }
          const title = str(args.title, request?.title ?? "");
          const text = str(args.text, request?.text ?? "");
          const evidence = str(args.evidence, request?.evidence ?? "");
          if (title.trim() === "" || text.trim() === "") throw new Error("write needs title and text");
          if (evidence.trim() === "") throw new Error("write needs evidence — the fact checker must be able to re-check it");
          const written = memory.remember(project, {
            title,
            text,
            kind: str(args.kind, request?.kind ?? "finding"),
            tags: args.tags ?? request?.tags ?? [],
            evidence,
            sourceLineId: request?.lineId ?? "",
            sourceSessionId: sessionId,
            verifiedBy: sessionId,
            verifiedAt: typeof args.verifiedAt === "number" ? args.verifiedAt : Date.now(),
          });
          if (request !== null) {
            engine.store.decideMemoryRequest(board, request.id, { status: "accepted", decidedBy: sessionId, entryId: written.entry.id });
          }
          engine.store.flush(board);
          return `Memory ${written.created ? "written" : "updated"}: ${written.entry.id} — ${written.entry.title}` +
            (written.pruned > 0 ? ` (${written.pruned} old entries pruned)` : "") +
            (request !== null ? `. Tell the manager the request ${request.id} was accepted with swarm_message.` : "");
        }
        case "reject": {
          const request = board.memoryRequests.find((entry) => entry.id === args.requestId);
          if (request === undefined) throw new Error(`unknown memory request: ${args.requestId}`);
          engine.store.decideMemoryRequest(board, request.id, { status: "rejected", decidedBy: sessionId, reason: str(args.reason, "could not be verified") });
          engine.store.flush(board);
          return `Request ${request.id} rejected. Reason recorded; tell the manager with swarm_message.`;
        }
        case "update": {
          if (str(args.id).trim() === "") throw new Error("update needs an entry id");
          const written = memory.remember(project, {
            id: args.id,
            title: args.title,
            text: args.text,
            kind: args.kind,
            tags: args.tags,
            evidence: args.evidence,
            verifiedBy: sessionId,
            verifiedAt: typeof args.verifiedAt === "number" ? args.verifiedAt : Date.now(),
          });
          engine.store.flush(board);
          return `Memory updated: ${written.entry.id} — ${written.entry.title}`;
        }
        case "forget": {
          const dropped = memory.forget(project, { id: args.id });
          return `Deleted ${dropped.removed} entry; ${dropped.remaining} remain.`;
        }
        case "list":
          return renderMemoryIndex(memory.list(project, { limit: args.limit }));
        case "recall":
          if (str(args.query).trim() === "") throw new Error("recall needs a query");
          return renderMemoryHits(memory.recall(project, { query: args.query, limit: args.limit }), args.query);
        default:
          return "Unknown action: " + String(args.action);
      }
    },
  );
}

/**
 * Build the toolset for one role.
 *
 * The preset modules call this with their own role; the engine binds each tool
 * to the caller's board on execution, so one definition serves every session.
 */
export function createRoleTools(engine, role) {
  if (role === "manager") {
    return [managerStatusTool(engine), managerAgentTool(engine), managerLineTool(engine), managerMessageTool(engine), managerMemoryTool(engine)];
  }
  if (role === "expert") return [expertReportTool(engine), leaseTool(engine, "expert"), busMessageTool(engine, "expert")];
  if (role === "verifier") return [verifierVerdictTool(engine), leaseTool(engine, "verifier"), busMessageTool(engine, "verifier")];
  if (role === "memory") return [memoryAdminTool(engine), busMessageTool(engine, "memory")];
  throw new Error("unknown swarm role: " + String(role));
}

export { renderMemoryIndex, renderMemoryHits };
