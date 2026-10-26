/**
 * dsh-swarm — same-origin panel routes.
 *
 * The drawer reads one projection: `GET /swarm/__api__/state`. Mutations from
 * the human panel go through `POST /swarm/__api__/manage`, which is loopback
 * only — a LAN reader can look, never rewrite.
 *
 * @module dsh-swarm/routes
 */
import path from "node:path";

export const WEB_PREFIX = "/swarm";

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text.trim() === "" ? {} : JSON.parse(text));
      } catch (error) {
        reject(new Error("invalid JSON body: " + String(error && error.message ? error.message : error)));
      }
    });
    req.on("error", reject);
  });
}

function projectOfBoard(board) {
  if (board === null || board.projectKey === "") return null;
  return { key: board.projectKey, root: board.projectRoot, name: board.projectRoot === "" ? board.title : path.basename(board.projectRoot) };
}

/**
 * @param {object} options
 * @param {import('./store.js').SwarmStore} options.store
 * @param {import('./engine.js').SwarmEngine} options.engine
 * @param {object} options.settings settings surface from the host half
 */
export function createPanelRouter({ store, engine, settings, diagnostics, logger = () => {} }) {
  async function handleState(url, res) {
    const sessionId = String(url.searchParams.get("sessionId") ?? "").trim();
    if (sessionId === "") {
      sendJson(res, 200, { ok: true, service: "dsh-swarm", prefix: WEB_PREFIX, board: null, boards: store.listBoardIds().length, settings: store.settings() });
      return;
    }
    const board = store.get(sessionId);
    if (board === null) {
      sendJson(res, 200, { ok: true, service: "dsh-swarm", prefix: WEB_PREFIX, board: null, boards: store.listBoardIds().length, settings: store.settings(), boardsList: store.listBoardIds().map((entry) => ({ boardId: entry.boardId, mtime: entry.mtime })) });
      return;
    }
    const live = engine.live();
    const detailLineId = String(url.searchParams.get("lineId") ?? "").trim();
    if (detailLineId !== "") {
      try {
        sendJson(res, 200, { ok: true, detail: store.detail(board, detailLineId, live) });
      } catch (error) {
        sendJson(res, 404, { ok: false, error: String(error && error.message ? error.message : error) });
      }
      return;
    }
    const summary = store.summary(board, live);
    const project = projectOfBoard(board);
    let memory = null;
    if (project !== null) {
      try {
        const doc = store.memory.view(project);
        memory = {
          project,
          total: doc === null ? 0 : doc.entries.length,
          entries: doc === null ? [] : doc.entries.slice().reverse().map((entry) => ({
            id: entry.id,
            title: entry.title,
            text: entry.text,
            kind: entry.kind,
            tags: entry.tags,
            evidence: entry.evidence,
            verifiedAt: entry.verifiedAt,
            hits: entry.hits,
            updatedAt: entry.updatedAt,
          })),
        };
      } catch (error) {
        memory = { project, total: 0, entries: [], error: String(error && error.message ? error.message : error) };
      }
    }
    sendJson(res, 200, {
      ok: true,
      service: "dsh-swarm",
      prefix: WEB_PREFIX,
      board: {
        ...summary,
        messages: board.messages.slice(-60),
        memoryRequests: board.memoryRequests.slice(-40),
        settings: store.settings(),
      },
      memory,
      boards: store.listBoardIds().length,
      boardsList: store.listBoardIds().map((entry) => ({ boardId: entry.boardId, mtime: entry.mtime })),
    });
  }

  function handleBoards(res) {
    const boards = store.listBoardIds().map((entry) => {
      const board = store.get(entry.boardId);
      return {
        boardId: entry.boardId,
        title: board === null ? "" : board.title,
        project: board === null || board.projectKey === "" ? "" : (path.basename(board.projectRoot) || board.title),
        lines: board === null ? 0 : board.order.length,
        revision: board === null ? 0 : board.revision,
        mtime: entry.mtime,
      };
    });
    sendJson(res, 200, { ok: true, service: "dsh-swarm", boards });
  }

  async function handleModels(res) {
    const catalog = await settings.catalog();
    sendJson(res, 200, { ok: true, service: "dsh-swarm", catalog });
  }

  function handleMemory(url, res) {
    const sessionId = String(url.searchParams.get("sessionId") ?? "").trim();
    const board = sessionId === "" ? null : store.get(sessionId);
    const project = projectOfBoard(board);
    if (project === null) {
      sendJson(res, 200, { ok: false, error: "this session has no identifiable project" });
      return;
    }
    const query = String(url.searchParams.get("q") ?? "");
    const kind = String(url.searchParams.get("kind") ?? "");
    const limit = Number(url.searchParams.get("limit") ?? "60");
    const result = query === ""
      ? store.memory.list(project, { kind, limit })
      : store.memory.recall(project, { query, kind, limit });
    sendJson(res, 200, { ok: true, project: result.project, total: result.total, matches: result.matches });
  }

  async function handleManage(req, res) {
    if (!isLoopback(req)) {
      sendJson(res, 403, { ok: false, error: "panel mutations are loopback only" });
      return;
    }
    const body = await readJsonBody(req);
    const action = String(body.action ?? "");
    const sessionId = String(body.sessionId ?? "").trim();
    try {
      if (action === "save-settings") {
        const result = settings.setSettings(body);
        sendJson(res, 200, { ok: true, settings: result.settings });
        return;
      }
      if (action === "set-role-route") {
        const result = await settings.setRoleRoute(body);
        sendJson(res, 200, { ok: true, settings: result.settings, resolved: result.resolved ?? null });
        return;
      }
      const board = sessionId === "" ? null : store.get(sessionId);
      if (board === null) {
        sendJson(res, 404, { ok: false, error: "unknown board: " + sessionId });
        return;
      }
      if (action === "abort-line") {
        const line = store.lineOf(board, body.lineId);
        store.setLineStatus(board, line, "cancelled", String(body.reason ?? "cancelled from the panel"));
        engine.retireLineRoles(board, line);
        store.flush(board);
        sendJson(res, 200, { ok: true, line: { id: line.id, status: line.status } });
        return;
      }
      if (action === "decide") {
        const decision = store.addDecision(board, { lineId: String(body.lineId ?? ""), by: "panel", text: String(body.text ?? "") });
        store.flush(board);
        sendJson(res, 200, { ok: true, decision });
        return;
      }
      if (action === "grant") {
        const granted = store.grantResource(board, { id: body.resourceId, sessionId: body.sessionId2 ?? body.holderSessionId, lineId: body.lineId, force: body.force === true });
        store.flush(board);
        sendJson(res, 200, { ok: true, resource: granted.resource });
        return;
      }
      if (action === "revoke") {
        const revoked = await engine.revokeLease(board, body.resourceId);
        sendJson(res, 200, { ok: true, resource: revoked.resource, released: revoked.released, next: revoked.next });
        return;
      }
      if (action === "release") {
        const released = store.releaseResource(board, { id: body.resourceId });
        store.flush(board);
        sendJson(res, 200, { ok: true, resource: released.resource, released: released.released, next: released.next });
        return;
      }
      if (action === "forget-memory") {
        const project = projectOfBoard(board);
        if (project === null) throw new Error("this session has no identifiable project");
        const dropped = store.memory.forget(project, { id: body.id });
        sendJson(res, 200, { ok: true, ...dropped });
        return;
      }
      sendJson(res, 400, { ok: false, error: "unknown action: " + action });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
    }
  }

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      sendJson(res, 400, { ok: false, error: "bad request url" });
      return;
    }
    try {
      if (url.pathname === "/__health__") {
        sendJson(res, 200, {
          ok: true,
          service: "dsh-swarm",
          magic: "swarm-ok",
          prefix: WEB_PREFIX,
          root: store.root,
          boards: store.listBoardIds().length,
        });
        return;
      }
      if (url.pathname === "/__api__/boards" && req.method === "GET") {
        handleBoards(res);
        return;
      }
      if (url.pathname === "/__api__/state" && req.method === "GET") {
        await handleState(url, res);
        return;
      }
      if (url.pathname === "/__api__/models" && req.method === "GET") {
        await handleModels(res);
        return;
      }
      if (url.pathname === "/__api__/diagnostics" && req.method === "GET") {
        const report = typeof diagnostics === "function" ? await diagnostics() : { presets: [] };
        sendJson(res, 200, { ok: true, service: "dsh-swarm", ...report });
        return;
      }
      if (url.pathname === "/__api__/memory" && req.method === "GET") {
        handleMemory(url, res);
        return;
      }
      if (url.pathname === "/__api__/manage" && req.method === "POST") {
        await handleManage(req, res);
        return;
      }
      sendJson(res, 404, { ok: false, error: "unknown path: " + url.pathname });
    } catch (error) {
      logger("warn", "swarm: route failed: " + String(error && error.message ? error.message : error));
      sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
    }
  }

  return { handle, prefix: WEB_PREFIX };
}
