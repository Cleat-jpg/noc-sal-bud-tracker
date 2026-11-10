const GAS_URL = "https://script.google.com/macros/s/AKfycbwIrRvWJz95B0SKgjbVKkJLr8UgmT_5rFIduLS61P12dcl3wnqDgpxOR-UIBsfCH_Ut/exec";
const $ = (s) => document.querySelector(s);
const LS = {
  get: (k) => { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
  del: (k) => { try { localStorage.removeItem(k); } catch (e) {} }
};
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Math.random().toString(36).slice(2, 9);

let S = null, locked = false, loginMsg = "", mode = "login", view = "home", loadError = "";

const run = async (fn, ...args) => {
  const res = await fetch(GAS_URL, { method: "POST", body: JSON.stringify({ fn, args, token: LS.get("pd_token") }) });
  let j;
  try { j = JSON.parse(await res.text()); }
  catch (e) { throw new Error("The server sent back a web page instead of data. Check the Apps Script deployment (access: Anyone)."); }
  if (j.status === "error") {
    if (j.error === "UNAUTHORIZED") { LS.del("pd_token"); S = null; locked = true; loginMsg = "Your session ended. Please sign in again."; throw new Error("Signed out"); }
    throw new Error(j.error);
  }
  return j.data;
};

/* ---------- data model ---------- */
const LABEL = { BASIC: "Basic", EVENING: "Evening", RH: "Regular holiday", UH: "US holiday", SH: "Special holiday", OT: "Overtime", "OT/RH": "OT on regular holiday (Guessed Multiplier)", "E/RH": "Evening on regular holiday (Guessed Multiplier)", "E/UH": "Evening on US holiday (Guessed Multiplier)" };
// Bump MULT_VER whenever you change MULT0 and want EVERY account reset to the new defaults (custom edits are wiped once).
const MULT_VER = 3; // 3 = multipliers are whole-number percents (125 = 125%)
const MULT0 = { BASIC: 100, EVENING: 10, RH: 200, UH: 50, SH: 30, OT: 125, "OT/RH": 260, "E/RH": 160, "E/UH": 160 };
const fresh = () => ({ v: 1, profile: { role: "", rate: 0, per: "day", hpd: 8, cur: "₱", mult: { ...MULT0 }, multOv: {}, multVer: MULT_VER, ded: [] }, period: { start: "", end: "" }, hours: {}, budget: { pool: null, start: "", end: "", items: [], spends: [], log: [] }, past: [] });
function norm(s) {
  const f = fresh(); s = s || {}; const p = s.profile || {};
  // Multipliers follow MULT0 unless the user edited them after the current MULT_VER; a version bump resets everyone.
  const ov = p.multVer === MULT_VER ? (p.multOv || {}) : {};
  return { ...f, ...s, profile: { ...f.profile, ...p, rate: p.per === "hour" ? round2((Number(p.rate) || 0) * (p.hpd || 8)) : p.rate || 0, per: "day", mult: { ...MULT0, ...ov }, multOv: ov, multVer: MULT_VER, ded: p.ded || [] }, period: { ...f.period, ...(s.period || {}) }, hours: s.hours || {}, budget: { ...f.budget, ...(s.budget || {}) }, past: s.past || [] };
}
const sum = (a, f) => a.reduce((t, x) => t + (Number(f(x)) || 0), 0);
const m = (n) => { n = Number(n) || 0; return (n < 0 ? "−" : "") + S.profile.cur + Math.abs(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const niceDate = (iso) => { if (!iso) return ""; const [y, mo, d] = iso.split("-").map(Number); return new Date(y, mo - 1, d).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" }); };
const range = () => (S.period.start && S.period.end ? niceDate(S.period.start) + " – " + niceDate(S.period.end) : "No dates set");

const HOURLY = new Set(["OT", "OT/RH", "E/RH", "E/UH"]);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const ord = (n) => { const t = ["th", "st", "nd", "rd"], v = n % 100; return n + (t[(v - 20) % 10] || t[v] || t[0]); };
// Where a "deduct on day X" item lands in the current pay period.
// null = no date set (deduct every period) · "" = the day is not inside this period · "YYYY-MM-DD" = the date it hits
function dedHit(d) {
  const day = Math.round(Number(d.day)) || 0; if (!day) return null;
  const { start, end } = S.period; if (!start || !end) return null;
  let [y, mo] = start.split("-").map(Number); const [ey, em] = end.split("-").map(Number);
  while (y < ey || (y === ey && mo <= em)) {
    const dim = new Date(y, mo, 0).getDate();
    const iso = y + "-" + String(mo).padStart(2, "0") + "-" + String(Math.min(day, dim)).padStart(2, "0");
    if (iso >= start && iso <= end) return iso;
    if (++mo > 12) { mo = 1; y++; }
  }
  return "";
}
function calc() {
  // The rate is per day. The hourly rate is daily ÷ hours-per-day and is NOT rounded before use (only each pay line is rounded to the cent).
  const p = S.profile, daily = Number(p.rate) || 0, hr = daily / (p.hpd || 8);
  // Overtime and evening-on-holiday rows are counted in hours (× hourly rate); every other row is counted in days (× daily rate)
  const rows = Object.keys(LABEL).map((k) => { const h = Number(S.hours[k]) || 0, mu = Number(p.mult[k]) || 0, hrs = HOURLY.has(k); return { k, h, mu, unit: hrs ? "hr" : "day", pay: round2((h * (hrs ? hr : daily) * mu) / 100) }; });
  const gross = round2(sum(rows, (r) => r.pay));
  const ded = p.ded.map((d) => {
    const full = round2(d.type === "pct" ? (gross * (Number(d.value) || 0)) / 100 : Number(d.value) || 0);
    const hit = dedHit(d), on = hit !== "";
    return { ...d, full, hit, on, amt: on ? full : 0 };
  });
  const dTot = round2(sum(ded, (d) => d.amt));
  return { hr, daily, rows, gross, ded, dTot, net: Math.max(0, round2(gross - dTot)) };
}
// Left to assign = pool - allocated. Logging a spend never touches the allocation.
function bcalc() {
  const c = calc(), b = S.budget, pool = b.pool != null ? Number(b.pool) : c.net;
  const assigned = sum(b.items, (i) => i.amount), spent = sum(b.items, (i) => i.spent);
  return { pool, assigned, left: pool - assigned, spent, toSpend: assigned - spent, net: c.net };
}
// The budget can have its own dates; when blank it follows the salary pay period.
const bEnd = () => (S.budget.start && S.budget.end ? S.budget.end : S.period.end);
const brange = () => (S.budget.start && S.budget.end ? niceDate(S.budget.start) + " – " + niceDate(S.budget.end) : range());
function daysLeft() {
  if (!bEnd()) return 0;
  return Math.max(1, Math.ceil((new Date(bEnd() + "T23:59:59") - new Date()) / 864e5));
}

/* ---------- saving ---------- */
let q = Promise.resolve();
function persist() {
  q = q.then(() => run("saveState", S)).catch((e) => { if (locked) render(); else toast("Couldn’t save: " + e.message + " Tap ⟳ to reload."); });
}
function commit() { render(); persist(); }
function note(msg) { S.budget.log.unshift({ msg, ts: Date.now() }); S.budget.log = S.budget.log.slice(0, 30); }

async function load() {
  if (!LS.get("pd_token")) { locked = true; S = null; render(); return; }
  locked = false; render();
  try {
    const r = await run("getState");
    S = norm(r.state); loadError = "";
    if (!r.state) persist();
  } catch (e) { if (!locked) { loadError = e.message; toast("Couldn’t reach the server. Check your connection."); } }
  render();
}
$("#refresh").onclick = () => { S = null; loadError = ""; load(); };

/* ---------- shell ---------- */
function render() {
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.v === view));
  $("#nav").style.display = locked ? "none" : "";
  $("#sub").textContent = locked ? "" : LS.get("pd_user");
  const el = $("#app");
  if (locked) { el.innerHTML = authHtml(); bindAuth(); return; }
  if (!S) { el.innerHTML = loadError ? '<div class="card err">Couldn’t load your data: ' + esc(loadError) + "<br><br>Tap ⟳ to try again.</div>" : '<div class="empty">Loading…</div>'; return; }
  try { el.innerHTML = { home: rHome, salary: rSalary, budget: rBudget, account: rAccount }[view](); }
  catch (err) { console.error(err); el.innerHTML = '<div class="card err">This tab hit an error: ' + esc(err.message) + "</div>"; }
}
$("#nav").onclick = (e) => { const b = e.target.closest("button[data-v]"); if (b) { view = b.dataset.v; render(); window.scrollTo(0, 0); } };
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = "none"), 3600); }

/* ---------- sign in / sign up ---------- */
function authHtml() {
  const reg = mode === "register";
  return `<div class="card" style="margin-top:24px"><h2>${reg ? "Create your account" : "Sign in"}</h2>
    <p class="muted" style="margin:0 0 6px">${reg ? "Your salary and budget are saved to your account only." : "Welcome back."}</p>
    ${loginMsg ? `<p class="err" role="alert" style="margin:8px 0">${esc(loginMsg)}</p>` : ""}
    <div class="sheet" style="padding:0;max-height:none;border-radius:0">
    <label>Username<input id="au" autocomplete="username" autocapitalize="none" value="${esc(LS.get("pd_user"))}"></label>
    <label>Password<span style="position:relative;display:block"><input id="ap" type="password" autocomplete="${reg ? "new-password" : "current-password"}" style="padding-right:68px"><button type="button" id="apeye" aria-label="Show password" aria-pressed="false" style="position:absolute;right:4px;top:calc(50% + 2px);transform:translateY(-50%);border:none;background:none;color:var(--accent);font-weight:600;font-size:13px;padding:10px 12px;cursor:pointer">Show</button></span></label>
    ${reg ? '<label>Invite code (if you were given one)<input id="ai" autocomplete="off"></label>' : ""}</div>
    <button class="btn" id="ago" style="width:100%;margin-top:16px">${reg ? "Create account" : "Sign in"}</button>
    <button class="btn ghost" id="aswap" style="width:100%;margin-top:8px">${reg ? "I already have an account" : "New here? Create an account"}</button></div>`;
}
function bindAuth() {
  const go = $("#ago");
  const submit = async () => {
    const u = $("#au").value.trim(), p = $("#ap").value;
    if (!u || !p) { toast("Enter a username and password."); return; }
    go.disabled = true; go.textContent = "Please wait…";
    try {
      const r = mode === "register" ? await run("register", u, p, $("#ai") ? $("#ai").value : "") : await run("login", u, p);
      LS.set("pd_token", r.token); LS.set("pd_user", r.username); loginMsg = ""; S = null; view = "home"; load();
    } catch (e) { loginMsg = e.message; render(); }
  };
  go.onclick = submit;
  const eye = $("#apeye");
  eye.onclick = () => {
    const pw = $("#ap"), show = pw.type === "password";
    pw.type = show ? "text" : "password"; eye.textContent = show ? "Hide" : "Show";
    eye.setAttribute("aria-pressed", String(show)); eye.setAttribute("aria-label", show ? "Hide password" : "Show password"); pw.focus();
  };
  $("#ap").onkeydown = (e) => { if (e.key === "Enter") submit(); };
  $("#aswap").onclick = () => { mode = mode === "login" ? "register" : "login"; loginMsg = ""; render(); };
}

/* ---------- home ---------- */
function rHome() {
  const c = calc(), b = bcalc(), d = daysLeft();
  const setup = !(Number(S.profile.rate) > 0)
    ? `<div class="card"><h2>Let’s set you up</h2><p class="muted" style="margin:0 0 12px">Add your role and rate in the Salary tab, enter your hours, then plan your budget.</p><button class="btn" data-a="go-salary">Set up salary</button></div>` : "";
  const perDay = d && b.toSpend > 0 ? `<div class="sub" style="margin-top:12px">About ${m(b.toSpend / d)} a day for the next ${d} day${d > 1 ? "s" : ""}</div>` : "";
  const bars = S.budget.items.filter((i) => i.amount > 0).map((i) => `
    <div class="cat" style="grid-template-columns:1fr auto"><span style="font-weight:600;text-transform:uppercase;font-size:13.5px">${esc(i.desc)}</span><b>${m(i.spent)} <span class="muted" style="font-weight:400">/ ${m(i.amount)}</span></b>
    <div class="bar" style="grid-column:1 / 3"><i style="width:${Math.min(100, (i.spent / i.amount) * 100)}%${i.spent > i.amount ? ";background:var(--warn)" : ""}"></i></div></div>`).join("");
  const past = S.past.length ? `<div class="card"><h2>Past periods</h2><div class="scroll"><table><tr><th>Period</th><th>Take-home</th><th>Spent</th><th>Kept</th></tr>${S.past.map((p) =>
    `<tr><td>${esc(p.start ? niceDate(p.start) : "–")}</td><td>${m(p.net)}</td><td>${m(p.spent)}</td><td><b>${m(p.net - p.spent)}</b></td></tr>`).join("")}</table></div></div>` : "";
  return `${setup}<div class="card hero"><div class="sub" style="margin-top:0">Take-home · ${esc(range())}</div><div class="big">${m(c.net)}</div>
    <div class="stats"><div class="stat"><b>${m(b.spent)}</b><span>Spent</span></div><div class="stat"><b>${m(b.toSpend)}</b><span>Left to spend</span></div></div>${perDay}</div>
    ${bars ? `<div class="card"><h2>Where it’s going</h2>${bars}</div>` : ""}${past}
    <div style="text-align:center;margin:8px 0"><button class="btn ghost" data-a="per-new">Start a new pay period</button></div>`;
}

/* ---------- salary ---------- */
function rSalary() {
  const c = calc(), p = S.profile;
  return `<div class="card hero"><div class="hero-head"><div class="hero-meta"><span class="role">${esc(p.role || "Add your role")}</span><span class="date-range">${esc(range())}</span></div>
    <button class="btn ghost" data-a="sal-dates">Dates</button></div>
    <div class="big">${m(c.net)}</div><div class="sub" style="margin-top:2px">Take-home salary</div>
    <div class="stats"><div class="stat"><b>${m(c.gross)}</b><span>Gross expected</span></div><div class="stat"><b>${m(c.daily)}</b><span>Daily rate</span></div></div></div>
  <div class="card"><div class="addbar"><h2 style="margin:0">Rate &amp; role</h2><button class="btn" data-a="sal-rate" style="padding:7px 14px;font-size:13px">Edit</button></div>
    <div class="row"><div class="body"><div class="t">${esc(p.role || "No role yet")}</div><div class="s">${m(p.rate)} per day · ${p.hpd} h/day</div></div></div>
    <button class="btn ghost" data-a="sal-mult" style="margin-top:6px;font-size:13px;padding:8px 14px">Edit rate multipliers</button></div>
  <div class="card"><div class="addbar" style="gap:8px"><h2 style="margin:0;flex:1">Work breakdown</h2><button class="btn ghost" data-a="sal-plan" style="padding:7px 14px;font-size:13px">Plan days</button><button class="btn" data-a="sal-hours" style="padding:7px 14px;font-size:13px">Edit hours</button></div>
    ${S.period.off && S.period.off.length ? `<div class="muted" style="font-size:12.5px;margin-top:6px">${S.period.off.length} day${S.period.off.length > 1 ? "s" : ""} off this pay period</div>` : ""}
    <div class="scroll" style="margin-top:10px"><table class="table-responsive"><tr><th style="text-align:left">Type</th><th>Hrs / days</th><th>Rate</th><th>Pay</th></tr>
    ${c.rows.map((r) => `<tr><td style="font-weight:600">${esc(LABEL[r.k])}</td><td>${r.h ? r.h + (r.unit === "day" ? (r.h === 1 ? " day" : " days") : " h") : "–"}</td><td class="muted">${r.mu}%</td><td style="font-weight:600">${m(r.pay)}</td></tr>`).join("")}</table></div></div>
  <div class="card"><div class="addbar"><h2 style="margin:0">Contributions &amp; deductions</h2><button class="btn" data-a="ded-add" style="padding:7px 14px;font-size:13px">Add</button></div>
    ${c.ded.length ? c.ded.map((d) => `<div class="row ${d.on ? "" : "done"}"><div class="body"><div class="t">${esc(d.name)}</div><div class="s">${d.type === "pct" ? d.value + "% of gross" : "Fixed"}${Number(d.day) ? " · only on the " + ord(Math.round(Number(d.day))) + (d.hit ? " (" + niceDate(d.hit) + ")" : " · not in this pay period") : ""}</div></div><div class="amt minus">−${m(d.full)}</div><button class="edit" data-a="ded-edit" data-id="${esc(d.id)}" aria-label="Edit ${esc(d.name)}">✎</button></div>`).join("") +
      `<div class="row"><div class="body"><div class="t">Total deductions</div></div><div class="amt">−${m(c.dTot)}</div></div>` : '<div class="empty" style="padding:18px 0 6px">No deductions. Add SSS, PhilHealth, Pag-IBIG, tax and so on.</div>'}</div>`;
}

/* ---------- budget ---------- */
function rBudget() {
  const b = bcalc(), items = S.budget.items, over = b.left < 0;
  const aPct = b.pool > 0 ? Math.min(100, Math.max(0, (b.assigned / b.pool) * 100)) : 0;
  const uPct = b.pool > 0 ? Math.min(100, (b.spent / b.assigned || 0) * 100) : 0;
  const spends = S.budget.spends.slice(0, 6).map((e) => `<div class="row"><div class="body"><div class="t" style="font-size:14px;text-transform:uppercase">${esc(e.desc)}</div><div class="s">${esc(new Date(e.ts).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}${e.auto ? " · auto (item checked)" : ""}</div></div>
    <div class="amt">${m(e.amt)}</div><button class="btn ghost" data-a="bud-undo" data-id="${esc(e.id)}" style="padding:4px 10px;font-size:12px;border-radius:10px">Undo</button></div>`).join("");
  const log = S.budget.log.slice(0, 5).map((l) => `<div class="row" style="font-size:13.5px;padding:8px 0"><div class="body">${esc(l.msg)}</div><span class="muted" style="font-size:12px;white-space:nowrap">${esc(new Date(l.ts).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</span></div>`).join("");
  return `<div class="card hero"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h2 style="margin:0;font-size:20px">Budget · ${esc(brange())}</h2>
    <button class="btn ghost" data-a="bud-head" style="padding:6px 14px;font-size:13px">Edit</button></div>
    <div class="stats" style="margin-top:0"><div class="stat"><span>Budget</span><b>${m(b.pool)}</b></div><div class="stat"><span>${over ? "Over-assigned" : "Left to assign"}</span><b>${m(Math.abs(b.left))}</b></div></div>
    <div class="meter"><i style="width:${aPct}%"></i></div><div class="sub" style="font-size:12.5px;margin-top:6px">${m(b.assigned)} assigned${b.pool > 0 ? " · " + Math.max(0, (b.left / b.pool) * 100).toFixed(1) + "% unassigned" : ""}</div></div>
  <div class="card"><div style="display:flex;justify-content:space-between;align-items:baseline"><h2 style="margin:0">Money used</h2><span class="muted" style="font-size:12px">This pay period</span></div>
    <div style="font-size:34px;font-weight:700;letter-spacing:-0.02em;margin-top:8px">${m(b.spent)}</div>
    <div class="muted" style="font-size:13px">${b.assigned > 0 ? uPct.toFixed(1) + "% of what’s assigned · " + m(b.toSpend) + " left to spend" : "spent so far"}</div>
    <div class="meter"><i style="width:${uPct}%"></i></div>
    ${spends ? `<div class="muted" style="margin-top:10px;font-size:13px;font-weight:600">Recent spends</div>${spends}` : '<div class="empty" style="padding:14px 0 4px;font-size:13.5px">Nothing spent yet. Tap LOG on an item.</div>'}</div>
  <div class="card"><div class="addbar" style="margin-bottom:6px"><h2 style="margin:0">Plan</h2><button class="btn" data-a="bud-add" style="padding:8px 16px">Add item</button></div>
    ${items.length ? items.map((it) => { const rem = it.amount - it.spent, ov = rem < 0; return `
    <div class="item ${it.done ? "done" : ""}"><div class="top">
      <button class="chk ${it.done ? "on" : ""}" data-a="bud-toggle" data-id="${esc(it.id)}" aria-label="Mark ${esc(it.desc)} as ${it.done ? "not done" : "done"}">${it.done ? "✓" : ""}</button>
      <div class="nm">${esc(it.desc)}<div class="s muted" style="font-size:12px;font-weight:400;text-transform:none;letter-spacing:0">${m(it.spent)} spent · <span class="${ov ? "over-t" : ""}">${ov ? m(-rem) + " over" : m(rem) + " left"}</span></div></div>
      <b class="amt">${m(it.amount)}</b><button class="tag" data-a="bud-log" data-id="${esc(it.id)}">LOG</button><button class="edit" data-a="bud-edit" data-id="${esc(it.id)}" aria-label="Edit ${esc(it.desc)}" style="border:none;background:none;color:var(--mute);font-size:17px;cursor:pointer">✎</button></div>
      <div class="mini ${ov ? "over" : ""}"><i style="width:${it.amount > 0 ? Math.min(100, (it.spent / it.amount) * 100) : 0}%"></i></div></div>`; }).join("") : '<div class="empty" style="padding:18px 0">Add your first item, like Food or Rent.</div>'}</div>
  <div class="card"><h2 style="font-size:16px">Recent activity</h2>${log || '<div class="empty" style="padding:14px 0;font-size:13.5px">Edits will show up here.</div>'}</div>`;
}

/* ---------- account ---------- */
function rAccount() {
  return `<div class="card"><h2>Account</h2><div class="row"><div class="body"><div class="t">${esc(LS.get("pd_user"))}</div><div class="s">Signed in on this device</div></div></div>
    <div class="actions"><button class="btn ghost" data-a="pw">Change password</button><button class="btn" data-a="signout">Sign out</button></div></div>
    <p class="muted" style="text-align:center;font-size:13px">Your data is saved to your account and works on any device.</p>`;
}

/* ---------- modal ---------- */
function openModal(cfg) {
  const mo = $("#modal");
  mo.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(cfg.title)}"><h3>${esc(cfg.title)}</h3>
    ${cfg.fields.map((f) => `<label>${esc(f.label)}${f.opts
      ? `<select id="f_${f.k}">${f.opts.map((o) => `<option value="${esc(o[0])}" ${String(f.value) === String(o[0]) ? "selected" : ""}>${esc(o[1])}</option>`).join("")}</select>`
      : `<input id="f_${f.k}" type="${f.type || "text"}" value="${esc(f.value == null ? "" : f.value)}" placeholder="${esc(f.ph || "")}" ${f.type === "number" ? 'step="0.01" inputmode="decimal"' : ""} autocomplete="off">`}</label>`).join("")}
    <div class="actions">${cfg.del ? '<button class="btn danger" id="m_del">Delete</button>' : ""}<button class="btn ghost" id="m_cancel">Cancel</button><button class="btn" id="m_save">Save</button></div></div>`;
  mo.classList.add("open");
  const close = () => { mo.classList.remove("open"); mo.innerHTML = ""; };
  mo.onclick = (e) => { if (e.target === mo) close(); };
  $("#m_cancel").onclick = close;
  const busy = async (fn) => {
    const btns = mo.querySelectorAll("button"); btns.forEach((b) => (b.disabled = true));
    try { await fn(); close(); render(); }
    catch (e) { if (locked) { close(); render(); return; } toast(e.message || "Couldn’t save."); btns.forEach((b) => (b.disabled = false)); }
  };
  $("#m_save").onclick = () => {
    const v = {};
    for (const f of cfg.fields) { v[f.k] = document.getElementById("f_" + f.k).value.trim(); if (f.req && !v[f.k]) { toast("Add a " + f.label.toLowerCase() + " first."); document.getElementById("f_" + f.k).focus(); return; } }
    busy(() => cfg.save(v));
  };
  if (cfg.del) $("#m_del").onclick = () => busy(cfg.del);
  const first = mo.querySelector("input"); if (first && !first.value) first.focus();
}

/* ---------- actions ---------- */
const byId = (l, id) => l.find((i) => i.id === id);
const num = (x) => Math.max(0, Number(x) || 0);
$("#app").addEventListener("click", (e) => {
  const el = e.target.closest("[data-a]"); if (!el) return;
  const a = el.dataset.a, id = el.dataset.id, p = S && S.profile;
  if (a === "go-salary") { view = "salary"; render(); }
  else if (a === "sal-plan") openPlanner();
  else if (a === "signout") { run("logout").catch(() => {}); LS.del("pd_token"); S = null; locked = true; loginMsg = ""; mode = "login"; render(); }
  else if (a === "pw") openModal({ title: "Change password", fields: [{ k: "o", label: "Current password", type: "password", req: true }, { k: "n", label: "New password (8+ characters)", type: "password", req: true }],
    save: async (v) => { await run("changePassword", v.o, v.n); toast("Password changed."); } });
  else if (a === "sal-dates") openModal({ title: "Pay period dates", fields: [{ k: "s", label: "Start date", type: "date", value: S.period.start }, { k: "e", label: "End date", type: "date", value: S.period.end }],
    save: (v) => {
      S.period.start = v.s; S.period.end = v.e;
      // Keep only the days off that are still inside the new dates
      S.period.off = (S.period.off || []).filter((d) => d >= v.s && d <= v.e);
      commit();
    } });
  else if (a === "sal-rate") openModal({ title: "Rate & role", fields: [
    { k: "role", label: "Role", value: p.role, ph: "e.g. Customer service rep" },
    { k: "rate", label: "Daily rate (amount)", type: "number", value: p.rate || "", req: true },
    { k: "hpd", label: "Hours per day", type: "number", value: p.hpd },
    { k: "cur", label: "Currency symbol", value: p.cur }],
    save: (v) => { Object.assign(p, { role: v.role, rate: num(v.rate), per: "day", hpd: num(v.hpd) || 8, cur: v.cur || "₱" }); commit(); } });
  else if (a === "sal-mult") openModal({ title: "Rate multipliers", fields: Object.keys(LABEL).filter((k) => k !== "BASIC").map((k) => ({ k, label: LABEL[k] + (HOURLY.has(k) ? " (% of hourly rate)" : " (% of daily rate)"), type: "number", value: p.mult[k] })),
    save: (v) => { for (const k in v) { const x = num(v[k]); p.mult[k] = x; if (x === MULT0[k]) delete p.multOv[k]; else p.multOv[k] = x; } commit(); } });
  else if (a === "sal-hours") openModal({ title: "Hours worked", fields: Object.keys(LABEL).map((k) => ({ k, label: LABEL[k] + (HOURLY.has(k) ? " (hours)" : " (days)"), type: "number", value: S.hours[k] || "" })),
    save: (v) => { for (const k in v) S.hours[k] = num(v[k]); commit(); } });
  else if (a === "ded-add" || a === "ded-edit") {
    const d = id ? byId(p.ded, id) : null;
    openModal({ title: d ? "Edit deduction" : "Add deduction", fields: [
      { k: "name", label: "Name", value: d ? d.name : "", req: true, ph: "e.g. SSS" },
      { k: "type", label: "Type", value: d ? d.type : "fixed", opts: [["fixed", "Fixed amount"], ["pct", "Percent of gross"]] },
      { k: "value", label: "Amount or percent", type: "number", value: d ? d.value : "", req: true },
      { k: "day", label: "Deduct only on this day of the month (1–31). Leave blank to deduct every pay period", type: "number", value: d && d.day ? d.day : "", ph: "e.g. 15" }],
      save: (v) => { const day = v.day === "" ? null : Math.min(31, Math.max(1, Math.round(Number(v.day)) || 1)); if (d) Object.assign(d, { name: v.name, type: v.type, value: num(v.value), day }); else p.ded.push({ id: uid(), name: v.name, type: v.type, value: num(v.value), day }); commit(); },
      del: d ? () => { p.ded = p.ded.filter((x) => x.id !== id); commit(); } : null });
  }
  else if (a === "bud-head") openModal({ title: "Budget amount & dates", fields: [
    { k: "pool", label: "Amount to budget (leave blank to use take-home)", type: "number", value: S.budget.pool != null ? S.budget.pool : "", ph: m(calc().net) },
    { k: "s", label: "Budget start date (blank = salary dates)", type: "date", value: S.budget.start || "" },
    { k: "e", label: "Budget end date (blank = salary dates)", type: "date", value: S.budget.end || "" }],
    save: (v) => {
      if (!!v.s !== !!v.e) throw new Error("Set both dates, or leave both blank.");
      if (v.s && v.e < v.s) throw new Error("The end date must be after the start date.");
      S.budget.pool = v.pool === "" ? null : num(v.pool); S.budget.start = v.s; S.budget.end = v.e; commit();
    } });
  else if (a === "bud-add" || a === "bud-edit") {
    const it = id ? byId(S.budget.items, id) : null;
    openModal({ title: it ? "Edit budget item" : "Add budget item", fields: [{ k: "desc", label: "Name", value: it ? it.desc : "", req: true, ph: "e.g. Food" }, { k: "amt", label: "Amount assigned", type: "number", value: it ? it.amount : "", req: true }],
      save: (v) => { if (it) { it.desc = v.desc; it.amount = num(v.amt); note("Edited " + v.desc); } else { S.budget.items.push({ id: uid(), desc: v.desc, amount: num(v.amt), spent: 0, done: false }); note("Added " + v.desc + " (" + m(num(v.amt)) + ")"); } commit(); },
      del: it ? () => { S.budget.items = S.budget.items.filter((x) => x.id !== id); S.budget.spends = S.budget.spends.filter((x) => x.item !== id); note("Removed " + it.desc); commit(); } : null });
  }
  else if (a === "bud-log") {
    const it = byId(S.budget.items, id); if (!it) return;
    openModal({ title: "Log on " + it.desc, fields: [{ k: "spent", label: "Amount spent (counts as money used)", type: "number", ph: "e.g. 200" }, { k: "added", label: "Amount to add to this item (uses Left to assign)", type: "number", ph: "e.g. 500" }],
      save: (v) => {
        const sp = num(v.spent), ad = num(v.added); if (!sp && !ad) throw new Error("Enter an amount.");
        if (sp) { it.spent += sp; S.budget.spends.unshift({ id: uid(), item: it.id, desc: it.desc, amt: sp, ts: Date.now() }); S.budget.spends = S.budget.spends.slice(0, 100); note("Spent " + m(sp) + " on " + it.desc); }
        if (ad) { it.amount += ad; note("Added " + m(ad) + " to " + it.desc); }
        commit();
      } });
  }
  else if (a === "bud-toggle") {
    const it = byId(S.budget.items, id); if (!it) return;
    if (!it.done) {
      // Checking an item counts whatever is still left of its plan as money used
      it.done = true; const rem = Math.max(0, it.amount - it.spent);
      if (rem > 0) {
        it.spent += rem; it.autoSpent = rem;
        S.budget.spends.unshift({ id: uid(), item: it.id, desc: it.desc, amt: rem, ts: Date.now(), auto: true }); S.budget.spends = S.budget.spends.slice(0, 100);
        note("Marked " + it.desc + " done · " + m(rem) + " counted as used");
      }
    } else {
      // Unchecking gives back only what the check added automatically
      it.done = false; const back = it.autoSpent || 0;
      if (back > 0) {
        it.spent = Math.max(0, it.spent - back); it.autoSpent = 0;
        S.budget.spends = S.budget.spends.filter((x) => !(x.auto && x.item === it.id));
        note("Unchecked " + it.desc + " · " + m(back) + " returned");
      }
    }
    commit();
  }
  else if (a === "bud-undo") {
    const sp = byId(S.budget.spends, id); if (!sp || !confirm("Undo this spend? It comes off Money used and goes back to the item.")) return;
    const it = byId(S.budget.items, sp.item); if (it) { it.spent = Math.max(0, it.spent - sp.amt); if (sp.auto) { it.done = false; it.autoSpent = 0; } }
    S.budget.spends = S.budget.spends.filter((x) => x.id !== id); note("Undid " + m(sp.amt) + " on " + sp.desc); commit();
  }
  else if (a === "per-new") openModal({ title: "Start a new pay period", fields: [{ k: "s", label: "New start date", type: "date" }, { k: "e", label: "New end date", type: "date" }],
    save: (v) => {
      const c = calc(), b = bcalc();
      S.past.unshift({ start: S.period.start, end: S.period.end, net: c.net, spent: b.spent }); S.past = S.past.slice(0, 24);
      S.period = { start: v.s, end: v.e, off: [] }; S.hours = {}; S.budget.pool = null; S.budget.start = ""; S.budget.end = ""; S.budget.spends = []; S.budget.log = [];
      S.budget.items.forEach((i) => { i.spent = 0; i.done = false; i.autoSpent = 0; }); commit();
    } });
});

/* ---------- cut-off planner: pick the pay period and the days off ---------- */
const H = (t, n) => [t, n];
const PH = {
  // 2026 (Proclamation 1006)
  "2026-01-01": H("RH","New Year's Day"), "2026-04-02": H("RH","Maundy Thursday"), "2026-04-03": H("RH","Good Friday"),
  "2026-04-09": H("RH","Araw ng Kagitingan"), "2026-05-01": H("RH","Labor Day"), "2026-06-12": H("RH","Independence Day"),
  "2026-08-31": H("RH","National Heroes Day"), "2026-11-30": H("RH","Bonifacio Day"), "2026-12-25": H("RH","Christmas Day"),
  "2026-12-30": H("RH","Rizal Day"),
  "2026-02-17": H("SH","Chinese New Year"), "2026-04-04": H("SH","Black Saturday"), "2026-08-21": H("SH","Ninoy Aquino Day"),
  "2026-11-01": H("SH","All Saints' Day"), "2026-11-02": H("SH","All Souls' Day"), "2026-12-08": H("SH","Immaculate Conception"),
  "2026-12-24": H("SH","Christmas Eve"), "2026-12-31": H("SH","Last Day of the Year"),
  // 2027 (Proclamation 1427)
  "2027-01-01": H("RH","New Year's Day"), "2027-03-25": H("RH","Maundy Thursday"), "2027-03-26": H("RH","Good Friday"),
  "2027-04-09": H("RH","Araw ng Kagitingan"), "2027-05-01": H("RH","Labor Day"), "2027-06-12": H("RH","Independence Day"),
  "2027-08-30": H("RH","National Heroes Day"), "2027-11-30": H("RH","Bonifacio Day"), "2027-12-25": H("RH","Christmas Day"),
  "2027-12-30": H("RH","Rizal Day"),
  "2027-02-06": H("SH","Chinese New Year"), "2027-03-27": H("SH","Black Saturday"), "2027-08-21": H("SH","Ninoy Aquino Day"),
  "2027-11-01": H("SH","All Saints' Day"), "2027-11-02": H("SH","All Souls' Day"), "2027-12-08": H("SH","Immaculate Conception"),
  "2027-12-24": H("SH","Christmas Eve"), "2027-12-31": H("SH","Last Day of the Year")
};
// Add anything announced later, e.g. "2027-03-10": ["RH", "Eid'l Fitr"]. These win over everything else.
const EXTRA = {};

const p2 = (n) => String(n).padStart(2, "0");
const isoOf = (d) => d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
const parseLocal = (iso) => { const [y, mo, d] = iso.split("-").map(Number); return new Date(y, mo - 1, d); };
const nthDow = (y, mo, dow, n) => {
  if (n > 0) return 1 + ((dow - new Date(y, mo, 1).getDay() + 7) % 7) + (n - 1) * 7;
  const l = new Date(y, mo + 1, 0); return l.getDate() - ((l.getDay() - dow + 7) % 7);
};
const usCache = {};
function usYear(y) {
  if (usCache[y]) return usCache[y];
  const f = (mo, d) => y + "-" + p2(mo + 1) + "-" + p2(d);
  return (usCache[y] = {
    [f(0, 1)]: "New Year's Day (US)", [f(0, nthDow(y, 0, 1, 3))]: "MLK Day", [f(1, nthDow(y, 1, 1, 3))]: "Presidents' Day",
    [f(4, nthDow(y, 4, 1, -1))]: "Memorial Day", [f(5, 19)]: "Juneteenth", [f(6, 4)]: "Independence Day (US)",
    [f(8, nthDow(y, 8, 1, 1))]: "Labor Day (US)", [f(9, nthDow(y, 9, 1, 2))]: "Columbus Day", [f(10, 11)]: "Veterans Day",
    [f(10, nthDow(y, 10, 4, 4))]: "Thanksgiving", [f(11, 25)]: "Christmas (US)"
  });
}
// us = whether this person is paid for US holidays (a setting in the planner)
function holidayOf(iso, us) {
  if (EXTRA[iso]) return EXTRA[iso];
  if (PH[iso] && PH[iso][0] === "RH") return PH[iso];
  if (us) { const u = usYear(Number(iso.slice(0, 4)))[iso]; if (u) return ["UH", u]; }
  return PH[iso] || null;
}

// What one worked day adds to each row, in that row's unit (days, or hours for the HOURLY rows).
// A holiday row with a multiplier under 100% is a premium on top of a normal day, so that day also counts as BASIC.
// A holiday row at 100% or more is the whole day's pay, so that day replaces BASIC.
function dayCounts(shift, type) {
  const p = S.profile, hpd = Number(p.hpd) || 8;
  const tm = (t) => { const [h, mi] = String(t || "0:0").split(":").map(Number); return h * 60 + mi; };
  const s = tm(shift.start); let e = tm(shift.end); if (e <= s) e += 1440;
  const total = Math.max(0, (e - s) / 60 - (Number(shift.brk) || 0));
  let night = 0; // 10 PM – 6 AM
  [[0, 360], [1320, 1800], [2760, 3240]].forEach(([a, b]) => { night += Math.max(0, Math.min(e, b) - Math.max(s, a)); });
  const reg = Math.min(total, hpd), ot = Math.max(0, total - hpd);
  const nightReg = Math.min(night / 60, reg);
  const inUnit = (k, hrs) => (HOURLY.has(k) ? hrs : hrs / hpd);
  const o = {};
  const add = (k, v) => { if (v) o[k] = (o[k] || 0) + v; };
  if (!type) { add("BASIC", reg / hpd); add("EVENING", inUnit("EVENING", nightReg)); add("OT", ot); return o; }
  add(type, reg / hpd);
  if ((Number(p.mult[type]) || 0) < 100) add("BASIC", reg / hpd);
  const eve = type === "RH" ? "E/RH" : type === "UH" ? "E/UH" : "EVENING";
  add(eve, inUnit(eve, nightReg));
  add(type === "RH" ? "OT/RH" : "OT", ot);
  return o;
}

let cal = null;
function calTotals() {
  const t = {}; Object.keys(LABEL).forEach((k) => (t[k] = 0));
  let worked = 0;
  if (cal.start && cal.end) {
    for (let d = parseLocal(cal.start), end = parseLocal(cal.end); d <= end; d.setDate(d.getDate() + 1)) {
      const iso = isoOf(d);
      if (cal.off.has(iso)) continue;
      worked++;
      const h = holidayOf(iso, cal.us);
      const o = dayCounts(cal.shift, h ? h[0] : null);
      for (const k in o) t[k] += o[k];
    }
  }
  Object.keys(t).forEach((k) => (t[k] = round2(t[k])));
  return { t, worked };
}

function openPlanner() {
  const pr = S.profile, per = S.period;
  const first = per.start ? parseLocal(per.start) : new Date();
  cal = {
    start: per.start || "", end: per.end || "",
    off: new Set(per.start && per.end ? per.off || [] : []),
    month: new Date(first.getFullYear(), first.getMonth(), 1),
    shift: { start: "10:00", end: "18:00", brk: 0, ...(pr.shift || {}) },
    us: pr.usHol !== false
  };
  drawCal();
}
function closeCal() { const mo = $("#modal"); mo.classList.remove("open"); mo.innerHTML = ""; mo.onchange = null; cal = null; }

function drawCal() {
  const mo = $("#modal");
  const y = cal.month.getFullYear(), mn = cal.month.getMonth();
  const lead = new Date(y, mn, 1).getDay(), days = new Date(y, mn + 1, 0).getDate();
  const step = !cal.start ? "Tap the first day of the cut-off" : !cal.end ? "Now tap the last day" : "Tap the days you're off. Tap outside the range to start over.";
  let cells = "";
  for (let i = 0; i < lead; i++) cells += "<span></span>";
  for (let d = 1; d <= days; d++) {
    const iso = y + "-" + p2(mn + 1) + "-" + p2(d);
    const inRange = cal.start && (cal.end ? iso >= cal.start && iso <= cal.end : iso === cal.start);
    const edge = iso === cal.start || iso === cal.end;
    const off = cal.off.has(iso);
    const h = holidayOf(iso, cal.us);
    const tag = h ? `<small>${h[0] === "UH" ? "US" : h[0]}</small>` : "";
    cells += `<button class="cal-day${inRange ? " in" : ""}${edge ? " edge" : ""}${off ? " off" : ""}${h ? " h-" + h[0] : ""}" data-d="${iso}" ${h ? `title="${esc(h[1])}"` : ""} aria-label="${esc(niceDate(iso) + (h ? ", " + h[1] : "") + (off ? ", day off" : ""))}">${d}${tag}</button>`;
  }
  const { t, worked } = calTotals();
  const sum = Object.keys(LABEL).filter((k) => t[k]).map((k) => `<span class="pill">${esc(k)} ${t[k]}${HOURLY.has(k) ? "h" : "d"}</span>`).join(" ");
  const sh = cal.shift;
  mo.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="Plan this pay period">
    <h3>Plan this pay period</h3>
    <div class="muted" style="margin-bottom:8px">${step}</div>
    <div class="cal-nav">
      <button class="btn ghost" data-c="prev" aria-label="Previous month">‹</button>
      <b>${cal.month.toLocaleDateString("en-PH", { month: "long", year: "numeric" })}</b>
      <button class="btn ghost" data-c="next" aria-label="Next month">›</button>
    </div>
    <div class="cal">${["S","M","T","W","T","F","S"].map((x) => `<em>${x}</em>`).join("")}${cells}</div>
    <div class="muted" style="font-size:12.5px;margin-top:8px">RH regular · SH special${cal.us ? " · US holiday" : ""}. Crossed-out days are days off.</div>
    ${cal.end ? `<div style="margin-top:10px;font-size:13.5px"><b>${worked}</b> day${worked === 1 ? "" : "s"} worked · <b>${cal.off.size}</b> off</div>
      <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">${sum || '<span class="muted">No worked days</span>'}</div>` : ""}
    <div class="cal-shift">
      <label>Shift start<input type="time" data-s="start" value="${esc(sh.start)}"></label>
      <label>Shift end<input type="time" data-s="end" value="${esc(sh.end)}"></label>
      <label>Unpaid break (h)<input type="number" step="0.25" min="0" data-s="brk" value="${esc(sh.brk)}"></label>
    </div>
    <label class="cal-check"><input type="checkbox" data-s="us" ${cal.us ? "checked" : ""}> I’m paid for US holidays</label>
    <div class="actions">
      <button class="btn ghost" data-c="reset">Reset</button>
      <button class="btn ghost" data-c="close">Cancel</button>
      <button class="btn" data-c="apply" ${cal.end ? "" : "disabled"}>Use these days</button>
    </div>
  </div>`;
  mo.classList.add("open");
  mo.onclick = (e) => {
    if (e.target === mo) return closeCal();
    const dayEl = e.target.closest("[data-d]"), c = e.target.closest("[data-c]");
    if (dayEl) {
      const iso = dayEl.dataset.d;
      if (!cal.start) cal.start = iso;
      else if (!cal.end) { if (iso < cal.start) cal.start = iso; else cal.end = iso; }
      else if (iso >= cal.start && iso <= cal.end) { cal.off.has(iso) ? cal.off.delete(iso) : cal.off.add(iso); }
      else { cal.start = iso; cal.end = ""; cal.off.clear(); }
      drawCal();
    } else if (c) {
      const a = c.dataset.c;
      if (a === "prev") { cal.month = new Date(y, mn - 1, 1); drawCal(); }
      else if (a === "next") { cal.month = new Date(y, mn + 1, 1); drawCal(); }
      else if (a === "reset") { cal.start = ""; cal.end = ""; cal.off.clear(); drawCal(); }
      else if (a === "close") closeCal();
      else if (a === "apply") {
        const { t, worked } = calTotals();
        S.period = { ...S.period, start: cal.start, end: cal.end, off: [...cal.off].sort() };
        S.hours = t;
        S.profile.shift = { ...cal.shift };
        S.profile.usHol = cal.us;
        note("Planned " + niceDate(cal.start) + " – " + niceDate(cal.end) + " · " + worked + " days worked, " + cal.off.size + " off");
        closeCal(); commit();
        toast("Pay period and hours filled in.");
      }
    }
  };
  mo.onchange = (e) => {
    const k = e.target.dataset.s; if (!k) return;
    if (k === "us") cal.us = e.target.checked;
    else cal.shift[k] = e.target.value;
    drawCal();
  };
}

load();
