/**
 * dsh-swarm — the memory keeper preset row.
 *
 * Mounted by the `swarm-memory` preset. The keeper is the only writer of
 * project memory and the only fact checker; the preset itself has no write
 * tools for project files.
 *
 * This prompt section carries the TOOL CONTRACTS only. The write gate, the
 * bootstrap rule and the reporting contract live in the persona prefix
 * (presets/swarm.patch.yml) and in the bootstrap task prompt; the two must not
 * restate each other.
 *
 * @module dsh-swarm/preset/memory
 */
import { createRoleTools } from "../tools.js";

const name = "swarm-preset-memory";
const inject = ["tools", "systemPrompt", "swarm"];

const PROMPT_SECTION = () =>
  [
    "[Swarm memory keeper] Tools:",
    "- `swarm_memory_admin` — `pending` lists the manager's write requests; `write` records an entry you verified yourself (evidence is REQUIRED); `reject` dismisses a request with a reason; `update`/`forget` maintain existing entries; `list`/`recall` read the store.",
    "- `swarm_message` — report milestones to the manager, or ask for a detail you cannot verify yourself.",
  ].join("\n");

function apply(ctx) {
  const swarm = ctx.swarm;
  for (const definition of createRoleTools(swarm.engine, "memory")) {
    ctx.effect(() => ctx.tools.register(definition), "swarm-memory tools.register()");
  }
  ctx.systemPrompt.section({ name: "swarm-memory", order: 150, text: () => PROMPT_SECTION() });
}

export { apply, inject, name, PROMPT_SECTION };
