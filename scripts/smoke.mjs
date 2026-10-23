/**
 * dsh-swarm — offline smoke test.
 *
 * Exercises the pure-Node core (store, memory, engine, tool definitions) with a
 * fake runtime. It needs no harness process, so it is the first gate after any
 * change to lib/*.js.
 *
 * Run: node scripts/smoke.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SwarmStore, defaultSettings, normalizeSettings, LINE_STATUS } from "../lib/store.js";
import { SwarmEngine } from "../lib/engine.js";
import { createRoleTools } from "../lib/tools.js";
import { filterPresetRoster, installRosterFilter, HIDDEN_ROLE_PRESETS } from "../lib/roster.js";
import { createMemoryStore, resolveProjectIdentity, resolveNamedProject, projectKeyOf } from "../lib/memory.js";

let checks = 0;
function ok(condition, message) {
  checks += 1;
  if (!condition) throw new Error("FAIL: " + message);
}
function eq(actual, expected, message) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), message + " (got " + JSON.stringify(actual) + ", want " + JSON.stringify(expected) + ")");
}
function section(title) {
  process.stdout.write("\n# " + title + "\n");
}
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-swarm-smoke-"));
const projectDir = path.join(base, "project");
fs.mkdirSync(path.join(projectDir, "src", "nested"), { recursive: true });
fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });
fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
const bareDir = path.join(base, "bare-project");
fs.mkdirSync(bareDir, { recursive: true });
const outerDir = path.join(base, "outer");
fs.mkdirSync(path.join(outerDir, "packages", "inner", "src"), { recursive: true });
fs.mkdirSync(path.join(outerDir, ".git"), { recursive: true });
fs.writeFileSync(path.join(outerDir, "packages", "inner", "package.json"), "{}", "utf8");
const homeDir = os.homedir();

// ── memory: project identity ────────────────────────────────────────────────
section("memory identity");
const identity = resolveProjectIdentity(path.join(projectDir, "src", "nested"));
eq(identity.root, projectDir, "a nested cwd resolves to the project root");
ok(identity.key.startsWith("project-"), "project key is slug + hash");
eq(resolveProjectIdentity(path.join(outerDir, "packages", "inner")).root, outerDir, "the OUTERMOST marker wins in a monorepo");
const named = resolveNamedProject(bareDir);
eq(named.root, bareDir, "a directory the caller NAMED is accepted without a marker");
eq(resolveNamedProject(homeDir).key, "", "a home directory is refused as a project");
eq(resolveProjectIdentity(bareDir).key, "", "guessing does not invent a project");
eq(resolveProjectIdentity(projectDir).key, resolveProjectIdentity(path.join(projectDir, "src")).key, "the key is stable across subdirectories");

// ── memory store ────────────────────────────────────────────────────────────
section("memory store");
const memoryRoot = path.join(base, "memory");
const memory = createMemoryStore({ root: memoryRoot });
const project = { key: identity.key, root: identity.root, name: identity.name };
ok(memory.isEmpty(project), "a fresh project is empty");
const written = memory.remember(project, {
  title: "Build output lands in dist/, not build/",
  text: "The packaging step reads dist/. A build into build/ silently ships a stale bundle.",
  kind: "gotcha",
  tags: ["build"],
  evidence: "npm run build; ls dist/",
  verifiedBy: "memory-keeper",
  verifiedAt: Date.now(),
});
ok(written.created, "first write creates the entry");
ok(memory.isEmpty(project) === false, "the store is no longer empty");
const recalled = memory.recall(project, { query: "build", limit: 5 });
eq(recalled.matches.length, 1, "recall finds the entry by title");
eq(recalled.matches[0].entry.id, written.entry.id, "recall returns the written entry");
const hitsAfterRecall = recalled.matches[0].entry.hits;
memory.remember(project, { title: "Second entry", text: "Body", kind: "finding" });
const afterFlush = memory.recall(project, { query: "build", limit: 5 }).matches[0].entry;
ok(afterFlush.hits >= hitsAfterRecall, "recall hits are flushed with the next write");
const forgot = memory.forget(project, { id: written.entry.id });
eq(forgot.remaining, 1, "forget removes exactly one entry");
ok(memory.list(project, { limit: 10 }).total === 1, "list reflects the removal");

// ── store: board, settings, lines, revisions ────────────────────────────────
section("store");
const storeRoot = path.join(base, "boards");
const store = new SwarmStore({ root: storeRoot });
const managerId = "session-manager-1";
const board = store.open(managerId);
eq(board.version, 3, "board version (domain registry + multi-expert schema)");
const tagged = store.tagProject(board, projectDir);
ok(tagged.changed, "the board records its project");
store.flush(board);
eq(board.projectKey, identity.key, "project key recorded on the board");
eq(defaultSettings().maxConcurrent, 6, "default concurrency");
eq(normalizeSettings({ maxConcurrent: 99 }).maxConcurrent, 6, "out-of-range concurrency falls back");
const saved = store.saveSettings({ maxConcurrent: 2, roles: { expert: { provider: "fake", model: "expert-1", reasoningEffort: "" } } });
eq(saved.maxConcurrent, 2, "settings persist");
eq(store.settings().roles.expert.model, "expert-1", "role route persists");
const line = store.createLine(board, { title: "Fix the movement bug", request: "The player walks through walls", acceptance: "No wall penetration in the fixture map", kind: "bugfix", memoryIds: [] });
eq(line.status, "waiting", "a new line waits for dispatch");
store.setLineStatus(board, line, "working", "dispatched");
eq(line.startedAt > 0, true, "working stamps startedAt");
store.recordReport(board, line, { sessionId: "expert-1", summary: "Fixed", evidence: "test/move.test.ts:12", artifacts: ["src/move.ts"] });
store.recordVerdict(board, line, { sessionId: "verifier-1", round: 1, pass: false, criteria: [{ criterion: "no wall penetration", passed: false, evidence: "test fails" }], failures: ["collision at x=3"], notes: "", recheck: "npm test -- move" });
eq(store.lastVerdict(line).pass, false, "verdict recorded");
store.upsertRole(board, { sessionId: "expert-1", role: "expert", label: "Expert", lineId: line.id });
line.experts[0].sessionId = "expert-1";
line.experts[0].status = "running";
const summary = store.summary(board, { "expert-1": "running" });
eq(summary.counts.total, 1, "summary counts lines");
eq(summary.lines[0].experts[0].status, "running", "summary merges live status");
const delta = store.delta(board, 0);
ok(delta.events.length > 0, "delta returns events after revision 0");
const detail = store.detail(board, line.id, {});
eq(detail.line.reports.length, 1, "detail carries reports");
const storeDomain = store.defineDomain(board, { id: "web", name: "Web", responsibility: "pages and state" });
eq(store.domainOf(board, "web").name, "Web", "domain definition is recorded");
store.bindDomain(board, "web", "expert-1");
eq(board.roles["expert-1"].domain, "web", "binding marks the expert's domain");
eq(board.roles["expert-1"].persistent, true, "a domain owner is persistent");
const domainSummary = store.summary(board, { "expert-1": "running" });
ok(domainSummary.domains.some((domain) => domain.id === "web" && domain.expertSessionId === "expert-1"), "summary carries domain ownership");
eq(storeDomain.name, "Web", "defineDomain returns the domain");
store.retireRole(board, "expert-1");
store.flush(board);
const reopened = new SwarmStore({ root: storeRoot });
eq(reopened.get(managerId).lines[line.id].title, "Fix the movement bug", "board survives a reload");
eq(reopened.get(managerId).domains.web.name, "Web", "the domain registry survives a reload");
eq(reopened.settings().maxConcurrent, 2, "settings survive a reload");

// ── engine with a fake runtime ──────────────────────────────────────────────
section("engine");
const agents = new Map();
const descendants = [];
const calls = { startChild: [], sendSubagent: [], sendToManager: [] };
function makeAgent(id, cwd, parentSession) {
  const agent = {
    id,
    status: "idle",
    session: { header: { cwd, ...(parentSession === undefined ? {} : { parentSession }) } },
    followup(message) { agent.inbox = message; },
  };
  agents.set(id, agent);
  return agent;
}
const managerAgent = makeAgent(managerId, projectDir);
let childSeq = 0;
const runtime = {
  liveStatus: () => Object.fromEntries([...agents.entries()].map(([id, agent]) => [id, agent.status])),
  resolveAgent: async (id) => agents.get(id),
  startChild: async ({ parentAgent, preset, prompt, label }) => {
    childSeq += 1;
    const childId = preset + "-" + childSeq;
    makeAgent(childId, projectDir, parentAgent.id);
    calls.startChild.push({ preset, label, prompt, childId, parentId: parentAgent.id });
    return { childId, result: new Promise(() => {}), dispose: () => agents.delete(childId) };
  },
  sendSubagent: async (senderAgent, targetId, parts) => {
    calls.sendSubagent.push({ from: senderAgent.id, to: targetId, text: parts[0].text });
    return "msg-" + calls.sendSubagent.length;
  },
  sendToManager: async (agent, parts) => {
    calls.sendToManager.push({ to: agent.id, text: parts[0].text });
  },
  listDescendants: async () => descendants,
  log: () => {},
};
const engine = new SwarmEngine({ store, runtime });

const managerExec = { agent: managerAgent };
const attached = await engine.attach(managerExec, "manager");
eq(attached.board.boardId, board.boardId, "the manager attaches to its own board");
const newLine = await engine.createLine(attached.board, { title: "Movement fix", request: "Player clips through walls", acceptance: "No clipping in the fixture map", verifier: "required" }, null);
if (newLine.status !== "working") process.stdout.write("expert start failed: " + newLine.blockedReason + "\n");
eq(newLine.status, "working", "creating a line dispatches the expert");
eq(calls.startChild.length, 1, "one expert was started");
eq(calls.startChild[0].preset, "swarm-expert", "the expert preset is requested");
ok(calls.startChild[0].prompt.includes("Player clips through walls"), "the task book carries the user's words verbatim");
ok(calls.startChild[0].prompt.includes("swarm_report"), "the task book states the reporting contract");
const expertId = newLine.experts[0].sessionId;
const expertExec = { agent: agents.get(expertId) };
const expertAttached = await engine.attach(expertExec, "expert");
eq(expertAttached.board.boardId, board.boardId, "the expert reaches the manager's board through its parent session");

await engine.handleReport(attached.board, newLine, expertId, { summary: "Fixed collision resolution", evidence: "npm test -- move: 14 passed", artifacts: ["src/move.ts"] });
if (newLine.status !== "verifying") process.stdout.write("verify start failed: " + newLine.blockedReason + "\n");
eq(newLine.status, "verifying", "a report starts verification");
eq(calls.startChild.length, 2, "a verifier was started");
eq(calls.startChild[1].preset, "swarm-verifier", "the verifier preset is requested");
const verifierId = newLine.verifierId;

await engine.handleVerdict(attached.board, newLine, verifierId, {
  pass: false,
  criteria: [{ criterion: "no clipping", passed: false, evidence: "clips at x=3" }],
  failures: ["wall penetration at x=3"],
  notes: "",
  recheck: "npm test -- move",
});
eq(newLine.status, "reworking", "a failed verdict moves the line to reworking");
eq(calls.sendSubagent.length, 0, "the engine does not message the expert about the verdict");

await engine.handleReport(attached.board, newLine, expertId, { summary: "Fixed the x=3 case", evidence: "npm test -- move: 15 passed", artifacts: ["src/move.ts"] });
eq(newLine.status, "verifying", "the second report starts re-verification");
eq(calls.startChild.filter((call) => call.preset === "swarm-verifier").length, 1, "the resident verifier is reused rather than duplicated");
eq(calls.sendSubagent.length, 0, "the engine does not prompt the reused verifier");

await engine.handleVerdict(attached.board, newLine, verifierId, {
  pass: true,
  criteria: [{ criterion: "no clipping", passed: true, evidence: "15 passed" }],
  failures: [],
  notes: "",
  recheck: "",
});
eq(newLine.status, "done", "a passing verdict delivers the line");
await settle();
eq(calls.sendToManager.length, 0, "the engine does not notify the manager of the delivery");
eq(attached.board.roles[expertId].retiredAt > 0, true, "the expert is retired when the line closes");
eq(attached.board.roles[verifierId].retiredAt > 0, true, "the verifier is retired when the line closes");

// concurrency queue: one slot, two lines
section("concurrency queue");
store.saveSettings({ maxConcurrent: 1 });
const secondBoard = store.open(managerId);
const queuedA = await engine.createLine(secondBoard, { title: "A", request: "A", verifier: "none" }, null);
const queuedB = await engine.createLine(secondBoard, { title: "B", request: "B", verifier: "none" }, null);
if (queuedA.status !== "working") process.stdout.write("A diagnostic: active=" + engine.activeRoles(secondBoard) + " max=" + store.settings().maxConcurrent + " reason=" + queuedA.blockedReason + "\n");
eq(queuedA.status, "working", "the first queued line dispatches");
eq(queuedB.status, "waiting", "the second line waits for capacity");
await engine.handleReport(secondBoard, queuedA, queuedA.experts[0].sessionId, { summary: "A delivered", evidence: "none needed" });
await settle();
eq(queuedA.status, "done", "a no-verifier line is delivered on report");
eq(queuedB.status, "working", "closing the first line dispatches the waiting one");
store.saveSettings({ maxConcurrent: 6 });

// ── joint line: two experts on one task, one combined verification ─────────
section("joint line + shared resources");
const joint = await engine.createLine(secondBoard, {
  title: "Full-stack profile page",
  request: "Add a profile page that reads from the API",
  acceptance: "The page renders and the API contract matches",
  verifier: "none",
  experts: [
    { label: "frontend", domain: "web", focus: "the page and its state" },
    { label: "backend", domain: "api", focus: "the endpoint and its contract" },
  ],
}, null);
eq(joint.experts.length, 2, "a line can carry two expert seats");
ok(joint.experts[0].sessionId !== "" && joint.experts[1].sessionId !== "", "both seats started");
const jointStarts = calls.startChild.filter((call) => call.prompt.includes("Full-stack profile page"));
eq(jointStarts.length, 2, "two experts were started for the joint line");
ok(jointStarts[0].prompt.includes("frontend") && jointStarts[0].prompt.includes("backend"), "each task book names the sibling seats");
ok(jointStarts[0].prompt.indexOf("frontend") !== jointStarts[0].prompt.indexOf("backend"), "seats are distinct");

// shared resource: request -> grant -> queue -> release -> promotion
engine.defineLease(secondBoard, { id: "shared-env", label: "Backend instance" });
const seatA = joint.experts[0];
const seatB = joint.experts[1];
const requestA = await engine.requestLease(secondBoard, { sessionId: seatA.sessionId, label: seatA.label }, joint.id, "shared-env", "e2e");
eq(requestA.state, "queued", "a lease request queues instead of self-granting");
await settle();
eq(calls.sendToManager.length, 0, "the engine does not notify the manager of a lease request");
await engine.grantLease(secondBoard, { id: "shared-env", sessionId: seatA.sessionId, lineId: joint.id });
eq(secondBoard.resources["shared-env"].holder.sessionId, seatA.sessionId, "the manager grants the lease");
await settle();
eq(calls.sendSubagent.length, 0, "the engine does not tell the holder about the grant");
const requestB = await engine.requestLease(secondBoard, { sessionId: seatB.sessionId, label: seatB.label }, joint.id, "shared-env", "");
eq(requestB.position, 1, "a second requester waits in the queue");
const released = await engine.releaseLease(secondBoard, { sessionId: seatA.sessionId, label: seatA.label }, joint.id, "shared-env");
eq(released.next.sessionId, seatB.sessionId, "releasing promotes the queue head");
await engine.grantLease(secondBoard, { id: "shared-env", sessionId: seatA.sessionId, lineId: joint.id, force: true });
eq(secondBoard.resources["shared-env"].holder.sessionId, seatA.sessionId, "force transfer takes the lease back");

await engine.handleReport(secondBoard, joint, seatA.sessionId, { summary: "Page built", evidence: "screenshots/ profile.png" });
eq(joint.status, "working", "the line waits for the second seat");
await engine.handleReport(secondBoard, joint, seatB.sessionId, { summary: "Endpoint added", evidence: "GET /api/profile: 200" });
eq(joint.status, "done", "the line closes when every seat reported");
await settle();
eq(secondBoard.resources["shared-env"].holder, null, "closing the line auto-releases its lease");
eq(secondBoard.roles[seatA.sessionId].retiredAt, 0, "a domain expert stays resident after the line closes");
eq(secondBoard.roles[seatB.sessionId].retiredAt, 0, "the second domain expert stays resident");
eq(secondBoard.roles[seatA.sessionId].lineId, "", "the first domain expert is idle");
eq(secondBoard.roles[seatB.sessionId].lineId, "", "the second domain expert is idle");

// ── domain reuse: same domain = same expert, no new activation ─────────────
section("domain routing");
const startsBeforeReuse = calls.startChild.length;
const reuse = await engine.createLine(secondBoard, {
  title: "Web polish",
  request: "Polish the profile page",
  acceptance: "The page looks right",
  verifier: "none",
  domain: "web",
}, null);
eq(reuse.experts[0].sessionId, seatA.sessionId, "a same-domain line reuses the owner expert");
eq(reuse.experts[0].reused, true, "the seat is marked reused");
eq(reuse.experts[0].domain, "web", "the seat inherits the routing domain");
eq(calls.startChild.length, startsBeforeReuse, "reuse starts no new child");
ok(calls.sendSubagent.some((call) => call.to === seatA.sessionId && call.text.includes("Web polish")), "the reused expert receives the new task book");
eq(reuse.status, "working", "the reused line is working");
await engine.handleReport(secondBoard, reuse, seatA.sessionId, { summary: "Polished", evidence: "screenshots/profile.png" });
eq(reuse.status, "done", "the reused line closes on its report");
eq(secondBoard.roles[seatA.sessionId].retiredAt, 0, "the reused domain expert is not retired");
eq(secondBoard.roles[seatA.sessionId].lineId, "", "the reused domain expert goes idle again");

// busy owner: the new line queues, then dispatches when the owner frees
const busyA = await engine.createLine(secondBoard, { title: "Web A", request: "First web task", verifier: "none", domain: "web" }, null);
eq(busyA.status, "working", "the idle owner accepts the first task");
const startsBeforeBusy = calls.startChild.length;
const busyB = await engine.createLine(secondBoard, { title: "Web B", request: "Second web task", verifier: "none", domain: "web" }, null);
eq(busyB.status, "waiting", "a second task queues while the owner is busy");
eq(busyB.experts[0].sessionId, seatA.sessionId, "the queued seat is assigned to the owner");
eq(calls.startChild.length, startsBeforeBusy, "a busy owner does not spawn a duplicate");
await engine.handleReport(secondBoard, busyA, seatA.sessionId, { summary: "A done", evidence: "ok" });
await settle();
eq(busyB.status, "working", "the queued line dispatches when the owner frees");
eq(secondBoard.roles[seatA.sessionId].lineId, busyB.id, "the owner moves to the queued line");
ok(calls.sendSubagent.some((call) => call.to === seatA.sessionId && call.text.includes("Second web task")), "the queued task book is delivered");
await engine.handleReport(secondBoard, busyB, seatA.sessionId, { summary: "B done", evidence: "ok" });
eq(busyB.status, "done", "the queued line closes");
eq(secondBoard.roles[seatA.sessionId].retiredAt, 0, "the owner remains resident after both tasks");

// a new domain starts and binds a new expert
const startsBeforeNewDomain = calls.startChild.length;
const newDomain = await engine.createLine(secondBoard, { title: "Ops task", request: "Restart the service", verifier: "none", domain: "ops" }, null);
eq(newDomain.status, "working", "an unowned domain starts an expert");
eq(calls.startChild.length, startsBeforeNewDomain + 1, "the unowned domain starts exactly one child");
const opsOwner = secondBoard.roles[newDomain.experts[0].sessionId];
eq(opsOwner.domain, "ops", "the new expert is bound to the domain");
eq(opsOwner.persistent, true, "the domain owner is persistent");
ok(secondBoard.domains.ops !== undefined && secondBoard.domains.ops.expertSessionId === opsOwner.sessionId, "the domain registry records the owner");
await engine.handleReport(secondBoard, newDomain, opsOwner.sessionId, { summary: "Restarted", evidence: "systemctl status ok" });

// swarm_agent material and summary domain view
const agentTool = createRoleTools(engine, "manager").find((tool) => tool.name === "swarm_agent");
const material = await agentTool.execute({ action: "recommend", request: "Polish the page" }, { agent: managerAgent });
ok(material.includes("Domain routing material") && material.includes("web") && material.includes("ops"), "recommend lists domains and owners");
const summaryWithDomains = engine.store.summary(secondBoard, {});
ok(summaryWithDomains.domains.some((domain) => domain.id === "web" && domain.expertSessionId === seatA.sessionId), "the board summary carries domain ownership");
const domainAction = await agentTool.execute({ action: "domain", domainId: "qa", name: "QA", responsibility: "verification infrastructure" }, { agent: managerAgent });
ok(domainAction.includes("qa"), "swarm_agent defines a domain");
const bindAction = await agentTool.execute({ action: "bind", domainId: "qa", sessionId: opsOwner.sessionId }, { agent: managerAgent });
ok(bindAction.includes("qa"), "swarm_agent binds a live expert");
eq(secondBoard.roles[opsOwner.sessionId].domain, "qa", "the bound expert owns the new domain");
eq(secondBoard.domains.qa.expertSessionId, opsOwner.sessionId, "the registry records the new owner");
eq(secondBoard.domains.ops.expertSessionId, "", "rebinding clears the old domain owner");
const afterBind = await agentTool.execute({ action: "list" }, { agent: managerAgent });
ok(afterBind.includes("qa") && afterBind.includes("verification infrastructure"), "domain list carries responsibility text");
const duplicateDomain = await engine.createLine(secondBoard, {
  title: "Duplicate domain",
  request: "x",
  verifier: "none",
  experts: [{ label: "a", domain: "web" }, { label: "b", domain: "web" }],
}, null).then(() => null, (error) => error);
ok(duplicateDomain !== null && duplicateDomain.message.includes("same domain twice"), "a joint line refuses two seats in one domain");

// ── memory keeper + request queue ───────────────────────────────────────────
section("memory keeper");
const keeper = await engine.startMemoryKeeper(secondBoard);
eq(keeper.role, "memory", "memory keeper role recorded");
ok(calls.startChild.some((call) => call.preset === "swarm-memory"), "the keeper preset is requested");
const keeperExec = { agent: agents.get(keeper.sessionId) };
const keeperAttached = await engine.attach(keeperExec, "memory");
eq(keeperAttached.board.boardId, secondBoard.boardId, "the keeper attaches to the manager's board");
const sendsBeforeMemory = calls.sendSubagent.length;
const request = await engine.requestMemoryWrite(secondBoard, {
  title: "The fixture map must be rebuilt after move.json changes",
  text: "Changing move.json without rebuilding the fixture map leaves the old geometry in place.",
  evidence: "node tools/build-map.mjs; grep move.json dist/",
  lineId: "L-x",
}, managerId);
eq(request.status, "pending", "a memory request starts pending");
await settle();
eq(calls.sendSubagent.length, sendsBeforeMemory, "the engine does not ask the keeper to fact-check it");
ok(engine.store.pendingMemoryRequests(secondBoard).length === 1, "the queue lists the request");

// ── tool surface ────────────────────────────────────────────────────────────
section("tools");
const managerTools = createRoleTools(engine, "manager");
eq(managerTools.map((tool) => tool.name), ["swarm_status", "swarm_agent", "swarm_line", "swarm_message", "swarm_memory"], "manager tool names");
for (const definition of managerTools) {
  eq(definition.parameters.type, "object", definition.name + " has a JSON Schema object root");
  ok(Array.isArray(definition.parameters.required), definition.name + " declares required");
  eq(typeof definition.output.schema.type, "string", definition.name + " declares an output schema");
}
const expertTools = createRoleTools(engine, "expert");
eq(expertTools.map((tool) => tool.name), ["swarm_report", "swarm_lease", "swarm_message"], "expert tool names");
const verifierTools = createRoleTools(engine, "verifier");
eq(verifierTools.map((tool) => tool.name), ["swarm_verdict", "swarm_lease", "swarm_message"], "verifier tool names");
const memoryTools = createRoleTools(engine, "memory");
eq(memoryTools.map((tool) => tool.name), ["swarm_memory_admin", "swarm_message"], "memory tool names");

const statusTool = managerTools.find((tool) => tool.name === "swarm_status");
const statusText = await statusTool.execute({ mode: "snapshot" }, { agent: managerAgent });
ok(statusText.includes("SWARM"), "swarm_status renders a project header");
ok(statusText.includes("dispatcher"), "swarm_status reminds the manager to dispatch, not execute");
ok(statusText.includes("experts"), "swarm_status renders expert seats");
ok(statusText.includes("Resources"), "swarm_status renders shared resources");
const agentsText = await statusTool.execute({ mode: "agents" }, { agent: managerAgent });
ok(agentsText.includes("memory"), "agents view lists the memory keeper");
const lineTool = managerTools.find((tool) => tool.name === "swarm_line");
const created = await lineTool.execute({ action: "create", title: "Third line", request: "Do a thing", verifier: "none", experts: [{ label: "one" }, { label: "two", focus: "the other half" }] }, { agent: managerAgent });
ok(created.includes("Line"), "swarm_line create reports the line");
ok(created.includes("one") && created.includes("two"), "swarm_line create accepts several expert seats");
const messageTool = managerTools.find((tool) => tool.name === "swarm_message");
const messageText = await messageTool.execute({ to: queuedB.id, text: "How is it going?", lineId: "" }, { agent: managerAgent });
ok(messageText.includes("Delivered"), "swarm_message returns a receipt");
const leaseTool = expertTools.find((tool) => tool.name === "swarm_lease");
const leaseText = await leaseTool.execute({ action: "status" }, { agent: agents.get(queuedB.experts[0].sessionId) });
ok(leaseText.includes("shared-env"), "the expert can inspect shared resources");
descendants.push({ sessionId: "scout-1", label: "Scout", parentSessionId: queuedB.experts[0].sessionId, status: "idle" });
const scoutText = await messageTool.execute({ to: "scout-1", text: "Check the fixture", lineId: "" }, { agent: managerAgent });
ok(scoutText.includes("Delivered"), "the bus reaches a depth-2 subagent by session id");
ok(calls.sendSubagent.some((call) => call.to === "scout-1" && call.from === queuedB.experts[0].sessionId), "delivery to a subagent goes through its direct parent");
const reportTool = expertTools.find((tool) => tool.name === "swarm_report");
const expertLine = engine.store.lineOf(secondBoard, queuedB.id);
await engine.handleReport(secondBoard, expertLine, queuedB.experts[0].sessionId, { summary: "B delivered", evidence: "none needed" });
const reportText = await reportTool.execute({ summary: "one more" }, { agent: agents.get(queuedB.experts[0].sessionId) }).catch((error) => "ERR " + error.message);
ok(typeof reportText === "string", "the expert report tool executes or refuses with a message");
const memoryAdmin = memoryTools.find((tool) => tool.name === "swarm_memory_admin");
const pendingText = await memoryAdmin.execute({ action: "pending" }, { agent: agents.get(keeper.sessionId) });
ok(pendingText.includes(request.id), "the keeper sees the pending request");
const writtenText = await memoryAdmin.execute({
  action: "write",
  requestId: request.id,
  evidence: "node tools/build-map.mjs; grep move.json dist/",
  verifiedAt: Date.now(),
}, { agent: agents.get(keeper.sessionId) });
ok(writtenText.includes("written") || writtenText.includes("updated"), "the keeper writes the fact-checked entry");
eq(engine.store.pendingMemoryRequests(secondBoard).length, 0, "the request leaves the queue");
const managerMemory = managerTools.find((tool) => tool.name === "swarm_memory");
const recallText = await managerMemory.execute({ action: "recall", query: "fixture map" }, { agent: managerAgent });
ok(recallText.includes("fixture map"), "the manager can recall the recorded fact");

// ── verifier/expert loop closes without the manager ────────────────────────
section("verification loop");
const loopLine = await engine.createLine(secondBoard, { title: "Loop line", request: "Make the loop pass", acceptance: "loop passes", verifier: "required" }, null);
const loopExpert = loopLine.experts[0].sessionId;
await engine.handleReport(secondBoard, loopLine, loopExpert, { summary: "first attempt", evidence: "first" });
const loopVerifier = loopLine.verifierId;
const verdictTool = verifierTools.find((tool) => tool.name === "swarm_verdict");
const failText = await verdictTool.execute({
  pass: false,
  criteria: [{ criterion: "loop", passed: false, evidence: "not looping", owner: loopLine.experts[0].label }],
  failures: ["the loop does not close"],
  notes: "",
  recheck: "rerun the loop",
}, { agent: agents.get(loopVerifier) });
ok(failText.includes("FAIL") && failText.includes("Rework briefs delivered"), "a failed verdict reports automatic delivery");
ok(calls.sendSubagent.some((call) => call.to === loopExpert && call.text.includes("the loop does not close")), "the failed verdict auto-delivers the rework brief to the owner");
await reportTool.execute({ summary: "loop fixed", evidence: "second" }, { agent: agents.get(loopExpert) });
ok(calls.sendSubagent.some((call) => call.to === loopVerifier && call.text.includes("rework reported")), "the report tool wakes the verifier");
const passText = await verdictTool.execute({
  pass: true,
  criteria: [{ criterion: "loop", passed: true, evidence: "loops" }],
  failures: [],
  notes: "",
  recheck: "",
}, { agent: agents.get(loopVerifier) });
ok(passText.includes("PASS"), "a passing verdict closes the loop");
ok(calls.sendToManager.some((call) => call.text.includes("PASSED") && call.text.includes(loopLine.id)), "the passing verdict notifies the manager");
eq(loopLine.status, "done", "the loop reaches a deliverable state");

// ── line status vocabulary is closed ────────────────────────────────────────
section("vocabulary");
for (const status of ["waiting", "working", "verifying", "reworking", "done", "blocked", "cancelled"]) ok(LINE_STATUS.includes(status), "status " + status + " is known");

// ── internal presets are healthy and hidden only from the preset roster ─────
section("preset visibility");
const presetsYaml = fs.readFileSync(new URL("../presets/swarm.patch.yml", import.meta.url), "utf8");
eq((presetsYaml.match(/dsh-swarm\/preset\/gate/g) ?? []).length, 0, "no parked gate rows remain");
ok(!presetsYaml.includes("swarmInternalPresetGate"), "no preset waits for the old gate service");
ok(!presetsYaml.includes("persona: |-"), "tool-subagent rows carry no rejected persona config");
const managerBlock = presetsYaml.slice(presetsYaml.indexOf("id: preset-swarm\n"), presetsYaml.indexOf("id: preset-swarm-expert"));
ok(managerBlock.length > 0, "the manager preset block is present");
for (const row of [
  "@deepseek-ai/dsh-tool-bash",
  "@deepseek-ai/dsh-tool-pwsh",
  "@deepseek-ai/dsh-tool-fs",
  "@deepseek-ai/dsh-tool-fs-search",
  "@deepseek-ai/dsh-tool-jobs",
  "@deepseek-ai/dsh-tool-skill",
  "@deepseek-ai/dsh-tool-web",
  "@deepseek-ai/dsh-tool-todo",
  "@deepseek-ai/dsh-tool-subagent",
  "@deepseek-ai/dsh-tool-workflow",
  "@deepseek-ai/dsh-tool-goal",
  "@deepseek-ai/dsh-tool-ralph",
]) {
  ok(!managerBlock.includes(row), `the manager preset cannot execute: no ${row}`);
}
ok(managerBlock.includes("You are a DISPATCHER"), "the manager persona states the dispatcher identity");
ok(managerBlock.includes("Dispatch-only contract"), "the manager persona carries the hard dispatch contract");
ok(managerBlock.includes("Do not verify."), "the manager is forbidden to verify the work itself");
const managerPrompt = fs.readFileSync(new URL("../lib/preset/manager.js", import.meta.url), "utf8");
ok(managerBlock.includes("If a request needs code"), "the dispatch gate lives in the manager persona");
ok(!managerPrompt.includes("Dispatch gate") && !managerPrompt.includes("Agent count"), "the prompt section does not restate the persona doctrine");
ok(managerBlock.includes("## Domain routing"), "the manager persona carries the domain routing model");
ok(managerBlock.includes("Never start a second expert"), "the manager is told to reuse the domain owner");
ok(managerBlock.includes("exactly ONE independent verifier"), "the manager persona allows one verifier per line");
ok(managerBlock.includes("Do not add a second verifier"), "the manager persona forbids extra verifiers");
ok(managerBlock.includes("## Lease arbitration"), "the manager persona carries lease arbitration");
ok(managerPrompt.includes("swarm_agent") && managerPrompt.includes("swarm_lease"), "the manager prompt maps the swarm tool surface");
ok(managerBlock.includes("One user request = one task line"), "the manager persona carries the agent-count rule");
ok(["swarm_status", "swarm_agent", "swarm_line", "swarm_message", "swarm_memory"].every((tool) => managerPrompt.includes(tool)), "the manager prompt section documents every manager tool");

// The persona row's template variables are a closed set registered by the
// persona plugin. This harness registers only `provider` and `model`; `cwd`
// fails the whole mount with "unknown prompt variable".
const personaVariables = [...new Set([...presetsYaml.matchAll(/{{([a-zA-Z0-9_]+)}}/g)].map((match) => match[1]))].sort();
eq(personaVariables, ["model"], "persona templates use only registered variables");
ok(!/^\s*{{[a-zA-Z0-9_]+}}\s*$/m.test(presetsYaml), "no standalone prompt-variable line");

// ── runtime wiring that only shows up on a live delegation ─────────────────
section("runtime wiring");
const indexSource = fs.readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
ok(indexSource.includes("signal: inertSignal()"), "startActivation receives a constructor-safe signal");
ok(indexSource.includes("options.signal ?? inertSignal()"), "sendMessage receives a signal fallback");
ok(indexSource.includes('delivery: "parent"'), "children report to the parent through the harness, not the engine");

// pm-mode alignment: no autonomous engine-to-agent messages.
const engineSource = fs.readFileSync(new URL("../lib/engine.js", import.meta.url), "utf8");
const toolsSource = fs.readFileSync(new URL("../lib/tools.js", import.meta.url), "utf8");
ok(toolsSource.includes("never adds a second"), "the assign tool restarts the single verifier");
ok(!engineSource.includes("notifyManager"), "the engine has no manager-notification helper");
ok(!engineSource.includes("sendToRole"), "the engine has no role-send helper");
ok(!toolsSource.includes("notifyManager") && !toolsSource.includes("sendToRole"), "tools never push engine messages");
ok(engineSource.includes("Bootstrap is NOT a project survey"), "the keeper prompt forbids a bootstrap survey");
ok(engineSource.includes("Evidence is necessary, not sufficient"), "the keeper separates evidence from worthiness");
ok(toolsSource.includes("Evidence is necessary but not sufficient"), "the memory tool description carries the write gate");
ok(toolsSource.includes("Bootstrap is not a project survey"), "the memory tool description forbids a bootstrap survey");
ok(presetsYaml.includes("Bootstrap is NOT a project survey"), "the keeper persona forbids a bootstrap survey");
ok(managerPrompt.includes("recall before dispatching"), "the manager is told to recall before dispatch");
ok(managerPrompt.includes("zero entries is a valid result"), "the manager is told an empty store is valid");
ok(managerBlock.includes("wait for its report"), "the manager persona waits for the keeper before dispatch");
ok(managerBlock.includes("zero entries is valid"), "the manager persona accepts an empty bootstrap");
ok(engineSource.includes("0 entries") && engineSource.includes("Do not report process"), "the keeper reports a zero-entry bootstrap");

const sampleRoster = {
  presets: [
    { id: "standard", name: "Standard" },
    { id: "swarm", name: "Swarm" },
    { id: "swarm-expert", name: "Swarm Expert" },
    { id: "swarm-verifier", name: "Swarm Verifier", broken: "waiting" },
    { id: "swarm-memory", name: "Swarm Memory" },
  ],
};
eq(filterPresetRoster(sampleRoster).presets.map((row) => row.id), ["standard", "swarm"], "the UI roster keeps only the manager preset");
eq(filterPresetRoster({ presets: [{ id: "swarm" }] }).presets.length, 1, "unrelated rosters pass through");
eq(filterPresetRoster(null), null, "malformed rosters pass through");
eq(HIDDEN_ROLE_PRESETS.length, 3, "three internal preset ids are hidden");

const fakeRegistry = {
  presets: sampleRoster.presets.map((row) => ({ ...row })),
  async list() { return { presets: this.presets.map((row) => ({ ...row })) }; },
  async remoteExportList() { return { presets: this.presets.map((row) => ({ ...row })) }; },
};
const restoreRoster = installRosterFilter(fakeRegistry);
ok(typeof restoreRoster === "function", "the roster filter installs on a service");
const uiRoster = await fakeRegistry.remoteExportList();
eq(uiRoster.presets.map((row) => row.id), ["standard", "swarm"], "the Remote roster hides the internal presets");
eq((await fakeRegistry.list()).presets.length, 5, "the host list stays unfiltered for diagnostics and mount");
ok(installRosterFilter(fakeRegistry) === null, "the filter is installed only once");
restoreRoster();
eq((await fakeRegistry.remoteExportList()).presets.length, 5, "dispose restores the original Remote roster");

process.stdout.write("\n" + checks + " checks passed.\n");
fs.rmSync(base, { recursive: true, force: true });
