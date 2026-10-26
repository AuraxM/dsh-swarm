/**
 * dsh-swarm — client half.
 *
 * A session-header button and a right-hand drawer over the host's same-origin
 * `/swarm` route. Tabs: Lines, Agents, Messages, Memory, Settings. The drawer
 * polls only while open, follows the conversation on screen, and every write
 * goes through the loopback-only manage endpoint.
 *
 * Bundle format: a lazy factory registered with `window.__ModuleLoader__`,
 * React from the browser module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-swarm',
  factory(require) {
    var React = require('react');
    var h = React.createElement;
    var PREFIX = '/swarm';

    var CSS =
      ':root{--sw-titlebar-h:36px;--sw-winctl-right:0px;--sw-winctl-left:0px}' +
      'html[data-platform="win32"]{--sw-winctl-right:146px}' +
      'html[data-platform="darwin"]{--sw-winctl-left:88px;--sw-titlebar-h:32px}' +
      '.sw-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:14px;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:18px;cursor:pointer;flex:none;white-space:nowrap}' +
      '.sw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}' +
      '.sw-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}' +
      '.sw-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}' +
      '.sw-btn.on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-primary)}' +
      '.sw-btn.danger{color:var(--dsw-alias-state-error-primary)}' +
      '.sw-btn:disabled{opacity:.6;cursor:default}' +
      '.sw-panel{position:fixed;top:0;right:0;bottom:0;width:min(1040px,96vw);max-width:100vw;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border-left:.5px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-elevation-panel);pointer-events:auto;z-index:1200;padding-top:var(--sw-titlebar-h);box-sizing:border-box}' +
      '.sw-head{display:flex;align-items:center;gap:8px;padding:10px 14px;padding-right:calc(14px + var(--sw-winctl-right));padding-left:calc(14px + var(--sw-winctl-left));border-bottom:.5px solid var(--dsw-alias-border-l2);flex:none}' +
      '.sw-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}' +
      '.sw-sub{font-size:12px;color:var(--dsw-alias-label-tertiary)}' +
      '.sw-spacer{flex:1}' +
      '.sw-tabs{display:flex;gap:6px;align-items:center;padding:8px 14px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex:none;overflow-x:auto}' +
      '.sw-tab{height:26px;padding:0 12px;border-radius:13px;border:.5px solid var(--dsw-alias-border-l3);background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}' +
      '.sw-tab.on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover-accent)}' +
      '.sw-body{flex:1;min-height:0;overflow:auto;padding:12px 14px 28px}' +
      '.sw-err{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:4px 14px}' +
      '.sw-none{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:16px 2px;text-align:center}' +
      '.sw-stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}' +
      '.sw-stat{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-module-platform);padding:8px 12px;min-width:92px;display:flex;flex-direction:column;gap:2px}' +
      '.sw-stat .k{font-size:11px;color:var(--dsw-alias-label-tertiary)}' +
      '.sw-stat .v{font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}' +
      '.sw-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-module-platform);padding:10px 12px;margin-bottom:10px}' +
      '.sw-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
      '.sw-card-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}' +
      '.sw-chip{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:9px;font-size:11px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}' +
      '.sw-chip.s-working{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);background:none}' +
      '.sw-chip.s-verifying{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);background:none}' +
      '.sw-chip.s-reworking{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);background:none}' +
      '.sw-chip.s-done{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);background:none}' +
      '.sw-chip.s-blocked{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:none}' +
      '.sw-chip.s-cancelled{color:var(--dsw-alias-label-tertiary)}' +
      '.sw-chip.s-waiting{color:var(--dsw-alias-state-idle-primary);border-color:var(--dsw-alias-state-idle-primary);background:none}' +
      '.sw-meta{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:4px;line-height:1.5}' +
      '.sw-req{font-size:12.5px;color:var(--dsw-alias-label-secondary);margin-top:6px;white-space:pre-wrap}' +
      '.sw-block{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:8px;white-space:pre-wrap;line-height:1.5}' +
      '.sw-hr{border:none;border-top:.5px solid var(--dsw-alias-border-l2);margin:10px 0}' +
      '.sw-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}' +
      '.sw-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-tertiary);min-width:170px}' +
      '.sw-field select,.sw-field input{height:30px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:0 8px}' +
      '.sw-msg{border-left:2px solid var(--dsw-alias-border-l3);padding:2px 0 2px 8px;margin:6px 0;font-size:12px;color:var(--dsw-alias-label-secondary)}' +
      '.sw-mem{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;margin-bottom:8px}' +
      '.sw-settings{display:flex;flex-direction:column;gap:12px;max-width:760px;color:var(--dsw-alias-label-primary)}' +
      '.sw-settings h2{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}' +
      '.sw-settings .sw-card{background:var(--dsw-alias-bg-layer-2);margin-bottom:0}' +
      '.sw-settings .sw-row{margin-top:6px}' +
      '.sw-settings .sw-field{min-width:150px}' +
      '.sw-settings .sw-field select,.sw-settings .sw-field input{background:var(--dsw-alias-bg-layer-1)}' +
      '.sw-warn{color:var(--dsw-alias-state-warn-primary)}';

    /**
     * Mount the stylesheet once. A hot reload re-runs this module while the old
     * tag is still mounted; rewriting its contents makes a CSS change take
     * effect without a duplicate <style>.
     */
    function stylize() {
      if (typeof document === 'undefined') return;
      var tagId = 'dsh-swarm/swarm.css';
      var selector = 'style[data-plugin-css=' + JSON.stringify(tagId) + ']';
      var existing = document.querySelector(selector);
      if (existing !== null) {
        if (existing.textContent !== CSS) existing.textContent = CSS;
        return;
      }
      var tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-swarm';
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }
    stylize();

    // ── shared drawer state ─────────────────────────────────────────────────
    var listeners = new Set();
    var state = {
      open: false,
      tab: 'lines',
      sessionId: '',
      data: null,
      detail: null,
      detailId: '',
      catalog: null,
      error: '',
      notice: '',
      loading: false,
    };
    function setState(patch) {
      state = Object.assign({}, state, patch);
      listeners.forEach(function (fn) { try { fn(); } catch (error) { /* one bad subscriber */ } });
    }
    function useStore() {
      var pair = React.useState(0);
      var force = pair[1];
      React.useEffect(function () {
        var fn = function () { force(function (value) { return value + 1; }); };
        listeners.add(fn);
        return function () { listeners.delete(fn); };
      }, []);
      return state;
    }

    function liveSessionId() {
      try {
        var raw = window.localStorage.getItem('dsh.sessions.current');
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        var id = parsed && parsed.sessionId ? String(parsed.sessionId) : '';
        return id === '' ? null : id;
      } catch (error) {
        return null;
      }
    }

    function fetchJson(url, options) {
      return fetch(url, options).then(function (response) {
        return response.json().catch(function () { return { ok: false, error: 'invalid JSON from ' + url }; })
          .then(function (data) {
            if (!response.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + response.status));
            return data;
          });
      });
    }

    var inflight = false;
    function refresh(sessionId) {
      var target = sessionId || state.sessionId || liveSessionId() || '';
      if (target === '' || inflight) return Promise.resolve();
      inflight = true;
      return fetchJson(PREFIX + '/__api__/state?sessionId=' + encodeURIComponent(target))
        .then(function (data) {
          setState({ data: data, sessionId: target, error: '', loading: false });
        })
        .catch(function (error) {
          setState({ error: String(error && error.message ? error.message : error), loading: false });
        })
        .then(function () { inflight = false; });
    }

    function loadDetail(lineId) {
      var target = state.sessionId || liveSessionId() || '';
      if (target === '') return Promise.resolve();
      return fetchJson(PREFIX + '/__api__/state?sessionId=' + encodeURIComponent(target) + '&lineId=' + encodeURIComponent(lineId))
        .then(function (data) { setState({ detail: data.detail, detailId: lineId }); })
        .catch(function (error) { setState({ error: String(error && error.message ? error.message : error) }); });
    }

    function loadCatalog() {
      if (state.catalog !== null) return Promise.resolve();
      return fetchJson(PREFIX + '/__api__/models')
        .then(function (data) { setState({ catalog: data.catalog }); })
        .catch(function (error) { setState({ error: String(error && error.message ? error.message : error) }); });
    }

    function manage(body) {
      var target = state.sessionId || liveSessionId() || '';
      return fetchJson(PREFIX + '/__api__/manage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ sessionId: target }, body)),
      }).then(function (data) {
        setState({ notice: 'saved' });
        refresh();
        return data;
      }).catch(function (error) {
        setState({ error: String(error && error.message ? error.message : error) });
      });
    }

    /** Settings-page mutation: no session context is involved. */
    function postManage(body) {
      return fetchJson(PREFIX + '/__api__/manage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    function openPanel(sessionId) {
      var target = sessionId || liveSessionId() || state.sessionId || '';
      setState({ open: true, sessionId: target, tab: 'lines', error: '', notice: '', detail: null, detailId: '' });
      refresh(target);
    }
    function closePanel() {
      setState({ open: false, detail: null, detailId: '' });
    }

    function fmtDuration(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '0m';
      var minutes = Math.round(ms / 60000);
      if (minutes < 60) return minutes + 'm';
      var hours = Math.floor(minutes / 60);
      var rest = minutes % 60;
      return hours + 'h' + (rest === 0 ? '' : String(rest).padStart(2, '0') + 'm');
    }
    function fmtTime(ms) {
      if (!ms) return '-';
      var date = new Date(ms);
      return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    }
    function lineTitle(board, lineId) {
      var line = (board.lines || []).find(function (entry) { return entry.id === lineId; });
      return line ? (line.title || line.request || 'Untitled task') : lineId;
    }
    function statusChip(status) { return h('span', { className: 'sw-chip s-' + status }, status); }

    // ── header button ────────────────────────────────────────────────────────
    function HeaderButton(props) {
      var store = useStore();
      React.useEffect(function () {
        if (props.sessionId) refresh(props.sessionId);
        var timer = window.setInterval(function () { if (!state.open) refresh(props.sessionId); }, 20000);
        return function () { window.clearInterval(timer); };
      }, [props.sessionId]);
      var board = store.data && store.data.board;
      var counts = board && board.counts ? board.counts : null;
      var active = counts ? (counts.working || 0) + (counts.verifying || 0) + (counts.reworking || 0) : 0;
      var blocked = counts ? counts.blocked || 0 : 0;
      return h('button', {
        type: 'button',
        className: 'sw-btn' + (store.open ? ' on' : ''),
        title: store.open ? 'Close the Swarm project board' : 'Open the Swarm project board',
        'aria-pressed': store.open,
        onClick: function () {
          if (store.open) closePanel();
          else openPanel(props.sessionId);
        },
      }, '\u{1F41D} Swarm' + (active > 0 ? ' (' + active + ')' : '') + (blocked > 0 ? ' \u26D4' + blocked : ''));
    }

    // ── drawer ───────────────────────────────────────────────────────────────
    function Overlay() {
      var store = useStore();
      React.useEffect(function () {
        if (!store.open) return undefined;
        refresh();
        var timer = window.setInterval(function () {
          // Follow the conversation on screen: the drawer is registered in a
          // frame-level slot, so the only honest source of "current session" is
          // the GUI's own selection.
          var live = liveSessionId();
          if (live !== null && live !== state.sessionId) {
            setState({ sessionId: live, detail: null, detailId: '', error: '' });
            refresh(live);
            return;
          }
          refresh();
        }, 3000);
        return function () { window.clearInterval(timer); };
      }, [store.open, store.sessionId]);
      React.useEffect(function () {
        if (store.open && store.tab === 'settings') loadCatalog();
      }, [store.open, store.tab]);
      if (!store.open) return null;

      var board = store.data && store.data.board;
      var tabs = [
        ['lines', 'Lines'],
        ['agents', 'Agents'],
        ['messages', 'Messages'],
        ['resources', 'Resources'],
        ['memory', 'Memory'],
        ['settings', 'Settings'],
      ];
      var body = null;
      if (store.error) body = h('div', { className: 'sw-err' }, store.error);
      else if (board === null || board === undefined) body = h('div', { className: 'sw-none' }, 'No swarm board for this session yet. Start one with `swarm_line action=create` in a Swarm-mode conversation.');
      else if (store.tab === 'lines') body = h(LinesView, { board: board, store: store });
      else if (store.tab === 'agents') body = h(AgentsView, { board: board });
      else if (store.tab === 'messages') body = h(MessagesView, { board: board });
      else if (store.tab === 'resources') body = h(ResourcesView, { board: board });
      else if (store.tab === 'memory') body = h(MemoryView, { board: board, memory: store.data.memory });
      else body = h(SettingsView, { board: board, catalog: store.catalog, onSave: manage });

      return h('div', { className: 'sw-panel', role: 'dialog', 'aria-label': 'Swarm project board' },
        h('div', { className: 'sw-head' },
          h('span', { className: 'sw-title' }, '\u{1F41D} Swarm'),
          h('span', { className: 'sw-sub' }, board ? (board.title || board.projectName || 'Swarm project') : 'no board'),
          h('span', { className: 'sw-spacer' }),
          h('button', { type: 'button', className: 'sw-btn', onClick: function () { closePanel(); } }, 'Close')),
        h('div', { className: 'sw-tabs' }, tabs.map(function (tab) {
          return h('button', {
            key: tab[0],
            type: 'button',
            className: 'sw-tab' + (store.tab === tab[0] ? ' on' : ''),
            onClick: function () { setState({ tab: tab[0], notice: '', error: '' }); },
          }, tab[1]);
        })),
        h('div', { className: 'sw-body' }, body));
    }

    function Stat(key, value) {
      return h('div', { className: 'sw-stat', key: key }, h('span', { className: 'k' }, key), h('span', { className: 'v' }, value));
    }

    function LinesView(props) {
      var board = props.board;
      var store = props.store;
      var counts = board.counts || {};
      var order = ['working', 'verifying', 'reworking', 'blocked', 'waiting', 'done', 'cancelled'];
      var lines = (board.lines || []).slice().sort(function (left, right) {
        return order.indexOf(left.status) - order.indexOf(right.status) || right.updatedAt - left.updatedAt;
      });
      return h('div', null,
        h('div', { className: 'sw-stats' },
          Stat('lines', counts.total || 0),
          Stat('working', (counts.working || 0) + (counts.reworking || 0)),
          Stat('verifying', counts.verifying || 0),
          Stat('blocked', counts.blocked || 0),
          Stat('done', counts.done || 0),
          Stat('memory', props.store.data.memory ? props.store.data.memory.total : 0)),
        lines.length === 0 ? h('div', { className: 'sw-none' }, 'No task lines yet.') : null,
        lines.map(function (line) {
          var detailOpen = store.detailId === line.id;
          return h('div', { className: 'sw-card', key: line.id },
            h('div', { className: 'sw-card-head' },
              h('span', { className: 'sw-card-title' }, line.title || line.request || 'Untitled task'),
              statusChip(line.status),
              line.useVerifier ? h('span', { className: 'sw-chip' }, 'verified') : h('span', { className: 'sw-chip' }, 'no verifier'),
              h('span', { className: 'sw-chip' }, 'round ' + line.round),
              h('span', { className: 'sw-spacer' }),
              h('button', {
                type: 'button',
                className: 'sw-btn',
                onClick: function () {
                  if (detailOpen) setState({ detail: null, detailId: '' });
                  else loadDetail(line.id);
                },
              }, detailOpen ? 'Hide' : 'Detail'),
              line.status !== 'done' && line.status !== 'cancelled' ? h('button', {
                type: 'button',
                className: 'sw-btn danger',
                onClick: function () {
                  if (window.confirm('Cancel "' + (line.title || line.request || 'this task') + '"?')) manage({ action: 'abort-line', lineId: line.id, reason: 'cancelled from the panel' });
                },
              }, 'Abort') : null),
            h('div', { className: 'sw-meta' },
              'experts ' + ((line.experts || []).length === 0 ? '-' : (line.experts || []).map(function (expert) {
                return (expert.label || 'Expert') + ' [' + expert.status + (expert.reported ? ',reported' : '') + ']' + (expert.domain ? ' · ' + expert.domain : '') + (expert.reused ? ' · reused' : '');
              }).join(' + ')) +
              ' | verifier ' + (line.useVerifier ? (line.verifier ? (line.verifier.label || 'Verifier') + ' [' + line.verifier.status + ']' : '-') : '-') +
              ' | ' + fmtDuration(line.elapsedMs) + ' | relayed memory ' + line.memoryCount),
            h('div', { className: 'sw-req' }, line.request),
            line.blockedReason ? h('div', { className: 'sw-block sw-warn' }, 'BLOCKED: ' + line.blockedReason) : null,
            line.lastReport ? h('div', { className: 'sw-block' }, 'Last report (' + fmtTime(line.lastReport.at) + '): ' + line.lastReport.summary) : null,
            line.lastVerdict ? h('div', { className: 'sw-block' },
              'Last verdict: ' + (line.lastVerdict.pass ? 'PASS' : 'FAIL') +
              (line.lastVerdict.failures && line.lastVerdict.failures.length > 0 ? ' — ' + line.lastVerdict.failures.join('; ') : '')) : null,
            detailOpen && store.detail ? h(DetailView, { detail: store.detail }) : null);
        }));
    }

    function DetailView(props) {
      var detail = props.detail;
      var line = detail.line;
      function labelOf(sessionId) {
        var seat = (line.experts || []).find(function (expert) { return expert.sessionId === sessionId; });
        return seat ? seat.label : 'Expert';
      }
      return h('div', null,
        h('hr', { className: 'sw-hr' }),
        h('div', { className: 'sw-meta' }, 'Experts: ' + ((line.experts || []).length === 0 ? '-' : (line.experts || []).map(function (expert) {
          return expert.label + (expert.domain ? ' (' + expert.domain + ')' : '') + ' [' + expert.status + ']';
        }).join(' + '))),
        (line.experts || []).filter(function (expert) { return expert.focus; }).map(function (expert) {
          return h('div', { className: 'sw-meta', key: 'f' + expert.label }, expert.label + ' focus: ' + expert.focus);
        }),
        (line.reports || []).slice(-4).map(function (report, index) {
          return h('div', { key: 'r' + index, className: 'sw-block' },
            'Report ' + fmtTime(report.at) + ' — ' + labelOf(report.sessionId) + ': ' + report.summary +
            (report.artifacts.length ? '\nartifacts: ' + report.artifacts.join(', ') : '') +
            (report.evidence ? '\nevidence: ' + report.evidence : '') +
            (report.blockers ? '\nblockers: ' + report.blockers : ''));
        }),
        (line.verdicts || []).slice(-3).map(function (verdict, index) {
          return h('div', { key: 'v' + index, className: 'sw-block' },
            'Verdict round ' + verdict.round + ' (' + fmtTime(verdict.at) + '): ' + (verdict.pass ? 'PASS' : 'FAIL') +
            (verdict.criteria || []).map(function (criterion) { return '\n  [' + (criterion.passed ? 'x' : ' ') + '] ' + criterion.criterion + (criterion.owner ? ' (' + criterion.owner + ')' : '') + (criterion.evidence ? ' — ' + criterion.evidence : ''); }).join('') +
            (verdict.failures.length ? '\nfailures: ' + verdict.failures.join('; ') : '') +
            (verdict.recheck ? '\nrecheck: ' + verdict.recheck : ''));
        }),
        (detail.resources || []).length > 0 ? h('div', { className: 'sw-block' },
          'Resources:\n' + detail.resources.map(function (resource) {
            return resource.id + ': ' + (resource.holder ? (resource.holder.label || 'agent') + ' holds' : 'free') +
              (resource.queue.length ? ' | queue ' + resource.queue.map(function (entry) { return entry.label || 'agent'; }).join(' -> ') : '');
          }).join('\n')) : null,
        (detail.messages || []).length > 0 ? h('div', { className: 'sw-block' },
          'Recent messages:\n' + detail.messages.slice(-8).map(function (message) {
            return fmtTime(message.at) + ' ' + (message.fromRole || 'agent') + ' -> ' + (message.toRole || 'agent') + ' [' + message.kind + '] ' + message.text.slice(0, 220);
          }).join('\n')) : null,
        (detail.decisions || []).length > 0 ? h('div', { className: 'sw-block' },
          'Decisions:\n' + detail.decisions.map(function (decision) { return fmtTime(decision.at) + ' ' + decision.text; }).join('\n')) : null);
    }

    function ResourcesView(props) {
      var resources = props.board.resources || [];
      if (resources.length === 0) {
        return h('div', { className: 'sw-none' }, 'No shared resources are defined. The manager defines one with `swarm_line action=define-resource`; workers request it with `swarm_lease action=request`.');
      }
      return h('div', null, resources.map(function (resource) {
        return h('div', { className: 'sw-card', key: resource.id },
          h('div', { className: 'sw-card-head' },
            h('span', { className: 'sw-card-title' }, resource.id + ' — ' + resource.label),
            h('span', { className: 'sw-chip' }, resource.holder ? 'held' : 'free'),
            h('span', { className: 'sw-spacer' }),
            resource.holder ? h('button', {
              type: 'button',
              className: 'sw-btn danger',
              onClick: function () {
                if (window.confirm('Revoke lease ' + resource.id + '?')) manage({ action: 'revoke', resourceId: resource.id });
              },
            }, 'Force release') : null),
          h('div', { className: 'sw-meta' },
            resource.holder
              ? 'held by ' + (resource.holder.label || 'agent') +
                (resource.holder.lineId ? ' | task ' + lineTitle(props.board, resource.holder.lineId) : '') +
                (resource.holder.since ? ' | ' + fmtDuration(Date.now() - resource.holder.since) : '')
              : 'free'),
          resource.queue.length > 0 ? h('div', { className: 'sw-block' },
            'Queue: ' + resource.queue.map(function (entry) {
              return (entry.label || 'agent') + (entry.lineId ? ' (' + lineTitle(props.board, entry.lineId) + ')' : '');
            }).join(' -> ')) : null);
      }));
    }

    function AgentsView(props) {
      var roles = props.board.roles || [];
      var domains = props.board.domains || [];
      var domainCard = domains.length === 0 ? null : h('div', { className: 'sw-card' },
        h('div', { className: 'sw-card-head' }, h('span', { className: 'sw-card-title' }, 'Domains')),
        h('div', { className: 'sw-meta' }, domains.map(function (domain) {
          return domain.id + ' → ' + (domain.expertRetired ? 'unowned' : (domain.expertLabel || 'expert') + ' [' + (domain.status || 'unknown') + ']');
        }).join(' | ')));
      if (roles.length === 0) return h('div', null, domainCard, h('div', { className: 'sw-none' }, 'No role agents yet.'));
      return h('div', null, domainCard, roles.map(function (role) {
        return h('div', { className: 'sw-card', key: role.sessionId },
          h('div', { className: 'sw-card-head' },
            h('span', { className: 'sw-card-title' }, role.role + (role.label ? ' — ' + role.label : '')),
            h('span', { className: 'sw-chip' }, role.status),
            role.domain ? h('span', { className: 'sw-chip' }, role.domain) : null,
            role.persistent ? h('span', { className: 'sw-chip' }, 'resident') : null,
            role.lineId ? h('span', { className: 'sw-chip' }, lineTitle(props.board, role.lineId)) : null),
          h('div', { className: 'sw-meta' },
            (role.model ? role.provider + '/' + role.model : '') +
            (role.model && role.startedAt ? ' | ' : '') +
            (role.startedAt ? 'started ' + fmtTime(role.startedAt) : '')));
      }));
    }

    function MessagesView(props) {
      var messages = (props.board.messages || []).slice().reverse();
      if (messages.length === 0) return h('div', { className: 'sw-none' }, 'No messages yet.');
      return h('div', null, messages.map(function (message) {
        return h('div', { className: 'sw-msg', key: message.id },
          fmtTime(message.at) + '  ' + (message.fromRole || 'agent') + ' \u2192 ' + (message.toRole || 'agent') +
          '  [' + message.kind + ']' + (message.lineId ? ' ' + lineTitle(props.board, message.lineId) : '') + '\n' + message.text);
      }));
    }

    function MemoryView(props) {
      var memory = props.memory;
      var requests = (props.board.memoryRequests || []).filter(function (request) { return request.status === 'pending'; });
      if (memory === null) return h('div', { className: 'sw-none' }, 'This session has no identifiable project, so project memory is unavailable.');
      var entries = memory.entries || [];
      return h('div', null,
        h('div', { className: 'sw-stats' },
          Stat('project', memory.project.name || memory.project.root || 'current project'),
          Stat('entries', memory.total),
          Stat('pending', requests.length)),
        requests.length > 0 ? h('div', { className: 'sw-card' },
          h('div', { className: 'sw-card-head' }, h('span', { className: 'sw-card-title' }, 'Pending write requests')),
          requests.map(function (request) {
            return h('div', { key: request.id, className: 'sw-block' }, request.title + '\nclaim: ' + request.text + '\nevidence: ' + request.evidence);
          })) : null,
        entries.length === 0 ? h('div', { className: 'sw-none' }, 'Memory is empty. Start the keeper with `swarm_memory action=bootstrap`.') : null,
        entries.map(function (entry) {
          return h('div', { className: 'sw-mem', key: entry.id },
            h('div', { className: 'sw-card-head' },
              h('span', { className: 'sw-card-title' }, entry.title),
              h('span', { className: 'sw-chip' }, entry.kind),
              h('span', { className: 'sw-spacer' }),
              h('button', {
                type: 'button',
                className: 'sw-btn danger',
                onClick: function () {
                  if (window.confirm('Delete memory entry "' + entry.title + '"?')) manage({ action: 'forget-memory', id: entry.id });
                },
              }, 'Delete')),
            h('div', { className: 'sw-block' }, entry.text),
            h('div', { className: 'sw-meta' },
              (entry.evidence ? 'evidence: ' + entry.evidence + ' | ' : '') +
              (entry.verifiedAt ? 'verified ' + fmtTime(entry.verifiedAt) : 'unverified') +
              (entry.hits ? ' | used ' + entry.hits + 'x' : '')));
        }));
    }

    function SettingsView(props) {
      var board = props.board;
      var settings = board.settings || {};
      var catalog = props.catalog;
      var pair = React.useState(null);
      var form = pair[0];
      var setForm = pair[1];
      var current = form || settings;
      React.useEffect(function () {
        if (form === null) setForm(settings);
      }, [settings]);
      var roles = ['expert', 'verifier', 'memory'];
      var providers = catalog && catalog.providers ? catalog.providers : [];

      function update(patch) {
        setForm(Object.assign({}, current, patch));
      }
      function updateRole(role, patch) {
        var rolesNext = Object.assign({}, current.roles || {});
        rolesNext[role] = Object.assign({}, rolesNext[role] || {}, patch);
        update({ roles: rolesNext });
      }
      return h('div', null,
        h('div', { className: 'sw-card' },
          h('div', { className: 'sw-card-head' }, h('span', { className: 'sw-card-title' }, 'Runtime')),
          h('div', { className: 'sw-row' },
            h('label', { className: 'sw-field' }, 'Max concurrent role agents (1-8)',
              h('input', { type: 'number', min: 1, max: 8, value: current.maxConcurrent || 6, onChange: function (event) { update({ maxConcurrent: Number(event.target.value) }); } })),
            h('label', { className: 'sw-field' }, 'Default verifier policy',
              h('select', { value: current.verifier || 'auto', onChange: function (event) { update({ verifier: event.target.value }); } },
                h('option', { value: 'auto' }, 'auto'),
                h('option', { value: 'required' }, 'required'),
                h('option', { value: 'none' }, 'none')))),
          h('div', { className: 'sw-row' },
            h('button', {
              type: 'button',
              className: 'sw-btn primary',
              onClick: function () { props.onSave({ action: 'save-settings', maxConcurrent: current.maxConcurrent, verifier: current.verifier }); },
            }, 'Save runtime settings'))),
        h('div', { className: 'sw-card' },
          h('div', { className: 'sw-card-head' }, h('span', { className: 'sw-card-title' }, 'Role models')),
          h('div', { className: 'sw-meta' }, 'Unconfigured means "inherit the manager session model". Routes are validated against the live LLM adapter before they are written.'),
          roles.map(function (role) {
            var route = (current.roles || {})[role] || { provider: '', model: '', reasoningEffort: '' };
            var provider = providers.find(function (item) { return item.id === route.provider; });
            var models = provider ? provider.models : [];
            return h('div', { key: role, className: 'sw-row' },
              h('label', { className: 'sw-field' }, role + ' provider',
                h('select', {
                  value: route.provider || '',
                  onChange: function (event) { updateRole(role, { provider: event.target.value, model: '' }); },
                },
                  h('option', { value: '' }, '(inherit)'),
                  providers.map(function (item) { return h('option', { key: item.id, value: item.id }, item.name || item.id); }))),
              h('label', { className: 'sw-field' }, role + ' model',
                h('select', {
                  value: route.model || '',
                  onChange: function (event) { updateRole(role, { model: event.target.value }); },
                },
                  h('option', { value: '' }, '(inherit)'),
                  models.map(function (model) { return h('option', { key: model.id, value: model.id }, model.name || model.id); }))),
              h('label', { className: 'sw-field' }, 'effort (optional)',
                h('input', {
                  value: route.reasoningEffort || '',
                  placeholder: 'model default',
                  onChange: function (event) { updateRole(role, { reasoningEffort: event.target.value }); },
                })),
              h('button', {
                type: 'button',
                className: 'sw-btn',
                onClick: function () { props.onSave({ action: 'set-role-route', role: role, provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort }); },
              }, 'Save'));
          }),
          catalog && catalog.available === false ? h('div', { className: 'sw-block sw-warn' }, catalog.reason) : null));
    }

    // ── settings section: role model routes ──────────────────────────────────
    /**
     * The same routes the drawer's Settings tab edits, but as a first-class
     * DSH Settings page. It needs no session: the routes are deployment
     * settings, and the Host validates every route against the live LLM
     * adapter before it is written.
     */
    function SwarmModelSettings() {
      var catalogPair = React.useState(null);
      var catalog = catalogPair[0];
      var setCatalog = catalogPair[1];
      var statusPair = React.useState({ error: '', note: '', saving: '' });
      var status = statusPair[0];
      var setStatus = statusPair[1];

      React.useEffect(function () {
        fetchJson(PREFIX + '/__api__/models')
          .then(function (data) { setCatalog(data.catalog); })
          .catch(function (error) {
            setStatus({ error: String(error && error.message ? error.message : error), note: '', saving: '' });
          });
      }, []);

      if (catalog === null) {
        return h('div', { className: 'sw-settings' },
          h('h2', null, 'Swarm Models'),
          h('div', { className: 'sw-none' }, status.error || 'Loading model catalog…'));
      }

      var roles = catalog.roles || {};
      var providers = catalog.providers || [];
      var definitions = [
        { id: 'expert', title: 'Expert', text: 'Runs one expert seat on a task line; standard agent tool surface.' },
        { id: 'verifier', title: 'Verifier', text: 'Independently verifies a line\'s combined delivery; read-only on project files.' },
        { id: 'memory', title: 'Memory keeper', text: 'Owns project-memory writes after fact-checking.' },
      ];

      function updateRoute(role, patch) {
        var next = Object.assign({}, roles);
        next[role] = Object.assign({}, next[role] || {}, patch);
        setCatalog(Object.assign({}, catalog, { roles: next }));
      }

      function saveRoute(role) {
        var route = roles[role] || {};
        setStatus({ error: '', note: '', saving: role });
        postManage({
          action: 'set-role-route',
          role: role,
          provider: route.provider || '',
          model: route.model || '',
          reasoningEffort: route.reasoningEffort || '',
        }).then(function (data) {
          setCatalog(Object.assign({}, catalog, { roles: data.settings.roles }));
          setStatus({
            error: '',
            saving: '',
            note: role + ' saved: ' + (data.resolved ? data.resolved.provider + '/' + data.resolved.name : 'inherits the manager session model'),
          });
        }).catch(function (error) {
          setStatus({ error: String(error && error.message ? error.message : error), note: '', saving: '' });
        });
      }

      return h('div', { className: 'sw-settings' },
        h('h2', null, 'Swarm Models'),
        h('p', { className: 'sw-meta' },
          'Model routes for the role agents the engine starts. The manager uses the session\'s own model; an empty route inherits the manager model. Changes apply to the next delegation.'),
        catalog.available === false ? h('div', { className: 'sw-block sw-warn' }, catalog.reason) : null,
        status.error ? h('div', { className: 'sw-err' }, status.error) : null,
        status.note ? h('div', { className: 'sw-meta' }, status.note) : null,
        definitions.map(function (definition) {
          var route = roles[definition.id] || { provider: '', model: '', reasoningEffort: '' };
          var provider = providers.find(function (entry) { return entry.id === route.provider; });
          var models = provider ? provider.models : [];
          return h('div', { className: 'sw-card', key: definition.id },
            h('div', { className: 'sw-card-head' },
              h('span', { className: 'sw-card-title' }, definition.title),
              h('span', { className: 'sw-chip' }, route.provider !== '' && route.model !== '' ? 'configured' : 'inherit')),
            h('div', { className: 'sw-meta' }, definition.text),
            h('div', { className: 'sw-row' },
              h('label', { className: 'sw-field' }, 'Provider',
                h('select', {
                  value: route.provider || '',
                  disabled: catalog.available === false,
                  onChange: function (event) { updateRoute(definition.id, { provider: event.target.value, model: '' }); },
                },
                  h('option', { value: '' }, '(inherit)'),
                  providers.map(function (entry) { return h('option', { key: entry.id, value: entry.id }, entry.name || entry.id); }),
                  route.provider !== '' && !providers.some(function (entry) { return entry.id === route.provider; })
                    ? h('option', { value: route.provider }, route.provider + ' (unavailable)')
                    : null)),
              h('label', { className: 'sw-field' }, 'Model',
                h('select', {
                  value: route.model || '',
                  disabled: catalog.available === false || route.provider === '',
                  onChange: function (event) { updateRoute(definition.id, { model: event.target.value }); },
                },
                  h('option', { value: '' }, '(inherit)'),
                  models.map(function (model) { return h('option', { key: model.id, value: model.id }, model.name || model.id); }),
                  route.model !== '' && !models.some(function (model) { return model.id === route.model; })
                    ? h('option', { value: route.model }, route.model + ' (unavailable)')
                    : null)),
              h('label', { className: 'sw-field' }, 'Reasoning effort',
                h('input', {
                  value: route.reasoningEffort || '',
                  placeholder: 'model default',
                  onChange: function (event) { updateRoute(definition.id, { reasoningEffort: event.target.value }); },
                })),
              h('button', {
                type: 'button',
                className: 'sw-btn primary',
                disabled: status.saving === definition.id || catalog.available === false,
                onClick: function () { saveRoute(definition.id); },
              }, status.saving === definition.id ? 'Saving…' : 'Save')));
        }));
    }

    // ── registration ─────────────────────────────────────────────────────────
    function apply(ctx) {
      var slots = ctx.slots;
      slots.inject('conversation.session.header.actions', function () {
        return slots.register({
          name: 'conversation.session.header.actions',
          id: 'swarm-button',
          order: 21,
          label: 'Swarm board button',
        }, function (props) { return h(HeaderButton, { sessionId: props.sessionId }); });
      });
      slots.inject('shell.overlay', function () {
        return slots.register({
          name: 'shell.overlay',
          id: 'swarm-overlay',
          order: 0,
          label: 'Swarm project board',
        }, function () { return h(Overlay, null); });
      });
      slots.inject('settings.section', function () {
        return slots.register({
          name: 'settings.section',
          id: 'swarm-role-models',
          order: 25,
          label: 'Swarm Models',
        }, function () { return h(SwarmModelSettings, null); });
      });
    }

    return { inject: ['slots'], apply: apply };
  },
});
