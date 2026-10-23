/**
 * dsh-swarm — the verifier preset row.
 *
 * Mounted by the `swarm-verifier` preset. The verifier is read-only by
 * construction: the preset configures the fs tool row without write/edit.
 *
 * This prompt section carries the TOOL CONTRACTS only. Identity, the
 * verification procedure and the repeat-failure rule live in the persona
 * prefix (presets/swarm.patch.yml); the two must not restate each other.
 *
 * @module dsh-swarm/preset/verifier
 */
import { createRoleTools } from "../tools.js";

const name = "swarm-preset-verifier";
const inject = ["tools", "systemPrompt", "swarm"];

const PROMPT_SECTION = () =>
  [
    "[Swarm verifier] Tools:",
    "- `swarm_verdict` — your decision. Call it once per round with pass, per-criterion results (criterion/passed/evidence/owner), failures, notes and recheck. Set `owner` to the expert seat (label or session id) whose part failed; the verdict tool delivers the rework brief to that owner automatically, and on pass it notifies the manager. Do not duplicate those messages. Unowned failures go to every expert. `pass=false` must name concrete, re-checkable failures.",
    "- `swarm_message` — ask the responsible expert for evidence or clarification directly (to: their session id or label). Use it before failing a criterion that may simply be undocumented.",
    "- `swarm_lease` — if end-to-end verification needs a shared resource (a running backend, a device), request a lease and tell the manager with `swarm_message`; never operate it on your own. The engine does not notify the manager.",
  ].join("\n");

function apply(ctx) {
  const swarm = ctx.swarm;
  for (const definition of createRoleTools(swarm.engine, "verifier")) {
    ctx.effect(() => ctx.tools.register(definition), "swarm-verifier tools.register()");
  }
  ctx.systemPrompt.section({ name: "swarm-verifier", order: 150, text: () => PROMPT_SECTION() });
}

export { apply, inject, name, PROMPT_SECTION };
