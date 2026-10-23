/**
 * dsh-swarm — host half.
 *
 * Mounted once per process by the profile's bundle patch. It owns the mission
 * store, the orchestration engine, the project-memory store, the runtime
 * adapter the engine drives and the same-origin `/swarm` panel route.
 *
 * It REGISTERS NOTHING MODEL-FACING. A row mounted by the profile runs in a
 * root context, so `ctx.tools.register` here would land in the process-global
 * tool layer and publish the swarm toolset into every preset. The four role
 * presets publish their own tools instead (`dsh-swarm/preset/*`), which is the
 * only place a scope exists.
 *
 * @module dsh-swarm
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { SwarmStore, LINE_STATUS, TERMINAL_STATUS } from "./store.js";
import { SwarmEngine } from "./engine.js";
import { createPanelRouter, WEB_PREFIX } from "./routes.js";
import { installRosterFilter } from "./roster.js";

const name = "swarm-mode";
const inject = ["webServer"];

const HERE = path.dirname(fileURLToPath(import.meta.url));

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/** Local user-message constructor: same shape the harness's own helper builds. */
function localUserMessage(content, source) {
  return deepFreeze({ id: randomUUID(), role: "user", content, source });
}

let llmModule;
let llmUnavailableLogged = false;

/**
 * Build a durable user-role message for the manager's inbox.
 *
 * `createUserMessage` is the harness's own constructor when it resolves. The
 * import is dynamic because a workspace-linked install cannot resolve
 * `@deepseek-ai/*`; the fallback is the same shape (id/role/content/source),
 * not a stub.
 */
async function makeUserMessage(content, source, logger) {
  if (llmModule === undefined) {
    try {
      llmModule = await import("@deepseek-ai/dsh-llm");
    } catch (error) {
      llmModule = null;
      if (!llmUnavailableLogged) {
        llmUnavailableLogged = true;
        logger("warn", "swarm: @deepseek-ai/dsh-llm not resolvable; using the local message constructor (" + String(error && error.message ? error.message : error) + ")");
      }
    }
  }
  if (llmModule !== null && typeof llmModule?.createUserMessage === "function") {
    return llmModule.createUserMessage({ content, source });
  }
  return localUserMessage(content, source);
}

/**
 * Constructor-safe inert abort signal for a delegation with no caller signal.
 *
 * Never `AbortSignal.abort()`: the subagent service calls
 * `spec.signal.throwIfAborted()` while materializing a child, so an already
 * aborted signal turns "the engine has no caller signal" into an immediate,
 * misleading AbortError. A fresh controller's signal is present and never
 * fires; it is the same stand-in pm-mode's expert delegation uses.
 */
function inertSignal() {
  if (typeof AbortController !== "undefined") return new AbortController().signal;
  return Object.freeze({
    aborted: false,
    reason: undefined,
    onabort: null,
    throwIfAborted() {},
    addEventListener() {},
    removeEventListener() {},
  });
}

/** The runtime adapter the engine drives. */
function createRuntime(ctx, logger) {
  const service = (key) => {
    try {
      return ctx.get(key);
    } catch {
      return undefined;
    }
  };

  async function resolveAgent(sessionId) {
    const agents = service("agents");
    if (agents !== undefined && typeof agents.get === "function") {
      const live = agents.get(sessionId);
      if (live !== undefined && live !== null) return live;
    }
    const controller = service("sessionController");
    if (controller !== undefined && typeof controller.resolveAgent === "function") {
      const resolved = await controller.resolveAgent(sessionId);
      if (resolved !== null && typeof resolved === "object" && resolved.error !== undefined) {
        throw new Error(String(resolved.error?.message ?? resolved.error));
      }
      if (resolved?.agent !== undefined) return resolved.agent;
    }
    return undefined;
  }

  function liveStatus() {
    const agents = service("agents");
    if (agents === undefined || typeof agents.list !== "function") return {};
    const out = {};
    try {
      for (const agent of agents.list()) {
        const id = typeof agent === "string" ? agent : agent?.id;
        if (typeof id === "string" && id !== "") out[id] = typeof agent?.status === "string" ? agent.status : "unknown";
      }
    } catch {
      /* registry mid-teardown */
    }
    return out;
  }

  async function startChild({ parentAgent, preset, prompt, label, agentOptions, maxDepth }) {
    const registry = service("subagents");
    if (registry === undefined || typeof registry.startActivation !== "function") {
      throw new Error("this deployment has no subagents registry (the host composition does not mount a delegation backend)");
    }
    const provider = typeof registry.getProvider === "function" ? registry.getProvider("spawn") : undefined;
    if (provider === undefined) throw new Error('the subagents registry has no "spawn" provider');
    const request = {
      parent: parentAgent,
      prompt: [{ type: "text", text: prompt }],
      maxDepth,
      agentPreset: preset,
    };
    if (agentOptions !== undefined) request.agentOptions = agentOptions;
    const started = await registry.startActivation({
      provider: "spawn",
      label,
      request,
      // pm-mode alignment: the harness (not this engine) notifies the parent
      // when a child turn settles. The engine itself never messages an agent.
      delivery: "parent",
      // startActivation dereferences spec.signal while materializing the child;
      // a background role must not inherit the manager turn's cancellation.
      signal: inertSignal(),
    });
    const childId = String(started.childId);
    return {
      childId,
      result: started.result,
      dispose: () => {
        try {
          started.dispose?.();
        } catch {
          /* already gone */
        }
      },
    };
  }

  async function sendSubagent(senderAgent, targetId, parts, options = {}) {
    const registry = service("subagents");
    if (registry === undefined || typeof registry.sendMessage !== "function") {
      throw new Error("this deployment has no subagents registry, so messages cannot be delivered");
    }
    return await registry.sendMessage(senderAgent, targetId, parts, { signal: options.signal ?? inertSignal() });
  }

  async function sendToManager(managerAgent, parts, source) {
    const message = await makeUserMessage(parts, source, logger);
    if (typeof managerAgent.followup !== "function") throw new Error("the manager agent does not accept followup messages");
    managerAgent.followup(message);
    const sessions = service("sessions");
    if (sessions !== undefined && typeof sessions.flush === "function" && managerAgent.session !== undefined) {
      try {
        await sessions.flush(managerAgent.session);
      } catch {
        /* the inbox already accepted it */
      }
    }
  }

  async function listDescendants(rootSessionId) {
    const registry = service("subagents");
    if (registry === undefined || typeof registry.listDescendants !== "function") return [];
    const entries = await registry.listDescendants(rootSessionId);
    if (!Array.isArray(entries)) return [];
    return entries.map((entry) => ({
      sessionId: String(entry.id ?? entry.sessionId ?? ""),
      label: String(entry.label ?? ""),
      parentSessionId: String(entry.parentSessionId ?? ""),
      status: String(entry.activity ?? entry.status ?? "unknown"),
    })).filter((entry) => entry.sessionId !== "");
  }

  return {
    liveStatus,
    resolveAgent,
    startChild,
    sendSubagent,
    sendToManager,
    listDescendants,
    log: (level, message) => {
      try {
        ctx.logger?.[level]?.(message);
      } catch {
        /* a logger that throws must not break a tool call */
      }
    },
  };
}

function apply(ctx) {
  const logger = (level, message) => {
    try {
      ctx.logger?.[level]?.(message);
    } catch {
      /* ignore */
    }
  };
  const store = new SwarmStore({ logger });
  const runtime = createRuntime(ctx, logger);
  const engine = new SwarmEngine({ store, runtime, logger });

  // Hide the three internal role presets from the preset roster that feeds both
  // the new-session picker and Settings -> Agent Presets. The Typert gateway
  // resolves the Remote method on every call, so an instance-level shim is
  // enough; `mount()` is untouched and the engine still starts children with
  // these ids. No second UI package, no "broken" rows.
  ctx.inject(["agentPresets"], (child) => {
    try {
      const registry = child.get("agentPresets");
      if (registry === undefined || registry === null) return;
      const restore = installRosterFilter(registry, logger);
      if (restore !== null) child.effect(() => restore, "swarm preset-roster filter");
    } catch (error) {
      logger("warn", "swarm: preset-roster filter failed: " + String(error && error.message ? error.message : error));
    }
  });

  // ── settings surface (panel + presets read the same values) ──────────────
  const llm = () => {
    try {
      return ctx.get("llm");
    } catch {
      return undefined;
    }
  };

  const validateRoute = async (wanted) => {
    const active = llm();
    if (active === undefined) throw new Error("this deployment has no llm service, so a route cannot be validated; refusing to write it");
    const info = await active.resolveModelInfo(wanted.provider, wanted.model);
    const efforts = (info.reasoning?.efforts ?? []).map((effort) => effort.id);
    if (wanted.reasoningEffort !== "" && !efforts.includes(wanted.reasoningEffort)) {
      throw new Error(
        `model ${wanted.provider}/${wanted.model} does not support reasoning effort "${wanted.reasoningEffort}"` +
          (efforts.length > 0 ? `; available: ${efforts.join(", ")}` : "; leave it empty for the model default"),
      );
    }
    return { info, capabilities: { vision: (info.inputModalities ?? []).includes("image") } };
  };

  const settingsSurface = {
    settings: () => store.settings(),
    async setRoleRoute(input) {
      const role = String(input?.role ?? "").trim();
      if (role !== "expert" && role !== "verifier" && role !== "memory") throw new Error('role must be "expert", "verifier" or "memory"');
      const wanted = {
        provider: String(input?.provider ?? "").trim(),
        model: String(input?.model ?? "").trim(),
        reasoningEffort: String(input?.reasoningEffort ?? "").trim(),
      };
      const before = store.settings();
      if (wanted.provider === "" || wanted.model === "") {
        const roles = { ...before.roles, [role]: { provider: "", model: "", reasoningEffort: "" } };
        return { settings: store.saveSettings({ roles, updatedBy: "panel" }), resolved: null };
      }
      const { info } = await validateRoute(wanted);
      const roles = { ...before.roles, [role]: wanted };
      return {
        settings: store.saveSettings({ roles, updatedBy: "panel" }),
        resolved: { id: info.id, name: info.name, provider: info.provider },
      };
    },
    setSettings(input) {
      const patch = {};
      if (input?.maxConcurrent !== undefined) {
        const value = Number(input.maxConcurrent);
        if (!Number.isSafeInteger(value) || value < 1 || value > 8) throw new Error("maxConcurrent must be an integer between 1 and 8");
        patch.maxConcurrent = value;
      }
      if (input?.verifier !== undefined) {
        if (!["auto", "required", "none"].includes(String(input.verifier))) throw new Error('verifier must be "auto", "required" or "none"');
        patch.verifier = String(input.verifier);
      }
      return { settings: store.saveSettings({ ...patch, updatedBy: "panel" }) };
    },
    async catalog() {
      const active = llm();
      const settings = store.settings();
      if (active === undefined) {
        return { available: false, reason: "this deployment has no llm service", providers: [], roles: settings.roles };
      }
      const providers = [];
      try {
        for (const provider of active.listProviders()) {
          const entry = { id: provider.id, name: provider.name, models: [], error: "" };
          try {
            const models = await active.listModels(provider.id);
            entry.models = models.map((model) => ({ id: model.id, name: model.name ?? model.id }));
          } catch (error) {
            entry.error = String(error && error.message ? error.message : error);
          }
          providers.push(entry);
        }
      } catch (error) {
        return { available: false, reason: String(error && error.message ? error.message : error), providers: [], roles: settings.roles };
      }
      return { available: true, providers, roles: settings.roles };
    },
  };

  // ── panel route ──────────────────────────────────────────────────────────
  const diagnostics = async () => {
    const registry = (() => {
      try {
        return ctx.get("agentPresets");
      } catch {
        return undefined;
      }
    })();
    const wanted = ["swarm", "swarm-expert", "swarm-verifier", "swarm-memory"];
    let rows = [];
    try {
      // Diagnostics read the registry's own list; only the UI-facing Remote
      // projection is filtered. A broken internal preset is a real composition
      // bug, never a hiding artifact.
      const raw = registry?.list;
      if (registry !== undefined && typeof raw === "function") {
        rows = (await raw.call(registry)).map((preset) => ({
          id: preset.id,
          name: preset.name ?? "",
          broken: preset.broken === undefined ? "" : String(preset.broken),
        }));
      }
    } catch (error) {
      return { presets: [], error: String(error && error.message ? error.message : error) };
    }
    return {
      presets: rows,
      wanted: wanted.map((id) => {
        const found = rows.find((preset) => preset.id === id);
        return { id, present: found !== undefined, broken: found === undefined ? "missing" : found.broken };
      }),
    };
  };

  let disposeRoute = null;
  const router = createPanelRouter({
    store,
    engine,
    settings: settingsSurface,
    diagnostics,
    logger,
  });
  try {
    disposeRoute = ctx.webServer.register({
      kind: "prefix",
      path: WEB_PREFIX,
      handler: (req, res) => {
        const raw = req.url || "/";
        let stripped = raw.slice(WEB_PREFIX.length);
        if (stripped === "" || stripped.startsWith("?")) stripped = "/" + stripped;
        req.url = stripped;
        router.handle(req, res);
      },
    });
  } catch (error) {
    logger("warn", "swarm: " + WEB_PREFIX + " route already registered; reusing the existing one (" + String(error && error.message ? error.message : error) + ")");
  }

  ctx.effect(() => () => {
    try {
      if (disposeRoute) disposeRoute();
    } catch {
      /* route table already gone */
    }
  }, "swarm route teardown");

  // The service the four preset rows read. It carries the one process-wide
  // engine; presets register tools over it and provide nothing themselves.
  ctx.effect(
    () =>
      ctx.provide("swarm", {
        store,
        engine,
        runtime,
        memory: store.memory,
        prefix: WEB_PREFIX,
        root: store.root,
        settings: settingsSurface.settings,
        catalog: settingsSurface.catalog,
        setRoleRoute: settingsSurface.setRoleRoute,
        setSettings: settingsSurface.setSettings,
        packageRoot: path.join(HERE, ".."),
      }),
    "swarm provide()",
  );

  // ── /swarm command ───────────────────────────────────────────────────────
  const commands = (() => {
    try {
      return ctx.get("commands");
    } catch {
      return undefined;
    }
  })();
  if (commands !== undefined && typeof commands.register === "function") {
    commands.register({
      name: "swarm",
      description: "Swarm project board: status | boards | json",
      input: { hint: "[status|boards|json]" },
      handler: async (invocation) => {
        const arg = String(invocation.rawInput || "").trim().toLowerCase();
        const sessionId = invocation.agent === undefined ? "" : String(invocation.agent.id);
        try {
          if (arg === "json") {
            const board = sessionId === "" ? null : store.get(sessionId);
            return { kind: "success", text: JSON.stringify(board === null ? { service: "dsh-swarm", root: store.root, boards: store.listBoardIds().length } : { boardId: board.boardId, lines: board.order.length, revision: board.revision }) };
          }
          if (arg === "boards" || arg === "ls") {
            const found = store.listBoardIds();
            if (found.length === 0) return { kind: "success", text: "(no swarm boards yet)" };
            return {
              kind: "success",
              text: found.map((entry) => {
                const board = store.get(entry.boardId);
                return `${entry.boardId} | ${board === null ? "?" : board.title} | ${new Date(entry.mtime).toISOString()}`;
              }).join("\n"),
            };
          }
          const found = store.listBoardIds();
          return {
            kind: "success",
            text: `on swarm service running\nroot ${store.root} | boards ${found.length}\npanel /swarm/ | session header "Swarm" button\nthis session's board: ${sessionId === "" ? "(none)" : sessionId}`,
          };
        } catch (error) {
          return { kind: "error", text: "swarm: " + String(error && error.message ? error.message : error) };
        }
      },
    });
  }

  logger("info", "swarm: mounted (root " + store.root + ", panel " + WEB_PREFIX + ")");
}

export { apply, inject, name, WEB_PREFIX, LINE_STATUS, TERMINAL_STATUS, SwarmStore, SwarmEngine };
