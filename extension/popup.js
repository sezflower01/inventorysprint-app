const CFG = self.INVSPRNT_CFG;
const $ = (id) => document.getElementById(id);

const bg = (type, extra = {}, { timeoutMs = 8000, retries = 1 } = {}) =>
  new Promise((res) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; res(r); } };
    const attempt = (left) => {
      let timer = setTimeout(() => {
        if (settled) return;
        // SW likely asleep — retry once to wake it
        if (left > 0) return attempt(left - 1);
        done({ ok: false, error: "bg_timeout" });
      }, timeoutMs);
      try {
        chrome.runtime.sendMessage({ type, ...extra }, (r) => {
          clearTimeout(timer);
          // Swallow "message port closed" — treat as transient
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            if (left > 0) return attempt(left - 1);
            return done({ ok: false, error: lastErr.message || "runtime_error" });
          }
          done(r);
        });
      } catch (e) {
        clearTimeout(timer);
        if (left > 0) return attempt(left - 1);
        done({ ok: false, error: String(e?.message || e) });
      }
    };
    attempt(retries);
  });

async function refresh() {
  const r = await bg("INVSPRNT_GET_SESSION");
  const signed = !!r?.session?.access_token;
  $("pop-status").textContent = signed ? "Signed in ✓" : "Sign in to InventorySprint";
  $("pop-signin-form").classList.toggle("hidden", signed);
  $("pop-signout").classList.toggle("hidden", !signed);
  $("pop-open").classList.toggle("hidden", !signed);
  if (!signed) $("pop-error").textContent = "";
}

$("pop-signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("pop-email").value.trim();
  const password = $("pop-password").value;
  const btn = $("pop-signin-submit");
  $("pop-error").textContent = "";
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const r = await bg("INVSPRNT_SIGN_IN_PASSWORD", { email, password }, { timeoutMs: 12000 });
    if (!r?.ok) throw new Error(r?.error || "Sign in failed");
    $("pop-password").value = "";
    await refresh();
  } catch (err) {
    $("pop-error").textContent = String(err?.message || err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});

$("pop-signout").addEventListener("click", async () => {
  await bg("INVSPRNT_SIGN_OUT");
  refresh();
});

$("pop-open").href = CFG.APP_URL;
$("pop-forgot").href = `${CFG.APP_URL}/forgot-password`;

refresh();
