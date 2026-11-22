(() => {
  var ID = "@exocortex/exo-overlay";
  var BASE = "/api/exocortex/overlay";
  var RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  var STYLES = [
    ".exo-overlay-banner{position:fixed;inset:0 0 auto 0;z-index:2147483000;display:flex;flex-wrap:wrap;gap:.5rem .75rem;align-items:center;padding:.4rem .8rem;font:500 12px/1.4 ui-sans-serif,system-ui,sans-serif;color:var(--dsw-alias-label-primary,#f5f7fa);background:var(--dsw-alias-bg-layer-2,#20242b);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.16));box-shadow:inset 3px 0 0 var(--dsw-alias-state-warn-primary,#e8b339)}",
    ".exo-overlay-banner[data-exo-overlay-failed=true]{box-shadow:inset 3px 0 0 var(--dsw-alias-state-error-primary,#e5534b)}",
    ".exo-overlay-banner .exo-overlay-run{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#b6bec9)}",
    ".exo-overlay-banner .exo-overlay-summary{font-variant-numeric:tabular-nums}",
    ".exo-overlay-banner .exo-overlay-failures{flex:1 1 100%;display:none;margin:0;padding:0;list-style:none;font-size:11px;color:var(--dsw-alias-label-secondary,#b6bec9)}",
    ".exo-overlay-banner[data-exo-overlay-failed=true] .exo-overlay-failures{display:grid;gap:.15rem}",
    ".exo-overlay-banner button{font:inherit;cursor:pointer;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.22));background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:inherit;padding:.2rem .55rem}",
    ".exo-overlay-banner button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.16))}"
  ].join("");
  var MARKER_ATTRIBUTE = "data-plugin";

  function parseRunId(search) {
    if (typeof search !== "string") return undefined;
    var params = new URLSearchParams(search.charAt(0) === "?" ? search : "?" + search);
    var value = params.get("exo_overlay");
    if (typeof value !== "string" || value === "" || !RUN_ID_PATTERN.test(value)) return undefined;
    return value;
  }

  function candidateUrl(runId, pkg, rev) {
    return BASE + "/" + runId + "/" + pkg + "/client.js?rev=" + encodeURIComponent(rev);
  }

  function overlayGraph(graph, rows) {
    var report = { requested: rows.size, matched: [], unmatched: [] };
    if (rows.size === 0 || graph === null || typeof graph !== "object") return { graph: graph, report: report };
    var entries = Array.isArray(graph.entries) ? graph.entries : [];
    var served = new Set(entries.map(function (row) { return row.id; }));
    for (var id of rows.keys()) {
      if (served.has(id)) report.matched.push({ id: id, rev: rows.get(id).rev });
      else report.unmatched.push(id);
    }
    if (entries.length === 0) return { graph: graph, report: report };
    var rewritten = entries.map(function (row) {
      var target = rows.get(row.id);
      if (target === undefined) return Object.assign({}, row);
      return Object.assign({}, row, { url: target.url, rev: target.rev });
    });
    var next = {};
    for (var key of Object.keys(graph)) next[key] = graph[key];
    next.entries = rewritten;
    return { graph: next, report: report };
  }

  function wireFromManifest(manifest) {
    var plugins = new Map();
    for (var plugin of manifest.plugins || []) plugins.set(plugin.id, plugin);
    var entries = (manifest.modules || []).map(function (row) {
      var entry = { id: row.id, url: row.url, rev: row.rev, inject: (row.inject || []).slice() };
      if (Array.isArray(row.external) && row.external.length > 0) entry.external = row.external.slice();
      var declared = plugins.get(row.id);
      if (declared !== undefined && declared.immediately === true) entry.immediately = true;
      return entry;
    });
    var batchesByUrl = new Map();
    for (var entry of entries) {
      var batch = batchesByUrl.get(entry.url);
      if (batch !== undefined) {
        batch.entries.push(entry.id);
        continue;
      }
      batchesByUrl.set(entry.url, { phase: "application", url: entry.url, rev: entry.rev, entries: [entry.id] });
    }
    var batches = Array.from(batchesByUrl.values());
    var wire = { rev: manifest.rev };
    if (manifest.release !== undefined) wire.release = manifest.release;
    wire.entries = entries;
    wire.batches = batches;
    return wire;
  }

  function exitUrlOf(search) {
    var params = new URLSearchParams(typeof search === "string" && search.charAt(0) === "?" ? search : "?" + (search || ""));
    var session = params.get("s");
    return session === null || session === "" ? "/" : "/?s=" + encodeURIComponent(session);
  }

  function overlayUrlOf(search, runId) {
    var params = new URLSearchParams(typeof search === "string" && search.charAt(0) === "?" ? search : "?" + (search || ""));
    params.set("exo_overlay", runId);
    return "/?" + params.toString();
  }

  function createOverlayClient(options) {
    var modules = options.modules;
    var runId = options.runId;
    var entries = modules.entries;
    var doc = options.document || globalThis.document;
    var location = options.location || globalThis.location || {};
    var fetchImpl = options.fetch || globalThis.fetch;
    var eventSourceFactory = options.eventSource || function (url) { return new EventSource(url); };
    var source = undefined;
    var disposed = false;
    var canonical = modules.manifest === undefined ? undefined : wireFromManifest(modules.manifest);
    var rows = new Map();
    var report = { requested: 0, matched: [], unmatched: [] };
    var manifestError = undefined;
    var runtimeError = undefined;
    var originalSync = entries.sync;
    var originalReload = entries.reload;
    var unsubscribe = function () {};
    var banner;
    var summary;
    var failures;
    var style;

    function failureRows() {
      var snapshot = entries.state === undefined || typeof entries.state.getSnapshot !== "function"
        ? { failures: [] }
        : entries.state.getSnapshot();
      return Array.isArray(snapshot.failures) ? snapshot.failures : [];
    }

    function render() {
      if (summary === undefined || failures === undefined) return;
      var errors = failureRows();
      var count = errors.length;
      var parts = [rows.size + " candidate" + (rows.size === 1 ? "" : "s") + " requested", report.matched.length + " matched"];
      for (var match of report.matched) parts.push(match.id + "@" + match.rev);
      if (report.unmatched.length > 0) parts.push("unmatched " + report.unmatched.join(", "));
      parts.push(count + " candidate failure" + (count === 1 ? "" : "s"));
      if (manifestError !== undefined) parts.push("manifest: " + manifestError);
      if (runtimeError !== undefined) parts.push("overlay: " + runtimeError);
      summary.textContent = parts.join(" · ");
      var loud = count > 0 || report.unmatched.length > 0 || manifestError !== undefined || runtimeError !== undefined;
      banner.setAttribute("data-exo-overlay-failed", loud ? "true" : "false");
      failures.textContent = "";
      for (var error of errors) {
        var row = doc.createElement("li");
        row.textContent = error.id + ": " + error.message;
        failures.append(row);
      }
      for (var missing of report.unmatched) {
        var missingRow = doc.createElement("li");
        missingRow.textContent = "unmatched " + missing + ": no graph entry serves that module identity";
        failures.append(missingRow);
      }
      if (manifestError !== undefined) {
        var manifestRow = doc.createElement("li");
        manifestRow.textContent = "manifest: " + manifestError;
        failures.append(manifestRow);
      }
      if (runtimeError !== undefined) {
        var runtimeRow = doc.createElement("li");
        runtimeRow.textContent = "overlay: " + runtimeError;
        failures.append(runtimeRow);
      }
    }

    function mountBanner() {
      banner = doc.createElement("div");
      banner.className = "exo-overlay-banner";
      banner.setAttribute("data-exo-overlay", runId);
      banner.dataset.exoOverlay = runId;
      var run = doc.createElement("span");
      run.className = "exo-overlay-run";
      run.textContent = "?exo_overlay=" + runId;
      summary = doc.createElement("span");
      summary.className = "exo-overlay-summary";
      var open = doc.createElement("button");
      open.type = "button";
      open.setAttribute("data-exo-action", "open");
      open.textContent = "Open Full Tab";
      open.addEventListener("click", function () {
        var win = globalThis.window;
        if (win !== undefined && typeof win.open === "function") win.open(overlayUrlOf(location.search, runId), "_blank", "noopener");
      });
      var exit = doc.createElement("button");
      exit.type = "button";
      exit.setAttribute("data-exo-action", "exit");
      exit.textContent = "Exit Sandbox";
      exit.addEventListener("click", function (event) {
        if (event !== undefined && typeof event.preventDefault === "function") event.preventDefault();
        location.assign(exitUrlOf(location.search));
      });
      failures = doc.createElement("ul");
      failures.className = "exo-overlay-failures";
      banner.append(run, summary, open, exit, failures);
      doc.body.append(banner);
      style = doc.createElement("style");
      style.setAttribute(MARKER_ATTRIBUTE, ID);
      style.textContent = STYLES;
      doc.head.append(style);
      render();
    }

    function syncCanonical() {
      if (canonical === undefined) return Promise.resolve();
      var applied = overlayGraph(canonical, rows);
      report = applied.report;
      render();
      return originalSync.call(entries, applied.graph);
    }

    async function loadManifest() {
      try {
        var response = await fetchImpl(BASE + "/" + runId + "/manifest", { headers: { accept: "application/json" } });
        if (response === undefined || response.ok !== true) {
          manifestError = "answered " + String(response === undefined ? "nothing" : response.status);
          render();
          return;
        }
        var body = await response.json();
        var packages = body !== null && typeof body === "object" && Array.isArray(body.packages) ? body.packages : [];
        for (var index = 0; index < packages.length; index += 1) {
          var row = packages[index];
          if (row === null || typeof row !== "object") throw new Error("package row " + index + " is not an object");
          if (typeof row.id !== "string" || row.id === "") throw new Error("package row " + index + " carries no module id");
          if (typeof row.pkg !== "string" || row.pkg === "") throw new Error(row.id + " carries no storage key (pkg)");
          if (typeof row.rev !== "string" || row.rev === "") throw new Error(row.id + " carries no rev");
          rows.set(row.id, {
            id: row.id,
            pkg: row.pkg,
            rev: row.rev,
            url: typeof row.url === "string" && row.url !== "" ? row.url : candidateUrl(runId, row.pkg, row.rev)
          });
        }
        report = overlayGraph(canonical, rows).report;
        render();
        if (report.matched.length > 0 && !disposed) await syncCanonical();
      } catch (error) {
        manifestError = String(error && error.message !== undefined ? error.message : error);
        render();
      }
    }

    function watch() {
      try {
        source = eventSourceFactory(BASE + "/" + runId + "/events");
      } catch (error) {
        manifestError = "event stream: " + String(error && error.message !== undefined ? error.message : error);
        render();
        return;
      }
      source.addEventListener("message", function (event) {
        if (disposed) return;
        var frame;
        try {
          frame = JSON.parse(event.data);
        } catch {
          return;
        }
        if (frame === null || typeof frame !== "object") return;
        if (frame.type === "overlay" && Array.isArray(frame.packages) && canonical !== undefined) {
          for (var packageIndex = 0; packageIndex < frame.packages.length; packageIndex += 1) {
            var row = frame.packages[packageIndex];
            if (row === null || typeof row !== "object" || typeof row.id !== "string" || typeof row.rev !== "string") continue;
            var previous = rows.get(row.id);
            if (previous !== undefined && previous.rev === row.rev) continue;
            if (typeof row.pkg !== "string" || row.pkg === "") {
              runtimeError = "overlay frame for " + row.id + " carries no storage key (pkg)";
              render();
              continue;
            }
            var snapshotUrl = typeof row.url === "string" && row.url !== "" ? row.url : candidateUrl(runId, row.pkg, row.rev);
            rows.set(row.id, { id: row.id, pkg: row.pkg, rev: row.rev, url: snapshotUrl });
            report = overlayGraph(canonical, rows).report;
            render();
            void originalReload.call(entries, row.id, row.rev);
          }
          return;
        }
        if (frame.type === "refreshed" && typeof frame.id === "string" && typeof frame.rev === "string") {
          if (typeof frame.pkg !== "string" || frame.pkg === "") {
            runtimeError = "refreshed frame for " + frame.id + " carries no storage key (pkg)";
            render();
            return;
          }
          var url = typeof frame.url === "string" && frame.url !== "" ? frame.url : candidateUrl(runId, frame.pkg, frame.rev);
          rows.set(frame.id, { id: frame.id, pkg: frame.pkg, rev: frame.rev, url: url });
          report = overlayGraph(canonical, rows).report;
          render();
          void originalReload.call(entries, frame.id, frame.rev);
          return;
        }
        if (frame.type === "removed" && typeof frame.id === "string") {
          rows.delete(frame.id);
          report = overlayGraph(canonical, rows).report;
          render();
          return;
        }
        if (frame.type === "failed" && typeof frame.message === "string") {
          runtimeError = frame.message;
          render();
        }
      });
    }

    function start() {
      entries.sync = function sync(graph) {
        canonical = graph;
        var applied = overlayGraph(graph, rows);
        report = applied.report;
        render();
        return originalSync.call(this, applied.graph);
      };
      entries.reload = function reload(id, rev) {
        if (rows.has(id)) return Promise.resolve();
        return originalReload.call(this, id, rev);
      };
      if (entries.state !== undefined && typeof entries.state.subscribe === "function") {
        unsubscribe = entries.state.subscribe(function () { render(); });
      }
      mountBanner();
      watch();
      void loadManifest();
      return function dispose() {
        disposed = true;
        entries.sync = originalSync;
        entries.reload = originalReload;
        unsubscribe();
        if (source !== undefined) source.close();
        if (banner !== undefined) banner.remove();
        if (style !== undefined) style.remove();
      };
    }

    return {
      start: start,
      rows: function () { return new Map(rows); },
      canonical: function () { return canonical; }
    };
  }

  // The host /runs endpoint is the only overlay index. No shadow browser registry.
  function mountOverlayPicker() {
    var doc = globalThis.document;
    if (doc === undefined || typeof doc.createElement !== "function") return function () {};
    var element;
    var closed = false;
    function openRun(runId, inPreview) {
      if (!RUN_ID_PATTERN.test(runId)) return;
      var canonical = new URL(globalThis.location.href);
      canonical.hash = "";
      canonical.searchParams.delete("exo_overlay");
      var candidate = new URL(canonical.href);
      candidate.searchParams.set("exo_overlay", runId);
      if (!inPreview) {
        globalThis.location.assign(candidate.href);
        return;
      }
      // A URL hash change alone does not re-run the workbench's deep-link
      // installer. Change a harmless query value to force a fresh document.
      var params = new URLSearchParams();
      params.set("exo_preview_url", candidate.href);
      params.set("exo_label", runId);
      params.set("exo_perspective", "operator-browser");
      canonical.searchParams.set("exo_preview_open", runId);
      canonical.hash = params.toString();
      globalThis.location.assign(canonical.href);
    }
    function mount() {
      if (closed || !doc.body) return;
      var old = doc.getElementById("exo-operator-overlay-switcher");
      if (old !== null) old.remove();
      var host = doc.createElement("div");
      host.id = "exo-overlay-picker";
      host.style.cssText = "position:fixed;top:62px;right:18px;z-index:2147482900";
      var shadow = host.attachShadow({ mode: "open" });
      var css = doc.createElement("style");
      css.textContent = [
        "*{box-sizing:border-box}",
        "button{font:500 12px/1.3 system-ui,sans-serif;cursor:pointer;color:#f4f5f7;background:#282a31;border:1px solid #50535d;border-radius:7px;padding:7px 10px}",
        "button:hover{background:#393c46}",
        ".launch{box-shadow:0 6px 20px #0005;font-weight:650}",
        ".panel{display:none;position:absolute;top:42px;right:0;width:min(440px,calc(100vw - 32px));max-height:min(520px,calc(100vh - 125px));overflow:auto;background:#191b20;border:1px solid #434651;border-radius:12px;box-shadow:0 20px 54px #0009;color:#f3f4f6;padding:14px;font:12px/1.45 system-ui,sans-serif}",
        ".panel[data-open=true]{display:block}",
        ".head,.row,.links{display:flex;gap:8px;align-items:center}",
        ".head,.row{justify-content:space-between}",
        ".head strong{font-size:14px}",
        ".muted,.time{color:#aeb1ba;font-size:11px}",
        ".links{flex-wrap:wrap;margin:10px 0}",
        ".row{border-top:1px solid #31333b;padding:9px 0;align-items:flex-start}",
        ".item{min-width:0;flex:1}",
        ".name{font-weight:600;word-break:break-word}",
        ".name[data-active=true]{color:#aebdff}",
        ".details{font-size:11px;color:#aeb1ba;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:225px}",
        ".actions{display:flex;gap:5px;flex-shrink:0}",
        ".actions button,.links button{padding:5px 7px;font-size:11px}",
        ".error{color:#ffc4a3}"
      ].join("\n");
      shadow.append(css);
      var launch = doc.createElement("button");
      launch.className = "launch";
      launch.textContent = "overlays";
      launch.setAttribute("aria-label", "Manage Exocortex overlays");
      var panel = doc.createElement("section");
      panel.className = "panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "Overlay candidates");
      panel.setAttribute("data-open", "false");
      shadow.append(launch, panel);
      function button(label, handler) {
        var b = doc.createElement("button");
        b.textContent = label;
        b.addEventListener("click", handler);
        return b;
      }
      function textBlock(className, text) {
        var el = doc.createElement("div");
        el.className = className;
        el.textContent = text;
        return el;
      }
      function nav(title) {
        var link = doc.querySelector('button[aria-label="' + title + '"]');
        if (link) { link.click(); panel.setAttribute("data-open", "false"); }
        else { panel.append(textBlock("error", title + " is not available in this layout.")); }
      }
      async function refresh() {
        panel.textContent = "";
        var head = doc.createElement("div");
        head.className = "head";
        var title = doc.createElement("strong");
        title.textContent = "overlay workspace";
        head.append(title, button("close", () => panel.setAttribute("data-open", "false")));
        panel.append(head);
        panel.append(textBlock("muted", "these are real staged candidates. open, preview or return to canonical; no candidate is silently promoted."));
        var links = doc.createElement("div");
        links.className = "links";
        links.append(
          button("canonical", () => {
            var u = new URL(globalThis.location.href);
            u.searchParams.delete("exo_overlay");
            u.searchParams.delete("exo_preview_open");
            u.hash = "";
            globalThis.location.assign(u.href);
          }),
          button("actor studio", () => nav("Actor Studio")),
          button("plugins", () => nav("Plugins"))
        );
        panel.append(links, textBlock("muted", "reading staged runs…"));
        try {
          var response = await globalThis.fetch(BASE + "/runs", { credentials: "same-origin", cache: "no-store" });
          if (!response.ok) throw new Error("overlay index HTTP " + response.status);
          var data = await response.json();
          if (!Array.isArray(data.runs)) throw new Error("overlay index did not return runs");
          if (closed || panel.getAttribute("data-open") !== "true") return;
          panel.lastChild.remove();
          launch.textContent = "overlays · " + data.runs.length;
          var active = parseRunId(globalThis.location.search);
          if (data.runs.length === 0) panel.append(textBlock("muted", "no staged candidates"));
          for (var row of data.runs) {
            if (!row || typeof row.runId !== "string" || !RUN_ID_PATTERN.test(row.runId)) continue;
            var wrap = doc.createElement("div");
            wrap.className = "row";
            var item = doc.createElement("div"); item.className = "item";
            var label = textBlock("name", row.runId);
            label.setAttribute("data-active", active === row.runId ? "true" : "false");
            var packages = Array.isArray(row.packages) ? row.packages.join(", ") : "";
            var details = textBlock("details", row.candidateCount + " candidate module(s) · " + (packages || "no candidate modules"));
            details.title = packages;
            item.append(label, details);
            var actions = doc.createElement("div"); actions.className = "actions";
            actions.append(button("preview", () => openRun(row.runId, true)), button("open", () => openRun(row.runId, false)));
            wrap.append(item, actions);
            panel.append(wrap);
          }
          panel.append(textBlock("muted", "the list is read from sfub on each opening. authoring remains with the selected agent."));
        } catch (error) {
          if (!closed && panel.getAttribute("data-open") === "true") {
            panel.lastChild.textContent = "overlay index unavailable: " + String(error?.message || error);
            panel.lastChild.className = "error";
          }
        }
      }
      launch.addEventListener("click", () => {
        var open = panel.getAttribute("data-open") !== "true";
        panel.setAttribute("data-open", open ? "true" : "false");
        if (open) void refresh();
      });
      doc.body.append(host);
      element = host;
    }
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mount, { once: true });
    else mount();
    return function dispose() {
      closed = true;
      doc.removeEventListener("DOMContentLoaded", mount);
      element?.remove();
    };
  }

  function apply(ctx) {
    // Skip synthetic test windows and previews nested inside a frame.
    var topLevel = false;
    try { topLevel = typeof window !== "undefined" && window === globalThis && window.top === window; } catch {}
    var disposePicker = topLevel ? mountOverlayPicker() : function () {};
    var runId = parseRunId(globalThis.location === undefined ? "" : globalThis.location.search);
    var disposeGraph = function () {};
    if (runId !== undefined) {
      var client = createOverlayClient({ modules: ctx.modules, runId: runId });
      disposeGraph = client.start();
    }
    var dispose = function () { disposePicker(); disposeGraph(); };
    if (ctx !== undefined && typeof ctx.effect === "function") ctx.effect(function () { return dispose; }, "exo-overlay: candidate graph and operator picker");
    return dispose;
  }

  var __ModuleLoader__ = globalThis.window?.__ModuleLoader__ ?? globalThis.__ModuleLoader__;
  if (typeof window !== "undefined" && __ModuleLoader__ !== undefined) {
    __ModuleLoader__.load({
      id: ID,
      factory: () => ({
        inject: ["modules"],
        apply: apply,
        __test: {
          apply: apply,
          createOverlayClient: createOverlayClient,
          overlayGraph: overlayGraph,
          wireFromManifest: wireFromManifest,
          parseRunId: parseRunId,
          exitUrlOf: exitUrlOf,
          RUN_ID_PATTERN: RUN_ID_PATTERN
        }
      })
    });
  }
})();
