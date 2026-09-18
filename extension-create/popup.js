const CFG = self.INVSPRNT_CFG;
const $ = (id) => document.getElementById(id);

const bg = (type, extra = {}) =>
  new Promise((res) => chrome.runtime.sendMessage({ type, ...extra }, (r) => res(r)));

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
    const r = await bg("INVSPRNT_SIGN_IN_PASSWORD", { email, password });
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

$("pop-open").href = `${CFG.APP_URL}/tools/create-listing`;
$("pop-forgot").href = `${CFG.APP_URL}/forgot-password`;

refresh();
