/**
 * dsh-swarm — preset roster filter.
 *
 * The shipped agent-preset registry publishes one roster to the UI: the
 * new-session picker and Settings -> Agent Presets read the same
 * `agentPresets.list` Remote. The registry has no hidden/selectable field, so
 * the only way to keep the three internal role presets out of BOTH surfaces is
 * to filter the roster at the Host boundary.
 *
 * `agentPresets.remoteExportList` is resolved by the Typert gateway on every
 * call (`Reflect.get(receiver, implementation)`), so an own property installed
 * on the service instance is picked up by both UI surfaces. `mount()` is
 * untouched: the engine still starts children with these preset ids, and the
 * registry still resolves/retains them.
 *
 * Pure data helpers live here so the filter is testable offline.
 *
 * @module dsh-swarm/roster
 */

/** Preset ids that only the engine may start, never a human-selected session. */
export const HIDDEN_ROLE_PRESETS = Object.freeze(["swarm-expert", "swarm-verifier", "swarm-memory"]);

const HIDDEN = new Set(HIDDEN_ROLE_PRESETS);

/**
 * Remove the internal role presets from one roster payload.
 *
 * Unknown shapes pass through untouched so a future roster field change cannot
 * make this filter throw inside a Remote call.
 *
 * @param {unknown} roster - `{ presets: [...] }`, or anything the registry sent.
 * @returns {unknown} the same object when nothing was hidden, otherwise a copy
 *   with the internal rows removed.
 */
export function filterPresetRoster(roster) {
  if (roster === null || typeof roster !== "object") return roster;
  const presets = roster.presets;
  if (!Array.isArray(presets)) return roster;
  const kept = presets.filter((row) => row !== null && typeof row === "object" && !HIDDEN.has(row.id));
  return kept.length === presets.length ? roster : { ...roster, presets: kept };
}

/** One method shim that keeps the registry's own `this` and restores its shape. */
function wrapRosterMethod(receiver, method, wrapper) {
  const original = receiver[method];
  if (typeof original !== "function") return null;
  const hadOwn = Object.hasOwn(receiver, method);
  const restore = () => {
    try {
      if (hadOwn) receiver[method] = original;
      else delete receiver[method];
    } catch {
      /* a non-configurable own method stays as the wrapper; dispose is best-effort */
    }
  };
  const replacement = async (...args) => wrapper(await original.apply(receiver, args));
  try {
    receiver[method] = replacement;
    if (receiver[method] === replacement) return restore;
  } catch {
    /* fall through to defineProperty */
  }
  try {
    Object.defineProperty(receiver, method, { value: replacement, configurable: true, writable: true });
    return restore;
  } catch {
    return null;
  }
}

/**
 * Install the roster filter on one live `agentPresets` service.
 *
 * Only `remoteExportList` (the Remote implementation the client roster reads) is
 * wrapped. The host's `list` is deliberately left untouched: it is the registry's
 * own view and the source of diagnostics, and the subagent mount path resolves
 * definitions rather than this UI projection. `mount`, `resolve`, `retain` and
 * `list` are untouched.
 *
 * @param {object} registry - the live agentPresets service.
 * @param {(level: string, message: string) => void} [log] - optional logger.
 * @returns {(() => void) | null} a disposer that restores the original method,
 *   or null when the service shape is not understood.
 */
export function installRosterFilter(registry, log = () => {}) {
  if (registry === null || typeof registry !== "object") return null;
  if (registry.__swarmRosterFiltered === true) return null;

  const restore = wrapRosterMethod(registry, "remoteExportList", filterPresetRoster);
  if (restore === null) {
    log("warn", "swarm: agentPresets.remoteExportList is not writable; internal presets stay visible in the UI");
    return null;
  }
  registry.__swarmRosterFiltered = true;
  log("info", "swarm: internal role presets filtered from the UI roster (" + HIDDEN_ROLE_PRESETS.join(", ") + ")");
  return () => {
    try {
      restore();
    } catch {
      /* best-effort */
    }
    try {
      delete registry.__swarmRosterFiltered;
    } catch {
      /* best-effort */
    }
  };
}
