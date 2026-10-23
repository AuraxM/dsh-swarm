# dsh-swarm

Swarm Mode for the DeepSeek Harness: the user talks to a **manager** session, which
runs the project as a swarm of role agents — one **expert** per task line, an
independent **verifier** for development work, and a **memory keeper** that owns
project memory. The **state machine** is owned by the plugin's engine, not by the
manager model, so the manager stays small, fast and replaceable while delivery
quality is protected by an independent role. In the pm-mode tradition, the engine
**sends no autonomous messages**: agents coordinate with `swarm_message`, and the
engine records state, starts/retires role agents, and only delivers a task book
when a manager tool explicitly dispatches to a reused domain expert.

This is the role-separated successor to the `pm` (总控) idea: pm-mode's manager did
routing, acceptance and progress bookkeeping in one context; that context degraded
under a fast model and frequent compaction. Here acceptance moves to a verifier,
progress moves to the engine, and the manager only decides.

## Roles

| Role | Preset | Depth | Owns | Does not |
|---|---|---|---|---|
| Manager | `swarm` (user-facing) | 0 | intake, domain routing, line creation, choosing the expert team, verifier policy, decisions, user reporting, memory relay, shared-resource leases | acceptance, progress tracking, code reading, shell, memory writes |
| Expert / executor | `swarm-expert` (internal) | 1 | one domain owner or one line seat end to end; may start subagents; structured `swarm_report`; shared-resource requests | deciding its own pass; writing memory; operating a shared resource without a lease |
| Verifier | `swarm-verifier` (internal) | 1 | independent per-criterion verdict against the acceptance criteria, with owners | modifying the deliverable (preset has no write/edit tools) |
| Memory keeper | `swarm-memory` (internal) | 1 | sole writer and sole fact checker of project memory; bootstrap triage; reports when its review is done | project source writes; serving memory bodies to workers |

A line may have **one or several experts**. A single-domain request gets one seat;
a feature that touches frontend and backend gets two (plus one verifier), and the
manager may add or remove seats while the line is in flight. The verifier judges
the combined delivery and can attribute each failed criterion to a seat, so the
verifier messages only the responsible expert and the engine resets only that
seat's report.

### Domains and expert reuse (pm-mode model)

The board keeps a **domain registry**: one responsibility text and one owner expert
per domain. The manager reads it with `swarm_agent recommend`/`list`, defines a
missing domain with `domain`, and binds a live expert with `bind`.

`swarm_line create domain=<id>` (or `experts[].domain`) routes the seat:

- the domain's owner is live and **idle** → the engine sends the new task book to
  that expert and creates no activation; the expert's context carries over;
- the owner is **busy** → the line queues; when the owner's current line closes,
  the engine dispatches the parked line automatically;
- no live owner → a new expert starts and the domain is bound to it.

A domain expert is **persistent**: closing its line releases its leases and marks
its seat retired, but the role stays live with an empty `lineId`; it consumes no
concurrency slot while idle. The verifier and non-domain experts are per-line and
retire normally. In this schema an expert owns at most one domain; both directions
are one-to-one (`bind` clears any other domain that pointed at the same expert).

The engine starts role agents with `agentPreset`, so each role carries only its own
tool surface and prompt. The expert preset is the standard agent surface (filesystem,
shell, search, web, jobs, skills, subagents, workflow); the verifier runs the
filesystem row with `write:false, edit:false`; the memory keeper is read-only on
project files. Children are started with `delivery: "parent"`: the harness's own
child-completion notices are delivered automatically, exactly the channel pm-mode
relies on. The engine sends no autonomous messages; the verifier/expert **tool
calls** deliver the rework/final messages, and a manager's explicit
`swarm_line create` may dispatch a task book to a reused domain expert.

### Dispatcher discipline (pm-mode alignment)

pm-mode's dispatcher and children share one composition (`composeFrom`), so its
shell and filesystem rows cannot be removed for the dispatcher without crippling
the children. pm-mode therefore constrains the dispatcher **behaviourally** in the
persona prefix: no project exploration, no troubleshooting, no product code, no
design, no verification, no long-running work; only single-point evidence checks
(stop at the second hop). Our manager preset is structurally thinner — no shell,
filesystem, search, jobs, skills, web, todo, subagent, workflow or goal rows — and
the persona carries the same dispatch-only contract: dispatch and stop, no
pre-solving, no self-verification, no step-lines. `scripts/smoke.mjs` asserts both
the absence of execution rows and the presence of the doctrine, because the thin
tool surface stops code execution but only the prompt stops the manager from
writing the solution in prose.

The workflow itself is prompt-borne, following pm-mode's organisation: identity
→ task model → hard prohibitions → domain routing → shared resources → memory →
acceptance/reporting → idle/red lines. Our manager persona now states the loop
explicitly: read board → keeper first (end turn, wait for its report; zero entries
valid) → recall/route by domain → create one line with request/acceptance/
boundaries → stop → monitor, arbitrate leases, report sources → idle. The keeper
step is a written rule, not a tool-level gate: the model is trusted to follow it.

## Why two planes

The plugin is a host row plus four preset rows, exactly like pm-mode:

- `lib/index.js` (mounted once by the profile bundle) owns the board store, the
  engine, the runtime adapter, the project-memory store and the `/swarm` panel
  route. It **registers no tool and no prompt section** — a row mounted by the
  profile lives in a root context, and `ctx.tools.register` there would publish
  the swarm toolset into every preset in the process.
- `lib/preset/{manager,expert,verifier,memory}.js` are the four subpath plugin
  rows. Each registers its role's tools into the mounting preset's agent scope and
  writes one prompt section.
- The section carries the **tool contracts only** — one bullet per tool plus the
  cross-tool mechanics (which tool owns what). Identity, judgment, hard rules and
  the workflow live in the preset persona, so the two never restate each other;
  the split is asserted in `scripts/smoke.mjs`. Repeating the doctrine in both
  places costs the manager context on every turn, which is why it was removed.

The engine is pure JavaScript over an injected runtime, so the state machine is
testable offline (`scripts/smoke.mjs`).

### The internal role presets are hidden from the preset UI

The shipped `@deepseek-ai/dsh-agent-preset` registry has no `hidden` or
`selectable` field: every declared preset is offered by the new-session picker
and by Settings -> Agent Presets. The plugin hides the three internal presets at
the Host boundary instead of forking the shipped UI:

- `lib/roster.js` wraps only `agentPresets.remoteExportList`, the Remote
  implementation the picker/Settings roster reads. The Typert gateway resolves
  that implementation on **every call** (`Reflect.get(receiver, implementation)`),
  so the shim feeds both UI surfaces a roster without `swarm-expert`,
  `swarm-verifier` or `swarm-memory`. The host's own `list`, and the registry's
  `mount`, `resolve` and `retain`, are untouched: diagnostics and child
  composition see the real registry, and the engine still starts children with
  those ids.
- The internal presets are ordinary healthy compositions; there are **no parked
  gate rows**. The roster shim is presentation-only.

Verification: Settings -> Agent Presets and the new-session picker list **only
`Swarm`** among the swarm presets, with no red badge; `/swarm/__api__/diagnostics`
lists all four with `broken: ""` (an internal preset that is broken is a real
composition bug, not the hiding mechanism). `scripts/smoke.mjs` covers the pure
filter, installation/restore, the raw diagnostic roster, and the absence of gate
rows and rejected `tool-subagent` persona configs.

Consequence: **do not create a session on `swarm-expert`, `swarm-verifier` or
`swarm-memory` by hand**; they are child compositions started by the engine. If
a future harness adds a real hidden flag, remove the roster shim and use that
flag instead.

## Task-line lifecycle

```
waiting -> working -> verifying -> rework -> working -> ... -> done
                    \-> blocked (recorded; the manager sees it in swarm_status)
```

- A line is one user request. `swarm_line create` stores the request verbatim,
  the acceptance criteria, the boundaries, the expert seats
  (`experts=[{label,domain,focus}]`), the routing domain and the relayed memory
  ids, then routes each seat: reuse the domain owner, queue behind a busy owner,
  or start a new expert. Non-domain seats wait in the capacity queue.
- Each seat calls `swarm_report`. The engine waits until **every** seat has
  reported; only then does it set the line to `verifying`. A resident verifier is
  not re-prompted: the **expert's report tool** wakes it after a rework report
  (the manager can also send a message). A seat that reports `blocked` blocks the
  line, and the report tool notifies the manager.
- `swarm_verdict pass=false` carries per-criterion `owner` values. The engine
  resets only the owning seats' reported flags (unowned failures go to all
  seats); the **verdict tool** then delivers the rework brief to each owner
  automatically. The seat reworks and reports; the report tool wakes the verifier.
- **No round cap.** The loop runs until a verdict passes. The engine records
  repeated failure signatures and blocked lines; it does not escalate by message:
  - a repeated failure signature across two rounds (board event),
  - an expert that reports `blocked` (or cannot finish),
  - a decision that needs the user's words (manager reads status).
- A passing verdict retires the line's per-line agents, releases every lease they
  held, and frees their concurrency slots. The **verdict tool notifies the
  manager** of the pass; a no-verifier delivery or a blocker is reported by the
  expert's report tool. A domain owner stays resident and receives the next
  queued same-domain task.

### Stuck seats (manager judgment, no mechanism)

The engine records a `repeated failure signature` event when a verdict repeats
the previous round's failed criteria; it does nothing about it. Replacing a seat
is the manager's call, made from the board (`swarm_status mode=detail` carries
the verdict history, `mode=delta` the escalation event), and the doctrine is
prompt-borne — manager preset persona plus the `swarm/preset/manager` prompt
section. No round cap, no automatic trigger, no engine policy.

- **Progress is the failure moving.** A different failed criterion, or the same
  one with a changed reason, means the seat is advancing; the same criterion
  with the same failure text means it is circling its own context.
- **Swap the seat, not the task**: `remove-expert` the seat, then `add-expert`
  with a new label and **no domain**. A seat *with* a domain is routed to that
  domain's owner, and `remove-expert` only makes an owner idle — so
  re-dispatching with `domain=<id>` hands the task back to the same expert with
  its context intact. That is the trap: a swap that looks like a swap changes
  nothing.
- The workspace survives the swap; the conversation does not. The proven dead
  end goes into the new seat's `focus` as a fact ("do not retry X: it fails
  because Y"), never as the old plan or the old seat's reasoning.
- The manager re-applies the same test after each swap; the engine counts
  neither rounds nor swaps. Slow work, a lease wait and a `blocked` report are
  not swaps: the first is not progress, the second is arbitration, the third is
  a decision. A swap that leaves the failure where it was usually indicts the
  acceptance criteria, not the expert.

### Shared resources

Some resources exist once on the machine (a backend instance, a build slot, a
device) and only one agent may operate them at a time:

1. the manager declares one with `swarm_line action=define-resource`;
2. a worker asks with `swarm_lease action=request` — this only queues; the worker
   messages the manager with `swarm_message`;
3. the manager grants it to one session (`action=grant`), takes it back
   (`revoke`), or hands a free one to the queue head (`grant-next`); the engine
   does **not** notify the holder, so the manager must message it;
4. the holder releases it with `swarm_lease action=release`; the queue head is
   promoted (state only) and the holder tells the manager;
5. when the line closes, the engine releases every lease its roles held (state
   only).

The manager is the only issuer; a worker never self-grants.

## Message bus

Every agent can message every other agent with `swarm_message` (targets: `manager`,
`expert`, `verifier`, `memory`, a line id, or a session id). The runtime natively
allows only parent <-> direct child delivery, so the engine relays: it resolves a
legal adjacent sender, delivers through the subagent service, and prefixes the
body with the real sender (`[swarm] from <label> (<role>, line ...)`). Every
message is recorded on the board and visible in the panel and in `swarm_status`.

The usual reporting paths are stated in the presets (experts -> manager at delivery/
blocking, verifier -> the responsible expert on failures, experts <-> siblings on
interface/contract, everyone -> memory keeper for write requests, keeper -> manager
for milestones), but the bus itself is unrestricted.

## Memory

Project memory is keyed by project, not by session (`$DSH_HOME/swarm/memory/`).

- **The manager is the only reader.** `swarm_memory action=list|recall` reads the
  index and bodies. When it creates a line it passes `memoryIds`; the engine
  injects the entries verbatim into the task book under a "relayed by the manager"
  header. Workers never see a memory tool and their presets never mention memory,
  so a stale store cannot pollute a working agent's context.
- **The memory keeper is the only writer.** Writes go through
  `swarm_memory_admin action=write` and require evidence plus the moment of
  verification. The write gate is the delete test: delete it — would the next
  agent get this wrong? What passes: credentials or tokens valid only here, a
  required ordering or a step everyone skips, a format something downstream
  string-matches, a measured fact that contradicts the obvious reading, or a
  conclusion already proven with evidence. What does not: repository layout,
  build/test commands, common tool usage, anything a competent agent arrives at
  unaided. **Evidence is necessary but not sufficient**; a well-evidenced obvious
  fact still does not go in, and the keeper rejects such requests even when the
  evidence is impeccable. Same delete test as pm-mode; unlike pm-mode's
  dispatcher, here only the keeper writes and evidence is a hard requirement.
- **Write requests are a queue.** After a line ends (or when a report reveals a
  non-obvious fact) the manager queues a claim with evidence via
  `swarm_memory action=request-write`, then messages the keeper. The keeper
  verifies it, writes it, or rejects it with a reason, and messages the manager
  with the decision. The engine sends no notification.
- **Bootstrap is not a survey.** When a project has no memory, the manager starts
  the keeper with `swarm_memory action=bootstrap`; the keeper looks only for
  non-obvious traps, verifies each candidate, and lets the delete test decide.
  Zero entries is a valid result — an empty memory beats a common-sense dump.
  The keeper reports the count and topics (including "0 entries").
- **The keeper comes first, by workflow.** The manager starts the keeper with
  `swarm_memory action=bootstrap` and then **ends its turn**; it creates the first
  line only after the keeper's message reports what survived the gate (0 entries
  is valid). This is a prompt-level workflow rule, not a tool gate: the manager's
  persona and the tool descriptions state the order, and the model is trusted to
  follow it. A session with no identifiable project has no memory home, so the
  keeper step does not apply there.
- **No approach preferences.** A chosen approach, an architecture preference or a
  plan is not memory: it is relayed into later task books and would pin the next
  expert to the previous expert's idea. Record what failed and why (a fact), not
  what was chosen (a preference).
- Memory entries carry `evidence`, `verifiedAt`, `verifiedBy`, tags and hit counts.
  A human can delete a wrong entry from the panel; the keeper can update one.

## Panel

Session-header button (`🐝 Swarm (n) ⛔m`) plus a right-hand drawer over the
same-origin `/swarm` route, polling only while open:

| Tab | Contents |
|---|---|
| Lines | line cards: status, every expert seat with live status, domain, reused flag and reported flag, verifier, round, last report/verdict, elapsed; Detail expands per-seat reports, verdicts (with owners) and messages; Abort cancels a line |
| Agents | domain registry (id → owner, live status, current line) plus role roster with live status, domain, resident flag, line, model and parent |
| Messages | the bus transcript |
| Resources | shared resources: holder, hold time, wait queue, force release |
| Memory | entries (evidence, verified time, hits), pending write requests, delete |
| Settings | max concurrent role agents, default verifier policy, per-role model routes |

The same role-route editor is also a first-class **Settings -> Swarm Models** page
(`settings.section`, order 25), so deployment models can be changed without
opening a Swarm conversation: pick `provider` / `model` / `reasoningEffort` per
role, Save, and the Host validates the route against the live LLM adapter. An
empty route inherits the manager session's model; the manager itself always uses
the session's model.

There is deliberately **no Gantt chart and no statistics**: the plugin stores no
tool-call timeline. The board answers "what is the project doing right now",
which is what the manager and the human actually need.

## Tools

| Tool | Role | Purpose |
|---|---|---|
| `swarm_status` | manager | snapshot / delta / detail / agents — the project picture, including domain ownership |
| `swarm_agent` | manager | recommend / list / domain / bind — domain routing registry and owner lookup |
| `swarm_line` | manager | create / add-expert / remove-expert / assign (verifier) / verify / abort / decide / note / define-resource / grant / grant-next / revoke / release |
| `swarm_message` | every role | universal message bus |
| `swarm_memory` | manager | list / recall / request-write / bootstrap (manager-only reads) |
| `swarm_report` | expert | structured delivery or blocker |
| `swarm_lease` | expert / verifier | request / release / status for a shared-resource lease |
| `swarm_verdict` | verifier | per-criterion verdict with owners, failures, recheck |
| `swarm_memory_admin` | memory keeper | pending / write / update / forget / reject / list / recall |

All parameter schemas are raw JSON Schema (root `type: object`). The package
imports nothing from `@deepseek-ai/*` at load time; the only dynamic import is
the harness user-message constructor with a local equivalent fallback. That keeps
a workspace-linked install working (the fish-loop junction lesson).

## Configuration

`$DSH_HOME/swarm/settings.json`:

```json
{
  "version": 1,
  "maxConcurrent": 6,
  "verifier": "auto",
  "roles": {
    "expert":   { "provider": "", "model": "", "reasoningEffort": "" },
    "verifier": { "provider": "", "model": "", "reasoningEffort": "" },
    "memory":   { "provider": "", "model": "", "reasoningEffort": "" }
  }
}
```

- Empty role routes mean "inherit the manager's model". Configure them in
  **Settings -> Swarm Models** (or the panel's Settings tab); routes are validated
  against the live LLM adapter before they are written.
- `maxConcurrent` is capped at 8 and should stay below the harness's own
  `subagent.maxActiveSubagents` (default 8 per activation tree), because an
  expert's own subagents consume the same budget.
- `verifier` is the default policy for new lines: `auto` and `required` assign a
  verifier, `none` does not. `auto` currently means "assign" (there is no
  reliable heuristic for development-vs-research at creation time); the manager
  is told to pass `none` for pure reconnaissance lines.

Data lives under `$DSH_HOME/swarm/`: one directory per manager session holding
`board.json` (atomic tmp+rename), plus `memory/index.json` and one document per
project. Reinstalling the bundle leaves all boards and memory in place.

## HTTP surface

| Route | Purpose |
|---|---|
| `GET /swarm/__health__` | liveness probe (`magic: swarm-ok`) |
| `GET /swarm/__api__/state?sessionId=` | board projection + messages + memory requests + settings |
| `GET /swarm/__api__/state?sessionId=&lineId=` | one line's full detail |
| `GET /swarm/__api__/boards` | every board on disk |
| `GET /swarm/__api__/models` | provider/model catalog for the settings form |
| `GET /swarm/__api__/diagnostics` | preset registration check (`swarm`, `swarm-expert`, `swarm-verifier`, `swarm-memory`) |
| `GET /swarm/__api__/memory?sessionId=` | project memory entries |
| `POST /swarm/__api__/manage` | panel mutations — **loopback only** |

## Install and verify

```
plugin_manager action=install_bundle target=E:\Projects\dsh-plugin\dsh-swarm
```

The host row and the four preset rows mount through the live patch layer in this
deployment (`install_bundle` reported `application: applied`, and `list_plugins`
shows all five rows `active`), so the picker can offer `Swarm` without a restart.
A change to the host **code** still needs a process restart: Node's ESM cache
keeps the old module generation for the same specifier. A client change needs a
page refresh.

Verify:

1. `GET /swarm/__health__` -> `{"ok":true,"magic":"swarm-ok",...}`;
2. a new session on the `Swarm` preset lists `swarm_status`, `swarm_agent`,
   `swarm_line`, `swarm_message`, `swarm_memory` (and no shell/filesystem tools);
   the new-session picker lists **only `Swarm`** — the internal presets are filtered
   from the roster by the Host shim; they are healthy child compositions, not
   gate-hidden broken rows);
3. start a project session and run `swarm_status mode=snapshot`;
4. `swarm_memory action=bootstrap` starts the keeper; the manager ends its turn
   and waits for the keeper's report (entry count/topics, 0 is valid), then
   creates the first line;
5. `swarm_agent action=domain id=web name=Web responsibility="pages and state"`,
   then `swarm_line action=create domain=web ...` starts and binds one expert; a
   second `domain=web` line reuses that expert with no new activation, and a
   third while it is busy queues until the owner frees;
6. `swarm_line action=create ... verifier=required` starts one expert; its
   `swarm_report` starts a verifier; a failed verdict is sent to the expert by
   the **verifier**, not the engine;
7. `swarm_line action=create ... experts=[{label:"frontend",domain:"web"},{label:"backend",domain:"api"}]`
   reuses or starts one owner per independent domain; the verifier starts only
   after both report, and a failed criterion with `owner:"frontend"` makes the
   verifier message only the frontend seat; the seat reports and messages the
   verifier back;
8. `swarm_line action=define-resource resourceId=shared-env`, then a worker's
   `swarm_lease action=request` queues and the worker messages the manager; the
   manager's `grant` hands it over (and must tell the holder), and closing the
   line releases it automatically (state only).

## Development

```powershell
node scripts/smoke.mjs          # 221 checks: memory, store, engine (domains/reuse, joint lines, leases), tools, verification loop, preset roster filter, dispatcher guards, memory gate, wiring
node scripts/check-client.mjs   # 28 checks: bundle format, stylesheet mount, slot registrations, settings section, domain view
node --check lib/*.js
```

The presets are YAML; validate them in a YAML parser before installing (the
`!!js` platform expressions need a permissive tag handler). The four preset ids
are `swarm`, `swarm-expert`, `swarm-verifier`, `swarm-memory`; the engine passes
them as `request.agentPreset`, so renaming one requires touching both
`presets/swarm.patch.yml` and `lib/engine.js`.

### Known traps

1. **The client stylesheet must be MOUNTED, not just declared.** A `CSS` string
   that no one appends to the document leaves the overlay entry as an unstyled
   flex row floating over the app — measured once, and it looks like a broken
   layout rather than a missing stylesheet. `scripts/check-client.mjs` runs the
   bundle against a DOM stub and fails when the `<style>` tag is absent or the
   rules do not parse as balanced.
2. **The frame overlay is click-through.** `.sw-panel` must opt back in with
   `pointer-events:auto`, or every control is unclickable while looking fine.
3. **Reserve the title bar and the window controls.** The drawer is fixed at
   `top:0`; `padding-top: var(--sw-titlebar-h)` and the header's
   `padding-right: calc(14px + var(--sw-winctl-right))` keep content out from
   under the traffic lights and the Windows caption buttons.
4. **Persona prefixes interpolate only registered variables.** This deployment
   registers `provider` and `model` for `deployment:persona-prefix`; a
   `{{cwd}}` placeholder fails the whole turn with `unknown prompt variable`.
   Keep only `{{model}}`/`{{provider}}` in the four persona prefixes, inline in
   prose (a standalone `{{model}}` line is a duplicate, not a context block).
   `scripts/smoke.mjs` asserts the closed variable set.
5. **Every delegation call needs a signal object.** `startActivation` dereferences
   `spec.signal.throwIfAborted()` while materializing the child, and
   `sendMessage` expects the option to exist. A background role must not inherit
   a manager turn's cancellation, so the runtime adapter passes a fresh, inert
   `AbortController.signal` (never `AbortSignal.abort()` — an aborted signal
   fails immediately with a misleading AbortError). `scripts/smoke.mjs` asserts
   both call sites carry the fallback.
6. **Structured output closes a child's input.** See "Deliberate limits".
7. **The engine sends no autonomous messages.** Coordination is tool-mediated:
   agents call `swarm_message`; the engine records state and starts/retires
   children. A manager's explicit `swarm_line create` is allowed to dispatch the
   task book to a reused expert; that is the manager's action, not a push. Do not
   reintroduce `notifyManager`/`sendToRole`-style pushes: they queue as "[swarm]"
   user messages in the manager's inbox and are exactly what pm-mode avoids. The
   harness's own child-completion notices are the only automatic messages.
8. **A thin tool surface does not stop prose work.** The manager has no
   filesystem/shell, but it can still answer a request with a design or a plan.
   The dispatch-only persona is load-bearing; pm-mode has the same prompt-only
   constraint on its dispatcher's shell because the dispatcher shares the child
   toolset.
9. **`domain` on a seat is a lifecycle decision, not a tag.** Any seat started
   with a domain becomes a persistent owner: line close frees it instead of
   retiring it. Use `domain` only for genuine routing; a one-off line must omit
   it or its expert stays resident.

## Deliberate limits

- **Structured reports are tools, not `outputSchema`.** The subagent service can
  give a child an `outputSchema` and a `structured_output` tool, but a committed
  structured result closes that activation's input. That is incompatible with
  the no-cap rework loop, which must message the same expert again. `swarm_report`
  and `swarm_verdict` therefore carry the schemas, and the engine validates and
  records them itself.
- **No round cap on verification.** A line that cannot pass keeps looping; the
  board records repeated failure signatures (pm-mode alignment: the engine sends
  no autonomous message, so there is no escalation push).
- **The verifier is read-only by tool surface, not by sandbox.** It can run tests
  and builds; the doctrine says it must not modify the deliverable. A strict
  sandbox would break test runs.
- **Leases are manager-issued but auto-released.** A worker cannot self-grant a
  shared resource; the manager's grant is the only path. When a line closes, the
  engine releases every lease its roles held and promotes the queue head (state
  only; no message), so a crashed line cannot strand a backend instance.
- **A joint line verifies only after every seat reports.** `swarm_line action=verify`
  is the explicit override for a partial delivery. A seat that blocks the line
  stops verification until the manager fixes the team or the task.
- **Domain ownership is one-to-one in this schema.** pm-mode lets one expert own
  several domains; here a role carries one `domain` and a domain one owner, and
  `swarm_agent bind` clears any other domain that pointed at the same expert. A
  seat carrying a domain becomes persistent; closing its line leaves it resident
  and idle. An idle domain owner consumes no concurrency slot; when dispatched it
  does (a queued reuse bypasses the new-start capacity check because the role is
  already live).
- **The memory keeper is per session.** Memory is project-scoped, but the keeper
  agent is a child of the manager session; a new session starts its own keeper
  and reads the same store. Its manager starts that keeper and waits for its
  report before the first line.
- **One project per manager session.** The board records the manager's cwd as its
  project; running the same session in another checkout re-tags the board (the
  same rule as pm-mode).
- **`maxConcurrent` is a plugin-side queue**, not a runtime guarantee: the
  harness's `maxActiveSubagents` still applies to the whole activation tree,
  including an expert's own subagents.
