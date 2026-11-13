// Tap-outside-to-close + single-open behavior for icon-bar popovers.
// Kept external because MV3 extension page CSP forbids inline <script>.
document.addEventListener('click', (e) => {
  document.querySelectorAll('details.apx-pop[open]').forEach((d) => {
    if (!d.contains(e.target)) d.removeAttribute('open');
  });
});
document.querySelectorAll('details.apx-pop').forEach((d) => {
  d.addEventListener('toggle', () => {
    if (d.open) {
      document.querySelectorAll('details.apx-pop[open]').forEach((o) => {
        if (o !== d) o.removeAttribute('open');
      });
    }
  });
});
