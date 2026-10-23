/**
 * dsh-swarm — the expert preset row.
 *
 * Mounted by the `swarm-expert` preset. The expert is a standard agent unit:
 * filesystem, shell, search, web, subagents of its own. Its only swarm tools are
 * the structured delivery report plus the message bus.
 *
 * This prompt section carries the TOOL CONTRACTS only. Identity, judgment and
 * the workflow live in the persona prefix (presets/swarm.patch.yml); the two
 * must not restate each other.
 *
 * @module dsh-swarm/preset/expert
 */
import { createRoleTools } from "../tools.js";

const name = "swarm-preset-expert";
const inject = ["tools", "systemPrompt", "swarm"];

const PROMPT_SECTION = () =>
  [
    "[Swarm expert] Tools:",
    "- `swarm_report` — your delivery contract. Call it each time you deliver or are blocked, with summary, artifacts, evidence, blockers, facts, questions. The engine records it and waits for EVERY seat to report before the independent verifier judges the combined delivery.",
    "- `swarm_lease` — shared resources (a backend instance, a build slot, a device) are single-holder. `action=request` queues you; the engine does not notify the manager, so tell it with `swarm_message`. Do not operate the resource until you hold the lease. `action=release` hands it back and tells you to message the manager; `action=status` shows holders and waiters.",
    "- `swarm_message` — message any agent (manager, verifier, a sibling expert, a line id when it has one expert, a session id). Use it to agree on the interface between your parts; structured delivery still goes through `swarm_report`.",
    "",
    "Rules:",
    "1. Report non-obvious facts in `facts`: a command that reports success while doing nothing, an ordering constraint, a format something downstream depends on. The manager decides whether they are recorded.",
    "2. If you cannot finish, say exactly what blocks you in `swarm_report` (or message the manager) instead of guessing or silently expanding scope.",
    "3. Your subagents report to you, not to the manager. You are responsible for collecting their output.",
  ].join("\n");

function apply(ctx) {
  const swarm = ctx.swarm;
  for (const definition of createRoleTools(swarm.engine, "expert")) {
    ctx.effect(() => ctx.tools.register(definition), "swarm-expert tools.register()");
  }
  ctx.systemPrompt.section({ name: "swarm-expert", order: 150, text: () => PROMPT_SECTION() });
}

export { apply, inject, name, PROMPT_SECTION };
