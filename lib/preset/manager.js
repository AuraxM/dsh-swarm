/**
 * dsh-swarm — the manager preset row.
 *
 * Mounted by the `swarm` agent preset (the user-facing one). Registers the
 * manager's dispatch/read surface into that preset's agent scope only, so no
 * other preset ever sees `swarm_*`.
 *
 * This prompt section carries the TOOL CONTRACTS only. Identity, judgment and
 * the workflow live in the persona prefix (presets/swarm.patch.yml); the two
 * must not restate each other.
 *
 * @module dsh-swarm/preset/manager
 */
import { createRoleTools } from "../tools.js";

const name = "swarm-preset-manager";
const inject = ["tools", "systemPrompt", "swarm"];

const PROMPT_SECTION = () =>
  [
    "[Swarm manager] Tools:",
    "- `swarm_status` — read the project picture. `mode=snapshot` (default) gives every line with its experts/verifier, status, round, last verdict and last report, plus roles, domains, memory state and leases. `mode=delta since=<revision>` gives only what changed. `mode=detail lineId=...` gives one line's reports/verdicts/messages. `mode=agents` includes the experts' own subagents.",
    "- `swarm_agent` — routing registry: `recommend`/`list` returns every domain, its responsibility, owner and live status; `domain` defines a domain; `bind` gives a live expert ownership. Judge ownership yourself.",
    "- `swarm_line` — create/steer lines. One user request = one line; a line may have SEVERAL expert seats only when the work genuinely spans independent domains. Pass `domain=<id>` (or `experts[].domain`) to reuse that domain's live owner; the engine queues when the owner is busy and binds a new expert when there is none. Add/remove seats later, force verification with `verify`, and pick `verifier=auto|required|none`. Relay project facts with `memoryIds=[...]` — pass ids, never pasted text.",
    "- `swarm_line` also owns SHARED RESOURCES: `define-resource` once (a backend instance, build slot, device), then `grant` it to one agent session; `revoke`, `grant-next` and `release` manage handoff. Workers request leases with `swarm_lease` and wait for your grant.",
    "- `swarm_message` — talk to any agent (manager, an expert seat by session id, verifier, memory, a line id when it has one expert, or any session id). A receipt, not an answer.",
    "- `swarm_memory` — `list`/`recall` read the project's recorded facts; recall before dispatching and relay only entries that change execution. `request-write` queues a **non-obvious, project-specific** claim (with evidence) for the memory keeper, then message the keeper; `bootstrap` starts the keeper when the store is empty (not a survey; zero entries is a valid result).",
  ].join("\n");

function apply(ctx) {
  const swarm = ctx.swarm;
  for (const definition of createRoleTools(swarm.engine, "manager")) {
    ctx.effect(() => ctx.tools.register(definition), "swarm-manager tools.register()");
  }
  ctx.systemPrompt.section({ name: "swarm-manager", order: 150, text: () => PROMPT_SECTION() });
}

export { apply, inject, name, PROMPT_SECTION };
