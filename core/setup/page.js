// Cấu hình page (core/setup/page.html): the steps from setup-check.ps1 (POST /api/setup), each AI with the account it is
// signed in to, a button on each that can be fixed or changed, then Model AI. "← Quay lại" goes to ?back= (the page it
// was opened from), so the menu and every tool share this one page.
(() => {
  const $ = (s) => document.querySelector(s);
  const post = (path, data, method = "POST") => fetch(path, { method, body: data ? JSON.stringify(data) : undefined }).then((r) => r.json()).catch(() => ({ error: "Không kết nối được." }));
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});
  // Only a page of this server: a path, never another site.
  const back = new URLSearchParams(location.search).get("back");
  const backUrl = back && back.startsWith("/") && !back.startsWith("//") ? back : "/";
  $(".back").onclick = () => { location.href = backUrl; };
  fetch("/api/root").then((r) => r.json()).then((r) => { if (r.version) document.title = `Cấu hình ${r.version}`; }).catch(() => {});

  // Which section each step is in, in this order; anything else the check adds goes under Cài đặt.
  const AI = ["login", "antigravity"];
  const BASE = ["node", "codex"];
  const marks = { ok: ["✔", "darkgreen"], fail: ["✖", "firebrick"], warn: ["!", "#b06000"] };
  const items = new Map();
  const item = (id, parent) => {
    const box = el("div", "item"), mark = el("span", "mark", "○"), body = el("div", "body"), side = el("div", "side");
    const name = el("div", "name"), account = el("div", "account"), detail = el("div", "detail", "Đang kiểm tra…"), uses = el("div", "uses"), extra = el("div");
    const fix = el("button", "btn", ""); fix.type = "button"; fix.hidden = true;
    body.append(name, account, detail, uses, extra); side.append(fix);
    box.append(mark, body, side);
    parent.append(box);
    const row = { box, mark, name, account, detail, uses, extra, fix, side };
    items.set(id, row);
    return row;
  };
  for (const id of AI) item(id, $("#ai"));
  for (const id of BASE) item(id, $("#base"));
  const NAMES = { login: "Codex (ChatGPT)", antigravity: "Antigravity CLI", node: "Node.js", codex: "Codex" };
  for (const [id, row] of items) row.name.textContent = NAMES[id];
  const LABELS = { install: "Cài", login: "Đăng nhập", antigravity: "Đăng nhập" };
  // Beside the sign-in button: the AI's own site in Chrome, to see or switch the account there.
  const SITES = { login: [["Mở ChatGPT", "chatgpt"]] };
  const WAIT = {
    install: "Đang cài…",
    login: "Đang mở trang đăng nhập…",
    antigravity: "Đã mở Terminal: gõ /login, xong bấm Kiểm tra lại.",
    site: "Đã mở trang. Xong bấm Kiểm tra lại.",
  };

  // Cài / cập nhật tất cả AI: Codex and Antigravity CLI (server: step update-all), then the check again.
  $(".all").onclick = async () => {
    const button = $(".all"), note = $("#all-result");
    button.disabled = true; note.hidden = false;
    note.textContent = "Đang cài và cập nhật…";
    const r = await post("/api/setup-step", { step: "update-all" });
    const results = r.results || [{ name: "Lỗi", ok: false, message: r.error || "Không chạy được." }];
    note.replaceChildren(...results.map((x) => el("div", "", `${x.ok ? "✔" : "✖"} ${x.name}${x.message ? ": " + x.message : ""}`)));
    button.disabled = false;
    check();
  };

  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    $(".again").disabled = true;
    for (const row of items.values()) { row.mark.textContent = "○"; row.mark.style.color = ""; row.detail.textContent = "Đang kiểm tra…"; row.fix.hidden = true; row.side.querySelectorAll(".site").forEach((b) => b.remove()); }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 60000);
    const report = await fetch("/api/setup", { method: "POST", signal: abort.signal, cache: "no-store" }).then((r) => r.json())
      .catch((e) => ({ error: e.name === "AbortError" ? "Kiểm tra quá thời gian. Bấm Kiểm tra lại." : "Mất kết nối với app. Bấm Kiểm tra lại." }));
    clearTimeout(timer);
    const steps = [].concat(report.Steps || []);
    if (!steps.length) for (const row of items.values()) { row.mark.textContent = "!"; row.mark.style.color = marks.warn[1]; row.detail.textContent = report.error || "Chưa kiểm tra được. Bấm Kiểm tra lại."; }
    const quota = steps.find((s) => s.Id === "quota");
    for (const step of steps) {
      const row = items.get(step.Id) || (step.Id !== "quota" && item(step.Id, $("#base")));
      if (!row) continue;
      if (!NAMES[step.Id]) row.name.textContent = step.Title;
      const [mark, color] = marks[step.State] || ["○", ""];
      row.mark.textContent = mark; row.mark.style.color = color;
      // Status only: the first clause of the check's detail ("Chưa cài", "Đã đăng nhập"), never its explanation.
      const brief = (d) => String(d || "").split(/\.\s|\s\(|\s[—–-]\s|:\s/)[0].trim();
      row.detail.textContent = brief(step.Detail);
      // The AIs: whose account, and what it is used for; Codex also shows what is left of its quota.
      const isAi = AI.includes(step.Id);
      row.account.hidden = !isAi;
      // Expired or signed out still names whose account it was (setup-check.ps1 keeps the last one seen).
      const lapsed = { expired: " · hết hạn", signedout: " · đã đăng xuất" }[step.SignIn] || "";
      row.account.textContent = step.Account ? `Tài khoản: ${step.Account}${lapsed}` : step.State === "ok" ? "Tài khoản: chưa đọc được email" : "Tài khoản: chưa đăng nhập";
      row.account.classList.toggle("none", !step.Account || !!lapsed);
      row.uses.textContent = "";
      if (step.Id === "login" && quota && quota.State !== "wait" && quota.Detail) row.detail.textContent = `${brief(step.Detail)} · Hạn mức: ${quota.Detail}`;
      if (step.Action) {
        const signedIn = step.State === "ok";
        row.fix.textContent = signedIn && ["login", "antigravity"].includes(step.Action) ? "Đổi tài khoản" : ["expired", "signedout"].includes(step.SignIn) ? "Đăng nhập lại" : LABELS[step.Action] || "Mở";
        row.fix.classList.toggle("primary", !signedIn);
        row.fix.hidden = false;
        row.fix.onclick = () => fix(step, row);
      }
      if (step.Action && SITES[step.Id]) for (const [text, site] of SITES[step.Id]) {
        const b = el("button", "btn site", text);
        b.type = "button";
        b.onclick = () => fix({ ...step, Action: "site" }, row, site);
        row.side.append(b);
      }
    }
    if (!items.get("login").detail.dataset.code) watchLogin();
    $(".again").disabled = false;
    checking = false;
  };

  // While Codex signs in: the one-time code to type on the page opened in Chrome, with Chép mã.
  let watching = 0;
  const watchLogin = () => {
    if (watching) return;
    watching = setInterval(async () => {
      const { code } = await fetch("/api/setup-login").then((r) => r.json()).catch(() => ({}));
      const detail = items.get("login").detail;
      if (!code) { if (detail.dataset.code) { delete detail.dataset.code; } return; }
      if (detail.dataset.code === code && detail.querySelector(".copy-code")) return;
      detail.dataset.code = code;
      const copy = el("button", "copy-code", "Chép mã");
      copy.type = "button";
      copy.onclick = async () => {
        // The clipboard API needs a focused page; the old copy command covers the rest.
        const done = await navigator.clipboard.writeText(code).then(() => true, () => {
          const box = Object.assign(document.createElement("textarea"), { value: code });
          document.body.append(box); box.select();
          const ok = document.execCommand("copy");
          box.remove();
          return ok;
        });
        copy.textContent = done ? "Đã chép" : "Chưa chép được";
        setTimeout(() => { copy.textContent = "Chép mã"; }, 2000);
      };
      detail.replaceChildren(`Mã đăng nhập: ${code} `, copy);
      for (const b of buttons()) b.disabled = false;
    }, 1000);
  };

  // Installing, opening Chrome or signing in runs on this computer; the steps are checked again after.
  const buttons = () => [...document.querySelectorAll(".item .side .btn")];
  const fix = async (step, row, site) => {
    for (const b of buttons()) b.disabled = true;
    row.detail.textContent = WAIT[step.Action] || "Đang mở…";
    if (step.Action === "login") watchLogin();
    const r = await post("/api/setup-step", { step: step.Action, site });
    if (r.superseded) return;
    for (const b of buttons()) b.disabled = false;
    // Signing in on a site or in Antigravity happens outside this page: keep the hint until Kiểm tra lại.
    if (["antigravity", "site"].includes(step.Action) && !r.error) return;
    await check();
    if (r.error) row.detail.textContent = r.error;
  };
  $(".again").onclick = () => { check(); usage(); };

  // Lượt dùng AI (GET /api/usage): calls, failures and Codex tokens per AI and account; the last failure with its cause.
  const CAUSES = { QUOTA: "Hết lượt", AUTH: "Chưa đăng nhập", AI_TIMEOUT: "Quá thời gian", NETWORK: "Mất mạng", BUSY: "AI bận hoặc lỗi", PROCESS_ACTIVE: "Codex chưa dừng hẳn", UNSUPPORTED: "AI không làm được việc này", POLICY: "Bị từ chối (chính sách)", UNKNOWN: "Lỗi khác" };
  const when = (t) => { const d = new Date(t); return `${d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })} ${d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" })}`; };
  const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",")}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
  const usage = async () => {
    const r = await fetch("/api/usage", { cache: "no-store" }).then((x) => x.json()).catch(() => ({ error: "Chưa đọc được lượt dùng." }));
    const body = $("#usage");
    const rows = [].concat(r.rows || []);
    if (!rows.length) {
      const tr = el("tr");
      tr.append(Object.assign(el("td", "sub", r.error || "Chưa có lượt gọi AI nào."), { colSpan: 5 }));
      return body.replaceChildren(tr);
    }
    body.replaceChildren(...rows.map((row) => {
      const tr = el("tr");
      const who = el("td");
      who.append(el("div", "", row.name), el("div", "sub", row.account || (row.ai === "chatgpt" ? "tài khoản ChatGPT trong Chrome" : row.ai === "antigravity" ? "tài khoản trong Antigravity" : "tài khoản mặc định")));
      tr.append(who);
      for (const w of ["today", "week", "month"]) {
        const c = row[w], td = el("td", "num");
        td.append(el("div", "", `${c.calls} lượt`));
        const sub = [c.fail ? `${c.fail} lỗi` : "", c.tokens ? `${tokens(c.tokens)} token` : ""].filter(Boolean).join(" · ");
        if (sub) td.append(el("div", "sub", sub));
        tr.append(td);
      }
      const fail = el("td");
      if (row.lastFail) {
        fail.append(el("div", row.lastFail.cause === "QUOTA" && !row.okSinceFail ? "warn" : "", `${CAUSES[row.lastFail.cause] || row.lastFail.cause} · ${when(row.lastFail.t)}`));
        fail.append(el("div", "sub", row.okSinceFail ? "đã chạy được lại sau đó" : "chưa chạy được lần nào sau đó"));
      } else fail.append(el("div", "sub", "Không có"));
      tr.append(fail);
      return tr;
    }));
  };
  usage();

  // Model AI: the model and reasoning level Codex uses; empty keeps Codex's own default. Saved for every tool.
  const model = $(".model"), effort = $(".effort");
  const effortNames = { low: "Thấp · ít token nhất", medium: "Vừa", high: "Cao", xhigh: "Rất cao", max: "Tối đa", ultra: "Siêu cao" };
  let models = [];
  const fill = (select, values, labels, value) => { select.replaceChildren(...values.map((v, i) => Object.assign(el("option", "", labels[i]), { value: v }))); select.value = values.includes(value) ? value : ""; };
  const fillEfforts = (value) => {
    const m = models.find((x) => x.slug === model.value);
    const efforts = ["", ...(m ? [].concat(m.efforts || []) : ["low", "medium", "high"])];
    fill(effort, efforts, efforts.map((e) => (e ? effortNames[e] + (m && e === m.default_effort ? " (mặc định)" : "") : "Mức suy nghĩ mặc định")), value);
  };
  model.onchange = effort.onchange = async () => {
    fillEfforts(effort.value);
    const r = await post("/api/config/ai", { model: model.value, effort: effort.value });
    if (r.error) alert(r.error);
  };
  fetch("/api/config/ai").then((r) => r.json()).then((r) => {
    models = [].concat(r.models || []);
    const saved = r.settings || {};
    if (saved.model && !models.some((m) => m.slug === saved.model)) models.unshift({ slug: saved.model, name: saved.model, efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], default_effort: "" });
    fill(model, ["", ...models.map((m) => m.slug)], ["Model mặc định của Codex", ...models.map((m) => m.name)], saved.model || "");
    fillEfforts(saved.effort || "");
  }).catch(() => { fill(model, [""], ["Model mặc định của Codex"], ""); fillEfforts(""); });
  // Model AI của Claude: run-settings.json of THIS window. claudeModel = a listed alias / id or a custom id (default claude-sonnet-4-6); claudeEffort = claude --effort, "" = no flag.
  // The model list comes from the server (GET /api/run-settings claudeModelGroups), one source.
  const cmodel = $(".cmodel"), ceffort = $(".ceffort"), ccustom = $(".ccustom");
  const CUSTOM = "__custom", CE = ["", "low", "medium", "high", "xhigh", "max"], DEFAULT_CM = "claude-sonnet-4-6", CM_RE = /^[A-Za-z0-9._\-\[\]]{1,60}$/;
  const effLabel = (e) => (e ? effortNames[e] : "Mức suy nghĩ mặc định");
  let cgroups = [];
  const fillClaudeModels = (value) => {
    const ids = cgroups.flatMap((g) => g.models.map((m) => m.id));
    const custom = !ids.includes(value);
    const opts = cgroups.map((g) => { const og = el("optgroup"); og.label = g.family + " · " + g.note; og.append(...g.models.map((m) => Object.assign(el("option", "", m.label), { value: m.id }))); return og; });
    cmodel.replaceChildren(...opts, Object.assign(el("option", "", "Khác (nhập mã model)"), { value: CUSTOM }));
    cmodel.value = custom ? CUSTOM : value;
    ccustom.value = custom ? value : "";
    ccustom.style.visibility = custom ? "visible" : "hidden";
  };
  const saveClaude = async () => {
    const custom = cmodel.value === CUSTOM;
    const model = custom ? ccustom.value.trim() : cmodel.value;
    ccustom.style.visibility = custom ? "visible" : "hidden";
    ccustom.classList.toggle("bad", custom && !!model && !CM_RE.test(model));
    if (custom && !CM_RE.test(model)) return; // wait for a valid id
    const r = await post("/api/run-settings", { claudeModel: model, claudeEffort: ceffort.value });
    if (r.error) alert(r.error);
  };
  fill(ceffort, CE, CE.map(effLabel), "");
  cmodel.onchange = () => { if (cmodel.value === CUSTOM) { ccustom.style.visibility = "visible"; ccustom.focus(); if (!ccustom.value.trim()) return; } saveClaude(); };
  ccustom.onchange = ceffort.onchange = saveClaude;
  fetch("/api/run-settings").then((r) => r.json()).then((r) => {
    cgroups = r.claudeModelGroups || [];
    fillClaudeModels(r.claudeModel || DEFAULT_CM);
    fill(ceffort, CE, CE.map(effLabel), r.claudeEffort || "");
  }).catch(() => {});
  // Agent chạy Flow: run-settings.json agentBackend (claude | antigravity) + agyModel / agyEffort of THIS window; the model list is `agy models` read by the server (static list when agy cannot answer).
  const amodel = $(".amodel"), aeffort = $(".aeffort");
  const fillAgy = (groups, value) => {
    const ids = groups.flatMap((g) => g.models.map((m) => m.id));
    const opts = groups.map((g) => { const og = el("optgroup"); og.label = g.family + (g.note ? " · " + g.note : ""); og.append(...g.models.map((m) => Object.assign(el("option", "", m.label), { value: m.id }))); return og; });
    const extra = value && !ids.includes(value) ? [Object.assign(el("option", "", value), { value })] : [];
    amodel.replaceChildren(Object.assign(el("option", "", "Model mặc định của Antigravity"), { value: "" }), ...extra, ...opts);
    amodel.value = value || "";
  };
  const saveAgy = async () => { const r = await post("/api/run-settings", { agyModel: amodel.value, agyEffort: aeffort.value }); if (r.error) alert(r.error); };
  fill(aeffort, CE, CE.map(effLabel), "");
  amodel.onchange = aeffort.onchange = saveAgy;
  fetch("/api/run-settings").then((r) => r.json()).then((r) => {
    fillAgy(r.agyModelGroups || [], r.agyModel || "");
    fill(aeffort, CE.filter((x) => x !== "max"), CE.filter((x) => x !== "max").map(effLabel), r.agyEffort || "");
  }).catch(() => {});
  // ----- Cách chạy: everything the main window used to hold (Viết review, Tạo ảnh, Luồng, Chrome profile, Tài khoản Flow, token, Mở Chrome),
  // saved in the same run-settings.json / flow-browser files through the same endpoints. The main window re-reads them when it is shown again
  // (Quay lại, focus), so nothing needs a reload. Shown only on Product Review's server (the others have no /api/run-settings).
  const rvScan = $(".rv-scan"), rvReviews = $(".rv-reviews"), rvQueue = $(".rv-queue");
  const runSec = $("#run-sec"), rvText = $(".rv-text"), rvImage = $(".rv-image"), rvThreads = $(".rv-threads"), flowOnly = $("#flow-only");
  const fbProfile = $(".fb-profile"), fbInstall = $(".fb-install"), fbAccount = $(".fb-account"), fbCheck = $(".fb-check"), tokBox = $(".fb-token-box"), tokLabel = $(".fb-token-label");
  const tokInput = $(".fb-token"), tokSave = $(".fb-token-save"), tokClear = $(".fb-token-clear"), fbOpen = $(".fb-open"), fbRecheck = $(".fb-recheck"), fbDot = $(".fb-open .dot");
  let rs = {}, fb = { mode: "own", profile: "", profiles: [] };
  const saveRs = (part) => post("/api/run-settings", part);
  const imageValue = (r) => (r.imageBackend === "agent" ? (r.agentBackend === "antigravity" ? (r.agyImages === "flow" ? "agent-agy-flow" : "agent-agy") : "agent") : "codex");
  const curProfile = () => (fb.mode === "own" ? null : fb.profiles.find((x) => x.folder === fb.profile) || null);
  const flowShown = () => rvImage.value === "agent" || rvImage.value === "agent-agy-flow"; // the ones that drive Google Flow in Chrome
  const refreshCheck = () => {
    const c = window.FlowCheck.flowAccountCheck(curProfile(), fbAccount.value);
    fbCheck.textContent = c.short; fbCheck.title = [c.block, c.warn].filter(Boolean).join("\n\n");
    fbCheck.style.color = c.block ? "#b22222" : "#b06000";
    fbAccount.style.borderColor = c.block ? "#b22222" : c.warn ? "#b06000" : "";
  };
  const refreshToken = () => {
    const p = curProfile(), show = !!p && p.playwright_extension;
    tokBox.hidden = !show;
    if (!show) return;
    const saved = !!p.token_saved;
    tokInput.placeholder = saved ? "Dán token mới để thay" : "Dán token của profile này";
    tokLabel.textContent = saved ? "Token Playwright · đã lưu token" : "Token Playwright (tùy chọn)";
  };
  const refreshFlowMode = () => {
    flowOnly.hidden = !flowShown();
    const ext = fb.mode !== "own", p = curProfile();
    fbDot.style.display = fbRecheck.style.display = ext ? "none" : "";
    fbInstall.hidden = !p || p.playwright_extension;
    refreshToken(); refreshCheck();
    if (!ext && flowShown()) loginDot(false);
  };
  const loginDot = async (fresh) => {
    fbDot.style.background = "var(--muted)";
    const r = await fetch("/api/flow-login/status" + (fresh ? "?fresh=1" : "")).then((x) => x.json()).catch(() => null);
    fbDot.style.background = r?.state === "logged_in" ? "darkgreen" : r?.state === "logged_out" ? "firebrick" : "var(--muted)";
    fbOpen.title = ({ logged_in: "Đã đăng nhập Google Flow", logged_out: "Chưa đăng nhập", busy: "Đang bận" }[r?.state] || "Chưa kiểm tra được") + (r?.detail ? " (" + r.detail + ")" : "");
  };
  const loadFb = () => fetch("/api/flow-browser").then((r) => r.json()).then((j) => {
    fb = { mode: j.mode === "own" ? "own" : "extension", profile: j.profile || "", profiles: j.profiles || [] };
    const items = ["own", ...fb.profiles.map((p) => p.folder)], labels = ["Chrome riêng của tool", ...fb.profiles.map((p) => ((p.email || p.name || p.folder).split("@")[0]) + " · " + p.folder + (p.playwright_extension ? "" : " · chưa có extension"))];
    fill(fbProfile, items, labels, fb.mode === "own" ? "own" : fb.profile);
    fbProfile.title = fbProfile.selectedOptions[0]?.textContent || "";
  }).catch(() => {});
  const loadAccounts = (saved) => {
    const cur = String(saved.flowAccount || "").toLowerCase(), list = [...new Set([...(saved.flowAccounts || []), ...(cur ? [cur] : [])])];
    fill(fbAccount, ["", ...list], ["Tự chọn tài khoản Flow", ...list], cur);
  };
  const loadRun = async () => {
    const r = await fetch("/api/run-settings").then((x) => (x.ok ? x.json() : Promise.reject())).catch(() => null);
    if (!r) return;
    rs = r; runSec.hidden = false;
    fill(rvText, ["auto", "codex", "antigravity", "claude"], ["Tự động (agent)", "Codex", "Antigravity CLI", "Claude"], r.reviewAi || "auto");
    fill(rvImage, ["codex", "agent", "agent-agy", "agent-agy-flow"], ["Codex", "Claude (Flow)", "Antigravity", "Antigravity (Flow)"], imageValue(r));
    rvThreads.value = r.threadsSaved ? r.threads : rvImage.value === "codex" ? 2 : 1; // Codex keeps its old default 2 until a value is saved
    // Quét web / Cập nhật review / Hàng chờ & chuẩn bị: Claude or Antigravity (Codex has no browser mode). Older windows: the server answers with their old single agent.
    for (const [box, key] of [[rvScan, "scanAgent"], [rvReviews, "reviewsAgent"], [rvQueue, "queueAgent"]]) fill(box, ["claude", "antigravity"], ["Claude", "Antigravity"], r[key] === "antigravity" ? "antigravity" : "claude");
    loadAccounts(r);
    await loadFb();
    refreshFlowMode();
  };
  rvText.onchange = () => saveRs({ reviewAi: rvText.value });
  rvImage.onchange = async () => {
    // Claude (Flow) and Antigravity are the same agent run driven by a different agent (agentBackend); Codex leaves the agent as it is.
    const v = rvImage.value, part = v === "codex" ? { imageBackend: "codex" } : { imageBackend: "agent", agentBackend: v === "agent" ? "claude" : "antigravity", agyImages: v === "agent-agy-flow" ? "flow" : "self" };
    await saveRs(part);
    if (!rs.threadsSaved) rvThreads.value = v === "codex" ? 2 : 1;
    refreshFlowMode();
  };
  rvScan.onchange = () => saveRs({ scanAgent: rvScan.value });
  rvReviews.onchange = () => saveRs({ reviewsAgent: rvReviews.value });
  rvQueue.onchange = () => saveRs({ queueAgent: rvQueue.value });
  rvThreads.onchange = () => { const n = Math.max(1, Math.min(4, Math.round(Number(rvThreads.value)) || 1)); rvThreads.value = n; rs.threadsSaved = true; saveRs({ threads: n }); };
  fbProfile.onchange = async () => {
    const v = fbProfile.value;
    const r = await post("/api/flow-browser", v === "own" ? { mode: "own" } : { mode: "extension", profile: v });
    if (r.error) { alert(r.error); return loadRun(); }
    // the server moves the Flow account to the new profile (alignFlowAccount): re-read everything
    await loadRun();
  };
  fbAccount.onchange = async () => { const r = await saveRs({ flowAccount: fbAccount.value }); if (r.error) alert(r.error); refreshCheck(); };
  fbInstall.onclick = async () => { const r = await post("/api/flow-browser/install-extension", { profile: fbProfile.value }); if (r.error) alert(r.error); };
  const saveToken = async (token) => {
    const profile = fbProfile.value;
    const r = await post("/api/flow-browser/token", { profile, token });
    tokInput.value = "";
    if (r.error) return alert(r.error);
    const p = fb.profiles.find((x) => x.folder === profile); if (p) p.token_saved = !!r.token_saved;
    refreshToken();
    alert(r.token_saved ? "Đã lưu token cho " + profile + ": chạy không cần bấm Connect." : "Đã xoá token. Chưa lưu token: mỗi lượt bấm Connect.");
  };
  tokSave.onclick = () => { const t = tokInput.value.trim(); if (t) saveToken(t); else { alert("Dán token (trang Playwright MCP Bridge của profile " + fbProfile.value + ") vào ô rồi bấm Lưu."); tokInput.focus(); } };
  tokInput.addEventListener("keydown", (e) => { if (e.key === "Enter") tokSave.click(); });
  tokClear.onclick = () => {
    const p = curProfile();
    if (p && !p.token_saved) { tokInput.value = ""; return alert("Profile " + p.folder + " chưa lưu token."); }
    if (confirm("Xoá token của " + fbProfile.value + "? Các lượt sau sẽ cần bấm Connect.")) saveToken("");
  };
  fbOpen.onclick = async () => {
    const r = await post("/api/flow-login/open", {});
    if (r.error) return alert("Chưa mở được Chrome đăng nhập: " + r.error);
    if (fb.mode === "own") fbDot.style.background = "var(--muted)";
  };
  fbRecheck.onclick = () => loginDot(true);
  addEventListener("focus", () => { if (!runSec.hidden && flowShown()) loadFb().then(refreshFlowMode); });
  loadRun();
  check();
})();
