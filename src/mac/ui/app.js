// Product Review's window, on macOS and Windows alike, drawn like Windows 10 classic controls; the work itself runs
// in PowerShell through server.mjs.
"use strict";

// ---------- helpers ----------
const modelInfo = { claude: {}, codex: "" };
const isFlow = (v) => v === "agent" || v === "agent-agy"; // Tạo ảnh: Claude (Flow) or Antigravity (Flow), both are the Flow run
const api = async (cmd, args = {}) => {
  const r = await fetch("/api/rpc", { method: "POST", body: JSON.stringify({ cmd, args }) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body.result;
};
// PowerShell unrolls one-item arrays; lists always come back as arrays here.
const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const fileUrl = (p) => `/file?path=${encodeURIComponent(p)}&t=${Date.now()}`;

function el(tag, cls = "", props = {}) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") e.textContent = v;
    else if (k === "style") Object.assign(e.style, v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e[k] = v;
  }
  return e;
}
// left, top, width, height (px), plus right/bottom for anchored edges, like WinForms Location/Size/Anchor.
function at(e, l, t, w, h, anchor = {}) {
  const s = e.style;
  if (anchor.right != null) { s.right = anchor.right + "px"; if (anchor.left !== false) s.left = l + "px"; else s.width = w + "px"; }
  else { s.left = l + "px"; if (w != null) s.width = w + "px"; }
  if (anchor.bottom != null) { s.bottom = anchor.bottom + "px"; if (anchor.top !== false) s.top = t + "px"; else s.height = h + "px"; }
  else { s.top = t + "px"; if (h != null) s.height = h + "px"; }
  if (anchor.right != null && anchor.left !== false) s.removeProperty("width");
  if (anchor.bottom != null && anchor.top !== false) s.removeProperty("height");
  return e;
}
const label = (text, cls = "") => el("div", "label " + cls, { text });
const button = (text, primary = false) => el("button", "btn" + (primary ? " primary" : ""), { text, type: "button" });
function picture(cls = "") {
  const p = el("div", "pic " + cls);
  const img = el("img");
  img.hidden = true;
  p.append(img);
  p.set = (path, emptyText = "") => {
    p.querySelector(".empty")?.remove();
    p.classList.toggle("has", !!path);
    img.hidden = !path;
    if (path) { img.src = fileUrl(path); img.onerror = () => { img.hidden = true; }; }
    else if (emptyText) p.append(el("div", "empty", { text: emptyText }));
  };
  // A small × on hover removes the shown image (Add-RemoveOverlay).
  p.onRemove = (fn) => { const x = el("div", "x", { text: "×" }); x.addEventListener("click", (e) => { e.stopPropagation(); fn(); }); p.append(x); };
  return p;
}
function numeric(min, max, value) {
  const box = el("div", "num");
  const input = el("input", "", { value: String(value) });
  const spin = el("div", "spin");
  const up = el("button", "up", { type: "button" }), down = el("button", "down", { type: "button" });
  spin.append(up, down);
  box.append(input, spin);
  const clamp = (v) => Math.max(box.min, Math.min(box.max, Number.isFinite(v) ? Math.round(v) : box.min));
  Object.assign(box, { min, max });
  Object.defineProperty(box, "value", { get: () => clamp(Number(input.value)), set: (v) => { input.value = String(clamp(v)); } });
  Object.defineProperty(box, "enabled", { set: (on) => { input.disabled = !on; up.disabled = !on; down.disabled = !on; box.classList.toggle("disabled", !on); } });
  up.onclick = () => { box.value = box.value + 1; box.onchange?.(); };
  down.onclick = () => { box.value = box.value - 1; box.onchange?.(); };
  input.onchange = () => { box.value = box.value; box.onchange?.(); };
  input.onblur = () => { box.value = Number(input.value); };
  return box;
}
function combo(items = []) {
  const s = el("select", "combo");
  s.setItems = (values, labels = values) => { s.replaceChildren(...values.map((v, i) => new Option(labels[i], v))); };
  s.setItems(items);
  return s;
}
function checkbox(text) {
  const wrap = el("label", "check");
  const input = el("input", "", { type: "checkbox" });
  wrap.append(input, document.createTextNode(text));
  wrap.input = input;
  return wrap;
}
// Pick image files from disk; each one is uploaded so PowerShell gets a real file path.
async function upload(file) {
  const r = await fetch(`/api/upload?name=${encodeURIComponent(file.name || "clipboard.png")}`, { method: "POST", body: file });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error);
  return body.path;
}
const imageFiles = (items) => [...items].filter((f) => /^image\/(png|jpeg)$/.test(f.type));

// Errors in this window are logged on the Mac side (workspace/logs/app-errors.log) and go into Báo lỗi.
const reportError = (message, stack) => fetch("/api/client-error", { method: "POST", body: JSON.stringify({ message: String(message || ""), stack: String(stack || "") }) }).catch(() => {});
addEventListener("error", (e) => reportError(e.message, e.error?.stack || `${e.filename}:${e.lineno}:${e.colno}`));
addEventListener("unhandledrejection", (e) => reportError(e.reason?.message || e.reason, e.reason?.stack));

// A product link as the list shows it, short and readable (Format-ShortProductUrl on Windows).
function shortUrl(link) {
  let u;
  try { u = new URL(link.trim()); } catch { return link.trim(); }
  if (u.hostname === "local.invalid") return "Sản phẩm tự thêm (không có link)";
  const site = u.hostname.replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (!parts.length) return site;
  let name = decodeURIComponent(parts.at(-1)).replace(/\.(html?|php|aspx?)$/, "");
  if (name.length > 32) name = name.slice(0, 31) + "…";
  return `${site} › ${name}`;
}

// ---------- fit to the window ----------
// Laid out for 1024 x 721 at least (#client). A smaller window scales the whole page down to fit instead of cutting
// it off; below 60% it stops shrinking and scrolls. Child windows are centred in the page's own (scaled) size.
let zoom = 1;
const viewWidth = () => innerWidth / zoom, viewHeight = () => innerHeight / zoom;
function fitWindow() {
  zoom = Math.max(0.6, Math.min(1, innerWidth / 1024, innerHeight / 721));
  document.documentElement.style.zoom = zoom === 1 ? "" : String(zoom);
  document.body.style.overflow = viewWidth() < 1023 || viewHeight() < 720 ? "auto" : "";
}
fitWindow();
addEventListener("resize", fitWindow);

// ---------- child windows ----------
const stack = [];
function openWindow(title, w, h, { white = false } = {}) {
  const modal = el("div", "modal");
  const win = el("div", "window");
  const bar = el("div", "titlebar");
  const close = el("button", "close", { text: "✕", type: "button" });
  bar.append(el("div", "t", { text: title }), close);
  const body = el("div", "wbody" + (white ? " white" : ""));
  body.style.width = w + "px";
  body.style.height = h + "px";
  win.append(bar, body);
  modal.append(win);
  document.body.append(modal);
  const place = () => {
    win.style.left = Math.max(0, Math.round((viewWidth() - win.offsetWidth) / 2)) + "px";
    win.style.top = Math.max(0, Math.round((viewHeight() - win.offsetHeight) / 2)) + "px";
  };
  place();
  const view = { body, win, onClose: null, closed: false, cancel: null };
  view.close = () => {
    if (view.closed) return;
    view.closed = true;
    modal.remove();
    stack.splice(stack.indexOf(view), 1);
    updateActionAvailability();
    view.onClose?.();
  };
  close.onclick = () => (view.cancel || view.close)();
  stack.push(view);
  updateActionAvailability();
  return view;
}
addEventListener("keydown", (e) => {
  const top = stack.at(-1);
  if (e.key === "Escape" && top) { e.preventDefault(); (top.cancel || top.close)(); }
});
// ContextMenuStrip shown under a button: [{ text, disabled, onClick }]; a click elsewhere closes it.
function dropMenu(anchor, items) {
  const menu = el("div", "menu");
  const done = () => { menu.remove(); removeEventListener("mousedown", outside, true); removeEventListener("keydown", escape, true); };
  const outside = (e) => { if (!menu.contains(e.target)) done(); };
  const escape = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); done(); } };
  for (const item of items) {
    const row = el("div", item.disabled ? "off" : "", { text: item.text });
    if (!item.disabled) row.onclick = () => { done(); item.onClick(); };
    menu.append(row);
  }
  // Screen positions are scaled by the page's zoom (fitWindow); the menu's are not.
  const r = anchor.getBoundingClientRect();
  Object.assign(menu.style, { left: r.left / zoom + "px", top: r.bottom / zoom + "px" });
  document.body.append(menu);
  addEventListener("mousedown", outside, true);
  addEventListener("keydown", escape, true);
}
// MessageBox.Show: resolves "OK", "Yes" or "No".
function messageBox(text, title = "", buttons = ["OK"], labels = {}) {
  return new Promise((resolve) => {
    const view = openWindow(title, 0, 0);
    view.win.classList.add("msg");
    view.body.style.width = view.body.style.height = "";
    const bar = el("div", "bar");
    const names = { OK: "OK", Yes: "Yes", No: "No", ...labels };
    let answer = buttons.includes("No") ? "No" : "OK";
    for (const b of buttons) {
      const btn = el("button", "btn", { text: names[b], type: "button" });
      btn.onclick = () => { answer = b; view.close(); };
      bar.append(btn);
    }
    view.body.append(el("div", "txt", { text }), bar);
    view.onClose = () => resolve(answer);
    view.win.style.minWidth = "180px";
    view.win.style.left = Math.round((viewWidth() - view.win.offsetWidth) / 2) + "px";
    view.win.style.top = Math.round((viewHeight() - view.win.offsetHeight) / 2) + "px";
    bar.firstChild.focus();
  });
}

// ---------- main window ----------
const ui = { client: document.getElementById("client") };
const state = { rows: [], fallback: false, library: "remote", group: "Áo", version: "", output: "", codex: false };
const run = { active: false, since: 0, total: 0, done: 0, index: 0, stages: new Map(), jobRows: [], stage: "", stopped: false, failure: false, started: 0, resultFolder: "", anim: 0 };

function buildMain() {
  const c = ui.client;
  // Header (Dock Top, 64).
  const header = at(el("div", "panel"), 0, 0, null, 64, { right: 0 });
  header.append(at(label("Product Review", ""), 20, 19, null, 26));
  header.firstChild.style.fontSize = "17.33px";
  ui.btnUpdate = at(button("Cập nhật"), null, 16, 100, 32, { right: 24, left: false });
  // Cấu hình (core/setup), left of Cập nhật.
  ui.btnSetup = at(button("Cấu hình"), null, 16, 100, 32, { right: 132, left: false });
  // Tải về máy runs in the background (src/sync-source.ps1); its progress shows here, in the header, so work goes on.
  ui.syncLabel = at(label("", "muted"), 260, 14, null, 22, { right: 446 });
  ui.syncLabel.style.textAlign = "right";
  ui.syncBar = at(el("div", "progress"), null, 40, 200, 4, { right: 446, left: false });
  ui.syncBar.append(el("span"));
  ui.syncLabel.hidden = ui.syncBar.hidden = true;
  // Tải lại: this tool's server starts again on the files as they are now and the page loads afresh.
  ui.btnReload = at(button("Tải lại"), null, 16, 90, 32, { right: 240, left: false });
  // Sessions (several windows from one source, core/setup/session.mjs): the badge tells which window this is (number, session, Chrome profile)
  // and which Chrome tab group the next run will open, so a window can be matched to its tab group.
  ui.btnSessions = at(button("Các phiên"), null, 16, 100, 32, { right: 338, left: false });
  // "Các phiên" panel, minimal: ONE labelled combo of projects (+ "Phiên mặc định") and ONE button that opens that project's own window, or focuses it
  // when it is already open. Closes on a click outside, Esc and right after a window is opened.
  ui.sessionsPanel = at(el("div", "card"), null, 52, 300, null, { right: 24, left: false });
  Object.assign(ui.sessionsPanel.style, { zIndex: "30", display: "none", padding: "12px", background: "var(--surface)", border: "1px solid var(--line)" });
  const pickLabel = el("div", "muted", { text: "Dự án" }); Object.assign(pickLabel.style, { fontSize: "10px", marginBottom: "2px" });
  ui.sessionPick = combo();
  Object.assign(ui.sessionPick.style, { position: "static", display: "block", width: "100%", height: "32px", marginBottom: "8px" });
  // A typed name opens a BLANK session (not tied to a project): shown only when the last entry "＋ Phiên mới (đặt tên)…" is picked.
  ui.newNameBox = el("div"); Object.assign(ui.newNameBox.style, { display: "none", marginBottom: "8px" });
  const nameLabel = el("div", "muted", { text: "Tên phiên mới" }); Object.assign(nameLabel.style, { fontSize: "10px", marginBottom: "2px" });
  ui.sessionName = el("input", "text", { placeholder: "vd: grenheim-2", maxlength: "30" });
  Object.assign(ui.sessionName.style, { position: "static", display: "block", width: "100%", height: "32px" });
  ui.nameHint = el("div", "muted", { text: "Chữ thường a-z, số 0-9 và dấu -, tối đa 30 ký tự." }); Object.assign(ui.nameHint.style, { fontSize: "10px", marginTop: "3px", minHeight: "14px" });
  ui.newNameBox.append(nameLabel, ui.sessionName, ui.nameHint);
  ui.btnSessionOpen = button("Mở cửa sổ", true);
  Object.assign(ui.btnSessionOpen.style, { position: "static", display: "block", width: "100%", height: "32px" });
  // what is open right now (read-only, from live data): shown above the combo
  ui.openLine = el("div", "muted"); Object.assign(ui.openLine.style, { fontSize: "10px", marginBottom: "8px", display: "none", lineHeight: "1.35" });
  ui.sessionsPanel.append(ui.openLine, pickLabel, ui.sessionPick, ui.newNameBox, ui.btnSessionOpen);
  ui.openNames = new Set(); // names of the windows open now (sessions and projects), for the live check of a typed name
  ui.projectIds = new Set();
  const NAME_RE = /^[a-z0-9][a-z0-9-]{0,29}$/;
  // "" = fine, else the red hint
  const nameProblem = () => {
    const v = ui.sessionName.value.trim();
    if (!v) return "Nhập tên phiên.";
    if (!NAME_RE.test(v)) return "Tên không hợp lệ: chỉ a-z, 0-9 và -, bắt đầu bằng chữ hoặc số, tối đa 30 ký tự.";
    if (ui.openNames.has(v)) return "Phiên \"" + v + "\" đang mở.";
    if (ui.projectIds.has(v)) return "Trùng tên một dự án: chọn dự án trong danh sách.";
    return "";
  };
  const pickedInfo = () => ui.sessionPick.selectedOptions[0]?._info || null;
  const refreshPickButton = ui.refreshPickButton = () => { // also on ui: loadSessionPicker (outside this scope) calls it
    const info = pickedInfo(), isNew = !!info && info.value === "__new";
    ui.newNameBox.style.display = isNew ? "" : "none";
    if (isNew) {
      const problem = nameProblem();
      ui.nameHint.textContent = ui.sessionName.value.trim() && problem ? problem : "Chữ thường a-z, số 0-9 và dấu -, tối đa 30 ký tự.";
      ui.nameHint.style.color = ui.sessionName.value.trim() && problem ? "var(--error)" : "var(--muted)";
      ui.sessionName.style.borderColor = ui.sessionName.value.trim() && problem ? "var(--error)" : "";
      ui.btnSessionOpen.textContent = "Mở cửa sổ"; ui.btnSessionOpen.disabled = !!problem; ui.btnSessionOpen.title = problem;
      return;
    }
    ui.btnSessionOpen.textContent = "Mở cửa sổ";
    ui.btnSessionOpen.disabled = !info || !!info.disabled;
    ui.btnSessionOpen.title = !info ? "Không còn dự án rảnh" : info.disabled ? info.reason || "" : "";
  };
  // The server answers { ok, session }: success only when it opened exactly what was asked for.
  const openPicked = async () => {
    const info = pickedInfo();
    if (!info || info.disabled) return;
    let body, expected;
    if (info.value === "__new") { if (nameProblem()) return; expected = ui.sessionName.value.trim(); body = { name: expected }; }
    else if (info.value === "__default") { expected = ""; body = { name: "" }; }
    else { expected = info.value; body = { project: info.value }; }
    ui.btnSessionOpen.disabled = true;
    const res = await fetch("/api/sessions/open", { method: "POST", body: JSON.stringify(body) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    if (res.error) { refreshPickButton(); return messageBox(res.error); }
    if (!res.ok || res.session !== expected) { refreshPickButton(); return messageBox("Máy chủ mở cửa sổ khác với dự án đã chọn (" + (res.session === undefined ? "không rõ" : res.session || "phiên mặc định") + "). Chưa mở."); }
    try { localStorage.setItem("pr.sessions.last", info.value === "__new" ? "" : info.value); } catch {}
    ui.sessionName.value = "";
    ui.sessionsPanel.style.display = "none";
    loadSessionPicker(); // the new window shows as disabled "· đang mở #n" as soon as it has registered
  };
  ui.sessionPick.onchange = () => { const info = pickedInfo(); if (info && !info.disabled && info.value !== "__new") { try { localStorage.setItem("pr.sessions.last", info.value); } catch {} } refreshPickButton(); if (info && info.value === "__new") ui.sessionName.focus(); };
  ui.sessionPick.ondblclick = openPicked;
  ui.sessionPick.addEventListener("keydown", (e) => { if (e.key === "Enter") openPicked(); });
  ui.sessionName.addEventListener("input", refreshPickButton);
  ui.sessionName.addEventListener("keydown", (e) => { if (e.key === "Enter") openPicked(); });
  ui.btnSessionOpen.onclick = openPicked;
  ui.btnSessions.onclick = () => { const open = ui.sessionsPanel.style.display !== "none"; ui.sessionsPanel.style.display = open ? "none" : ""; if (!open) loadSessionPicker(); };
  document.addEventListener("mousedown", (e) => { if (ui.sessionsPanel.style.display !== "none" && !ui.sessionsPanel.contains(e.target) && e.target !== ui.btnSessions) ui.sessionsPanel.style.display = "none"; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") ui.sessionsPanel.style.display = "none"; });
  header.append(ui.btnReload, ui.btnSetup, ui.btnUpdate, ui.syncLabel, ui.syncBar, ui.btnSessions, ui.sessionsPanel);


  // Link sản phẩm & ảnh (20,78 820x376, Top/Left/Right).
  const cardList = at(el("div", "card"), 20, 78, null, 376, { right: 264 });
  cardList.append(at(label("Link sản phẩm & ảnh"), 14, 10, null, 20));
  const editor = at(el("div", "panel"), 14, 36, null, 328, { right: 14 });
  ui.btnAdd = at(button("+ Thêm sản phẩm", true), 0, 0, 160, 34);
  ui.btnBulk = at(button("Nhập hàng loạt"), 172, 0, 150, 34);
  ui.btnClear = at(button("Xóa tất cả"), 334, 0, 120, 34);
  ui.btnProjects = at(button("Dự án"), 466, 0, 120, 34);
  ui.flow = at(el("div", "flow"), 0, 44, null, null, { right: 0, bottom: 0 });
  Object.assign(ui.flow.style, { background: "#fff", border: "1px solid #000", padding: "10px 10px 6px 10px" });
  editor.append(ui.btnAdd, ui.btnBulk, ui.btnClear, ui.btnProjects, ui.flow);
  cardList.append(editor);

  // Thao tác (856,78 224x376, Top/Right).
  const cardActions = at(el("div", "card"), null, 78, 224, 376, { right: 24, left: false });
  cardActions.append(at(label("Thao tác"), 14, 10, null, 20));
  // In the order they are used: review the results, open them, then support. Cấu hình is in the header.
  const names = [["btnReview", "Duyệt & xuất file"], ["btnOut", "Mở kết quả"], ["btnLogs", "Báo lỗi"], ["btnClearLog", "Xóa thông báo"]];
  names.forEach(([key, text], i) => { ui[key] = at(button(text), 14, 36 + i * 37, 196, 32); cardActions.append(ui[key]); });
  // Claude (Flow) only: its own Chrome profile must be signed in to Google Flow (workspace/chrome-profile, signed in by hand).
  // No text lines: the sign-in state is a dot inside the "Mở Chrome để đăng nhập" button (green = signed in, red = signed out, grey = checking / busy / unknown);
  // the message is its tooltip. Both buttons always stay.
  // Same 37 px step as the buttons above (36 + 4 * 37): the gap between all buttons is equal.
  // Second group of the card, a thin divider away from the result buttons: Chrome profile, Tài khoản Flow, then the sign-in button (and Kiểm tra lại in own-Chrome mode).
  ui.flowLoginBox = at(el("div", "abs"), 0, 36 + names.length * 37, 224, 182);
  { const divider = at(el("div", "abs"), 14, 0, 196, 1); divider.style.background = "var(--line)"; ui.flowDivider = divider; }
  ui.btnFlowOpen = at(button("Mở Chrome để đăng nhập"), 14, 110, 196, 32);
  ui.btnFlowCheck = at(button("Kiểm tra lại"), 14, 147, 196, 32);
  ui.flowDot = el("span", "", { style: { display: "inline-block", width: "7px", height: "7px", borderRadius: "50%", marginRight: "6px", verticalAlign: "middle", background: "var(--muted)" } });
  ui.btnFlowOpen.prepend(ui.flowDot);
  // Which signed-in Google account Flow uses (the profile may hold several; Flow opens the first, which can be the one out of credits).
  ui.lblFlowAccount = at(label("Tài khoản Flow", "muted"), 14, 58, 84, 14);
  ui.lblFlowAccount.style.fontSize = "11px"; ui.lblFlowAccount.style.lineHeight = "14px";
  // The live profile/account check (refreshFlowCheck): a short note on the label row, the full text in its tooltip; never moves anything.
  ui.flowCheck = at(label("", "muted"), 98, 58, 112, 14);
  Object.assign(ui.flowCheck.style, { fontSize: "11px", lineHeight: "14px", textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
  ui.flowAccount = at(combo(), 14, 72, 196, 32);
  ui.flowAccount.title = "Để trống = Flow tự chọn. Danh sách là các tài khoản Google đã đăng nhập trong profile Chrome đang chọn (hoặc Chrome riêng); Claude sẽ chọn đúng tài khoản đó, không đăng xuất, không đổi tài khoản khác. Đổi profile thì tài khoản tự theo profile (profile chỉ 1 tài khoản); vẫn chọn tay được tài khoản khác.";
  ui.flowAccount.setItems([""], ["Tự chọn tài khoản Flow"]);
  // The account list is read from the server: the accounts of the chosen Chrome profile (or of the own Chrome).
  // prev (profile change) = the account chosen before: the account then follows the new profile (followFlowAccount). On load (prev undefined)
  // it only follows when the saved account is not signed in to the saved profile. Either way the person can pick another one by hand after.
  const postFlowAccount = (v) => fetch("/api/run-settings", { method: "POST", body: JSON.stringify({ flowAccount: v }) }).catch(() => {});
  const loadFlowAccounts = (prev) => fetch("/api/run-settings").then((r) => r.json()).then(async (saved) => {
    let cur = String(saved.flowAccount || "").toLowerCase();
    await ui.flowBrowserReady;
    const p = flowProfile();
    if (p) {
      const accounts = (p.accounts || []).map((a) => String(a).toLowerCase());
      const was = prev === undefined ? cur : prev, want = followFlowAccount(accounts, was);
      if (prev !== undefined || (cur && !accounts.includes(cur))) {
        if (want !== cur) await postFlowAccount(want); // the server may have aligned it already (alignFlowAccount)
        cur = want;
        if (want !== was) appendLog(want ? `Tài khoản Flow tự theo profile ${p.folder}: ${want}${was ? " (trước: " + was + ")" : ""}. Muốn tài khoản khác thì chọn ở ô Tài khoản Flow.`
          : `Profile ${p.folder} có ${accounts.length} tài khoản Google: chưa chọn tài khoản Flow${was ? " (bỏ " + was + ": không đăng nhập trong profile này)" : ""}. Chọn ở ô Tài khoản Flow.`);
      }
    }
    const list = [...new Set([...(saved.flowAccounts || []), ...(cur ? [cur] : [])])];
    ui.flowAccount.setItems(["", ...list], ["Tự chọn tài khoản Flow", ...list]);
    ui.flowAccount.value = cur;
    ui.flowAccount.title = ui.flowAccount.value || "Tự chọn tài khoản Flow";
    ui.flowAccountSaved = ui.flowAccount.value;
    refreshFlowCheck();
  }).catch(() => {});
  ui.flowAccountSaved = "";
  ui.flowAccount.onchange = () => { const v = ui.flowAccount.value.trim(); ui.flowAccount.title = v || "Tự chọn tài khoản Flow"; refreshFlowCheck(); if (v === ui.flowAccountSaved) return; ui.flowAccountSaved = v; postFlowAccount(v); };
  // Which browser Claude (Flow) drives: "own" = the tool's own Chrome, or a Chrome profile installed on this machine (everyday Chrome through the Playwright extension).
  ui.lblFlowBrowser = at(label("Chrome profile", "muted"), 14, 8, 100, 14);
  ui.lblFlowBrowser.style.fontSize = "11px"; ui.lblFlowBrowser.style.lineHeight = "14px";
  ui.flowBrowser = at(combo(), 14, 22, 196, 32);
  ui.flowBrowser.title = "Trình duyệt cho Claude (Flow): Chrome thật của bạn (chọn profile có sẵn trên máy, cần extension Playwright, bấm Connect mỗi lượt) hoặc Chrome riêng của tool.";
  ui.flowBrowser.setItems([""], ["Đang đọc profile…"]);
  // Only an explicit change that really differs from the SAVED value is saved (a mouse wheel on a focused list must never change it);
  // after every load the list shows the saved choice. Profiles without the extension can be given it from the button below.
  ui.flowBrowserSaved = ""; ui.flowBrowserProfiles = [];
  ui.flowBrowser.addEventListener("wheel", (e) => { if (document.activeElement === ui.flowBrowser) e.preventDefault(); }, { passive: false });
  ui.btnInstallExt = at(button("Cài extension"), 112, 6, 98, 18);
  Object.assign(ui.btnInstallExt.style, { fontSize: "10px", padding: "0 4px", lineHeight: "16px", minHeight: "0" });
  ui.btnInstallExt.title = "Cài extension vào profile này: mở trang Playwright MCP Bridge trên Chrome Web Store trong đúng profile đã chọn. Bạn tự bấm Thêm vào Chrome; tool không cài thay.";
  ui.btnInstallExt.hidden = true;
  // Optional Playwright extension token of the chosen profile (extension mode, profile with the extension): saved = runs connect without the Connect click.
  // It sits in the slot of "Kiểm tra lại" (that button exists only in own-Chrome mode). The token is never read back: the server only says token_saved.
  // The input, Lưu and Xoá are ALWAYS there and usable (the person may reset the token in the extension and paste a new one over the saved one);
  // "đã lưu token" is only a status on the label row.
  ui.lblToken = at(label("Token Playwright (tùy chọn)", "muted"), 14, 145, 196, 14);
  Object.assign(ui.lblToken.style, { fontSize: "11px", lineHeight: "14px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
  ui.tokenInput = at(el("input", "text", { type: "password", autocomplete: "off", placeholder: "Dán token của profile này" }), 14, 160, 100, 24);
  ui.tokenInput.style.fontSize = "12px";
  ui.btnTokenSave = at(button("Lưu"), 118, 160, 44, 24);
  ui.btnTokenClear = at(button("Xoá"), 166, 160, 44, 24);
  for (const b of [ui.btnTokenSave, ui.btnTokenClear]) Object.assign(b.style, { fontSize: "11px", padding: "0 4px", minHeight: "0", lineHeight: "22px" });
  const refreshTokenRow = () => {
    const p = ui.flowBrowserProfiles.find((x) => x.folder === ui.flowBrowser.value);
    const show = !!p && p.playwright_extension && ui.flowBrowser.value !== "own";
    for (const n of [ui.lblToken, ui.tokenInput, ui.btnTokenSave, ui.btnTokenClear]) n.style.display = show ? "" : "none";
    if (!show) return;
    const saved = !!p.token_saved;
    ui.tokenInput.disabled = ui.btnTokenSave.disabled = ui.btnTokenClear.disabled = false;
    ui.tokenInput.placeholder = saved ? "Dán token mới để thay" : "Dán token của profile này";
    const text = saved ? "Đã lưu token cho " + p.folder + ": chạy không cần bấm Connect. Dán token mới rồi Lưu để thay (khi đã đặt lại token trong extension), Xoá để bỏ" : "Chưa lưu token: mỗi lượt bấm Connect";
    ui.lblToken.title = ui.tokenInput.title = text + ". Token lấy trên trang của extension Playwright MCP Bridge trong đúng profile này (mỗi profile một token riêng).";
    ui.btnTokenSave.title = saved ? "Lưu token mới đè lên token đã lưu" : "Lưu token cho " + p.folder;
    ui.btnTokenClear.title = "Xoá token đã lưu của " + p.folder;
    ui.lblToken.textContent = saved ? "Token Playwright · đã lưu token" : "Token Playwright (tùy chọn)";
  };
  const saveToken = async (token) => {
    const profile = ui.flowBrowser.value;
    const r = await fetch("/api/flow-browser/token", { method: "POST", body: JSON.stringify({ profile, token }) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    ui.tokenInput.value = "";
    if (r.error) return messageBox(r.error);
    const p = ui.flowBrowserProfiles.find((x) => x.folder === profile); if (p) p.token_saved = !!r.token_saved;
    refreshTokenRow();
    messageBox(r.token_saved ? "Đã lưu token cho " + profile + ": chạy không cần bấm Connect." : "Đã xoá token. Chưa lưu token: mỗi lượt bấm Connect.");
  };
  ui.btnTokenSave.onclick = () => { const t = ui.tokenInput.value.trim(); if (t) saveToken(t); else { messageBox("Dán token (trang Playwright MCP Bridge của profile " + ui.flowBrowser.value + ") vào ô rồi bấm Lưu."); ui.tokenInput.focus(); } };
  ui.tokenInput.addEventListener("keydown", (e) => { if (e.key === "Enter") ui.btnTokenSave.click(); });
  ui.btnTokenClear.onclick = () => {
    const p = ui.flowBrowserProfiles.find((x) => x.folder === ui.flowBrowser.value);
    if (p && !p.token_saved) { ui.tokenInput.value = ""; return messageBox("Profile " + p.folder + " chưa lưu token."); }
    if (confirm("Xoá token của " + ui.flowBrowser.value + "? Các lượt sau sẽ cần bấm Connect.")) saveToken("");
  };
  const refreshInstallButton = () => { const p = ui.flowBrowserProfiles.find((x) => x.folder === ui.flowBrowser.value); ui.btnInstallExt.hidden = !p || p.playwright_extension; refreshTokenRow(); };
  const loadFlowBrowser = () => fetch("/api/flow-browser").then((r) => r.json()).then((j) => {
    ui.flowBrowserProfiles = j.profiles || [];
    const items = ["own", ...ui.flowBrowserProfiles.map((p) => p.folder)], labels = ["Chrome riêng của tool", ...ui.flowBrowserProfiles.map((p) => ((p.email || p.name || p.folder).split("@")[0]) + " · " + p.folder + (p.playwright_extension ? "" : " · chưa có extension"))];
    ui.flowBrowser.setItems(items, labels);
    [...ui.flowBrowser.options].forEach((o, i) => { const p = ui.flowBrowserProfiles[i - 1]; o.title = i === 0 ? "Chrome riêng của tool (profile tách biệt)" : (p.email || p.name || p.folder) + " (" + p.folder + ")" + (p.playwright_extension ? "" : " · chưa có extension Playwright MCP Bridge"); });
    ui.flowBrowserSaved = j.mode === "own" ? "own" : j.profile;
    ui.flowBrowser.value = ui.flowBrowserSaved;
    ui.flowBrowser.title = ui.flowBrowser.selectedOptions[0]?.title || "";
    refreshInstallButton(); applyFlowBrowserMode(); refreshFlowCheck();
  }).catch(() => {});
  // Re-read the profiles (accounts, extension, token) without touching the pickers: before a Flow run and when the window gets focus,
  // so signing an account in or out of Chrome shows in the check without reopening the app.
  ui.refreshFlowProfiles = () => fetch("/api/flow-browser").then((r) => r.json()).then((j) => {
    if (Array.isArray(j.profiles)) ui.flowBrowserProfiles = j.profiles;
    refreshInstallButton(); refreshFlowCheck();
  }).catch(() => {});
  addEventListener("focus", () => { if (ui.flowLoginBox.style.display !== "none" && flowExtensionMode()) ui.refreshFlowProfiles(); });
  ui.flowBrowser.onchange = async () => {
    const v = ui.flowBrowser.value;
    ui.flowBrowser.title = ui.flowBrowser.selectedOptions[0]?.title || "";
    refreshInstallButton();
    if (v === ui.flowBrowserSaved) return;
    const r = await fetch("/api/flow-browser", { method: "POST", body: JSON.stringify(v === "own" ? { mode: "own" } : { mode: "extension", profile: v }) }).then((x) => x.ok).catch(() => false);
    // The Flow account follows the new profile (prev = the account chosen before the change).
    if (r) { const prev = ui.flowAccountSaved; ui.flowBrowserSaved = v; refreshSessionBadge(); applyFlowBrowserMode(); refreshFlowCheck(); loadFlowAccounts(prev); } else ui.flowBrowser.value = ui.flowBrowserSaved;
  };
  ui.btnInstallExt.onclick = async () => {
    const r = await fetch("/api/flow-browser/install-extension", { method: "POST", body: JSON.stringify({ profile: ui.flowBrowser.value }) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    if (r.error) messageBox(r.error);
  };
  ui.flowBrowserReady = loadFlowBrowser();
  ui.btnFlowOpen.onclick = openFlowLogin;
  ui.btnFlowCheck.onclick = () => checkFlowLogin(true);
  ui.flowLoginBox.style.display = "none";
  ui.flowLoginBox.append(ui.flowDivider, ui.lblFlowBrowser, ui.flowBrowser, ui.btnInstallExt, ui.lblFlowAccount, ui.flowCheck, ui.flowAccount, ui.btnFlowOpen, ui.btnFlowCheck, ui.lblToken, ui.tokenInput, ui.btnTokenSave, ui.btnTokenClear);
  cardActions.append(ui.flowLoginBox);

  // Run row (20,466 1060x90).
  const cardRun = at(el("div", "card"), 20, 466, null, 90, { right: 24 });
  // Bắt đầu, Chạy tiếp, Dừng, status: all before x=460 where the token / quota labels start.
  ui.btnRun = at(button("Bắt đầu", true), 14, 25, 130, 40);
  // Chạy tiếp: continues the last stopped / unfinished Claude (Flow) run with its own items, context and sign wording.
  ui.btnResume = at(button("Chạy tiếp"), 154, 25, 100, 40);
  ui.btnResume.disabled = true;
  ui.btnStop = at(button("Dừng"), 264, 25, 90, 40);
  ui.btnStop.disabled = true;
  ui.lblStatus = at(label("", "muted"), 366, 32, 90, 26);
  ui.lblStatus.style.lineHeight = "26px";
  // The two pickers and Luồng form one block (2 rows of 22 + 5 gap = 49 px), centered in the 90 px card like the buttons: rows at 20 and 47.
  ui.lblThr = at(label("Luồng:", "muted"), null, 47, 56, 24, { right: 88, left: false });
  ui.numThr = at(numeric(1, 4, 2), null, 44, 64, 24, { right: 22, left: false });
  ui.lblThr.style.lineHeight = "24px";
  // What the next run uses (read-only; model and effort are chosen in Cấu hình): one compact line under the two pickers.
  ui.lblModel = at(label("", "muted"), null, 70, 376, 16, { right: 22, left: false });
  Object.assign(ui.lblModel.style, { fontSize: "11px", lineHeight: "16px", textAlign: "right" });
  // Which AI does the work: Codex, or the sites in the tools' own Chrome (signed in from Cấu hình). Viết review covers
  // every text step; Tạo ảnh the photo. Remembered on this machine.
  const picker = (text, y, key, values, labels) => {
    const name = at(label(text, "muted"), null, y, 76, 22, { right: 316, left: false });
    name.style.lineHeight = "22px";
    const box = at(combo(), null, y, 150, 22, { right: 158, left: false });
    box.setItems(values, labels);
    try { box.value = localStorage.getItem(key) || values[0]; } catch {}
    if (!box.value) box.value = values[0];
    box.onchange = () => {
      try { localStorage.setItem(key, box.value); } catch {}
      // Tạo ảnh: Claude (Flow) and Antigravity (Flow) are the same Flow run driven by a different agent (agentBackend).
      if (key === "imageBackend") { const part = isFlow(box.value) ? { imageBackend: "agent", agentBackend: box.value === "agent-agy" ? "antigravity" : "claude" } : { imageBackend: "codex" }; if (part.agentBackend) modelInfo.claude.agentBackend = part.agentBackend; saveRunSettings(part); }
      else saveRunSettings({ [key]: box.value });
      updateUsage(); updateAgentControls(); refreshModelInfo();
    };
    return [name, box];
  };
  [ui.lblText, ui.cmbText] = picker("Viết review:", 20, "textBackend", ["codex", "antigravity", "claude"], ["Codex", "Antigravity CLI", "Claude"]);
  [ui.lblBackend, ui.cmbBackend] = picker("Tạo ảnh:", 47, "imageBackend", ["codex", "agent", "agent-agy"], ["Codex", "Claude (Flow)", "Antigravity (Flow)"]);
  // Luồng, Viết review and Tạo ảnh are kept in workspace/config/run-settings.json (the server), so they are the same next time.
  const saveRunSettings = (part) => fetch("/api/run-settings", { method: "POST", body: JSON.stringify(part) }).catch(() => {});
  ui.numThr.onchange = () => saveRunSettings({ threads: ui.numThr.value });
  fetch("/api/run-settings").then((r) => r.json()).then((saved) => {
    if (saved.threads) ui.numThr.value = saved.threads;
    modelInfo.claude = saved;
    loadFlowAccounts();
    if (["codex", "antigravity", "claude"].includes(saved.textBackend)) ui.cmbText.value = saved.textBackend;
    if (saved.imageBackend === "agent") ui.cmbBackend.value = saved.agentBackend === "antigravity" ? "agent-agy" : "agent";
    else if (saved.imageBackend === "codex") ui.cmbBackend.value = "codex";
    updateUsage();
    refreshModelInfo();
    updateAgentControls();
    resumeAgent();
  }).catch(() => {});
  // Tokens this run has used (added up from each Codex call) and the quota left, refreshed in the background.
  // They shrink with the window (cut with …) so they never run under the pickers on the right.
  ui.lblTokens = at(label("", "muted"), 460, 25, null, 20, { right: 400 });
  ui.lblQuota = at(label("", "muted"), 460, 45, null, 20, { right: 400 });
  for (const l of [ui.lblTokens, ui.lblQuota]) Object.assign(l.style, { fontSize: "11px", lineHeight: "20px" });
  cardRun.append(ui.btnRun, ui.btnResume, ui.btnStop, ui.lblStatus, ui.lblTokens, ui.lblQuota, ui.lblText, ui.cmbText, ui.lblBackend, ui.cmbBackend, ui.lblThr, ui.numThr, ui.lblModel);

  // Tiến trình & thông báo (20,508 1060x282, all anchors).
  const cardLog = at(el("div", "card"), 20, 568, null, null, { right: 24, bottom: 10 });
  cardLog.append(at(label("Tiến trình & thông báo"), 14, 10, 150, 20));
  // always-visible run line: which feature runs (or ran last), for which project, since when, last step
  ui.runLine = at(label("", "muted"), 170, 10, null, 20, { right: 14 });
  Object.assign(ui.runLine.style, { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: "11px", lineHeight: "20px" });
  cardLog.append(ui.runLine);
  setTimeout(refreshRunLine, 500);
  ui.bar = at(el("div", "progress"), 14, 36, null, 8, { right: 14 });
  ui.bar.append(el("span"));
  ui.lblProgress = at(label("Thêm sản phẩm và ảnh đi kèm để bắt đầu."), 14, 50, null, 24, { right: 14 });
  ui.lblProgress.style.lineHeight = "24px";
  ui.txtLog = at(el("textarea", "text", { readOnly: true }), 14, 80, null, null, { right: 14, bottom: 12 });
  cardLog.append(ui.bar, ui.lblProgress, ui.txtLog);

  c.append(header, cardList, cardActions, cardRun, cardLog);
}

function appendLog(text) { if (text) { ui.txtLog.value += text + "\n"; ui.txtLog.scrollTop = ui.txtLog.scrollHeight; } }
function setStatus(text, color) { ui.lblStatus.textContent = text; ui.lblStatus.style.color = color || "var(--muted)"; }
function countUrls() { return new Set(state.rows.map((r) => r.url.trim()).filter(Boolean)).size; }
function updateStatus() { if (!run.active) setStatus(`Sẵn sàng • ${countUrls()} sản phẩm`); }
function setBar(value, max, marquee = false) {
  ui.bar.classList.toggle("marquee", marquee);
  ui.bar.firstChild.style.width = marquee ? "" : `${Math.min(100, (value / Math.max(1, max)) * 100)}%`;
}

// ----- queue rows (Add-ProductQueueRow / Update-ProductQueueRow) -----
// Link info from PowerShell: products[] (each with scenes[]) plus all scenes flattened.
function normInfo(info) {
  if (!info) return null;
  return { ...info, products: list(info.products).map((p) => ({ ...p, scenes: list(p.scenes) })), scenes: list(info.scenes) };
}
function rowStatus(row) {
  const products = row.info?.products || [], scenes = row.info?.scenes || [];
  const image = products.find((p) => p.ok)?.file || scenes.find((s) => s.ok)?.file || "";
  if (scenes.some((s) => !s.ok) || products.some((p) => p.file && !p.ok)) return { text: "Không đọc được ảnh, hãy gắn lại.", color: "var(--error)", image };
  if (products.some((p) => !p.scenes.length)) return { text: "● Có ảnh gốc chưa có review", color: "var(--warn)", image };
  if (scenes.length) return { text: (products.length > 1 ? `● ${products.length} mẫu · ${scenes.length} ảnh` : scenes.length > 1 ? `● ${scenes.length} ảnh` : "● Đã có ảnh"), color: "var(--ok)", image };
  return row.url.trim() ? { text: "● Chưa có ảnh", color: "var(--warn)", image: "" } : { text: "Chưa có link", color: "var(--muted)", image: "" };
}
// Each row's status label, so a run can update it without rebuilding the row (a rebuild reloads every thumbnail).
let statusOf = new WeakMap();
function renderRows() {
  statusOf = new WeakMap();
  const width = Math.max(700, ui.flow.clientWidth - 40);
  ui.flow.replaceChildren(...state.rows.map((row, i) => {
    const card = el("div", "qrow", { style: { width: width + "px" } });
    const st = row.stage ? { text: row.stage.text, color: row.stage.color } : rowStatus(row);
    const pic = at(picture(), width - 192, 8, 44, 44);
    pic.set(rowStatus(row).image);
    // Wide enough for the longest stage ("◔ Đang tạo ảnh, lượt gửi 1/3").
    const status = at(label(st.text), width - 430, 19, 230, 24);
    status.style.color = st.color;
    status.style.lineHeight = "24px";
    statusOf.set(row, status);
    const open = at(button("Xem / sửa"), width - 136, 12, 90, 34);
    const remove = at(button("×"), width - 40, 12, 32, 34);
    remove.title = "Xóa sản phẩm";
    // Shown short ("shop.com › product-name"); the full link on hover.
    const url = at(el("div", "text plain", { text: shortUrl(row.url) }), 52, 20, width - 487, 22);
    Object.assign(url.style, { lineHeight: "20px", textOverflow: "ellipsis" });
    url.title = row.url.trim();
    card.append(at(label("#" + (i + 1), "muted"), 10, 19, 40, 22), url, status, pic, open, remove);
    card.onclick = (e) => { if (!run.active && e.target !== remove) showProductDialog(row); };
    remove.onclick = (e) => { e.stopPropagation(); if (run.active) return; state.rows.splice(state.rows.indexOf(row), 1); renderRows(); updateStatus(); persist(); };
    // Drop images straight onto the row thumbnail.
    pic.addEventListener("dragover", (e) => e.preventDefault());
    pic.addEventListener("drop", async (e) => {
      e.preventDefault(); e.stopPropagation();
      try {
        const files = imageFiles(e.dataTransfer.files);
        if (!files.length) return;
        const root = await api("draftOpen");
        await api("draftAttach", { root, url: row.url.trim(), paths: await Promise.all(files.map(upload)) });
        row.info = normInfo(await api("draftSave", { root, url: row.url.trim(), others: [], group: state.group }));
        renderRows();
      } catch (err) { row.stage = { text: err.message, color: "var(--error)" }; renderRows(); row.stage = null; }
    });
    return card;
  }));
}

// ----- The run status line (every window, and the Dự án popup): what runs now, else the last finished run -----
const mmss = (s) => String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
const hhmm = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
function runLines(rs) {
  if (!rs) return [];
  if (rs.running && rs.running.length) return rs.running.map((r) => "Đang chạy: " + r.feature + (r.project ? " · " + r.project : "") + " · " + mmss(r.elapsed_s || 0) + (r.last_text ? " · " + r.last_text.replace(/\s+/g, " ").slice(0, 140) : ""));
  const l = rs.last;
  if (!l) return ["Đang rảnh: không có lượt nào đang chạy"];
  const what = l.feature + (l.project ? " · " + l.project : ""), at = " lúc " + hhmm(l.updated || l.started);
  const result = l.status === "done" ? "đã xong" : l.status === "stopped" ? "đã dừng" : "dừng vì lỗi";
  return ["Đang rảnh · Lượt trước: " + what + " · " + result + at + (l.status !== "done" && l.status !== "stopped" && l.error ? " (" + l.error.slice(0, 120) + ")" : "")];
}
async function refreshRunLine() {
  const rs = await fetch("/api/runs/status").then((x) => x.json()).catch(() => null);
  if (!rs || !ui.runLine) return rs;
  const lines = runLines(rs);
  ui.runLine.textContent = lines.join("  |  ");
  ui.runLine.title = lines.join("\n");
  ui.runLine.style.color = rs.running && rs.running.length ? "var(--accent)" : !rs.last ? "var(--muted)" : rs.last.status === "done" ? "var(--ok)" : rs.last.status === "stopped" ? "var(--muted)" : "var(--error)";
  return rs;
}
setInterval(refreshRunLine, 3000);
// ----- Sessions: badge, window title, list of the open windows, "Mở cửa sổ mới" -----
let sessionState = {};
async function refreshSessionBadge() {
  const j = await fetch("/api/session").then((r) => r.json()).catch(() => null);
  if (!j || j.error) return;
  sessionState = j;
  document.title = j.title; // the window title bar: Product Review · #stt · phiên · profile (shown once, nowhere else)
}
async function loadSessionPicker() {
  const [pr, ss] = await Promise.all([fetch("/api/sessions/projects").then((x) => x.json()).catch(() => ({ projects: [] })), fetch("/api/sessions").then((x) => x.json()).catch(() => ({ sessions: [] }))]);
  const projects = pr.projects || [], sessions = (ss.sessions || []).slice().sort((a, b) => a.stt - b.stt);
  ui.openNames = new Set(sessions.map((e) => e.session).filter(Boolean));
  ui.projectIds = new Set(projects.map((p) => p.id));
  // read-only line: the windows that are really alive now
  ui.openLine.textContent = sessions.length ? "Đang mở: " + sessions.map((e) => "#" + e.stt + " " + (e.project_name || e.session || "mặc định") + (e.current ? " (cửa sổ này)" : "")).join(" · ") : "";
  ui.openLine.style.display = sessions.length ? "" : "none";
  // the dropdown lists ONLY what can be opened: free projects (most unused products first), the used-up ones last, then "＋ Phiên mới (đặt tên)…".
  // value = the project id, never parsed from the label. Projects that are open or used by another session are not listed.
  const entry = (value, label, extra = {}) => ({ value, label, disabled: false, ...extra });
  const free = [], usedUp = [];
  for (const p of projects) {
    if (p.window_open || p.busy || p.mine) continue; // held by a window (this one too) or a run: not offered
    const name = p.name || p.id, count = p.scanned ? p.unused + "/" + p.products + " chưa dùng" : "chưa quét";
    if (p.scanned && p.unused === 0) usedUp.push(entry(p.id, name + " · hết (" + count + ")"));
    else free.push(entry(p.id, name + " · " + count, { unused: p.scanned ? p.unused : -1 }));
  }
  free.sort((a, b) => b.unused - a.unused); // stable: equal ones keep the server's recently-used order
  const selectable = [...free, ...usedUp];
  const placeholder = selectable.length ? [] : [entry("", "Không còn dự án rảnh", { disabled: true, placeholder: true })];
  const items = [...placeholder, ...selectable, entry("__new", "＋ Phiên mới (đặt tên)…")];
  ui.sessionPick.replaceChildren(...items.map((it) => { const o = new Option(it.label, it.value); o._info = it; o.disabled = it.disabled; o.title = it.label; return o; }));
  // the project picked last time while it is still listed, else the first free project; nothing free = the placeholder
  let last = ""; try { last = localStorage.getItem("pr.sessions.last") || ""; } catch {}
  const wanted = selectable.find((it) => it.value === last) || free[0] || selectable[0] || items.find((it) => it.placeholder);
  ui.sessionPick.selectedIndex = Math.max(0, items.indexOf(wanted));
  ui.refreshPickButton?.();
}
setInterval(refreshSessionBadge, 5000);

async function loadState() {
  await refreshSessionBadge();
  Object.assign(state, await api("state"));
  state.rows = list(state.rows).map((info) => ({ url: info.url, info: normInfo(info) }));
  document.title = sessionState.title || ("Product Review " + (state.version || "")).trim();
  renderRows();
  updateStatus();
}

// The list saves itself on every change; Bắt đầu checks that every link is ready.
function persist() { saveQueue(false).catch(() => {}); }
async function saveQueue(requireReady = false) {
  return api("queueSave", { urls: state.rows.map((r) => r.url), requireReady });
}

async function updateReviewButton() {
  const pending = run.resultFolder ? await api("pending", { batch: run.resultFolder }).catch(() => 0) : 0;
  ui.btnReview.textContent = pending > 0 ? `Duyệt & xuất file (${pending})` : "Duyệt & xuất file";
  ui.btnReview.classList.toggle("primary", pending > 0);
}

// ----- product dialog: one row per product image, its review images beside it -----
// Small thumbnails only; clicking one opens it large. Each pair becomes one generated image.
function showImagePreview(path, title) {
  const view = openWindow(title, 760, 560);
  const pic = at(picture(), 12, 12, 736, 490);
  pic.style.background = "var(--smoke)";
  pic.set(path);
  const close = at(button("Đóng"), 648, 514, 100, 32);
  close.onclick = view.close;
  view.body.append(pic, close);
  close.focus();
}

// Native macOS file dialog opened at a folder; returns the picked files' real paths.
async function chooseImages(folder, table = false) {
  const r = await fetch("/api/choose-images", { method: "POST", body: JSON.stringify({ folder, table }) }).then((x) => x.json()).catch(() => ({ paths: [] }));
  return list(r.paths);
}

// "Từ kho ảnh": nothing loads until a danh mục is chosen, so the window opens at once. Thêm uses the picked
// images directly (downloading only those not on this machine yet); Tải về máy brings the chosen danh mục, or
// every danh mục, over in one go. Either way nothing is fetched twice.
function showLibraryPicker() {
  return new Promise((resolve) => {
    const view = openWindow("Chọn ảnh review từ kho ảnh", 760, 540);
    // One toolbar row, 28px tall: danh mục, Mặc định and Tải về máy share its height and centre line.
    const groups = at(combo(), 20, 14, 220, 28);
    // Mặc định: the picker opens on this danh mục next time (and loads it at once).
    const isDefault = at(checkbox("Mặc định"), 250, 14, 86, 28);
    isDefault.input.disabled = true;
    const sync = at(button("Tải về máy"), 342, 14, 120, 28);
    sync.classList.add("has-chevron");
    const count = at(label("", "muted"), 474, 14, 266, 28);
    count.style.lineHeight = "28px";
    const note = at(label(""), 20, 494, 500, 24);
    note.style.color = "var(--error)";
    // Background loading shows on a thin bar along the top of the grid: running while the library listing loads,
    // then filling as the thumbnails arrive.
    const loadBar = at(el("div", "progress"), 20, 46, 720, 4);
    loadBar.append(el("span"));
    loadBar.hidden = true;
    const grid = at(el("div", "flow"), 20, 52, 720, 420);
    Object.assign(grid.style, { background: "#fff", border: "1px solid #000", display: "flex", flexWrap: "wrap", alignContent: "flex-start", gap: "6px", padding: "6px" });
    const add = at(button("Thêm", true), 536, 490, 110, 32), cancel = at(button("Hủy"), 656, 490, 84, 32);
    add.disabled = true;
    view.body.append(groups, isDefault, sync, count, loadBar, grid, note, add, cancel);
    let files = [], shown = 0, result = [], all = [], syncing = false, loads = 0, listing = false, summary = "";
    const picked = new Map();
    view.onClose = () => resolve(result);
    view.cancel = () => { if (!syncing) view.close(); };
    cancel.onclick = view.cancel;
    const busy = (on) => { syncing = on; sync.disabled = on || !all.length; groups.disabled = on; cancel.disabled = on; add.disabled = on || !picked.size; };
    // Thumbnails load top to bottom, six at a time, so a big danh mục never loads all at once.
    const thumbs = { queue: [], active: 0, round: 0, total: 0, done: 0 };
    const refreshCount = () => {
      const loading = thumbs.done < thumbs.total, percent = thumbs.total ? Math.round((thumbs.done / thumbs.total) * 100) : 0;
      loadBar.hidden = !groups.value || !(listing || loading);
      loadBar.classList.toggle("marquee", listing && !loading);
      loadBar.firstChild.style.width = listing && !loading ? "" : `${percent}%`;
      if (syncing) return;
      if (!groups.value) { count.textContent = "Chọn danh mục để xem ảnh."; add.disabled = true; return; }
      add.disabled = !picked.size;
      if (loading) { count.textContent = `${picked.size ? `Đã chọn ${picked.size} · ` : ""}Đang tải ảnh ${thumbs.done}/${thumbs.total} (${percent}%)`; return; }
      if (listing) { count.textContent = files.length ? `${files.length} ảnh có trên máy · đang tải danh sách kho ảnh…` : "Đang tải danh sách…"; return; }
      if (summary) { count.textContent = summary; return; }
      const local = files.filter((f) => f.local).length;
      count.textContent = files.length ? `Đã chọn ${picked.size} / ${files.length} ảnh · ${local} ảnh có trên máy` : "Danh mục này chưa có ảnh.";
    };
    const pump = () => {
      while (thumbs.active < 6 && thumbs.queue.length) {
        const [img, src] = thumbs.queue.shift();
        const round = thumbs.round;
        thumbs.active++;
        img.onload = img.onerror = () => { if (round === thumbs.round) { thumbs.active--; thumbs.done++; refreshCount(); pump(); } };
        img.src = src;
      }
    };
    const clearGrid = () => { Object.assign(thumbs, { queue: [], active: 0, total: 0, done: 0 }); thumbs.round++; grid.replaceChildren(); shown = 0; };
    const showMore = () => {
      grid.querySelector(".more")?.remove();
      for (const f of files.slice(shown, shown + 120)) {
        const tile = el("div", "", { style: { width: "100px", height: "100px", padding: "3px", background: picked.has(f.name) ? "var(--accent)" : "var(--smoke)", cursor: "pointer", flex: "none" } });
        const img = el("img", "", { decoding: "async", style: { width: "100%", height: "100%", objectFit: "contain", display: "block" } });
        tile.append(img);
        thumbs.queue.push([img, f.local ? `/file?path=${encodeURIComponent(f.local)}` : f.url]);
        tile.onclick = () => {
          summary = "";
          if (picked.has(f.name)) { picked.delete(f.name); tile.style.background = "var(--smoke)"; }
          else { picked.set(f.name, f); tile.style.background = "var(--accent)"; }
          refreshCount();
        };
        grid.append(tile);
      }
      thumbs.total += Math.min(files.length, shown + 120) - shown;
      shown = Math.min(files.length, shown + 120);
      if (shown < files.length) {
        const more = el("button", "btn more", { text: "Xem thêm", type: "button", style: { position: "static", width: "100px", height: "100px" } });
        more.onclick = showMore;
        grid.append(more);
      }
      pump(); refreshCount();
    };
    // A danh mục shows its local copies at once; the library listing loads in the background and, when it brings
    // more (or the local copies are out of date), the grid is redrawn from it, keeping what was picked.
    const load = async () => {
      const token = ++loads;
      clearGrid(); picked.clear(); files = []; listing = false; summary = "";
      note.style.color = "var(--error)";
      note.textContent = "";
      if (!groups.value) return refreshCount();
      const group = groups.value;
      listing = true; refreshCount();
      files = list(await api("sourceIndexedFiles", { group }).catch(() => []));
      if (token !== loads) return;
      showMore(); refreshCount();
      const next = await api("sourceFiles", { group }).catch(() => ({ Files: files, Error: "Không kết nối được kho ảnh (mạng). Đang hiện ảnh có trên máy." }));
      if (token !== loads) return;
      listing = false;
      note.style.color = "var(--error)";
      note.textContent = next.Error || "";
      const nextFiles = list(next.Files);
      if (nextFiles.length !== files.length || nextFiles.some((f) => !f.local)) {
        const keep = new Set(picked.keys());
        picked.clear();
        for (const f of nextFiles) if (keep.has(f.name)) picked.set(f.name, f);
        clearGrid(); files = nextFiles; showMore();
      }
      refreshCount();
    };
    // Tải về máy runs in the background of the main window (progress in its header); this window stays usable.
    const runSync = async (names) => {
      if (!names.length) return;
      note.style.color = "var(--muted)";
      note.textContent = (await startSync(names)) ? "Đang tải ngầm, xem tiến độ ở thanh trên cùng. Vẫn làm việc bình thường." : "Đang có một lượt tải về máy, đợi xong rồi bấm lại.";
    };
    sync.onclick = () => dropMenu(sync, [
      { text: "Danh mục đang chọn", disabled: !groups.value, onClick: () => runSync([groups.value]) },
      { text: `Tất cả danh mục (${all.length})`, onClick: () => runSync(all) },
    ]);
    let defaultGroup = "";
    const showDefault = () => { isDefault.input.disabled = !groups.value; isDefault.input.checked = !!groups.value && groups.value === defaultGroup; };
    groups.onchange = () => { showDefault(); load(); };
    isDefault.input.onchange = () => {
      defaultGroup = isDefault.input.checked ? groups.value : "";
      api("sourceDefaultSet", { group: defaultGroup }).catch(() => {});
    };
    add.onclick = async () => {
      const chosen = [...picked.values()];
      const missing = chosen.filter((f) => !f.local);
      busy(true); count.textContent = missing.length ? `Đang tải ${missing.length} ảnh đã chọn…` : "Đang thêm…";
      try {
        const fetched = missing.length ? list(await api("sourcePick", { group: groups.value, files: missing.map(({ name, md5, url }) => ({ name, md5, url })) })) : [];
        result = [...chosen.filter((f) => f.local).map((f) => f.local), ...fetched];
        state.group = groups.value;
        busy(false);
        view.close();
      } catch { count.textContent = "Chưa tải được ảnh đã chọn. Kiểm tra mạng rồi thử lại."; busy(false); }
    };
    Promise.all([api("groups", { local: false }), api("sourceDefault").catch(() => "")]).then(([g, saved]) => {
      all = list(g);
      defaultGroup = saved || "";
      groups.setItems(["", ...all], ["Chọn danh mục…", ...all]);
      groups.value = all.includes(defaultGroup) ? defaultGroup : "";
      showDefault();
      load();
      if (!all.length) { count.textContent = "Chưa có danh mục nào đang bật."; sync.disabled = true; }
    }).catch(() => { count.textContent = "Chưa tải được danh sách danh mục."; });
  });
}

// ----- Quét web: Claude opens a shop website, reads its menu and takes the products with their main image into the web's PROJECT
// (workspace/projects/<id>/products.csv, docs/scan-prompt.md, /api/scan/*): a web already scanned only gets its new products;
// "Nhập vào danh sách" opens Nhập hàng loạt on that table -----
function showScanDialog() {
  const view = openWindow("Quét web", 760, 480);
  const hint = at(label("Claude mở web trong Chrome riêng của app, đọc menu, lấy sản phẩm và ảnh chính từng danh mục, rồi lưu vào dự án của web đó (products.csv cho Nhập hàng loạt, cột used = F, chạy xong link nào tự đổi thành T). Quét lại web đã có chỉ thêm sản phẩm mới."), 16, 10, 728, 62);
  Object.assign(hint.style, { whiteSpace: "normal", lineHeight: "20px" });
  const siteBox = at(el("input", "text", { value: "", placeholder: "https://ten-shop.com" }), 16, 102, 380, 25);
  const projectBox = at(combo(["", ]), 412, 102, 230, 25);
  const maxBox = at(el("input", "text", { type: "number", value: "20", min: "1", max: "200" }), 658, 102, 86, 25);
  const log = at(el("textarea", "text mono"), 16, 142, 728, 208);
  log.readOnly = true; log.wrap = "off";
  const status = at(label(""), 16, 358, 728, 66);
  status.style.whiteSpace = "pre-line";
  const openDir = at(button("Mở thư mục"), 16, 436, 120, 32);
  const toImport = at(button("Nhập vào danh sách"), 146, 436, 180, 32);
  const start = at(button("Bắt đầu quét", true), 400, 436, 130, 32);
  const stop = at(button("Dừng"), 540, 436, 90, 32);
  const close = at(button("Đóng"), 640, 436, 104, 32);
  view.body.append(
    hint, at(label("Link trang chủ của web"), 16, 78, 380, 22), siteBox, at(label("Hoặc chọn dự án có sẵn"), 412, 78, 230, 22), projectBox, at(label("Tối đa"), 658, 78, 86, 22), maxBox,
    log, status, openDir, toImport, start, stop, close,
  );
  openDir.hidden = toImport.hidden = true; stop.disabled = true;
  let timer = null, scan = null, startedAt = 0;
  const say = (text, color = "") => { status.style.color = color; status.textContent = text; };
  const clock = () => { const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000)); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
  const setBusy = (on) => { start.disabled = on; stop.disabled = !on; siteBox.readOnly = maxBox.readOnly = on; projectBox.disabled = on; };
  // Existing projects: picking one fills the link and its last "tối đa" (no re-typing, and the web is updated, not scanned again).
  let known = [];
  api("projects").then((all) => {
    known = list(all);
    projectBox.setItems(["", ...known.map((p) => p.id)], ["Chọn dự án…", ...known.map((p) => `${p.name || p.id} (${p.products} sản phẩm)`)]);
  }).catch(() => {});
  projectBox.onchange = () => {
    const p = known.find((x) => x.id === projectBox.value);
    if (p) { siteBox.value = p.site; maxBox.value = p.max_per_collection || 20; }
  };
  const poll = async () => {
    const st = await fetch("/api/scan/status").then((x) => x.json()).catch(() => null);
    if (!st) return;
    if (st.other_active) { setBusy(false); start.disabled = true; say("Đang có một lượt Claude khác chạy (tạo ảnh Flow). Chờ xong rồi quét.", "var(--warn)"); return; }
    if (!st.scan_run) return;
    if (!startedAt) startedAt = Date.now() - (st.elapsed_s || 0) * 1000;
    scan = st.scan || scan;
    log.value = list(st.tail).join("\n"); log.scrollTop = log.scrollHeight;
    const rows = scan?.rows ?? 0;
    if (st.active) { setBusy(true); say(`Đang quét… ${clock()} · đã lưu ${rows} sản phẩm\n${st.last_text || ""}`.trim(), "var(--accent)"); return; }
    clearInterval(timer); timer = null; setBusy(false);
    const ok = st.status === "done";
    if (rows) { openDir.hidden = toImport.hidden = false; }
    const merge = scan && scan.added !== undefined ? ` (mới ${scan.added}, đã có ${scan.already_known})` : "";
    say(ok ? `Quét xong: ${rows} sản phẩm trong dự án${merge}.\n${scan?.csv || ""}` : `Lượt quét dừng${st.error ? ": " + st.error : ""}. Dự án có ${rows} sản phẩm${merge}.${scan?.csv ? "\n" + scan.csv : ""}`, ok ? "var(--ok)" : "var(--error)");
  };
  const watch = () => { if (!timer) timer = setInterval(poll, 1500); poll(); };
  start.onclick = async () => {
    if (run.active) return say("Đang có một lượt chạy trong cửa sổ chính. Chờ xong rồi quét.", "var(--warn)");
    const site = siteBox.value.trim();
    if (!site) return say("Dán link trang chủ của web cần quét.", "var(--error)");
    openDir.hidden = toImport.hidden = true; log.value = ""; scan = null; startedAt = Date.now();
    const r = await fetch("/api/scan/run", { method: "POST", body: JSON.stringify({ site, max: Number(maxBox.value) || 20 }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return say(body.error || "Chưa bắt đầu quét được.", "var(--error)");
    setBusy(true); say("Đang bắt đầu…", "var(--accent)"); watch();
  };
  // Quét web popup: Dừng stops this scan (the Dự án popup has its own Dừng buttons for the light and main runs)
  stop.onclick = async () => { stop.disabled = true; say("Đang dừng…", "var(--accent)"); await fetch("/api/scan/stop", { method: "POST" }).catch(() => {}); };
  openDir.onclick = () => scan?.dir && api("openPath", { path: scan.dir });
  toImport.onclick = () => { if (!scan?.csv) return; view.close(); showBulkDialog({ csv: scan.csv }); };
  // Closing the popup leaves a running scan running; opening it again picks it up.
  view.onClose = () => { if (timer) { clearInterval(timer); timer = null; } };
  view.cancel = close.onclick = () => view.close();
  fetch("/api/scan/status").then((x) => x.json()).then((st) => { if (st?.scan_run && st.active) { siteBox.value = st.scan?.site || ""; maxBox.value = st.scan?.max || 20; watch(); } else if (st?.other_active) poll(); }).catch(() => {});
  siteBox.focus();
}

// ----- Dự án: each web is a project (workspace/projects/<id>/): its menu, product links, images, the used flag and the review number last
// seen on each product page. "Quét cập nhật" only adds new products (/api/scan/*); "Cập nhật số review" has Claude read the number every
// product page shows (READ ONLY, docs/reviews-count-prompt.md, /api/project/reviews/*); "Nhập vào danh sách" imports the used = F rows -----
function showProjectsDialog(pick = "") {
  const view = openWindow("Dự án", 900, 684);
  const fmtStamp = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)} ${s.slice(11, 16)}` : "chưa có");
  const oneLine = (style = {}) => Object.assign({ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, style);
  const listTitle = at(label("Dự án của bạn", "muted"), 16, 14, 150, 20);
  const unpick = at(button("Bỏ chọn dự án"), 160, 10, 106, 24);
  Object.assign(unpick.style, { fontSize: "11px" });
  unpick.title = "Cửa sổ này thôi làm dự án đang chọn (nhả khóa dự án); tiêu đề về mặc định.";
  unpick.onclick = () => selectProject("");
  const projectLine = at(label("", "muted"), 282, 14, 602, 20);
  Object.assign(projectLine.style, oneLine());
  const listBox = at(el("div", "flow"), 16, 40, 250, 340);
  const addWeb = at(button("Thêm web mới"), 16, 388, 250, 32);
  addWeb.onclick = () => showScanDialog();
  Object.assign(listBox.style, { background: "#fff", border: "1px solid #000" });
  const catLabel = at(label("Danh mục"), 282, 44, 70, 22);
  const catBox = at(combo(), 356, 40, 230, 25);
  const unusedOnly = at(checkbox("Chỉ chưa dùng"), 610, 42, 140, 22);
  // Default ON (user 2026-11-21): the table, Thêm vào hàng chờ and Chuẩn bị trước start with only the unused products; untick to see all.
  unusedOnly.input.checked = true;
  const countLabel = at(label("", "muted"), 760, 44, 124, 22);
  countLabel.style.textAlign = "right";
  const COLS = "1fr 140px 44px 62px 96px";
  const head = el("div", "");
  Object.assign(head.style, { display: "grid", gridTemplateColumns: COLS, gap: "6px", alignItems: "center", fontSize: "11px", color: "var(--muted)", padding: "0 6px", height: "22px", boxSizing: "border-box", position: "sticky", top: "0", background: "var(--smoke)", borderBottom: "1px solid var(--line)" });
  head.append(...["Sản phẩm", "Danh mục", "Dùng", "Review", "Kiểm tra"].map((t) => el("div", "", { text: t, style: oneLine() })));
  const tableBox = at(el("div", "flow"), 282, 76, 602, 344);
  Object.assign(tableBox.style, { background: "#fff", border: "1px solid #000" });
  const status = at(label(""), 16, 426, 868, 40);
  Object.assign(status.style, { whiteSpace: "pre-line", lineHeight: "20px" });
  // Two SEPARATE groups, each with its own numbers (remembered per session) and its own button; labels above the boxes.
  const group = (title, x) => { const t = at(label(title, ""), x, 470, 200, 18); t.style.fontWeight = "600"; return t; };
  const small = (text, x, w) => { const l = at(label(text, "muted"), x, 490, w, 16); l.style.fontSize = "11px"; return l; };
  const qTitle = group("Thêm vào hàng chờ", 16);
  const qCountHint = small("Số sản phẩm", 16, 90), queueCount = at(numeric(1, 200, 10), 16, 508, 64, 28);
  queueCount.title = "Số sản phẩm đưa vào hàng chờ (theo danh mục và ô Chỉ chưa dùng đang chọn), 1-200";
  const qSceneHint = small("Ảnh ngữ cảnh / sản phẩm", 110, 150), sceneCount = at(numeric(1, 4, 2), 110, 508, 64, 28);
  sceneCount.title = "Số ảnh ngữ cảnh khác nhau cho mỗi sản phẩm khi thêm vào hàng chờ, 1-4. Lấy trước từ kho đã chuẩn bị (dòng có ít nhất số ảnh này), phần thiếu Claude chọn.";
  const queueBtn = at(button("Thêm vào hàng chờ"), 270, 506, 160, 32);
  const divider = at(el("div", "abs"), 448, 470, 1, 68); divider.style.background = "var(--line)";
  const pTitle = group("Chuẩn bị trước", 466);
  // retry the products skipped earlier because no scene fitted (their skipped row is replaced); off by default, remembered per session
  const retrySkipped = at(checkbox("Thử lại sản phẩm đã bỏ qua"), 640, 470, 240, 18);
  retrySkipped.style.fontSize = "12px";
  retrySkipped.title = "Chuẩn bị lại cả các sản phẩm lần trước Claude bỏ qua vì không có ảnh bối cảnh hợp (dòng bỏ qua được thay bằng dòng mới).";
  const pCountHint = small("Số sản phẩm (0 = tất cả)", 466, 140), prepCount = at(numeric(0, 500, 50), 466, 508, 64, 28);
  prepCount.title = "Số sản phẩm Claude chuẩn bị trước lần này, 0 = tất cả sản phẩm còn lại (theo danh mục và ô Chỉ chưa dùng)";
  const pSceneHint = small("Ảnh ngữ cảnh / sản phẩm", 616, 150), prepScenes = at(numeric(1, 4, 4), 616, 508, 64, 28);
  prepScenes.title = "Số ảnh ngữ cảnh chuẩn bị cho mỗi sản phẩm, 1-4. Nên để 4: Thêm vào hàng chờ dùng được mọi số ảnh từ 1 đến 4 từ cùng một dòng.";
  const prepBtn = at(button("Chuẩn bị trước"), 770, 506, 110, 32);
  prepBtn.title = "Claude chọn sẵn ảnh bối cảnh cho các sản phẩm chưa chuẩn bị của dự án (theo danh mục và ô Chỉ chưa dùng), lưu vào kho đã chuẩn bị; không đụng hàng chờ, chạy được khi Bắt đầu đang chạy. Lần sau Thêm vào hàng chờ lấy ngay từ kho này.";
  const scanBtn = at(button("Quét cập nhật"), 16, 556, 120, 32);
  const reviewsBtn = at(button("Cập nhật số review"), 145, 556, 150, 32);
  const openDir = at(button("Mở thư mục"), 304, 556, 100, 32);
  const stop = at(button("Dừng"), 413, 556, 190, 32);
  const stopMain = at(button("Dừng"), 612, 556, 180, 32); stopMain.style.display = "none";
  const runBox = at(label("", "muted"), 16, 596, 868, 38);
  Object.assign(runBox.style, { whiteSpace: "pre-line", lineHeight: "18px", fontSize: "11px", overflow: "hidden" });
  const close = at(button("Đóng"), 800, 556, 80, 32);
  // the scene library tag index (shared by every project): state line + its own button on the last row
  const indexLine = at(label("Kho ảnh: …", "muted"), 16, 646, 680, 20);
  Object.assign(indexLine.style, oneLine({ fontSize: "11px" }));
  const indexBtn = at(button("Gắn nhãn kho ảnh"), 720, 640, 160, 32);
  indexBtn.title = "Claude xem mỗi ảnh trong kho MỘT lần (trên tấm ảnh ghép) và gắn nhãn: nơi chốn, có người, ánh sáng, chỗ tường trống, hợp loại sản phẩm nào. Chuẩn bị trước và Thêm vào hàng chờ dùng nhãn này để chỉ xem ít ảnh hợp nhất. Chỉ gắn ảnh chưa có nhãn; chạy được khi Bắt đầu đang chạy.";
  view.body.append(listTitle, unpick, projectLine, listBox, addWeb, catLabel, catBox, unusedOnly, countLabel, tableBox, status, qTitle, qCountHint, queueCount, qSceneHint, sceneCount, queueBtn, divider, pTitle, retrySkipped, pCountHint, prepCount, pSceneHint, prepScenes, prepBtn, scanBtn, reviewsBtn, openDir, stop, stopMain, close, runBox, indexLine, indexBtn);
  // each pair is remembered separately (this session's run-settings); the buttons read only their own boxes
  fetch("/api/run-settings").then((x) => x.json()).then((s) => {
    if (s.queueCount) queueCount.value = s.queueCount; if (s.queueScenes) sceneCount.value = s.queueScenes;
    if (s.prepCount !== undefined) prepCount.value = s.prepCount; if (s.prepScenes) prepScenes.value = s.prepScenes;
    retrySkipped.input.checked = s.prepRetrySkipped === true;
    refreshPrepared();
  }).catch(() => {});
  const remember = () => fetch("/api/run-settings", { method: "POST", body: JSON.stringify({ queueCount: queueCount.value, queueScenes: sceneCount.value, prepCount: prepCount.value, prepScenes: prepScenes.value, prepRetrySkipped: retrySkipped.input.checked }) }).catch(() => {});
  queueCount.onchange = remember; prepCount.onchange = remember; prepScenes.onchange = remember; retrySkipped.input.onchange = remember;
  sceneCount.onchange = () => { remember(); refreshPrepared(); }; // the footer counts the prepared rows the queue can use with THIS number of scenes

  // Two kinds of run can go at once: the main runner (scan / review count / the Flow run of Bắt đầu) and the LIGHT runner (queue, prep: no browser).
  let projects = [], current = "", data = null, timer = null, runningMain = "", runningLight = "", startedAt = 0, lightStarted = 0, ticks = 0, otherActive = false, otherLight = false, prepText = "", fastNote = "", orderActive = false, orderWasActive = false;
  // A window opened for a project (session named after it) shows only that project.
  // A window opened for a project stays on it; otherwise the popup opens on the FOCUSED project (or "Lẻ") and changing it is a change of the window's focus.
  const lockedProject = sessionState.locked ? sessionState.project : "";
  const say = (text, color = "") => { status.style.color = color; status.textContent = text; };
  const clock = () => { const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000)); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
  const KIND = { scan: "Đang quét cập nhật", reviews: "Đang đọc số review trên các trang sản phẩm", queue: "Đang thêm sản phẩm vào hàng chờ (chọn ảnh bối cảnh cho từng sản phẩm)", prep: "Đang chuẩn bị trước ảnh bối cảnh cho các sản phẩm", index: "Đang gắn nhãn kho ảnh (Claude xem ảnh ghép, mỗi ảnh một lần)" };
  const refreshButtons = () => {
    const has = !!data, mainBusy = !!runningMain, lightBusy = !!runningLight;
    scanBtn.disabled = mainBusy || otherActive || !has;
    reviewsBtn.disabled = mainBusy || otherActive || !has || !data.rows.length;
    // queue / prep need no browser: only another LIGHT run blocks them, never the main Bắt đầu run
    queueBtn.disabled = orderActive || (lightBusy && runningLight === "queue") || !has || !data.rows.length;
    prepBtn.disabled = lightBusy || otherLight || !has || !data.rows.length;
    indexBtn.disabled = lightBusy || otherLight || orderActive;
    queueCount.enabled = !lightBusy; sceneCount.enabled = !lightBusy; prepCount.enabled = !lightBusy; prepScenes.enabled = !lightBusy;
    openDir.disabled = !has;
    stop.disabled = !(mainBusy || lightBusy || orderActive);
    // each Dừng says what it stops; with two runs at once (main + light) there are two buttons
    const FEAT = { scan: "Quét web", reviews: "Cập nhật số review", queue: "Thêm vào hàng chờ", prep: "Chuẩn bị trước", index: "Gắn nhãn kho ảnh" };
    stop.textContent = "Dừng" + (runningLight ? " " + FEAT[runningLight] : orderActive ? " Thêm vào hàng chờ" : mainBusy ? " " + FEAT[runningMain] : "");
    stopMain.style.display = mainBusy && (lightBusy || orderActive) ? "" : "none";
    stopMain.textContent = mainBusy ? "Dừng " + FEAT[runningMain] : "Dừng";
  };
  const idleText = () => (data ? `${data.project.products} sản phẩm · đã dùng ${data.project.used} · đã kiểm tra review ${data.project.with_reviews}.` + (prepText ? "\n" + prepText : "") : "");
  // "Đã chuẩn bị: X sẵn sàng / Y sản phẩm" for the selected project and the category / only-unused filter.
  const refreshPrepared = async () => {
    if (!current) { prepText = ""; return; }
    const q = new URLSearchParams({ project: current, category: catBox.value, unused_only: unusedOnly.input.checked ? "1" : "0", scenes: String(sceneCount.value) });
    const r = await fetch("/api/project/prepared?" + q).then((x) => x.json()).catch(() => null);
    prepText = r && !r.error ? `Chuẩn bị trước: ${r.ready_usable} sẵn sàng (≥ ${sceneCount.value} ảnh)${r.ready > r.ready_usable ? ` + ${r.ready - r.ready_usable} ít ảnh hơn` : ""} · ${r.to_prepare} chưa chuẩn bị${r.skipped ? ` · ${r.skipped} đã bỏ qua` : ""} · ${r.in_queue} đã ở hàng chờ (${r.in_filter} sản phẩm${unusedOnly.input.checked ? " chưa dùng" : ""}${catBox.value ? " của danh mục" : ""})` : "";
    if (!runningMain && !runningLight && !otherActive && !otherLight && data && prepShowIdle) say(idleText(), "");
  };
  let prepShowIdle = true;
  // "Kho ảnh: N ảnh · M đã gắn nhãn" (src/scan.ps1 scene-index-status through /api/library/index)
  const refreshIndex = async () => {
    const r = await fetch("/api/library/index").then((x) => x.json()).catch(() => null);
    if (!r || r.error) { indexLine.textContent = "Kho ảnh: chưa đọc được số ảnh" + (r && r.error ? " (" + r.error + ")" : ""); return; }
    const left = Math.max(0, (r.photos || 0) - (r.indexed || 0));
    indexLine.textContent = r.offline ? `Kho ảnh: ${r.indexed} ảnh đã gắn nhãn (không kết nối được kho để đếm tổng)` : `Kho ảnh: ${r.photos} ảnh · ${r.indexed} đã gắn nhãn` + (left ? ` · ${left} chưa gắn nhãn` : " · đã gắn nhãn hết");
  };
  refreshIndex();

  const renderList = () => {
    unpick.style.display = current && !lockedProject ? "" : "none";
    listBox.replaceChildren(...(projects.length ? projects.map((p) => {
      const item = el("div", "", { style: { padding: "8px 10px", borderBottom: "1px solid var(--line)", cursor: "pointer" } });
      if (p.id === current) item.style.background = "var(--hover)";
      item.append(
        el("div", "", { text: p.name || p.id, style: oneLine({ fontSize: "12px" }) }),
        el("div", "label muted", { text: `${p.products} sản phẩm · đã dùng ${p.used}/${p.products}`, style: oneLine({ position: "static", fontSize: "11px" }) }),
        el("div", "label muted", { text: `Đã chuẩn bị: ${p.prepared || 0} sẵn sàng`, style: oneLine({ position: "static", fontSize: "11px" }) }),
        el("div", "label muted", { text: `Quét: ${fmtStamp(p.last_scan)}`, style: oneLine({ position: "static", fontSize: "11px" }) }),
        el("div", "label muted", { text: `Review: ${fmtStamp(p.last_reviews_check)}`, style: oneLine({ position: "static", fontSize: "11px" }) }),
      );
      item.title = p.site;
      if (p.heldBy) { item.style.opacity = "0.55"; item.style.cursor = "default"; item.append(el("div", "label muted", { text: "Đang mở ở cửa sổ " + p.heldBy, style: oneLine({ position: "static", fontSize: "11px" }) })); }
      item.onclick = () => { if (!p.heldBy) selectProject(p.id); };
      return item;
    }) : [el("div", "label muted", { text: "Chưa có dự án. Bấm Thêm web mới để quét web đầu tiên.", style: { position: "static", padding: "10px", whiteSpace: "normal" } })]));
  };

  const renderTable = () => {
    if (!data) { tableBox.replaceChildren(); countLabel.textContent = ""; return; }
    const cat = catBox.value, only = unusedOnly.input.checked;
    const rows = data.rows.filter((r) => (!cat || r.collection === cat) && (!only || !r.used));
    countLabel.textContent = `${rows.length}/${data.rows.length} sản phẩm`;
    tableBox.replaceChildren(head, ...rows.map((r) => {
      const line = el("div", "", { style: { display: "grid", gridTemplateColumns: COLS, gap: "6px", alignItems: "center", fontSize: "11px", padding: "3px 6px", minHeight: "24px", boxSizing: "border-box", borderBottom: "1px solid var(--line)" } });
      const name = el("div", "", { text: r.title || r.url, title: r.url, style: oneLine() });
      const group = el("div", "", { text: r.collection, title: r.collection, style: oneLine({ color: "var(--muted)" }) });
      const used = el("div", "", { text: r.used ? "T" : "F", title: r.used ? "Đã dùng: bấm để đổi về F" : "Chưa dùng: bấm để đổi thành T", style: { cursor: "pointer", textAlign: "center", color: r.used ? "var(--ok)" : "var(--muted)", border: "1px solid var(--line)", borderRadius: "3px", lineHeight: "18px" } });
      used.onclick = async () => {
        try { await api("projectSetUsed", { id: current, url: r.url, used: !r.used }); r.used = !r.used; renderTable(); refreshButtons(); loadProjects(current, true); }
        catch (e) { say(e.message, "var(--error)"); }
      };
      const count = el("div", "", { text: r.reviews_checked_at ? r.reviews_count : "–", title: r.reviews_checked_at ? "" : "Chưa kiểm tra", style: oneLine({ textAlign: "right" }) });
      const when = el("div", "", { text: r.reviews_checked_at ? fmtStamp(r.reviews_checked_at) : "", style: oneLine({ color: "var(--muted)" }) });
      line.append(name, group, used, count, when);
      return line;
    }));
  };

  // The category list: every category of the menu, then any that only appear in the table.
  const fillCategories = () => {
    const keep = catBox.value;
    const names = [], seen = new Set();
    for (const m of list(data?.menu)) { if (m.name && !seen.has(m.name)) { seen.add(m.name); names.push(m.name); } }
    for (const r of data?.rows || []) { if (r.collection && !seen.has(r.collection)) { seen.add(r.collection); names.push(r.collection); } }
    const count = (n) => (data?.rows || []).filter((r) => r.collection === n).length;
    catBox.setItems(["", ...names], ["Tất cả danh mục", ...names.map((n) => `${n} (${count(n)})`)]);
    catBox.value = names.includes(keep) ? keep : "";
  };

  const choose = async (id, quiet = false) => {
    current = id;
    try {
      data = id ? await api("projectRows", { id }) : null;
      if (data) { data.rows = list(data.rows); data.menu = list(data.menu); try { const c = await fetch("/api/project/counts?project=" + encodeURIComponent(id)).then((x) => x.json()); if (!c.error) { data.project.products = c.products; data.project.used = c.used; } } catch {} }
    } catch (e) { data = null; say(e.message, "var(--error)"); }
    projectLine.textContent = data ? `${data.project.name} · ${data.project.site}` : "";
    fillCategories(); renderList(); renderTable(); refreshButtons();
    if (data) { if (!quiet && !runningMain && !runningLight) say(idleText(), ""); refreshPrepared(); }
  };
  // The project of a window is the one selected here: another live window cannot take it (409 with the Vietnamese message).
  const selectProject = async (id) => {
    if (id === current) return;
    const r = await fetch("/api/session/project", { method: "POST", body: JSON.stringify({ project: id }) }).then(async (x) => ({ ok: x.ok, ...(await x.json().catch(() => ({}))) })).catch(() => ({ ok: true }));
    if (!r.ok) return say(r.error || "Dự án đang được phiên khác dùng.", "var(--error)");
    sessionState.project = id;
    await refreshSessionBadge(); // the window title follows the focus
    await choose(id);
    await loadProjects(id, true); // the list shows the new holder at once
    if (ui.sessionsPanel && ui.sessionsPanel.style.display !== "none") loadSessionPicker(); // and so does an open Các phiên panel
  };
  async function loadProjects(select = "", quiet = false) {
    try { projects = list(await api("projects")).filter((p) => !lockedProject || p.id === lockedProject); window.__prProjectsCache = projects; } catch (e) { projects = []; say(e.message, "var(--error)"); }
    // the counts shown everywhere come from ONE server function (/api/sessions/projects -> projectCounts), not from a second computation
    try { const c = await fetch("/api/sessions/projects").then((x) => x.json()); for (const p of projects) { const m = (c.projects || []).find((x) => x.id === p.id); if (m) { p.products = m.products; p.used = m.used; p.heldBy = m.window_open && !m.current ? "#" + m.window_stt : m.busy && !m.current ? m.busy : ""; } } } catch {}
    // the focus decides: "Lẻ" stays Lẻ, a project stays itself (never the first of the list by accident)
    const want = !select && !sessionState.project ? "" : (projects.some((p) => p.id === select) ? select : (projects.some((p) => p.id === current) ? current : ""));
    if (quiet && want === current) { renderList(); return; }
    await choose(want, quiet);
  }

  // One poll for the two runners: /api/agent/status (scan, review count, the Flow run) and /api/light/status (queue, prep).
  const poll = async () => {
    const [st, lt, od] = await Promise.all([fetch("/api/agent/status").then((x) => x.json()).catch(() => null), fetch("/api/light/status").then((x) => x.json()).catch(() => null), fetch("/api/project/queue/order").then((x) => x.json()).catch(() => null)]);
    if (!st || !lt) return;
    orderActive = !!(od && od.active);
    { const rs = await refreshRunLine(); runBox.textContent = runLines(rs).join("\n"); }
    const lightNow = lt.active && (lt.mode === "queue" || lt.mode === "prep" || lt.mode === "index");
    const mainNow = st.active && (st.mode === "scan" || st.mode === "reviews");
    otherLight = !!lightNow && !runningLight; otherActive = !!st.active && !mainNow && !runningMain;
    // --- the light runner started here (or still running from an earlier popup)
    if (lightNow) {
      if (!runningLight) { runningLight = lt.mode; otherLight = false; lightStarted = Date.now() - (lt.elapsed_s || 0) * 1000; }
    } else if (runningLight) {
      const kind = runningLight; runningLight = "";
      let ok = lt.status === "done";
      let text = ok ? "Xong." : `Lượt chạy dừng${lt.error ? ": " + lt.error : ""}.`;
      const tag = "[" + (kind === "queue" ? "Thêm vào hàng chờ" : kind === "index" ? "Gắn nhãn kho ảnh" : "Chuẩn bị trước") + (data && kind !== "index" ? " · " + data.project.name : "") + "] ";
      if (kind === "queue") {
        // the session's own numbers: the order (links of this project in THIS window's urls.txt) and the run's own last text
        await loadState().catch(() => {});
        const od2 = await fetch("/api/project/queue/order").then((x) => x.json()).catch(() => null);
        if (od2 && od2.line) { text = od2.line + (od2.message ? "\n" + od2.message : ""); ok = od2.state === "done" || (!od2.active && lt.status === "done" && od2.added >= od2.total); }
        else text = (lt.status === "done" ? "Lượt thêm vào hàng chờ đã xong." : "Lượt thêm vào hàng chờ dừng" + (lt.error ? ": " + lt.error : ".")) + (lt.last_text ? "\n" + lt.last_text : "");
      } else if (kind === "index") { await refreshIndex(); text = (ok ? "Gắn nhãn xong. " : `Gắn nhãn dừng${lt.error ? ": " + lt.error : ""}. Ảnh đã gắn vẫn được giữ. `) + indexLine.textContent;
      } else { text = (ok ? "Chuẩn bị xong." : `Chuẩn bị dừng${lt.error ? ": " + lt.error : ""}. Phần đã chuẩn bị vẫn nằm trong kho.`); }
      text = tag + text;
      fastNote = "";
      await refreshPrepared();
      say((kind === "prep" ? text + (prepText ? "\n" + prepText : "") : text), ok ? "var(--ok)" : "var(--error)");
      refreshButtons();
    }
    // --- the main runner (scan / review count); a Flow run only blocks scan and review count
    if (mainNow) {
      if (!runningMain) { runningMain = st.mode; startedAt = Date.now() - (st.elapsed_s || 0) * 1000; otherActive = false; }
    } else if (runningMain) {
      const kind = runningMain; runningMain = "";
      const ok = st.status === "done";
      let text = ok ? "Xong." : `Lượt chạy dừng${st.error ? ": " + st.error : ""}.`;
      if (kind === "scan") {
        const ss = await fetch("/api/scan/status").then((x) => x.json()).catch(() => null);
        const sc = ss?.scan;
        if (sc) text = `${ok ? "Quét xong" : "Quét dừng"}: ${sc.rows} sản phẩm trong dự án (mới ${sc.added ?? 0}, đã có ${sc.already_known ?? 0}).${ok ? "" : st.error ? " " + st.error : ""}`;
      } else if (ok) text = "Đã cập nhật số review.";
      await loadProjects(current, true); await choose(current, true);
      if (!runningLight) say(text, ok ? "var(--ok)" : "var(--error)");
    }
    // --- what the status area shows while something runs
    if (runningLight) {
      const secs = Math.max(0, Math.floor((Date.now() - lightStarted) / 1000)), clockText = String(Math.floor(secs / 60)).padStart(2, "0") + ":" + String(secs % 60).padStart(2, "0");
      say(`${KIND[runningLight]}… ${clockText}\n${(runningLight === "prep" ? prepText : lt.last_text) || ""}`.trim(), "var(--accent)");
      if (++ticks % 3 === 0) { if (runningLight === "prep") refreshPrepared(); else if (runningLight === "index") refreshIndex(); else choose(current, true); }
    } else if (runningMain) {
      say(`${KIND[runningMain]}… ${clock()}\n${st.last_text || ""}`.trim(), "var(--accent)");
      if (++ticks % 4 === 0) choose(current, true);
    } else if (st.active && !mainNow) say("Đang có một lượt Claude khác chạy (tạo ảnh Flow). Quét và cập nhật review chờ xong; Chuẩn bị trước và Thêm vào hàng chờ vẫn dùng được.", "var(--warn)");
    // Thêm vào hàng chờ order: its live line wins over the run text; when it ends, the main list is reloaded and the result shown once
    if (od && od.active) { say(od.line + (runningLight ? "\n" + (lt.last_text || "") : ""), "var(--accent)"); orderWasActive = true; }
    else if (orderWasActive && od) { orderWasActive = false; await loadState().catch(() => {}); refreshPrepared(); say((od.line || "") + (od.message ? "\n" + od.message : ""), od.state === "done" ? "var(--ok)" : "var(--warn)"); }
    refreshButtons();
    if (!st.active && !lt.active && !runningMain && !runningLight && !orderActive && timer) { clearInterval(timer); timer = null; }
  };
  const watch = () => { if (!timer) timer = setInterval(poll, 2000); poll(); };
  const begin = async (url, body, kind, failText) => {
    const isLight = kind === "queue" || kind === "prep" || kind === "index";
    if (!isLight && run.active) return say("Đang có một lượt chạy trong cửa sổ chính. Chờ xong rồi chạy.", "var(--warn)");
    const r = await fetch(url, { method: "POST", body: JSON.stringify(body) });
    const answer = await r.json().catch(() => ({}));
    if (!r.ok) return say(answer.error || failText, "var(--error)");
    ticks = 0;
    if (isLight) { runningLight = kind; lightStarted = Date.now(); } else { runningMain = kind; startedAt = Date.now(); }
    refreshButtons(); say("Đang bắt đầu…", "var(--accent)"); watch();
  };

  scanBtn.onclick = () => { if (data) begin("/api/scan/run", { site: data.project.site, max: data.project.max_per_collection || 20 }, "scan", "Chưa bắt đầu quét được."); };
  reviewsBtn.onclick = () => { if (data) begin("/api/project/reviews/run", { project: current }, "reviews", "Chưa bắt đầu cập nhật số review được."); };
  // Thêm vào hàng chờ: first the READY products of the prepared store go into the queue instantly (no agent); Claude only picks scenes for the shortfall.
  // It never starts image creation and writes no review text.
  queueBtn.onclick = async () => {
    if (!data) return;
    if (sceneCount.value === 0) {
      // No scenes wanted: add the first N products of the table (same filters) straight into the queue, no Claude run. The queue writes are mutex-guarded,
      // so this is safe while Bắt đầu runs.
      queueBtn.disabled = true; say("Đang thêm vào hàng chờ…", "var(--accent)");
      const r = await fetch("/api/project/queue/direct", { method: "POST", body: JSON.stringify({ project: current, category: catBox.value, unused_only: unusedOnly.input.checked, count: queueCount.value }) });
      const answer = await r.json().catch(() => ({}));
      refreshButtons();
      if (!r.ok) return say(answer.error || "Chưa thêm vào hàng chờ được.", "var(--error)");
      await loadState().catch(() => {});
      return say(`Đã thêm ${answer.added} sản phẩm (không ảnh bối cảnh). Xem danh sách ở cửa sổ chính.`, "var(--ok)");
    }
    queueBtn.disabled = prepBtn.disabled = true; say("Đang lấy từ kho đã chuẩn bị…", "var(--accent)");
    const r = await fetch("/api/project/queue/run", { method: "POST", body: JSON.stringify({ project: current, category: catBox.value, unused_only: unusedOnly.input.checked, count: queueCount.value, scenes: sceneCount.value }) });
    const a = await r.json().catch(() => ({}));
    if (!r.ok) { refreshButtons(); say(a.error || "Chưa thêm vào hàng chờ được.", "var(--error)"); return; }
    await loadState().catch(() => {});
    const got = a.from_prepared || 0, need = a.needs_claude || 0, dropNote = (a.dropped || []).length ? ` (${a.dropped.length} dòng đã chuẩn bị không còn hợp lệ, đã trả về "chưa chuẩn bị")` : "";
    fastNote = `Đã lấy ${got} từ kho đã chuẩn bị, ${need} cần Claude chọn thêm${dropNote}.`;
    refreshPrepared();
    if (need <= 0 || a.finished) { refreshButtons(); say(a.message ? (got ? `Đã lấy ${got} sản phẩm từ kho đã chuẩn bị${dropNote}. ` : "") + a.message : `Đã lấy ${got} sản phẩm từ kho đã chuẩn bị, không cần Claude${dropNote}. Xem danh sách ở cửa sổ chính.`, got ? "var(--ok)" : "var(--warn)"); return; }
    // the rest is an order of this window: it fills from the stock while Chuẩn bị trước runs, then Claude picks the remainder by itself
    orderActive = true; orderWasActive = true; ticks = 0; refreshButtons(); say((a.order && a.order.line) || fastNote, "var(--accent)"); watch();
  };
  // Chuẩn bị trước: Claude picks the scenes of the not-yet-prepared products and stores them (prepared.csv); the queue is not touched.
  prepBtn.onclick = () => { if (data) begin("/api/project/prep/run", { project: current, category: catBox.value, unused_only: unusedOnly.input.checked, limit: prepCount.value, scenes: prepScenes.value, retry_skipped: retrySkipped.input.checked }, "prep", "Chưa bắt đầu chuẩn bị được."); };
  const stopMainRun = () => fetch(runningMain === "reviews" ? "/api/project/reviews/stop" : "/api/scan/stop", { method: "POST" }).catch(() => {});
  // Dừng stops the light run (index / prep / queue) or the queue order when there is one, else the main run; the second button stops the main run when both run
  stop.onclick = async () => {
    stop.disabled = true; say("Đang dừng " + stop.textContent.replace(/^Dừng ?/, "") + "…", "var(--accent)");
    if (runningLight === "index") await fetch("/api/library/index/stop", { method: "POST" }).catch(() => {});
    else if (runningLight || orderActive) await fetch("/api/project/queue/stop", { method: "POST" }).catch(() => {});
    else if (runningMain) await stopMainRun();
  };
  stopMain.onclick = async () => { stopMain.disabled = true; say("Đang dừng " + stopMain.textContent.replace(/^Dừng ?/, "") + "…", "var(--accent)"); await stopMainRun(); stopMain.disabled = false; };
  // Gắn nhãn kho ảnh: Claude tags the untagged library photos once (light runner, no browser; Bắt đầu keeps running). The index is shared by every project.
  indexBtn.onclick = () => begin("/api/library/index/run", {}, "index", "Chưa bắt đầu gắn nhãn kho ảnh được.");
  openDir.onclick = () => data && api("openPath", { path: data.project.dir });
  catBox.onchange = () => { renderTable(); refreshPrepared(); };
  unusedOnly.input.onchange = () => { renderTable(); refreshPrepared(); };
  // Closing the popup leaves a running scan or review update running; opening it again picks it up.
  view.onClose = () => { if (timer) { clearInterval(timer); timer = null; } };
  view.cancel = close.onclick = () => view.close();
  refreshButtons();
  // Never an empty box while the list loads: the last known list at once (refreshed right after), else a loading line.
  if (window.__prProjectsCache && window.__prProjectsCache.length) { projects = window.__prProjectsCache.filter((p) => !lockedProject || p.id === lockedProject); renderList(); }
  else listBox.replaceChildren(el("div", "label muted", { text: "Đang tải danh sách dự án…", style: { position: "static", padding: "10px", whiteSpace: "normal" } }));
  loadProjects(pick || sessionState.project || "").then(() => watch());
}

async function showProductDialog(target = null) {
  let root;
  try { root = await api("draftOpen"); } catch (e) { return appendLog(e.message); }
  const view = openWindow("Ảnh sản phẩm gốc & ảnh review", 760, 430, { white: true });
  const b = view.body;
  let saved = false;
  view.onClose = () => { document.removeEventListener("paste", onPaste); if (!saved) api("draftDiscard", { root }).catch(() => {}); };
  const urlBox = at(el("input", "text", { value: target ? target.url : "" }), 20, 40, 720, 25);
  const rowsBox = at(el("div", "flow"), 20, 100, 720, 250);
  Object.assign(rowsBox.style, { background: "#fff", border: "1px solid #000" });
  const status = at(label(""), 20, 358, 500, 26);
  status.style.lineHeight = "26px";
  const save = at(button("Lưu sản phẩm"), 516, 388, 120, 30);
  const cancel = at(button("Hủy"), 646, 388, 94, 30);
  b.append(
    at(label("Link sản phẩm"), 20, 16, null, 22), urlBox,
    at(label("Ảnh gốc", "muted"), 26, 76, 70, 22), at(label("Ảnh review của ảnh gốc đó", "muted"), 110, 76, 300, 22),
    rowsBox, status, save, cancel,
  );
  view.cancel = view.close;
  cancel.onclick = view.close;
  const fail = (e) => { status.textContent = e.message; status.style.color = "var(--error)"; };


  // Paste and drop go to the row last used; -1 means "a new product image".
  let products = [], active = -1;
  const attach = async (files, productIndex, asProduct = false) => {
    files = imageFiles(files);
    if (!files.length) return;
    try { await attachPaths(await Promise.all(files.map(upload)), productIndex, asProduct); } catch (e) { fail(e); }
  };
  // asProduct: the picture becomes the product image of row productIndex (replacing it; the row's review images stay).
  const attachPaths = async (paths, productIndex, asProduct = false) => {
    try {
      if (!paths.length) return;
      const role = productIndex < 0 || asProduct ? "Product" : "Scene";
      const url = await api("draftAttach", { root, url: urlBox.value.trim(), paths, role, productIndex });
      if (url !== urlBox.value.trim()) urlBox.value = url;
      if (role === "Product" && !asProduct) active = Number.MAX_SAFE_INTEGER;
      await refresh();
    } catch (e) { fail(e); }
  };
  const thumb = (path, ok, onRemove, title) => {
    const t = picture();
    Object.assign(t.style, { position: "relative", width: "56px", height: "56px", flex: "none", border: "1px solid var(--line)", background: "var(--smoke)", cursor: "pointer" });
    t.set(ok ? path : "");
    t.title = title;
    t.onclick = () => ok && showImagePreview(path, title);
    t.onRemove(onRemove);
    return t;
  };
  const addTile = (text, onPick) => {
    const tile = el("button", "btn", { type: "button", text });
    Object.assign(tile.style, { position: "static", width: "56px", height: "56px", flex: "none", fontSize: text === "+" ? "20px" : "12px", color: "var(--muted)", borderStyle: "dashed", padding: "0", whiteSpace: "normal" });
    tile.onclick = onPick;
    return tile;
  };
  const refresh = async () => {
    const url = urlBox.value.trim();
    try {
      const info = await api("draftInfo", { root, url });
      products = list(info.products).map((p) => ({ ...p, scenes: list(p.scenes) }));
    } catch { products = []; }
    if (active >= products.length) active = products.length - 1;
    const rows = products.map((p, i) => {
      // Product image, arrow, then its reviews; many reviews wrap onto more lines so the add tiles stay visible.
      const row = el("div", "", { style: { display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: "6px", padding: "6px", borderBottom: "1px solid var(--line)" } });
      if (i === active) row.style.background = "var(--hover)";
      // X on the product image clears ONLY that image (its review images stay); the empty slot then offers + / Dán to put a new one in.
      const product = p.file
        ? thumb(p.file, p.ok, async () => { await api("draftClearProduct", { root, url, productIndex: i }).catch(fail); refresh(); }, `Ảnh gốc #${i + 1}`)
        : el("div", "", { style: { position: "static", display: "flex", gap: "6px", flex: "none" } });
      if (!p.file) {
        product.title = "Thêm ảnh gốc cho dòng này (ảnh review giữ nguyên)";
        product.append(addTile("+", async () => { active = i; attachPaths(await chooseImages(""), i, true); }), addTile("Dán", () => { active = i; pasteButton(i, true); }));
      }
      const arrow = el("div", "label muted", { text: "→", style: { position: "static", width: "16px", height: "56px", lineHeight: "56px", textAlign: "center", flex: "none" } });
      product.style.flex = "none";
      const reviews = el("div", "", { style: { display: "flex", flexWrap: "wrap", gap: "6px", flex: "1", minWidth: "0" } });
      row.append(product, arrow, reviews);
      reviews.append(...p.scenes.map((s, k) => thumb(s.file, s.ok, async () => {
        await api("draftRemoveScene", { root, url, productIndex: i, index: k }).catch(fail); refresh();
      }, `Ảnh review ${k + 1} · ảnh gốc #${i + 1}`)), addTile("+ Máy", async () => { active = i; attachPaths(await chooseImages(await api("reviewFolder", { group: state.group }).catch(() => "")), i); }),
        addTile("+ Kho ảnh", async () => { active = i; attachPaths(await showLibraryPicker(), i); }),
        addTile("Dán", () => { active = i; pasteButton(i); }));
      // The row under the pointer receives pasted images.
      const select = () => { if (active !== i) { active = i; for (const [n, r] of [...rowsBox.children].entries()) r.style.background = n === i ? "var(--hover)" : ""; } };
      row.addEventListener("click", select);
      row.addEventListener("mouseenter", select);
      row.addEventListener("dragover", (e) => e.preventDefault());
      row.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); active = i; attach(e.dataTransfer.files, i); });
      return row;
    });
    const addRow = el("div", "", { style: { display: "flex", alignItems: "center", gap: "8px", padding: "6px" } });
    addRow.append(addTile("+", async () => attachPaths(await chooseImages(""), -1)), addTile("Dán", () => pasteButton(-1)), el("div", "label muted", { text: "Thêm ảnh gốc", style: { position: "static" } }));
    addRow.addEventListener("mouseenter", () => { active = -1; for (const r of rowsBox.children) r.style.background = ""; });
    addRow.addEventListener("dragover", (e) => e.preventDefault());
    addRow.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); attach(e.dataTransfer.files, -1); });
    rowsBox.replaceChildren(...rows, addRow);
    const reviews = products.reduce((n, p) => n + p.scenes.length, 0);
    const missing = products.filter((p) => !p.scenes.length).length;
    if (!url) { status.textContent = "Chưa có link"; status.style.color = "var(--muted)"; }
    else if (!products.length) { status.textContent = "● Chưa có ảnh"; status.style.color = "var(--warn)"; }
    else if (missing) { status.textContent = `● ${missing} ảnh gốc chưa có ảnh review`; status.style.color = "var(--warn)"; }
    else { status.textContent = `● ${products.length} ảnh gốc · ${reviews} ảnh review → ${reviews} ảnh kết quả`; status.style.color = "var(--ok)"; }
  };
  // Clipboard: an image goes to the active row (or becomes a product image when none); text in the link box stays text.
  // Nút Dán: images from the clipboard (the browser asks once for clipboard access).
  const pasteButton = async (productIndex, asProduct = false) => {
    const files = [];
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => /^image\/(png|jpeg)$/.test(t));
        if (type) files.push(new File([await item.getType(type)], type === "image/png" ? "clipboard.png" : "clipboard.jpg", { type }));
      }
    } catch {}
    if (files.length) return attach(files, productIndex, asProduct);
    // WebView2 often sees no image: let Windows read the clipboard (picture or copied image files).
    const paths = list(await api("clipboardImages").catch(() => []));
    if (!paths.length) return fail(new Error("Clipboard chưa có ảnh (copy ảnh hoặc file ảnh rồi bấm Dán lại)."));
    attachPaths(paths, productIndex, asProduct);
  };
  // Cmd/Ctrl+V anywhere while this popup is on top, even before anything in it has focus.
  const onPaste = (e) => {
    if (stack.at(-1) !== view) return;
    const files = imageFiles(e.clipboardData?.files || []);
    if (!files.length) return;
    e.preventDefault();
    attach(files, products.length && active >= 0 ? Math.min(active, products.length - 1) : -1);
  };
  document.addEventListener("paste", onPaste);
  rowsBox.addEventListener("dragover", (e) => e.preventDefault());
  rowsBox.addEventListener("drop", (e) => { e.preventDefault(); attach(e.dataTransfer.files, -1); });
  urlBox.oninput = () => { active = -1; refresh(); };
  save.onclick = async () => {
    try {
      const url = urlBox.value.trim();
      const others = state.rows.filter((r) => r !== target).map((r) => r.url.trim());
      const entry = normInfo(await api("draftSave", { root, url, others, group: state.group }));
      saved = true;
      if (target) Object.assign(target, { url, info: entry });
      else state.rows.push({ url, info: entry });
      view.close();
      renderRows();
      updateStatus();
      persist();
      if (!target) ui.flow.scrollTop = ui.flow.scrollHeight;
    } catch (e) { fail(e); }
  };
  await refresh();
  urlBox.focus();
}

// ----- Nhập hàng loạt (Show-ProductQueueBulkDialog): plain links join the list at once; a table (products.csv with images/)
// runs src/import-batch.ps1 in the background, which downloads and attaches the images -----
async function addLinks(urls) {
  const added = [];
  for (const url of urls) {
    const known = state.rows.find((r) => r.url.trim() === url);
    if (known) { added.push(known); continue; }
    const empty = state.rows.find((r) => !r.url.trim());
    if (empty) { empty.url = url; added.push(empty); } else { const row = { url, info: null }; state.rows.push(row); added.push(row); }
  }
  const infos = list(await api("rows", { urls: added.map((r) => r.url) }));
  added.forEach((r, i) => { r.info = normInfo(infos[i]); });
  renderRows();
  persist();
  updateStatus();
}
function showBulkDialog(preset = null) {
  const view = openWindow("Nhập hàng loạt", 760, 480);
  const hint = at(label("Dán link (mỗi dòng một link), hoặc kéo thả thư mục product-import hay file nén của nó (hoặc bấm Chọn file… và chọn products.csv) để app gắn ảnh."), 16, 14, 728, 40);
  hint.style.whiteSpace = "normal";
  const pick = at(button("Chọn file…"), 634, 58, 110, 30);
  const text = at(el("textarea", "text mono"), 16, 96, 728, 262);
  text.wrap = "off";
  const bar = at(el("div", "progress marquee"), 16, 368, 728, 6);
  bar.append(el("span"));
  bar.hidden = true;
  const status = at(label(""), 16, 380, 728, 48);
  status.style.whiteSpace = "pre-line";
  const save = at(button("Nhập", true), 520, 436, 110, 32);
  const cancel = at(button("Hủy"), 640, 436, 104, 32);
  view.body.append(hint, pick, text, bar, status, save, cancel);
  let timer = null, folder = "";
  const fail = (message) => { status.style.color = "var(--error)"; status.textContent = message; };
  const busy = (on) => { text.readOnly = on; save.disabled = on; pick.disabled = on; bar.hidden = !on; };
  pick.onclick = async () => {
    try {
      const [path] = await chooseImages("", true);
      if (!path) return;
      if (/\.(zip|rar|7z)$/i.test(path)) {
        const r = await api("importArchive", { path });
        text.value = r.text; folder = r.folder;
      } else {
        text.value = await api("importFile", { path });
        folder = path.slice(0, path.lastIndexOf("/"));
      }
      status.style.color = ""; status.textContent = "";
    } catch (err) { fail(err.message); }
  };
  // Kéo thả the product-import folder: products.csv is read here, the images/ files are copied for the import.
  const entries = (dir) => new Promise((done) => { const all = [], r = dir.createReader(); const next = () => r.readEntries((b) => b.length ? (all.push(...b), next()) : done(all)); next(); });
  const fileOf = (entry) => new Promise((done, failed) => entry.file(done, failed));
  view.body.addEventListener("dragover", (e) => { e.preventDefault(); view.body.classList.add("dropping"); });
  view.body.addEventListener("dragleave", (e) => { if (!view.body.contains(e.relatedTarget)) view.body.classList.remove("dropping"); });
  view.body.addEventListener("drop", async (e) => {
    e.preventDefault(); view.body.classList.remove("dropping");
    if (save.disabled) return;
    const dropped = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.());
    const zip = dropped.find((x) => x?.isFile && /\.(zip|rar|7z)$/i.test(x.name));
    if (zip) {
      // A packed product-import folder (.zip like the sample, .rar, .7z): unpacked by the app, then read like the folder.
      try {
        status.style.color = ""; status.textContent = "Đang giải nén…";
        const up = await fetch(`/api/upload?import=${Date.now().toString(36)}&name=${encodeURIComponent(zip.name)}`, { method: "POST", body: await fileOf(zip) }).then((x) => x.json());
        if (!up.path) throw new Error(up.error || "Chưa nhận được file nén.");
        const r = await api("importArchive", { path: up.path });
        text.value = r.text; folder = r.folder;
        status.textContent = `Đã nhận ${zip.name}. Bấm Nhập.`;
      } catch (err) { fail(err.message); }
      return;
    }
    const root = dropped.find((x) => x?.isDirectory);
    if (!root) return fail("Kéo thư mục (có products.csv và images/) hoặc file nén (.zip, .rar, .7z) của nó vào đây.");
    try {
      const top = await entries(root);
      const csv = top.find((x) => x.isFile && /\.csv$/i.test(x.name));
      if (!csv) throw new Error("Thư mục chưa có products.csv.");
      const images = top.find((x) => x.isDirectory && x.name === "images");
      const files = images ? (await entries(images)).filter((x) => x.isFile && /\.(jpe?g|png)$/i.test(x.name)) : [];
      if (!files.length) throw new Error("Thư mục images/ chưa có ảnh JPG/PNG.");
      const id = Date.now().toString(36);
      status.style.color = ""; folder = "";
      for (let i = 0; i < files.length; i++) {
        status.textContent = `Đang chép ảnh ${i + 1}/${files.length}…`;
        const r = await fetch(`/api/upload?import=${id}&name=${encodeURIComponent(files[i].name)}`, { method: "POST", body: await fileOf(files[i]) }).then((x) => x.json());
        folder = r.folder;
      }
      text.value = await (await fileOf(csv)).text();
      status.textContent = `Đã nhận ${root.name}: ${files.length} ảnh. Bấm Nhập.`;
    } catch (err) { fail(err.message); }
  });
  const finish = async (s) => {
    clearInterval(timer); timer = null; busy(false); cancel.textContent = "Đóng";
    if (!s) return fail("Chưa nhập được. Thử lại hoặc bấm Báo lỗi.");
    if (s.errors?.length) return fail(s.errors.slice(0, 3).join("\n"));
    await addLinks(list(s.links));
    const summary = `Đã nhập ${list(s.links).length} link, ${s.products} ảnh gốc, ${s.reviews} ảnh review.` + (s.skipped ? ` Bỏ qua ${s.skipped} dòng đã dùng.` : "");
    const failed = list(s.failed);
    if (!failed.length) { view.close(); return; }
    fail(`${summary} Lỗi ${failed.length} ảnh:\n` + failed.slice(0, 2).map((f) => `Dòng ${f.line}: ${f.reason}`).join("; "));
    text.value = ["# Ảnh chưa nhập được (sửa rồi nhập lại các dòng này):", ...failed.map((f) => `# Dòng ${f.line}: ${f.image} - ${f.reason}`)].join("\n");
  };
  save.onclick = async () => {
    status.style.color = ""; status.textContent = "";
    try {
      if (!text.value.trim()) throw new Error("Dán link hoặc bảng nhập trước.");
      const parsed = await api("importParse", { text: text.value, folder });
      if (list(parsed.errors).length) throw new Error(list(parsed.errors).slice(0, 3).join("\n"));
      if (!parsed.images) { await addLinks(list(parsed.links)); view.close(); return; }
      const r = await fetch("/api/import", { method: "POST", body: JSON.stringify({ text: text.value, folder }) });
      if (!r.ok) throw new Error((await r.json()).error);
      busy(true);
      bar.classList.add("marquee");
      const skipNote = parsed.skipped ? ` (bỏ qua ${parsed.skipped} dòng đã dùng)` : "";
      status.textContent = "Đang gắn ảnh…" + skipNote;
      timer = setInterval(async () => {
        const { running, status: s } = await (await fetch("/api/import")).json();
        if (s?.total) { bar.classList.remove("marquee"); bar.firstChild.style.width = `${Math.round((100 * s.done) / s.total)}%`; status.textContent = `Đang gắn ảnh ${s.done}/${s.total}…` + skipNote; }
        if (!running && timer) finish(s);
      }, 600);
    } catch (e) { fail(e.message); }
  };
  // Hủy while importing stops it; images already attached stay on their links.
  view.cancel = cancel.onclick = async () => {
    if (timer) { await fetch("/api/import", { method: "DELETE" }); clearInterval(timer); timer = null; }
    view.close();
  };
  // Opened from Quét web: the scan's products.csv is loaded, its images/ folder sits next to it.
  if (preset?.csv) {
    (async () => {
      try {
        text.value = await api("importFile", { path: preset.csv });
        folder = preset.csv.slice(0, preset.csv.lastIndexOf("/"));
        status.style.color = ""; status.textContent = "Đã nạp bảng quét. Dòng used = T được bỏ qua. Bấm Nhập.";
      } catch (err) { fail(err.message); }
    })();
  }
  text.focus();
}

// ----- Duyệt kết quả (New-BatchReviewDialog) -----
async function showReviewDialog() {
  const view = openWindow("Duyệt kết quả", 924, 721);
  const b = view.body;
  const heading = at(label("Chọn các lần chạy cần duyệt. Tích nhiều ô để duyệt chung một danh sách và xuất một file Loox.", "muted"), 12, 10, 640, 22);
  const pickAll = at(button("Chọn hết"), null, 8, 76, 26, { right: 96, left: false });
  const pickNone = at(button("Bỏ chọn"), null, 8, 76, 26, { right: 12, left: false });
  const runsBox = at(el("div", "runs"), 12, 40, null, 116, { right: 12 });
  const hint = at(label("Mỗi dòng một đánh giá. Bấm ảnh để xem lớn; Giữ cả ảnh, chỉ lấy nội dung hoặc bỏ từng dòng.", "muted"), 12, 162, 900, 22);
  const flow = at(el("div", "flow"), 12, 188, null, null, { right: 12, bottom: 69 });
  const status = at(label(""), 12, null, 520, 36, { bottom: 17, top: false });
  status.style.lineHeight = "36px";
  const exportBtn = at(button("Xuất file Loox", true), null, null, 180, 40, { right: 12, left: false, bottom: 17, top: false });
  exportBtn.disabled = true;
  // Export never opens anything by itself; this opens the folder of the Loox files (the same as Mở kết quả on the main screen).
  const openBtn = at(button("Mở thư mục xuất"), null, null, 150, 40, { right: 204, left: false, bottom: 17, top: false });
  openBtn.onclick = () => api("openPath", { path: state.exports });
  b.append(heading, pickAll, pickNone, runsBox, hint, flow, status, openBtn, exportBtn);
  let items = [], runs = [];
  const chosen = () => runs.filter((r) => r.input.checked).map((r) => r.path);
  const refresh = () => {
    const done = items.filter((i) => i.decision).length, good = items.filter((i) => ["ok", "text"].includes(i.decision)).length;
    if (!chosen().length) { status.textContent = "Tích chọn ít nhất một lần chạy ở trên để duyệt."; exportBtn.disabled = true; return; }
    status.textContent = `Đã chọn ${chosen().length} lần chạy • Đã duyệt ${done}/${items.length} đánh giá • Giữ ${good} • Bỏ ${done - good}`;
    exportBtn.disabled = !(items.length > 0 && done === items.length && good > 0);
  };
  const decideFor = (item, paint) => async (value) => {
    const next = item.decision === value ? "" : value;
    await api("reviewDecide", { batch: item.batch, id: item.id, decision: next, reason: "" });
    item.decision = next;
    paint();
    refresh();
  };
  const load = async () => {
    const picked = chosen();
    items = picked.length ? list(await api("reviewItemsMany", { batches: picked })) : [];
    const width = Math.max(840, flow.clientWidth - 28);
    flow.replaceChildren(...items.map((item, n) => {
      const row = el("div", "rrow", { style: { width: width + "px" } });
      const thumb = at(picture(), 8, 7, 48, 48);
      thumb.style.background = "var(--smoke)";
      thumb.style.cursor = "pointer";
      thumb.set(item.image);
      const title = at(label(`#${n + 1} · ${item.run.slice(11)} · ${item.handle}${item.review_only ? " · review không ảnh" : ""}`), 68, 5, width - 360, 20);
      const bodyText = at(label(item.body, "muted"), 68, 28, width - 360, 24);
      const ok = at(button("Giữ"), width - 306, 17, 64, 28), textOnly = at(button("Chỉ lấy nội dung"), width - 234, 17, 146, 28), bad = at(button("Bỏ"), width - 80, 17, 64, 28);
      const paint = () => {
        ok.classList.toggle("primary", item.decision === "ok");
        textOnly.classList.toggle("primary", item.decision === "text");
        bad.classList.toggle("flat-error", item.decision === "bad");
        row.classList.toggle("ok", ["ok", "text"].includes(item.decision));
        row.classList.toggle("bad", item.decision === "bad");
      };
      const decide = decideFor(item, paint);
      ok.onclick = () => decide("ok");
      textOnly.onclick = () => decide("text");
      bad.onclick = () => decide("bad");
      thumb.onclick = () => showReviewPreview(item, decide);
      paint();
      row.append(thumb, title, bodyText, ok, textOnly, bad);
      return row;
    }));
    refresh();
  };
  // One checkbox per run (newest first); none is chosen when Duyệt opens; the ones already chosen stay chosen when the list is drawn again.
  const drawRuns = (all, keep) => {
    runs = all.map((x) => {
      const row = el("label", "check runrow");
      const input = el("input", "", { type: "checkbox" });
      input.checked = !!keep && keep.has(x.path);
      input.onchange = load;
      row.append(input, document.createTextNode(`${x.name} · ${x.images} ảnh · ${x.pending ? `chưa duyệt ${x.pending}` : "đã duyệt hết"}${x.exported ? " · đã xuất" : ""}`));
      return { path: x.path, input, row };
    });
    runsBox.replaceChildren(...runs.map((r) => r.row));
  };
  pickAll.onclick = () => { runs.forEach((r) => { r.input.checked = true; }); load(); };
  pickNone.onclick = () => { runs.forEach((r) => { r.input.checked = false; }); load(); };
  // Export shows its progress on the button itself; no extra message windows. One file for every chosen run.
  exportBtn.onclick = async () => {
    exportBtn.disabled = true; exportBtn.textContent = "Đang xuất…";
    try {
      const picked = chosen();
      const file = await api("reviewExportAll", { batches: picked });
      exportBtn.textContent = "✓ Đã xuất";
      hint.textContent = "Đã xuất 1 file: " + file;
      drawRuns(list(await api("reviewBatches")), new Set(picked));
      setTimeout(() => { exportBtn.textContent = "Xuất file Loox"; refresh(); }, 2000);
    } catch (e) { status.textContent = e.message; exportBtn.textContent = "Xuất file Loox"; refresh(); }
  };
  const all = list(await api("reviewBatches"));
  drawRuns(all);
  if (!all.length) status.textContent = "Chưa có lần chạy nào để duyệt. Lần chạy tạo ra ảnh sẽ hiện ở đây.";
  else await load();
  return new Promise((resolve) => { view.onClose = resolve; });
}

function showReviewPreview(item, decide) {
  const view = openWindow("Xem ảnh đánh giá", 1080, 720);
  const b = view.body;
  // Left: the product photo above the review photo the image was made from; right: the result.
  const original = at(label("Ảnh sản phẩm gốc"), 12, 12, 500, 24);
  const product = at(picture(), 12, 42, 522, 250);
  const sceneLabel = at(label("Ảnh review ban đầu"), 12, 296, 500, 22);
  const scene = at(picture(), 12, 322, 522, 250);
  const result = at(picture(), 546, 42, 522, 530);
  for (const p of [product, scene, result]) p.style.background = "var(--smoke)";
  product.set(item.product);
  scene.set(item.scene);
  // Review-only item: no generated image, the result pane stays empty (the original review photo is in the pane on the left).
  result.set(item.review_only ? "" : item.image, item.review_only ? "Chỉ review, không có ảnh" : "");
  if (!item.product) original.textContent = "Ảnh sản phẩm gốc · không có";
  if (!item.scene) sceneLabel.textContent = "Ảnh review ban đầu · không có";
  const body = at(el("textarea", "text", { readOnly: true, value: item.body }), 12, 584, 1056, 70);
  const state_ = at(label(""), 12, 674, 540, 28);
  // Giữ or Bỏ decides and closes the window, so there is no separate Đóng; Esc closes without deciding.
  const keep = at(button("Giữ cả ảnh"), 650, 670, 130, 36), textOnly = at(button("Chỉ lấy nội dung"), 790, 670, 146, 36), skip = at(button("Bỏ đánh giá"), 946, 670, 122, 36);
  state_.textContent = { ok: "Đang giữ đánh giá và ảnh", text: "Chỉ giữ nội dung, CSV không có ảnh", bad: "Đang bỏ đánh giá này khỏi CSV" }[item.decision] || "Chưa chọn giữ hoặc bỏ";
  keep.onclick = async () => { await decide("ok"); view.close(); };
  textOnly.onclick = async () => { await decide("text"); view.close(); };
  skip.onclick = async () => { await decide("bad"); view.close(); };
  b.append(original, at(label(item.review_only ? "Chỉ review · không có ảnh kết quả" : "Ảnh kết quả"), 548, 12, 500, 24), product, sceneLabel, scene, result, body, state_, keep, textOnly, skip);
}

// ----- Cấu hình: core/setup/page.html; "← Quay lại" comes back here -----
function showSetupDialog() { location.href = `/setup?back=${encodeURIComponent(location.pathname + location.search)}`; }

// ----- Cập nhật (Show-UpdateDialog): check, then download and install with a running bar -----
function showUpdateDialog() {
  const view = openWindow("Cập nhật", 440, 168);
  const status = at(label(""), 20, 20, 400, 44);
  status.style.whiteSpace = "normal";
  const bar = at(el("div", "progress marquee"), 20, 72, 400, 10);
  bar.append(el("span"));
  const go = at(button("Cập nhật", true), 220, 112, 100, 32), close = at(button("Đóng"), 330, 112, 90, 32);
  go.hidden = true;
  close.onclick = () => { if (!close.disabled) view.close(); };
  view.cancel = close.onclick;
  view.body.append(status, bar, go, close);
  const current = state.version || "bản hiện tại";
  let next = "";
  const check = async () => {
    status.textContent = "Đang kiểm tra bản mới…";
    bar.hidden = false; go.hidden = true;
    try { next = await api("updateCheck"); }
    catch { bar.hidden = true; status.textContent = "Không kiểm tra được bản mới. Kiểm tra mạng rồi thử lại."; return; }
    bar.hidden = true;
    if (!next) { status.textContent = `Đang dùng bản mới nhất (${current}).`; return; }
    status.textContent = `Có phiên bản mới ${next} (đang dùng ${current}).`;
    go.hidden = false; go.focus();
  };
  // The server replaces the files, restarts on them, and the page reloads once it answers again.
  go.onclick = async () => {
    status.textContent = `Đang tải và cài phiên bản ${next}…`;
    bar.hidden = false; go.hidden = true; close.disabled = true;
    const r = await fetch("/api/update", { method: "POST" }).catch(() => null);
    if (!r || !r.ok) {
      bar.hidden = true; close.disabled = false; go.textContent = "Thử lại"; go.hidden = false;
      status.textContent = "Chưa cập nhật được. Kiểm tra mạng rồi thử lại.";
      return;
    }
    status.textContent = "Đã cập nhật. Đang mở lại app…";
    const wait = () => fetch("/api/rpc", { method: "POST", body: JSON.stringify({ cmd: "state", args: {} }) })
      .then((x) => (x.ok ? location.reload() : setTimeout(wait, 500))).catch(() => setTimeout(wait, 500));
    setTimeout(wait, 800);
  };
  check();
}

// ----- run (Start-GuiBatch, timer ticks) -----
const actionLocks = new Set();
function updateActionAvailability() {
  const busy = run.active || actionLocks.size > 0 || stack.length > 0;
  for (const b of [ui.btnFlowOpen, ui.btnFlowCheck]) if (b) b.disabled = busy || flowLogin.checking;
  for (const b of [ui.btnRun, ui.btnSetup, ui.btnLogs, ui.btnReview, ui.btnOut, ui.btnUpdate, ui.btnClearLog, ui.btnAdd, ui.btnBulk, ui.btnClear, ui.btnProjects]) b.disabled = busy;
  // Claude (Flow) cannot start until its own Chrome is signed in to Google Flow.
  if (ui.cmbBackend?.value === "agent" && !flowExtensionMode() && flowLogin.state !== "logged_in") ui.btnRun.disabled = true;
  ui.btnStop.disabled = !run.active;
  // Chạy tiếp continues a Claude (Flow) run, so it is only offered when Tạo ảnh = Claude (Flow); with Codex, Bắt đầu already continues (finished links leave the queue).
  if (ui.btnResume) ui.btnResume.disabled = busy || !ui.resumeRun || ui.btnRun.disabled || !isFlow(ui.cmbBackend?.value);
  ui.numThr.enabled = !busy;
  ui.cmbText.disabled = busy;
  // Both modes keep image generation enabled.
  ui.cmbBackend.disabled = busy;
  ui.flow.style.pointerEvents = busy ? "none" : "";
}
function setActionBusy(reason, on) {
  if (on) actionLocks.add(reason); else actionLocks.delete(reason);
  updateActionAvailability();
}
function setRunning(on) {
  run.active = on;
  updateActionAvailability();
}
function updateRunDisplay() {
  if (!run.active) return;
  const elapsed = Math.floor((Date.now() - run.started) / 1000);
  const time = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  let activity = [...run.stages].filter(([, v]) => !["Đã xong", "Chưa hoàn tất"].includes(v)).sort((a, b) => a[0] - b[0]).map(([k, v]) => `SP ${k}: ${v}`);
  if (run.stage === "Đang lưu kết quả" || !activity.length) activity = [run.stage];
  ui.lblProgress.textContent = `${run.done}/${run.total} ảnh đã xong  •  ${activity.join("  |  ")}  •  ${time}  •  ${run.ai}`;
  // Each job's live stage on its queue row (a link with several images runs several jobs).
  for (const [key, value] of run.stages) {
    const i = run.jobRows.length >= key ? run.jobRows[key - 1] - 1 : key - 1;
    const row = state.rows[i];
    if (!row) continue;
    const done = value === "Đã xong";
    row.stage = { text: done ? "✔ Đã xong" : `◔ ${value}`, color: done ? "var(--ok)" : "var(--accent)" };
  }
  // Only the status labels change during a run; a row drawn before the run started is rebuilt once.
  if (state.rows.some((row) => !statusOf.get(row)?.isConnected)) return renderRows();
  for (const row of state.rows) {
    const status = statusOf.get(row), st = row.stage || rowStatus(row);
    if (status.textContent !== st.text) status.textContent = st.text;
    status.style.color = st.color;
  }
}
const usage = { quota: "Hạn mức: đang lấy…", at: 0, reading: false };
const formatCount = (n) => Number(n).toLocaleString("vi-VN");
// Antigravity and Claude report no tokens here: each finished call is counted instead ([AI-CALL]), and its limit is
// the Google account's own, shown on its site. Codex's tokens and quota only show when Codex is used.
const CALL_NAMES = { antigravity: ["Antigravity", "lượt"], claude: ["Claude", "lượt"] };
const LIMIT_NAMES = { antigravity: "hạn mức Antigravity", claude: "hạn mức Claude" };
// The model line of the run card: Claude (exact version id from Cấu hình) and/or Codex, for the selected backends.
function claudeLabel(id) {
  id = id || "claude-sonnet-4-6";
  for (const g of (modelInfo.claude.claudeModelGroups || [])) { const m = g.models.find((x) => x.id === id); if (m) return [m.label.split(" · ")[0], id]; }
  return [id, id];
}
// The Agent (Cấu hình, mục 5) that drives the browser for Tạo ảnh (Flow) and the other agent runs: Claude or Antigravity.
const agentName = () => (modelInfo.claude.agentBackend === "antigravity" ? "Antigravity" : "Claude");
function agyLabel(id) {
  if (!id) return "model mặc định";
  for (const g of (modelInfo.claude.agyModelGroups || [])) { const m = g.models.find((x) => x.id === id); if (m) return m.label.split(" · ")[0] === id ? id : m.label.split(" · ")[0] + " (" + id + ")"; }
  return id;
}
function updateModelLine() {
  if (!ui.lblModel || !ui.cmbText) return;
  const text = ui.cmbText.value, image = ui.cmbBackend.value;
  const parts = [];
  if (isFlow(image) && agentName() === "Antigravity") {
    const effort = { low: "thấp", medium: "vừa", high: "cao", xhigh: "rất cao", max: "tối đa" }[modelInfo.claude.agyEffort] || "mặc định";
    parts.push(`Antigravity ${agyLabel(modelInfo.claude.agyModel)} · mức: ${effort}` + (run.active && run.modelInUse ? ` · đang chạy: ${run.modelInUse}` : ""));
  }
  if (text === "claude" || (isFlow(image) && agentName() === "Claude")) {
    const [name, id] = claudeLabel(modelInfo.claude.claudeModel);
    const effort = { low: "thấp", medium: "vừa", high: "cao", xhigh: "rất cao", max: "tối đa" }[modelInfo.claude.claudeEffort] || "mặc định";
    parts.push(`Claude ${name === id ? id : name + " (" + id + ")"} · mức: ${effort}` + (run.active && run.modelInUse ? ` · đang chạy: ${run.modelInUse}` : ""));
  }
  if (text === "codex" || image === "codex") parts.push(`Codex ${modelInfo.codex || "model mặc định"}`);
  if (text === "antigravity" && !(isFlow(image) && agentName() === "Antigravity")) parts.push("Antigravity CLI");
  ui.lblModel.textContent = parts.join("  |  ");
  ui.lblModel.title = ui.lblModel.textContent;
}
async function refreshModelInfo() {
  try { const r = await (await fetch("/api/run-settings")).json(); modelInfo.claude = r; } catch {}
  try { modelInfo.codex = String(await api("aiSummary")).replace(/ ((chọn trong Cấu hình|mặc định của Codex))/, ""); } catch {}
  updateModelLine();
}
window.addEventListener("focus", refreshModelInfo);
function updateUsage() {
  updateModelLine();
  if (!ui.lblTokens || !ui.cmbText) return;
  const t = run.tokens || { in: 0, cached: 0, out: 0 };
  const [text, image] = run.active ? [run.text, run.image] : [ui.cmbText.value, ui.cmbBackend.value];
  const usesCodex = text === "codex" || image === "codex";
  const parts = Object.entries(run.calls || {}).map(([k, n]) => `${(CALL_NAMES[k] || [k])[0]}: ${formatCount(n)} ${(CALL_NAMES[k] || [, "lượt"])[1]}`);
  if (t.in || t.out) parts.unshift(`Token: ${formatCount(t.in + t.out)} · vào ${formatCount(t.in)} · ra ${formatCount(t.out)}`);
  ui.lblTokens.textContent = parts.length ? parts.join(" · ") : usesCodex ? "Token: chưa chạy" : "Lượt AI: chưa chạy";
  const web = [...new Set([text, image])].filter((k) => LIMIT_NAMES[k]).map((k) => LIMIT_NAMES[k]);
  const webText = web.length ? `${web.join(", ")} theo tài khoản của AI` : "";
  ui.lblQuota.textContent = !usesCodex ? `Hạn mức: ${webText}, xem trên trang của AI` : web.length ? `${usage.quota} · ${webText}` : usage.quota;
  // Cut with … in a narrow window: the whole line shows on hover.
  for (const l of [ui.lblTokens, ui.lblQuota]) l.title = l.textContent;
}
// Quota beside the run, kept current: read when the window opens, every minute, after each run and, while a run
// goes, after calls that used tokens.
async function refreshQuota() {
  if (usage.reading) return;
  usage.reading = true;
  const text = await api("quotaSummary").catch(() => "");
  Object.assign(usage, { reading: false, at: Date.now() });
  if (text) { usage.quota = text; updateUsage(); }
}

function receive(event) {
  switch (event.Kind) {
    case "Start": run.total = event.Total; break;
    case "Output": run.resultFolder = event.Path; break;
    case "Rows": run.jobRows = list(event.Rows); break;
    case "Item": run.index = event.Index; run.stages.set(event.Index, event.Stage); break;
    case "Stage": run.stages.set(event.Index, event.Stage); run.stage = event.Stage; break;
    case "Retry": run.stages.set(event.Index, event.Stage); break;
    case "Saving": run.stage = event.Stage; break;
    case "Completed": if (run.stages.get(event.Index) !== "Đã xong") run.done++; run.stages.set(event.Index, event.Stage); break;
    case "Failed": run.stages.set(event.Index, event.Stage); run.failure = true; break;
    case "Warning": run.failure = true; break;
    case "Call": run.calls[event.Backend] = (run.calls[event.Backend] || 0) + 1; updateUsage(); break;
    case "Tokens":
      run.tokens.in += event.TokensIn; run.tokens.cached += event.TokensCached; run.tokens.out += event.TokensOut; updateUsage();
      // Quota follows the run: re-read it after a call used tokens, at most every 15 seconds.
      if (!usage.reading && Date.now() - usage.at >= 15000) refreshQuota();
      break;
  }
  if (event.Text) appendLog(event.Text);
}
async function startBatch() {
  if (run.active) return;
  // Use the selected image provider for either run mode.
  if (isFlow(ui.cmbBackend.value)) return startAgent();
  try { await saveQueue(true); } catch (e) { return appendLog(e.message); }
  if (!countUrls()) return messageBox("Vui lòng thêm ít nhất một link sản phẩm.");
  if (!state.codex) return messageBox('Chưa có công cụ xử lý. Bấm "Cấu hình" để xem hướng dẫn.');
  ui.txtLog.value = "";
  Object.assign(run, { since: 0, total: countUrls(), done: 0, index: 0, stages: new Map(), jobRows: [], stage: "Đang chuẩn bị", stopped: false, failure: false, started: Date.now(), resultFolder: "", tokens: { in: 0, cached: 0, out: 0 }, calls: {} });
  updateUsage();
  for (const r of state.rows) r.stage = null;
  await updateReviewButton();
  // The AIs chosen are the only ones used: nothing falls back to Codex without asking (finish()).
  Object.assign(run, { text: ui.cmbText.value, image: ui.cmbBackend.value });
  // Shown on the progress line for the whole run: which AI writes, which one draws.
  run.ai = `Viết review: ${ui.cmbText.selectedOptions[0]?.text} · ` + `Tạo ảnh: ${ui.cmbBackend.selectedOptions[0]?.text}`;
  const r = await fetch("/api/run", { method: "POST", body: JSON.stringify({ threads: ui.numThr.value, backend: run.image, text: run.text }) });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    return appendLog("Chưa khởi động được lượt xử lý: " + (body.error || r.status));
  }
  setRunning(true);
  setStatus("Đang chạy", "var(--accent)");
  setBar(0, 1, true);
  updateRunDisplay();
  poll();
}
// ----- Claude (Google Flow): Claude Code drives Flow and writes the reviews (/api/agent/*); the images then wait in Duyệt -----
const flowLogin = { state: "", checking: false };
// Everyday-Chrome (extension) mode: the own profile is never probed, so the sign-in dot and "Kiểm tra lại" do not apply.
const flowExtensionMode = () => !!ui.flowBrowserSaved && ui.flowBrowserSaved !== "own";
// The chosen everyday-Chrome profile ({ folder, email, accounts, ... } from /api/flow-browser), or null in own-Chrome mode.
const flowProfile = () => (flowExtensionMode() && ui.flowBrowserProfiles?.find((x) => x.folder === ui.flowBrowserSaved)) || null;
// Same rule as core/setup/flow-browser.mjs followFlowAccount: the profile's only account; with several the current one if signed in there, else none.
function followFlowAccount(accounts, current = "") {
  const list = [...new Set((accounts || []).map((a) => String(a || "").toLowerCase()).filter(Boolean))], cur = String(current || "").toLowerCase();
  if (list.length === 1) return list[0];
  return cur && list.includes(cur) ? cur : "";
}
// Google's anti-bot flag hits a whole Chrome PROFILE: a Flow profile should hold one Google account and Flow should use it.
// block = the chosen account is not signed in to the chosen profile (Flow would open another account); warn = the profile holds several
// accounts (or none). Accounts come from Chrome's Local State / Preferences account_info (localChromeProfiles on the server).
function flowAccountCheck() {
  const p = flowProfile();
  if (!p) return { block: "", warn: "", short: "" };
  const accounts = (p.accounts || []).map((a) => String(a).toLowerCase()), acct = String(ui.flowAccount?.value || "").toLowerCase();
  const name = p.folder + (p.email ? " (" + p.email + ")" : "");
  let block = "", warn = "", short = "";
  if (acct && !accounts.includes(acct)) {
    block = `Tài khoản Flow ${acct} không đăng nhập trong profile ${name}${accounts.length ? " (có: " + accounts.join(", ") + ")" : ""}: Flow sẽ mở nhầm tài khoản. Cách sửa: chọn tài khoản của profile này ở ô Tài khoản Flow, hoặc chọn profile Chrome có ${acct}, hoặc đăng nhập ${acct} vào profile này.`;
    short = "● Sai profile";
  }
  if (accounts.length > 1) { warn = `Profile này có ${accounts.length} tài khoản (${accounts.join(", ")}): Google có thể khoá cả profile; nên dùng profile chỉ 1 tài khoản cho Flow.`; short = short || "● " + accounts.length + " tài khoản"; }
  else if (!accounts.length) { warn = "Profile " + name + " chưa đăng nhập tài khoản Google nào: đăng nhập đúng 1 tài khoản cho Flow vào profile này (nút Mở Chrome để đăng nhập)."; short = short || "● Chưa đăng nhập"; }
  return { block, warn, short };
}
// Live under the pickers: a short note on the Tài khoản Flow label row (full text in its tooltip) and the account box border.
function refreshFlowCheck() {
  if (!ui.flowCheck) return;
  const c = flowAccountCheck();
  ui.flowCheck.textContent = c.short;
  ui.flowCheck.title = [c.block, c.warn].filter(Boolean).join("\n\n");
  ui.flowCheck.style.color = c.block ? "var(--error)" : "var(--warn)";
  ui.flowAccount.title = (ui.flowAccount.value || "Tự chọn tài khoản Flow") + (ui.flowCheck.title ? "\n\n" + ui.flowCheck.title : "");
  ui.flowAccount.style.borderColor = c.block ? "var(--error)" : c.warn ? "var(--warn)" : "";
}
// Before Bắt đầu / Chạy tiếp with Claude (Flow): re-read the profiles, stop on a wrong account (the server refuses it too), ask on a warning.
async function flowPreflight() {
  if (ui.cmbBackend?.value === "agent-agy") return true; // Antigravity makes the images itself: no Chrome profile, no Flow account
  await ui.refreshFlowProfiles?.();
  const c = flowAccountCheck();
  if (c.block) { await messageBox(c.block, "Tài khoản Flow"); return false; }
  if (c.warn) return (await messageBox(c.warn + "\n\nVẫn chạy với profile này?", "Kiểm tra profile Chrome", ["Yes", "No"], { Yes: "Vẫn chạy", No: "Huỷ" })) === "Yes";
  return true;
}
function applyFlowBrowserMode() {
  const ext = flowExtensionMode();
  ui.flowDot.style.display = ext ? "none" : "inline-block";
  ui.btnFlowCheck.style.display = ext ? "none" : "";
  if (ext) {
    flowLogin.state = "extension";
    ui.btnFlowOpen.title = "Mở Flow trong profile Chrome đã chọn (" + (ui.flowBrowser.selectedOptions[0]?.text || "") + "), đúng tài khoản Flow đã chọn: thêm một tab vào Chrome đang mở, bạn đăng nhập hoặc kiểm tra ở đó. Tool không kiểm tra đăng nhập ở chế độ này.";
    updateActionAvailability();
  } else {
    ui.btnFlowOpen.title = "Mở Chrome riêng của tool để đăng nhập Google Flow (đăng nhập xong đóng cửa sổ đó rồi Kiểm tra lại).";
    flowLogin.state = ""; if (ui.cmbBackend?.value === "agent") checkFlowLogin();
  }
}
const FLOW_TEXT = {
  logged_in: ["Đã đăng nhập Google Flow", "var(--ok)"],
  logged_out: ["Chưa đăng nhập: nút Bắt đầu đang bị khoá.", "var(--warn)"],
  busy: ["Đang bận (Chrome riêng đang mở hoặc Claude đang chạy).", "var(--warn)"],
  error: ["Chưa kiểm tra được: bấm Kiểm tra lại.", "var(--warn)"],
};
function showFlowLogin(state, detail) {
  flowLogin.state = state;
  const [text, color] = state === "checking" ? ["Đang kiểm tra…", "var(--muted)"] : FLOW_TEXT[state] || ["", "var(--muted)"];
  // The dot in the button says it all; the message and any detail from the check are its tooltip.
  ui.flowDot.style.background = state === "logged_in" ? "var(--ok)" : state === "logged_out" ? "var(--error)" : "var(--muted)";
  ui.btnFlowOpen.title = (text || "Google Flow") + (detail ? ` (${detail})` : "");
  updateActionAvailability();
}
async function checkFlowLogin(fresh = false) {
  if (flowLogin.checking) return;
  flowLogin.checking = true; showFlowLogin("checking");
  const r = await fetch("/api/flow-login/status" + (fresh ? "?fresh=1" : "")).then((x) => x.json()).catch(() => null);
  flowLogin.checking = false;
  showFlowLogin(r?.state || "error", r?.detail || "");
}
async function openFlowLogin() {
  const r = await fetch("/api/flow-login/open", { method: "POST", body: "{}" });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return appendLog("Chưa mở được Chrome đăng nhập: " + (body.error || r.status));
  if (flowExtensionMode()) return appendLog("Đã mở Flow trong profile Chrome đã chọn (thêm một tab vào Chrome đang mở).");
  appendLog("Đã mở Chrome riêng của Claude. Đăng nhập Google, đóng cửa sổ đó rồi bấm Kiểm tra lại.");
  showFlowLogin("busy");
}
function updateAgentControls() {
  const on = isFlow(ui.cmbBackend?.value);
  if (!ui.flowLoginBox) return;
  ui.flowLoginBox.style.display = ui.cmbBackend.value === "agent" ? "" : "none"; // Chrome profile / Flow account / sign-in only for Claude (Flow)
  if (ui.cmbBackend.value === "agent" && !flowLogin.state && !flowLogin.checking && !flowExtensionMode()) checkFlowLogin();
  updateActionAvailability();
  ui.lblTokens.style.display = ui.lblQuota.style.display = on ? "none" : "";
}
async function startAgent() {
  try { await saveQueue(true); } catch (e) { return appendLog(e.message); }
  if (!countUrls()) return messageBox("Vui lòng thêm ít nhất một link sản phẩm.");
  if (!(await flowPreflight())) return;
  ui.txtLog.value = "";
  const r = await fetch("/api/agent/run", { method: "POST", body: JSON.stringify({ text: ui.cmbText.value }) });
  if (!r.ok) { const body = await r.json().catch(() => ({})); return appendLog("Chưa khởi động được " + agentName() + ": " + (body.error || r.status)); }
  attachAgent(Date.now());
}
// Chạy tiếp: which run can be continued (GET /api/agent/resumable), refreshed on load and after every run.
async function refreshResumable() {
  const r = await fetch("/api/agent/resumable").then((x) => x.json()).catch(() => null);
  ui.resumeRun = r?.resumable ? r.run : "";
  if (ui.btnResume) ui.btnResume.title = ui.resumeRun ? `Chạy tiếp lượt ${r.run}: còn ${r.left}/${r.items} ảnh chưa làm (giữ mô tả và chữ đã chọn).` : "Không có lượt dở dang để chạy tiếp.";
  updateActionAvailability();
}
async function resumeRun() {
  if (!ui.resumeRun) return;
  if (!isFlow(ui.cmbBackend?.value)) return appendLog("Chạy tiếp chỉ dùng cho Tạo ảnh = " + agentName() + " (Flow). Với Codex, bấm Bắt đầu: các link đã xong tự rời hàng chờ.");
  if (!(await flowPreflight())) return;
  ui.txtLog.value = "";
  const r = await fetch("/api/agent/run", { method: "POST", body: JSON.stringify({ run: ui.resumeRun }) });
  if (!r.ok) { const body = await r.json().catch(() => ({})); return appendLog("Chưa chạy tiếp được: " + (body.error || r.status)); }
  ui.resumeRun = "";
  attachAgent(Date.now());
}
function attachAgent(started) {
  Object.assign(run, { agent: true, since: 0, total: countUrls(), done: 0, stopped: false, failure: false, started, resultFolder: "", ai: agentName() === "Antigravity" ? "Antigravity (tạo ảnh)" : "Claude (Google Flow)" });
  setRunning(true);
  setStatus("Đang chạy", "var(--accent)");
  setBar(0, 1, true);
  pollAgent();
}
async function resumeAgent() {
  const st = await fetch("/api/agent/status").then((x) => x.json()).catch(() => null);
  // A Quét web or Cập nhật số review run is shown by its own popup, not as a Claude (Flow) run.
  if (st?.active && st.mode !== "scan" && st.mode !== "reviews") attachAgent(Date.now() - st.elapsed_s * 1000);
}
async function pollAgent() {
  if (!run.active || !run.agent) return;
  try {
    const st = await (await fetch("/api/agent/status")).json();
    if (st.result_folder) run.resultFolder = st.result_folder;
    if (st.model_in_use && st.model_in_use !== run.modelInUse) { run.modelInUse = st.model_in_use; updateModelLine(); }
    const elapsed = Math.floor((Date.now() - run.started) / 1000);
    const time = String(Math.floor(elapsed / 60)).padStart(2, "0") + ":" + String(elapsed % 60).padStart(2, "0");
    ui.lblProgress.textContent = `${st.last_text || agentName() + " đang chuẩn bị…"}  •  ${time}  •  ${run.ai}`;
    ui.txtLog.value = (st.tail || []).join("\n"); ui.txtLog.scrollTop = ui.txtLog.scrollHeight;
    if (!st.active) return finishAgent(st);
  } catch {}
  setTimeout(pollAgent, 1500);
}
async function finishAgent(st) {
  setRunning(false);
  run.agent = false; run.modelInUse = "";
  await loadState();
  refreshResumable();
  await updateReviewButton();
  const pending = run.resultFolder ? await api("pending", { batch: run.resultFolder }).catch(() => 0) : 0;
  // The run is over: stop the moving bar (full when finished, empty otherwise) and show a clean line, not Claude's last chat text.
  setBar(st.status === "done" ? 1 : 0, 1);
  const secs = Math.floor((Date.now() - run.started) / 1000);
  const took = `${Math.floor(secs / 60)} phút ${secs % 60} giây`;
  ui.lblProgress.textContent = st.status === "done" ? `Đã xong lượt chạy${pending > 0 ? ` • ${pending} ảnh chờ duyệt` : ""} • ${took} • ${run.ai}`
    : st.status === "stopped" ? `Đã dừng • ${took} • ${run.ai}` : (st.last_text || "Lượt chạy chưa hoàn tất.");
  if (st.status === "stopped") { setStatus("Đã dừng", "var(--muted)"); appendLog("Đã dừng. Các link chưa hoàn tất được giữ lại."); }
  else if (st.status === "done" && pending > 0) { setStatus("Chờ bạn duyệt", "var(--ok)"); appendLog(`Claude đã xong. ${pending} ảnh chờ bạn duyệt: bấm Duyệt & xuất file (Giữ/Bỏ từng ảnh). Claude không tự Giữ/Bỏ.`); }
  else if (st.status === "done") { setStatus("! Cần kiểm tra", "var(--warn)"); appendLog("Claude đã dừng nhưng chưa có ảnh nào chờ duyệt. Xem tiến trình ở trên."); }
  else { setStatus("! Cần thử lại", "var(--warn)"); appendLog("Lượt Claude chưa hoàn tất" + (st.error ? ": " + st.error : ".")); }
}
async function poll() {
  if (!run.active) return;
  try {
    const r = await (await fetch(`/api/run?since=${run.since}`)).json();
    for (const event of r.events) receive(event);
    run.since = r.next;
    if (r.resultFolder) run.resultFolder = r.resultFolder;
    updateRunDisplay();
    if (r.done && !r.running) return finish(r);
  } catch {}
  setTimeout(poll, 700);
}
async function finish(r) {
  setRunning(false);
  setBar(run.done, Math.max(1, run.total));
  for (const row of state.rows) row.stage = null;
  // Finished links leave the queue during the run; their images go too, so the list starts clean.
  await api("pruneMap").catch(() => {});
  await loadState();
  refreshQuota();
  const elapsed = Math.floor((Date.now() - run.started) / 1000);
  ui.lblProgress.textContent = `Đã xong ${run.done}/${run.total} ảnh • ${Math.floor(elapsed / 60)} phút ${elapsed % 60} giây • ${run.ai}`;
  if (r.stopped) { setStatus("Đã dừng", "var(--muted)"); appendLog("Đã dừng. Các link chưa hoàn tất được giữ lại."); }
  else if (r.exitCode === 0 && !run.failure) {
    setStatus("✔ Hoàn tất", "var(--ok)");
    appendLog("Xong. Bấm Duyệt & xuất file để duyệt từng ảnh; file Loox chỉ tạo khi duyệt xong.");
  } else {
    setStatus("! Cần thử lại", "var(--warn)");
    appendLog("Một số sản phẩm chưa hoàn tất. Bạn có thể bấm Bắt đầu để thử lại các link còn lại, hoặc Duyệt & xuất file với các ảnh đã xong.");
    appendLog("Nếu lỗi lặp lại, bấm Báo lỗi để tạo báo cáo cho admin.");
  }
  await updateReviewButton();
  // Another AI was chosen and some links failed: Codex is the steady one, but only on the user's yes, and only for
  // this retry (the choices shown go back to theirs next time).
  const others = [run.text !== "codex" && ui.cmbText.selectedOptions[0]?.text, run.image !== "codex" && run.image !== "none" && ui.cmbBackend.selectedOptions[0]?.text].filter(Boolean);
  if (!r.stopped && (r.exitCode !== 0 || run.failure) && others.length && countUrls()) {
    const answer = await messageBox(`Một số sản phẩm chưa xong với ${others.join(" và ")}. Chạy lại các link còn lại bằng Codex?`, "Chạy lại bằng Codex", ["Yes", "No"], { Yes: "Chạy bằng Codex", No: "Không" });
    if (answer === "Yes") {
      if (run.text !== "codex") ui.cmbText.value = "codex";
      if (run.image !== "codex" && run.image !== "none") ui.cmbBackend.value = "codex";
      startBatch();
    }
  }
}
// Running animation only in the status label.
setInterval(() => { if (run.active && !run.stopped && !run.agent) { run.anim = (run.anim + 1) % 3; setStatus("Đang chạy " + [".", "..", "..."][run.anim], "var(--accent)"); } }, 350);

// ---------- wiring ----------
function wire() {
  ui.btnAdd.onclick = () => showProductDialog();
  ui.btnProjects.onclick = () => showProjectsDialog();
  ui.btnBulk.onclick = showBulkDialog;
  ui.btnClear.onclick = () => { if (run.active) return; state.rows = []; renderRows(); updateStatus(); persist(); };
  // Báo lỗi: src/support-report.mjs runs in the background and keeps the report in workspace/reports; each step
  // shows on the button and in the log.
  ui.btnLogs.onclick = async () => {
    const rejected = await api("rejectedCount").catch(() => 0);
    const question = "Tạo báo cáo lỗi?\n\n" + (rejected ? `Gồm các lỗi từ lần báo trước và ${rejected} đánh giá đã Bỏ (kèm lý do).` : "Gồm các lỗi từ lần báo trước.") + " Báo cáo lưu trên máy (workspace/reports), không kèm ảnh.";
    if ((await messageBox(question, "Báo lỗi", ["Yes", "No"])) !== "Yes") return;
    setActionBusy("report", true); ui.btnLogs.textContent = "Đang tạo…";
    const reset = () => setTimeout(() => { ui.btnLogs.textContent = "Báo lỗi"; setActionBusy("report", false); }, 2500);
    if (!(await fetch("/api/send-errors", { method: "POST" }).then((r) => r.ok).catch(() => false))) { appendLog("Chưa tạo được báo cáo lỗi, thử lại sau."); return reset(); }
    let shown = "";
    const timer = setInterval(async () => {
      const { running, last } = await fetch("/api/send-errors").then((r) => r.json()).catch(() => ({ running: true, last: "" }));
      const [kind, a = "", b = ""] = last.split("|");
      if (kind === "step" && a !== shown) { shown = a; appendLog(a); }
      if (running) return;
      clearInterval(timer);
      if (kind === "saved") { ui.btnLogs.textContent = "✓ Đã lưu"; appendLog(`Đã lưu báo cáo lỗi: ${a}${Number(b) ? ` (kèm ${b} đánh giá đã Bỏ)` : ""}`); api("revealPath", { path: a }); }
      else { ui.btnLogs.textContent = "Báo lỗi"; appendLog(kind === "error" ? `Chưa tạo được báo cáo AI: ${a}` : "Tiến trình dừng không trả kết quả; xem log báo lỗi."); }
      reset();
    }, 700);
  };
  ui.btnClearLog.onclick = () => { ui.txtLog.value = ""; };
  // Kết quả = the Loox files Duyệt & xuất file made, one per export, named by time (workspace/exports). Each run keeps its own images in workspace/output/<run>.
  ui.btnOut.onclick = () => api("openPath", { path: state.exports });
  ui.btnReview.onclick = async () => { if (!run.active) { await showReviewDialog(); updateReviewButton(); } };
  ui.btnSetup.onclick = showSetupDialog;
  ui.btnUpdate.onclick = () => (run.active ? messageBox("Đang xử lý sản phẩm. Chờ chạy xong rồi cập nhật.", "Cập nhật") : showUpdateDialog());

  ui.btnRun.onclick = () => startBatch();
  ui.btnResume.onclick = () => resumeRun();
  refreshResumable();
  ui.btnReload.onclick = async () => {
    if (run.active) return messageBox("Đang chạy. Dừng hoặc chờ xong rồi tải lại.");
    ui.btnReload.disabled = true;
    ui.btnReload.textContent = "Đang tải…";
    const r = await fetch("/api/reload", { method: "POST" }).catch(() => null);
    if (!r || !r.ok) return location.reload();
    const wait = () => fetch("/api/rpc", { method: "POST", body: JSON.stringify({ cmd: "state", args: {} }) })
      .then((x) => (x.ok ? location.reload() : setTimeout(wait, 400))).catch(() => setTimeout(wait, 400));
    setTimeout(wait, 900);
  };
  ui.btnStop.onclick = async () => { if (run.active && run.agent) { run.stopped = true; await fetch("/api/agent/stop", { method: "POST" }); setStatus("Đang dừng...", "var(--accent)"); } else if (run.active) { run.stopped = true; await fetch("/api/stop", { method: "POST" }); setStatus("Đang dừng...", "var(--accent)"); } };
  addEventListener("beforeunload", (e) => { if (run.active) { e.preventDefault(); e.returnValue = ""; } });
  addEventListener("resize", () => renderRows());
}

// A newer release shows on the button, green with its version, without updating anything: checked a few
// seconds after the window opens and every 6 hours.
async function checkUpdate() {
  const next = await api("updateCheck").catch(() => null);
  if (next === null) return;
  ui.btnUpdate.textContent = next ? `Cập nhật ${next}` : "Cập nhật";
  ui.btnUpdate.style.width = next ? "150px" : "100px";
  ui.btnUpdate.classList.toggle("primary", !!next);
  placeSync();
}

// Cấu hình sits 8px left of the update button, Tải lại 8px left of Cấu hình, and the sync line ends 12px before it,
// however wide the update button is.
function placeSync() {
  const setup = 24 + ui.btnUpdate.offsetWidth + 8, reload = setup + ui.btnSetup.offsetWidth + 8;
  ui.btnSetup.style.right = `${setup}px`;
  ui.btnReload.style.right = `${reload}px`;
  ui.syncLabel.style.right = ui.syncBar.style.right = `${reload + ui.btnReload.offsetWidth + 12}px`;
}
const syncView = { timer: 0, hide: 0 };
// Starts Tải về máy for these danh mục; false when one is already running.
async function startSync(names) {
  const r = await fetch("/api/sync", { method: "POST", body: JSON.stringify({ groups: names }) }).catch(() => null);
  if (!r || !r.ok) return false;
  setActionBusy("sync", true);
  clearTimeout(syncView.hide);
  Object.assign(ui.syncLabel.style, { color: "" });
  ui.syncLabel.textContent = "⟳ Đang tải về máy…"; ui.syncLabel.hidden = false;
  ui.syncBar.firstChild.style.width = "0%"; ui.syncBar.hidden = false;
  pollSync();
  return true;
}
async function pollSync() {
  clearTimeout(syncView.timer);
  const r = await fetch("/api/sync").then((response) => response.json()).catch(() => null);
  if (!r) { syncView.timer = setTimeout(pollSync, 1500); return; }
  const s = r.status;
  setActionBusy("sync", !!r.running);
  if (r.running) {
    if (s && !s.finished) {
      const where = s.groups.length > 1 ? `${s.group} (${s.index}/${s.groups.length})` : s.group;
      ui.syncLabel.textContent = `⟳ Đang tải về máy: ${where} · ${formatCount(s.done)}/${formatCount(s.missing)} ảnh`;
      ui.syncBar.firstChild.style.width = `${s.missing ? Math.round((100 * s.done) / s.missing) : 0}%`;
    }
    ui.syncLabel.hidden = ui.syncBar.hidden = false;
    syncView.timer = setTimeout(pollSync, 700);
    return;
  }
  if (ui.syncLabel.hidden || !s) return;
  ui.syncBar.hidden = true;
  const ok = s.groups.length - s.failed.length, failed = list(s.failed);
  ui.syncLabel.textContent = ok
    ? `✓ Đã tải về máy ${s.groups.length > 1 ? `${ok} danh mục` : s.group}: ${formatCount(s.total)} ảnh (vừa tải ${formatCount(s.downloaded)})${failed.length ? ` · chưa tải được: ${failed.join(", ")}` : ""}`
    : `Chưa tải được về máy: ${failed.join(", ")}. Kiểm tra mạng và mật khẩu app.`;
  ui.syncLabel.style.color = failed.length ? "var(--error)" : "var(--ok)";
  syncView.hide = setTimeout(() => { ui.syncLabel.hidden = true; }, 12000);
}

buildMain();
wire();
loadState().catch((e) => appendLog(e.message));
setTimeout(checkUpdate, 3000);
placeSync();
fetch("/api/sync").then((r) => r.json()).then((r) => { if (r.running) { ui.syncLabel.hidden = false; pollSync(); } }).catch(() => {});
updateUsage();
setTimeout(refreshQuota, 2000);
setInterval(refreshQuota, 60 * 1000);
setInterval(checkUpdate, 6 * 3600 * 1000);
