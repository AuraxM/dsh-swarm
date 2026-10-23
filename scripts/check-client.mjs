/**
 * dsh-swarm — client bundle check.
 *
 * The client module is a browser script, so its stylesheet is a string mounted
 * at load time. A missing mount is invisible to node --check and produces an
 * unstyled panel floating over the app (measured once), so this check runs the
 * bundle against a DOM stub and asserts the tag, the rules and the slot
 * registrations.
 *
 * Run: node scripts/check-client.mjs
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

let checks = 0;
function ok(condition, message) {
  checks += 1;
  if (!condition) throw new Error("FAIL: " + message);
}

const source = fs.readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");

const styleTags = [];
let registered = null;
const slots = [];
const ReactStub = {
  createElement() { return null; },
  useState() { return [null, () => {}]; },
  useEffect() {},
};

globalThis.window = {
  __ModuleLoader__: {
    load(definition) { registered = definition; },
  },
  localStorage: { getItem() { return null; } },
  setInterval() { return 0; },
  clearInterval() {},
  confirm() { return false; },
  fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
};
globalThis.document = {
  querySelector() { return null; },
  createElement() { return { dataset: {}, textContent: "" }; },
  head: { appendChild(tag) { styleTags.push(tag); } },
};

// Run the bundle as a browser script: `require` is the module table lookup.
const run = new Function("require", source + "\n//# sourceURL=dsh-swarm-client.js");
run(() => ReactStub);

ok(registered !== null, "the bundle registers a lazy factory");
ok(registered.id === "dsh-swarm", "the factory id equals the package name");
const api = registered.factory(() => ReactStub);
ok(Array.isArray(api.inject) && api.inject.includes("slots"), "the client injects slots");
ok(typeof api.apply === "function", "the client exposes apply()");
api.apply({
  slots: {
    inject(key, callback) { callback(); },
    register(definition) {
      slots.push(definition);
      return () => {};
    },
  },
});
const ids = slots.map((definition) => definition.id);
ok(ids.includes("swarm-button"), "the session header button is registered");
ok(ids.includes("swarm-overlay"), "the frame overlay is registered");
ok(ids.includes("swarm-role-models"), "the settings section is registered");
ok(source.includes("function SwarmModelSettings"), "the settings section component exists");
ok(source.includes("action: 'set-role-route'"), "the settings section saves role routes");
ok(source.includes("__api__/models"), "the settings section reads the model catalog");
ok(source.includes("if (store.open) closePanel();"), "the header button toggles the drawer closed");
ok(source.includes("'aria-pressed': store.open"), "the header button exposes its open state");
ok(source.includes("className: 'sw-btn' + (store.open ? ' on' : '')"), "the header button reflects the open state visually");
ok(source.includes("['resources', 'Resources']"), "the shared-resource tab is registered");
ok(source.includes("function ResourcesView"), "the shared-resource view exists");
ok(source.includes("experts ' + ((line.experts"), "line cards render the expert seats");
ok(source.includes("expert.reused ? ' · reused'"), "line cards mark a reused domain expert");
ok(source.includes("var domains = props.board.domains"), "the agents view reads the domain registry");
ok(source.includes("h('span', { className: 'sw-card-title' }, 'Domains')"), "the agents view renders domain ownership");

ok(styleTags.length === 1, "exactly one stylesheet is mounted");
const css = styleTags[0].textContent;
ok(typeof css === "string" && css.length > 1000, "the stylesheet carries rules");
ok(css.includes(".sw-panel{position:fixed"), "the drawer is a fixed panel");
ok(css.includes("pointer-events:auto"), "the drawer opts back into pointer events (the overlay layer is click-through)");
ok(css.includes("--sw-titlebar-h"), "the drawer reserves the title bar");
ok(css.includes("--sw-winctl-right"), "the header reserves the window controls");
ok(!css.includes("undefined"), "no unresolved value leaked into the stylesheet");
ok(styleTags[0].dataset.pluginCss === "dsh-swarm/swarm.css", "the stylesheet tag is identifiable for hot reload");

const open = (css.match(/{/g) ?? []).length;
const close = (css.match(/}/g) ?? []).length;
ok(open === close && open > 40, "the stylesheet braces are balanced (" + open + "/" + close + ")");

process.stdout.write("\n" + checks + " client checks passed.\n");
