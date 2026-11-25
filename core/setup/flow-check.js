// Shared by the main window (preflight before Bắt đầu / Chạy tiếp) and Cấu hình (live note under Tài khoản Flow): one source for the
// Flow profile / account check. window.FlowCheck.flowAccountCheck(profile, account) -> { block, warn, short }.
(() => {
  // Google's anti-bot flag hits a whole Chrome PROFILE: a Flow profile should hold one Google account and Flow should use it.
  // block = the chosen account is not signed in to the chosen profile (Flow would open another account); warn = the profile holds several
  // accounts (or none). Accounts come from Chrome's Local State / Preferences account_info (localChromeProfiles on the server).
  function flowAccountCheck(p, account) {
    if (!p) return { block: "", warn: "", short: "" };
    const accounts = (p.accounts || []).map((a) => String(a).toLowerCase()), acct = String(account || "").toLowerCase();
    const name = p.folder + (p.email ? " (" + p.email + ")" : "");
    let block = "", warn = "", short = "";
    if (acct && !accounts.includes(acct)) {
      block = `Tài khoản Flow ${acct} không đăng nhập trong profile ${name}${accounts.length ? " (có: " + accounts.join(", ") + ")" : ""}: Flow sẽ mở nhầm tài khoản. Cách sửa: chọn tài khoản của profile này trong Cấu hình (mục Tài khoản Flow), hoặc chọn profile Chrome có ${acct}, hoặc đăng nhập ${acct} vào profile này.`;
      short = "● Sai profile";
    }
    if (accounts.length > 1) { warn = `Profile này có ${accounts.length} tài khoản (${accounts.join(", ")}): Google có thể khoá cả profile; nên dùng profile chỉ 1 tài khoản cho Flow.`; short = short || "● " + accounts.length + " tài khoản"; }
    else if (!accounts.length) { warn = "Profile " + name + " chưa đăng nhập tài khoản Google nào: đăng nhập đúng 1 tài khoản cho Flow vào profile này (nút Mở Chrome để đăng nhập)."; short = short || "● Chưa đăng nhập"; }
    return { block, warn, short };
  }
  window.FlowCheck = { flowAccountCheck };
})();
