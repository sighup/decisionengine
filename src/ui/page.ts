/** Single-file dashboard served by `de ui`. No build step, no external requests. */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DecisionEngine</title>
<style>
:root {
  --bg: #f6f5f1; --panel: #ffffff; --ink: #1d1c1a; --muted: #6b6860; --line: #e4e1d8;
  --accent: #2f5d50; --accent-soft: #e3eee9; --warn: #9a6400; --warn-soft: #fbf0d9;
  --bad: #a3302a; --bad-soft: #f8e3e1; --info: #3b5b8a; --info-soft: #e4ebf5;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151614; --panel: #1d1f1c; --ink: #ecebe6; --muted: #9b998f; --line: #2f322d;
    --accent: #7fc3ac; --accent-soft: #1f3530; --warn: #e2b155; --warn-soft: #3a2f17;
    --bad: #f08a80; --bad-soft: #3d1f1c; --info: #8fb2e8; --info-soft: #1d2a3d;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 var(--sans); }
header { display: flex; flex-wrap: wrap; gap: 16px; align-items: baseline; justify-content: space-between; padding: 18px 24px 12px; border-bottom: 1px solid var(--line); }
.brand { font-weight: 700; letter-spacing: -0.01em; font-size: 17px; }
.brand span { color: var(--muted); font-weight: 400; margin-left: 8px; }
.kpis { display: flex; gap: 22px; flex-wrap: wrap; }
.kpi b { font-size: 18px; display: block; font-variant-numeric: tabular-nums; }
.kpi small { color: var(--muted); }
nav { display: flex; gap: 4px; padding: 10px 24px 0; border-bottom: 1px solid var(--line); overflow-x: auto; }
nav button { background: none; border: 0; padding: 8px 12px; font: inherit; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; white-space: nowrap; }
nav button.on { color: var(--ink); border-color: var(--accent); }
main { padding: 16px 24px 48px; }
.split { display: grid; grid-template-columns: minmax(280px, 380px) 1fr; gap: 16px; align-items: start; }
@media (max-width: 820px) { .split { grid-template-columns: minmax(0, 1fr); } header, nav, main { padding-left: 16px; padding-right: 16px; } }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
.tools { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px; border-bottom: 1px solid var(--line); }
input[type=search], select { font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; min-width: 0; }
input[type=search] { flex: 1 1 100%; width: 0; }
.list { max-height: calc(100vh - 230px); overflow: auto; }
.item { padding: 10px 12px; border-bottom: 1px solid var(--line); cursor: pointer; }
.item:last-child { border-bottom: 0; }
.item:hover { background: var(--bg); }
.item.sel { background: var(--accent-soft); }
.item .id { font: 12px var(--mono); color: var(--muted); }
.item .t { font-weight: 600; }
.item.superseded .t, .item.deprecated .t { text-decoration: line-through; color: var(--muted); }
.badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.b { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--bg); color: var(--muted); border: 1px solid var(--line); }
.b.accepted { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
.b.proposed { background: var(--info-soft); color: var(--info); border-color: transparent; }
.b.superseded, .b.deprecated { background: var(--bg); }
.b.enf { background: var(--ink); color: var(--panel); border-color: transparent; }
.b.bad { background: var(--bad-soft); color: var(--bad); border-color: transparent; }
.detail { padding: 20px 24px; min-height: 300px; }
.detail h1 { font-size: 22px; line-height: 1.25; margin: 4px 0 6px; letter-spacing: -0.01em; }
.detail .meta { color: var(--muted); font-size: 13px; }
.detail h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 22px 0 6px; }
.why { font-size: 15px; border-left: 3px solid var(--accent); padding: 2px 0 2px 12px; }
.rej { list-style: none; padding: 0; margin: 0; }
.rej li { padding: 6px 0; border-bottom: 1px dashed var(--line); }
.rej li b { text-decoration: line-through; text-decoration-color: var(--bad); }
code, .mono { font-family: var(--mono); font-size: 12.5px; }
.rule { font-family: var(--mono); font-size: 12.5px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; margin: 4px 0; overflow-x: auto; }
.links { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 600px) { .links { grid-template-columns: 1fr; } }
.link { display: block; padding: 6px 8px; border-radius: 6px; cursor: pointer; border: 1px solid var(--line); margin: 4px 0; }
.link:hover { background: var(--bg); }
.link .mono { color: var(--muted); margin-right: 6px; }
.body { white-space: pre-wrap; color: var(--ink); }
.empty { color: var(--muted); padding: 40px; text-align: center; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; color: var(--muted); font-weight: 600; }
.lvl-error { color: var(--bad); } .lvl-warning { color: var(--warn); } .lvl-info { color: var(--info); }
.graphwrap { overflow: auto; padding: 8px; }
svg text { fill: var(--ink); font: 12px var(--sans); }
svg .node rect { fill: var(--panel); stroke: var(--line); }
svg .node.accepted rect { stroke: var(--accent); }
svg .node.proposed rect { stroke: var(--info); stroke-dasharray: 4 3; }
svg .node.superseded rect, svg .node.deprecated rect { opacity: .55; }
svg .node.sel rect { fill: var(--accent-soft); stroke-width: 2; }
svg .node { cursor: pointer; }
svg .edge { fill: none; stroke: var(--muted); stroke-opacity: .5; }
svg .id { fill: var(--muted); font: 11px var(--mono); }
.stat { display: inline-block; margin-right: 18px; }
.stat b { font-variant-numeric: tabular-nums; }
.who { font-size: 12px; font-weight: 400; color: var(--muted); margin-top: 2px; }
.who a { color: inherit; }
.livedot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); margin-left: 4px; vertical-align: middle; }
.livedot.on { background: #3aa76d; box-shadow: 0 0 0 3px color-mix(in srgb, #3aa76d 25%, transparent); }
.login { max-width: 460px; margin: 40px auto; padding: 24px; }
.login h2 { margin: 0 0 8px; }
.login form { display: flex; gap: 8px; margin-top: 12px; }
.login input { flex: 1; min-width: 0; font: inherit; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); }
button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: var(--panel); cursor: pointer; }
button.ghost { background: transparent; color: var(--ink); border-color: var(--line); }
button:disabled { opacity: .5; }
.actions { display: flex; gap: 8px; margin: 8px 0 4px; flex-wrap: wrap; }
.inbox { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 9px 12px; margin-bottom: 10px; border-radius: 8px; background: var(--info-soft); color: var(--info); }
.inbox button { flex: none; }
.captured { padding: 8px 10px; border-left: 3px solid var(--info); background: var(--info-soft); border-radius: 4px; margin: 8px 0; }
.hist { list-style: none; padding: 0; margin: 0; font-size: 13px; }
.hist li { padding: 3px 0; }
.toast { position: fixed; right: 16px; bottom: 16px; max-width: min(420px, calc(100vw - 32px)); background: var(--ink); color: var(--panel); padding: 10px 14px; border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.2); font-size: 13px; z-index: 10; }
.tools select { flex: 1 1 0; min-width: 0; }
</style>
</head>
<body>
<header>
  <div class="brand">DecisionEngine <span id="project"></span><div id="who" class="who"></div></div>
  <div class="kpis" id="kpis"></div>
</header>
<nav id="tabs">
  <button data-tab="log" class="on">Decision log</button>
  <button data-tab="graph">Graph</button>
  <button data-tab="activity">Enforcement</button>
  <button data-tab="health">Health</button>
</nav>
<main id="main"></main>
<script>
const S = { state: null, tab: "log", sel: null, q: "", status: "active", project: "", history: {}, live: false };
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const byId = () => Object.fromEntries(S.state.decisions.map((d) => [d.id, d]));

function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }
let TOKEN = store("de_token");
function takeToken() {
  const m = /[#&]token=([^&]+)/.exec(location.hash);
  if (!m) return false;
  TOKEN = decodeURIComponent(m[1]);
  store("de_token", TOKEN);
  history.replaceState(null, "", location.pathname);
  return true;
}
takeToken();
window.addEventListener("hashchange", () => { if (takeToken()) boot(); });

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { authorization: "Bearer " + TOKEN, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  if (r.status === 401) { signOut("Your token is no longer valid."); throw new Error("unauthorized"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
  return data;
}

function signOut(msg) { store("de_token", null); TOKEN = null; renderLogin(msg); }

function renderLogin(msg) {
  $("#kpis").innerHTML = ""; $("#tabs").style.display = "none";
  $("#main").innerHTML = '<div class="panel login"><h2>Sign in</h2><p class="meta">Paste an API token. Run <code>de ui</code> to open this page signed in, or ask an admin for an invite (<code>de invite</code>).</p>' +
    (msg ? '<p class="lvl-error">' + esc(msg) + "</p>" : "") +
    '<form id="lf"><input type="password" id="tok" placeholder="de_..." autocomplete="off"><button>Sign in</button></form></div>';
  $("#lf").onsubmit = (e) => { e.preventDefault(); TOKEN = $("#tok").value.trim(); store("de_token", TOKEN); boot(); };
}

function ruleText(r) {
  switch (r.type) {
    case "forbid_pattern": return "forbid /" + r.pattern + "/" + (r.flags || "") + (r.paths && r.paths.length ? "  in " + r.paths.join(", ") : "");
    case "require_pattern": return "require /" + r.pattern + "/" + (r.flags || "") + "  in " + r.paths.join(", ");
    case "forbid_dependency": return "forbid dependency  " + r.packages.join(", ");
    case "forbid_path": return "forbid changes to  " + r.paths.join(", ");
  }
  return JSON.stringify(r);
}

function visible() {
  return S.state.decisions.filter((d) => !S.project || !d.projects.length || d.projects.includes(S.project));
}

function filtered() {
  const q = S.q.toLowerCase().trim();
  return visible().filter((d) => {
    if (S.status === "active" && !(d.status === "accepted" || d.status === "proposed")) return false;
    if (S.status !== "active" && S.status !== "all" && d.status !== S.status) return false;
    if (!q) return true;
    const hay = [d.id, d.title, d.why, d.body, d.author, d.tags.join(" "), d.scope.join(" "), d.rejected.map((r) => r.option + " " + (r.reason || "")).join(" ")].join(" ").toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  }).slice().reverse();
}

function renderKpis() {
  const ds = visible();
  const acc = ds.filter((d) => d.status === "accepted");
  const t = S.state.totals;
  const k = [[acc.length, "settled"], [acc.filter((d) => d.rules.length).length, "enforced"], [ds.filter((d) => d.status === "proposed").length, "proposed"], [t.checks, "checks this week"], [t.violations, "violations caught"]];
  $("#kpis").innerHTML = k.map(([n, l]) => '<div class="kpi"><b>' + n + "</b><small>" + l + "</small></div>").join("");
  $("#project").innerHTML = esc(S.state.me.workspace.name) + ' <span class="livedot' + (S.live ? " on" : "") + '" title="' + (S.live ? "Live" : "Reconnecting") + '"></span>';
  $("#who").innerHTML = esc(S.state.me.member.name) + ' · <a href="#" id="so">sign out</a>';
  $("#so").onclick = (e) => { e.preventDefault(); signOut(); };
}

const CAPTURE_LABEL = { "capture:claude-code": "a Claude Code session", "capture:git": "commit history", "capture:notes": "notes" };
const captured = (d) => typeof d.source === "string" && d.source.startsWith("capture:");

function itemHtml(d) {
  const st = S.state.stats[d.id];
  return '<div class="item ' + d.status + (S.sel === d.id ? " sel" : "") + '" data-id="' + d.id + '">' +
    '<div class="id">' + d.id + " · " + esc(d.date) + (d.author ? " · " + esc(d.author) : "") + "</div>" +
    '<div class="t">' + esc(d.title) + "</div>" +
    '<div class="badges"><span class="b ' + d.status + '">' + d.status + "</span>" +
    (d.rules.length && d.status === "accepted" ? '<span class="b enf">enforced</span>' : "") +
    (d.status === "proposed" && captured(d) ? '<span class="b">captured</span>' : "") +
    (st && st.violations ? '<span class="b bad">' + st.violations + " caught</span>" : "") +
    (d.downstreamAll ? '<span class="b">' + d.downstreamAll + " depend on it</span>" : "") +
    d.tags.slice(0, 3).map((t) => '<span class="b">' + esc(t) + "</span>").join("") +
    "</div></div>";
}

function linkHtml(d) {
  return '<div class="link" data-id="' + d.id + '"><span class="mono">' + d.id + "</span>" + esc(d.title) + (d.status !== "accepted" ? ' <span class="b ' + d.status + '">' + d.status + "</span>" : "") + "</div>";
}

function detailHtml(id) {
  const all = byId();
  const d = all[id];
  if (!d) return '<div class="empty">Select a decision.</div>';
  const st = S.state.stats[d.id];
  const up = d.depends_on.map((x) => all[x]).filter(Boolean);
  const down = d.downstream.map((x) => all[x]).filter(Boolean);
  const meta = [d.id, d.status, d.date, d.author && "by " + d.author, d.discipline, "rev " + d.revision].filter(Boolean).map(esc).join(" · ");
  let h = '<div class="meta mono">' + meta + "</div><h1>" + esc(d.title) + "</h1>";
  if (d.status === "proposed") {
    if (captured(d)) h += '<div class="captured">Found in ' + esc(CAPTURE_LABEL[d.source] || d.source.slice(8)) + ". Nothing is enforced until someone accepts it." + (d.rules.length ? " Accepting turns on the rules below." : "") + "</div>";
    if (d.supersedes.length) h += '<div class="meta">Accepting replaces ' + d.supersedes.map(esc).join(", ") + ".</div>";
    h += '<div class="actions"><button data-act="accepted">Accept</button><button data-act="deprecated" class="ghost">Reject</button></div>';
  }
  else if (d.status === "accepted") h += '<div class="actions"><button data-act="deprecated" class="ghost">Deprecate</button></div>';
  if (d.superseded_by) h += "<p>Replaced by " + linkHtml(all[d.superseded_by] || { id: d.superseded_by, title: "(missing)", status: "" }) + "</p>";
  if (d.status === "accepted") {
    h += '<div class="meta">' + (d.rules.length ? "Enforced on every agent edit and in CI." : "Advisory: shown to agents as context, not mechanically checked.") +
      (st ? " Checked " + st.checks + " time" + (st.checks === 1 ? "" : "s") + " this week, " + st.violations + " violation" + (st.violations === 1 ? "" : "s") + " caught." : "") + "</div>";
  }
  if (d.why) h += '<h3>Why</h3><div class="why">' + esc(d.why) + "</div>";
  if (d.rejected.length) h += '<h3>Rejected</h3><ul class="rej">' + d.rejected.map((r) => "<li><b>" + esc(r.option) + "</b>" + (r.reason ? " — " + esc(r.reason) : "") + "</li>").join("") + "</ul>";
  if (d.rules.length) h += "<h3>Rules</h3>" + d.rules.map((r) => '<div class="rule">' + esc(ruleText(r)) + (r.message ? '<br><span style="color:var(--muted)">' + esc(r.message) + "</span>" : "") + "</div>").join("");
  h += "<h3>Applies to</h3><div>" + (d.projects.length ? d.projects.map(esc).join(", ") : "Every project") + " · " + (d.scope.length ? d.scope.map((s) => "<code>" + esc(s) + "</code>").join(", ") : "all paths") + "</div>";
  if (up.length || down.length || d.supersedes.length) {
    h += '<div class="links"><div><h3>Builds on</h3>' + (up.map(linkHtml).join("") || '<div class="meta">Nothing</div>') + "</div>" +
      "<div><h3>Depended on by" + (d.downstreamAll > down.length ? " (" + d.downstreamAll + " total)" : "") + "</h3>" + (down.map(linkHtml).join("") || '<div class="meta">Nothing yet</div>') + "</div></div>";
    if (d.supersedes.length) h += "<h3>Replaces</h3>" + d.supersedes.map((x) => all[x]).filter(Boolean).map(linkHtml).join("");
  }
  if (d.body) h += "<h3>" + (captured(d) ? "Evidence" : "Notes") + '</h3><div class="body">' + esc(captured(d) ? d.body.replace(/^> ?/gm, "") : d.body) + "</div>";
  if (d.source_ref) h += "<h3>" + (captured(d) ? "Source" : "Decided in") + '</h3><div class="mono">' + esc(d.source_ref) + "</div>";
  const hist = S.history[d.id + ":" + d.revision];
  h += "<h3>History</h3>" + (hist ? '<ul class="hist">' + hist.map((r) => "<li><span class=\"mono\">r" + r.revision + "</span> " + esc(new Date(r.created_at).toLocaleString()) + " · " + esc(r.author || "") + (r.note ? " · " + esc(r.note) : "") + "</li>").join("") + "</ul>" : '<div class="meta">Loading…</div>');
  if (!hist) api("GET", "/v1/decisions/" + d.id + "/revisions").then((r) => { S.history[d.id + ":" + d.revision] = r.revisions; if (S.sel === d.id && S.tab === "log") $("#detail").innerHTML = detailHtml(d.id); }).catch(() => {});
  return h;
}

function inboxHtml() {
  const n = visible().filter((d) => d.status === "proposed").length;
  if (!n || S.status === "proposed") return "";
  return '<div class="inbox"><span>' + n + " proposed decision" + (n === 1 ? "" : "s") + ' waiting for review</span><button class="ghost" id="review">Review</button></div>';
}

function renderLog() {
  const list = filtered();
  if (!S.sel || !list.find((d) => d.id === S.sel)) S.sel = list[0] ? list[0].id : null;
  const projects = S.state.me.projects;
  $("#main").innerHTML = '<div class="split"><div class="panel"><div class="tools">' +
    '<input type="search" id="q" placeholder="Search decisions, reasons, rejected options" value="' + esc(S.q) + '">' +
    '<select id="st">' + ["active", "accepted", "proposed", "superseded", "deprecated", "all"].map((s) => "<option" + (S.status === s ? " selected" : "") + ">" + s + "</option>").join("") + "</select>" +
    (projects.length ? '<select id="pj"><option value="">all projects</option>' + projects.map((p) => '<option value="' + esc(p.slug) + '"' + (S.project === p.slug ? " selected" : "") + ">" + esc(p.slug) + "</option>").join("") + "</select>" : "") +
    "</div>" + inboxHtml() +
    '<div class="list">' + (list.map(itemHtml).join("") || '<div class="empty">No decisions match. Record one with <code>de new</code>, or let your agent record it.</div>') + "</div></div>" +
    '<div class="panel detail" id="detail">' + detailHtml(S.sel) + "</div></div>";
  const q = $("#q");
  q.oninput = () => { S.q = q.value; const pos = q.selectionStart; renderLog(); const n = $("#q"); n.focus(); n.setSelectionRange(pos, pos); };
  $("#st").onchange = (e) => { S.status = e.target.value; renderLog(); };
  if ($("#review")) $("#review").onclick = () => { S.status = "proposed"; S.sel = null; renderLog(); };
  if ($("#pj")) $("#pj").onchange = (e) => { S.project = e.target.value; render(); };
}

function renderGraph() {
  const ds = visible();
  if (!ds.length) { $("#main").innerHTML = '<div class="panel empty">No decisions yet.</div>'; return; }
  const all = Object.fromEntries(ds.map((d) => [d.id, d]));
  const depth = {};
  const visiting = new Set();
  const dep = (id) => {
    if (depth[id] != null) return depth[id];
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const ups = (all[id]?.depends_on || []).filter((u) => all[u]);
    depth[id] = ups.length ? 1 + Math.max(...ups.map(dep)) : 0;
    visiting.delete(id);
    return depth[id];
  };
  ds.forEach((d) => dep(d.id));
  const cols = {};
  ds.forEach((d) => (cols[depth[d.id]] ||= []).push(d));
  const W = 230, H = 52, GX = 70, GY = 16, P = 16;
  const pos = {};
  let maxRows = 0;
  Object.keys(cols).forEach((c) => { cols[c].forEach((d, i) => (pos[d.id] = { x: P + c * (W + GX), y: P + i * (H + GY) })); maxRows = Math.max(maxRows, cols[c].length); });
  const width = P * 2 + Object.keys(cols).length * (W + GX) - GX;
  const height = P * 2 + maxRows * (H + GY) - GY;
  let edges = "", nodes = "";
  ds.forEach((d) => d.depends_on.forEach((u) => {
    if (!pos[u]) return;
    const a = pos[u], b = pos[d.id];
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
    edges += '<path class="edge" d="M' + x1 + "," + y1 + " C" + mx + "," + y1 + " " + mx + "," + y2 + " " + x2 + "," + y2 + '"/>';
  }));
  ds.forEach((d) => {
    const p = pos[d.id];
    const t = d.title.length > 32 ? d.title.slice(0, 31) + "…" : d.title;
    nodes += '<g class="node ' + d.status + (S.sel === d.id ? " sel" : "") + '" data-id="' + d.id + '" transform="translate(' + p.x + "," + p.y + ')">' +
      '<rect width="' + W + '" height="' + H + '" rx="8"/><text class="id" x="10" y="19">' + d.id + (d.rules.length && d.status === "accepted" ? " · enforced" : "") + "</text>" +
      '<text x="10" y="38">' + esc(t) + "</text><title>" + esc(d.title) + "</title></g>";
  });
  $("#main").innerHTML = '<div class="panel graphwrap"><div class="meta" style="padding:4px 8px 10px">Arrows run from a decision to the decisions that build on it. Click a node to open it.</div>' +
    '<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + " " + height + '">' + edges + nodes + "</svg></div>";
}

function renderActivity() {
  const ev = S.state.checks;
  if (!ev.length) { $("#main").innerHTML = '<div class="panel empty">No checks recorded yet. Checks are reported when agents edit files (hooks and MCP), on commit, and in CI.</div>'; return; }
  const rows = ev.map((e) => '<tr><td class="mono">' + esc(new Date(e.created_at).toLocaleString()) + "</td><td>" + esc(e.member || "") + "<br><span class=\"meta\">" + esc(e.agent || e.source) + (e.project ? " · " + esc(e.project) : "") + "</span></td>" +
    "<td>" + e.files.slice(0, 3).map((f) => "<code>" + esc(f) + "</code>").join("<br>") + (e.files.length > 3 ? "<br>+" + (e.files.length - 3) + " more" : "") + "</td>" +
    "<td>" + (e.violations.length ? e.violations.slice(0, 4).map((v) => '<span class="b bad" data-id="' + esc(v.id) + '" style="cursor:pointer">' + esc(v.id) + "</span> <code>" + esc(v.path) + (v.line ? ":" + v.line : "") + "</code>").join("<br>") : '<span class="meta">clean</span>') + "</td>" +
    "<td>" + (e.blocked ? '<b class="lvl-error">blocked</b>' : e.violations.length ? '<span class="lvl-warning">reported</span>' : "passed") + "</td></tr>").join("");
  $("#main").innerHTML = '<div class="panel" style="overflow-x:auto"><table><thead><tr><th>When</th><th>Who</th><th>Files</th><th>Violations</th><th>Outcome</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
}

function renderHealth() {
  const is = S.state.issues;
  if (!is.length) { $("#main").innerHTML = '<div class="panel empty">The decision graph is consistent: no broken links, cycles, stale dependencies or conflicting rules.</div>'; return; }
  $("#main").innerHTML = '<div class="panel" style="overflow-x:auto"><table><thead><tr><th>Level</th><th>Decision</th><th>Issue</th></tr></thead><tbody>' +
    is.map((i) => '<tr><td class="lvl-' + i.level + '">' + i.level + '</td><td><span class="mono" data-id="' + esc(i.id) + '" style="cursor:pointer">' + esc(i.id) + "</span></td><td>" + esc(i.message) + "</td></tr>").join("") + "</tbody></table></div>";
}

function render() {
  if (!S.state) return;
  $("#tabs").style.display = "";
  renderKpis();
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
  ({ log: renderLog, graph: renderGraph, activity: renderActivity, health: renderHealth })[S.tab]();
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

document.addEventListener("click", async (e) => {
  const tab = e.target.closest("#tabs button");
  if (tab) { S.tab = tab.dataset.tab; render(); return; }
  const act = e.target.closest("[data-act]");
  if (act && S.sel) {
    act.disabled = true;
    try { await api("PATCH", "/v1/decisions/" + S.sel, { status: act.dataset.act, note: "via dashboard" }); await load(); }
    catch (err) { toast(err.message); act.disabled = false; }
    return;
  }
  const el = e.target.closest("[data-id]");
  if (el && S.state && byId()[el.dataset.id]) {
    S.sel = el.dataset.id;
    if (S.tab !== "log") { S.tab = "log"; S.status = "all"; }
    else if (!filtered().find((d) => d.id === S.sel)) S.status = "all";
    render();
    window.scrollTo({ top: 0 });
  }
});

function enrich(decisions) {
  const down = {};
  decisions.forEach((d) => d.depends_on.forEach((u) => (down[u] ||= []).push(d.id)));
  const closure = (id) => { const seen = new Set(); const q = [...(down[id] || [])]; while (q.length) { const x = q.shift(); if (!seen.has(x)) { seen.add(x); q.push(...(down[x] || [])); } } return seen.size; };
  return decisions.map((d) => ({ ...d, downstream: down[d.id] || [], downstreamAll: closure(d.id) }));
}

let loading = null;
async function load() {
  if (loading) return loading;
  loading = (async () => {
    const [me, ds, st, ch, lint] = await Promise.all([api("GET", "/v1/me"), api("GET", "/v1/decisions"), api("GET", "/v1/stats?days=7"), api("GET", "/v1/checks?limit=200"), api("GET", "/v1/lint")]);
    S.state = { me, decisions: enrich(ds.decisions), stats: st.stats, totals: st.totals, checks: ch.checks, issues: lint.issues };
    if (!(document.activeElement && document.activeElement.id === "q")) render();
  })().finally(() => { loading = null; });
  return loading;
}

async function stream() {
  let backoff = 1000, lastId = null;
  while (TOKEN) {
    try {
      const r = await fetch("/v1/stream", { headers: { authorization: "Bearer " + TOKEN, ...(lastId ? { "last-event-id": lastId } : {}) } });
      if (r.status === 401) return signOut("Your token is no longer valid.");
      if (!r.ok || !r.body) throw new Error("stream");
      S.live = true; render(); backoff = 1000;
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          let ev = "message", data = "";
          raw.split("\n").forEach((l) => { if (l.startsWith("event:")) ev = l.slice(6).trim(); else if (l.startsWith("data:")) data += l.slice(5).trim(); else if (l.startsWith("id:")) lastId = l.slice(3).trim(); });
          if (ev === "ping" || ev === "ready") continue;
          try {
            const e = JSON.parse(data);
            if (ev === "decision.created") toast((e.payload && e.payload.status === "proposed" ? "New proposal " : (e.actor || "Someone") + " recorded ") + e.decision_key + ": " + (e.payload && e.payload.title || ""));
            else if (ev === "check.violation" && e.payload && e.payload.blocked) toast("Blocked a change that broke " + e.payload.violations.map((v) => v.id).join(", "));
          } catch (x) {}
          load().catch(() => {});
        }
      }
    } catch (e) {}
    S.live = false; render();
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30000);
  }
}

async function boot() {
  if (!TOKEN) return renderLogin();
  try { await load(); stream(); } catch (e) { if (TOKEN) $("#main").innerHTML = '<div class="panel empty">' + esc(e.message) + "</div>"; }
}
boot();
</script>
</body>
</html>`;
