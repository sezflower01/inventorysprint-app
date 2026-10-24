import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

const PRIMARY_HOST = 'inventorysprint.com';
const LOVABLE_HOSTS = ['repricer.lovable.app'];

// Hard-redirect lovable.app traffic to the primary domain so Google
// consolidates indexing on inventorysprint.com.
if (typeof window !== 'undefined' && LOVABLE_HOSTS.includes(window.location.hostname)) {
  const target = `https://${PRIMARY_HOST}${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.replace(target);
}

// Ensure a per-route canonical pointing at inventorysprint.com is always present
// (overrides any stale or hard-coded canonical injected elsewhere).
const ensureCanonical = () => {
  if (typeof window === 'undefined') return;
  const canonicalHref = `https://${PRIMARY_HOST}${window.location.pathname}`;
  const existing = document.querySelectorAll('link[rel="canonical"]');
  existing.forEach((el) => el.parentNode?.removeChild(el));
  const link = document.createElement('link');
  link.rel = 'canonical';
  link.href = canonicalHref;
  document.head.appendChild(link);
};

// Robots and googlebot metas used to be appended here, outside Helmet. That
// made them impossible for a page to override: NotFound could ask for
// noindex and this tag would still be sitting beside it saying index. They
// now live in <DefaultSeo>, so Helmet owns them and a deeper page Helmet
// wins -- which is what lets an unknown path actually be noindexed.

ensureCanonical();

// Keep canonical in sync as the SPA navigates between routes.
if (typeof window !== 'undefined') {
  const patch = (key: 'pushState' | 'replaceState') => {
    const orig = history[key];
    history[key] = function (...args: Parameters<typeof orig>) {
      const ret = orig.apply(this, args);
      queueMicrotask(ensureCanonical);
      return ret;
    } as typeof orig;
  };
  patch('pushState');
  patch('replaceState');
  window.addEventListener('popstate', ensureCanonical);
}

createRoot(document.getElementById("root")!).render(<App />);
