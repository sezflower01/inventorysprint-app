import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  emailVerified: boolean;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const checkAccountStatus = async (userId: string): Promise<boolean> => {
  try {
    const { data } = await supabase
      .from('profiles')
      .select('account_status')
      .eq('id', userId)
      .maybeSingle();

    if (data?.account_status === 'suspended' || data?.account_status === 'deleted') {
      toast.error(
        data.account_status === 'suspended'
          ? 'Your account has been suspended. Please contact support.'
          : 'Your account has been deleted. Please sign up again to continue.'
      );
      await supabase.auth.signOut();
      return false;
    }
    return true;
  } catch {
    return true; // Allow login if check fails (profile may not exist yet)
  }
};

// Module-level flag: only true while a user-initiated sign-out is in flight.
let manualSignOutInFlight = false;

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [emailVerified, setEmailVerified] = useState(false);
  const [loading, setLoading] = useState(true);

  // Silently hand the session to the InventorySprint Chrome extensions. Its
  // content script (handoff.js) already listens for this on every page of
  // the site — previously only /tools/ext-handoff ever sent it, which meant
  // "connecting" the extension required visiting a dedicated tab and staring
  // at a status page. Broadcasting it here means simply being signed in on
  // any page is enough; the extension picks it up invisibly in the
  // background, no separate connect step required.
  useEffect(() => {
    if (!session?.access_token || !session?.refresh_token || !emailVerified) return;
    try {
      window.postMessage(
        {
          type: 'ARBIPRO_EXT_SESSION',
          session: {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            expires_at: session.expires_at,
          },
        },
        window.location.origin,
      );
    } catch (_) { /* ignore */ }
  }, [session?.access_token, session?.refresh_token, session?.expires_at, emailVerified]);

  useEffect(() => {
    // Set up auth state listener FIRST
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        console.log('Auth state changed:', event, session?.user?.email);

        // SIGNED_OUT can be fired by the SDK for transient reasons (a single
        // failed token refresh, a network blip, another tab rotating the
        // refresh token, etc.). Only clear local state when the user asked to
        // sign out OR when a fresh getSession() confirms there really is no
        // session left. This prevents users from being kicked to /login
        // without their consent.
        if (event === 'SIGNED_OUT') {
          if (manualSignOutInFlight) {
            setSession(null);
            setUser(null);
            setEmailVerified(false);
            setLoading(false);
            return;
          }
          // Re-verify before clearing — give the SDK a moment to settle.
          setTimeout(async () => {
            try {
              const { data } = await supabase.auth.getSession();
              if (data?.session?.user) {
                console.log('Ignored spurious SIGNED_OUT — session still valid');
                setSession(data.session);
                setUser(data.session.user);
                setEmailVerified(Boolean(data.session.user.email_confirmed_at));
                setLoading(false);
                return;
              }
              console.log('SIGNED_OUT confirmed by getSession — clearing local state');
              setSession(null);
              setUser(null);
              setEmailVerified(false);
              setLoading(false);
            } catch (err) {
              // If we can't verify (network down), DO NOT sign the user out.
              console.warn('Could not verify SIGNED_OUT — keeping session.', err);
            }
          }, 250);
          return;
        }

        const isEmailVerified = Boolean(session?.user?.email_confirmed_at);

        // Only validate email + account status on the initial SIGNED_IN.
        // TOKEN_REFRESHED fires frequently (every ~hour) and a transient
        // profile fetch failure must NOT sign the user out.
        if (session?.user && event === 'SIGNED_IN') {
          if (!isEmailVerified) {
            setSession(null);
            setUser(null);
            setEmailVerified(false);
            setLoading(false);
            manualSignOutInFlight = true;
            try {
              await supabase.auth.signOut();
            } finally {
              manualSignOutInFlight = false;
            }
            toast.error('Please verify your email before accessing your account.');
            return;
          }

          // Check account status — use setTimeout to avoid Supabase deadlock
          setTimeout(async () => {
            const allowed = await checkAccountStatus(session.user.id);
            if (!allowed) {
              setSession(null);
              setUser(null);
              setLoading(false);
              return;
            }
          }, 0);
        }

        setSession(session);
        setUser(session?.user ?? null);
        setEmailVerified(isEmailVerified);
        setLoading(false);
      }
    );

    // THEN check for existing session. Previously a 12s timeout would force
    // loading=false (with user still null) if getSession() hadn't resolved
    // yet, even when a valid token was sitting in localStorage — ProtectedRoute
    // treats loading=false + user=null as "confirmed signed out" and hard-
    // redirects to /login. If getSession() was just a bit slower than 12s that
    // time (network blip, cold connection) but still eventually succeeded, the
    // user got bounced to /login and had to navigate back in once the real
    // session arrived — a false "signed out, then comes back" a few seconds
    // later. Fixed by never flipping loading=false on a mere timeout when a
    // token is present — only a genuine getSession() resolution/rejection or
    // an auth state event may resolve it, so ProtectedRoute never sees
    // loading=false+user=null unless that's actually confirmed. The timeout
    // below is now just a diagnostic log, plus (for the no-token case, where
    // there's nothing to hydrate and no race) the original fast release.
    //
    // UPDATE: Supabase's own /auth endpoint has documented intermittent
    // slowness (the InventorySprint Chrome extension's background.js was
    // already hardened for this — REFRESH_TIMEOUT_MS / STALE_TOKEN_GRACE_MS —
    // because the exact same freeze was hitting extension panels too). The
    // web app had no equivalent fallback and would hang on this screen for
    // however long Supabase took to respond, sometimes minutes, with no
    // recovery. Mirror the extension's proven pattern here: after a bounded
    // wait, read the session already sitting in localStorage (Supabase writes
    // it there itself) and use it immediately if it's not stale beyond a
    // grace window, instead of waiting on the network indefinitely. The real
    // getSession() call below keeps running in the background and will
    // correct this the moment it resolves either way.
    const STALE_GRACE_MS = 10 * 60 * 1000; // matches the extension's grace window
    function readStoredSessionStale(): Session | null {
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k || !k.startsWith('sb-') || !k.endsWith('-auth-token')) continue;
          const raw = localStorage.getItem(k);
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          if (parsed?.access_token && parsed?.user) return parsed as Session;
        }
      } catch { /* ignore */ }
      return null;
    }

    let initialResolved = false;
    let servedStaleSession = false;
    const hasStoredToken = (() => {
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) return true;
        }
      } catch { /* ignore */ }
      return false;
    })();

    const initialSessionTimeout = setTimeout(() => {
      if (initialResolved) return;
      if (!hasStoredToken) {
        // No token to hydrate — this is a real "signed out", not a race.
        setLoading(false);
        return;
      }
      // A token exists but getSession() is still pending. Use the cached
      // session from localStorage as an immediate stale fallback (bounded by
      // STALE_GRACE_MS past its own expiry) so the user isn't stuck staring
      // at a spinner during a slow Supabase Auth moment — matching how the
      // extension already degrades gracefully. The pending getSession() call
      // will still correct this once it actually resolves.
      const stale = readStoredSessionStale();
      const ageMs = stale?.expires_at ? Date.now() - stale.expires_at * 1000 : Infinity;
      if (stale && ageMs < STALE_GRACE_MS) {
        console.warn('Initial getSession() slow (>7s) — using cached session as a stale fallback.');
        servedStaleSession = true; // the hard ceiling below must not undo this
        const isEmailVerified = Boolean(stale.user?.email_confirmed_at);
        setSession(isEmailVerified ? stale : null);
        setUser(isEmailVerified ? stale.user : null);
        setEmailVerified(isEmailVerified);
        setLoading(false);
        return;
      }
      console.warn('Initial getSession() slow (>7s) — still waiting, not clearing session.');
    }, hasStoredToken ? 7000 : 1500);

    // HARD CEILING (2026-09-18). The branch above deliberately keeps waiting
    // when the stored session expired more than STALE_GRACE_MS ago -- and
    // nothing ever stopped that wait. getSession() then has to refresh the
    // token over the network; when that refresh stalls (Supabase's open
    // "401 errors due to JWT rejections" gateway incident; or auth-js's
    // session lock held by a stuck request in another tab) every signed-in
    // page sat on "Loading..." indefinitely. Reported 2026-09-18: the
    // seller's 11:50 sessions never refreshed; pages loaded forever.
    //
    // After 30 s, stop waiting and fall through as signed out, so
    // ProtectedRoute sends the seller to /login (with a redirect back) where
    // signing in again works. 30 s leaves room for the 20 s auth fetch
    // ceiling in client.ts plus a retry, so a slow-but-working refresh still
    // wins. If getSession() resolves later it still updates state as before.
    const hardCeiling = setTimeout(() => {
      // Nothing to do if getSession() answered, or the 7 s fallback already
      // let the seller in on a recent cached session.
      if (initialResolved || servedStaleSession) return;
      console.warn('Initial getSession() still pending after 30s — giving up and treating as signed out so the app is usable.');
      setSession(null);
      setUser(null);
      setLoading(false);
    }, 30_000);

    supabase.auth.getSession().then(({ data: { session } }) => {
      initialResolved = true;
      clearTimeout(initialSessionTimeout);
      clearTimeout(hardCeiling);
      const isEmailVerified = Boolean(session?.user?.email_confirmed_at);
      setSession(isEmailVerified ? session : null);
      setUser(isEmailVerified ? session?.user ?? null : null);
      setEmailVerified(isEmailVerified);
      setLoading(false);
    }).catch((err) => {
      initialResolved = true;
      clearTimeout(initialSessionTimeout);
      clearTimeout(hardCeiling);
      console.warn('Initial getSession() failed:', err);
      setLoading(false);
    });

    // Cross-tab session sync: when another tab signs in/out, Supabase writes
    // to localStorage. Mirror that into this tab's React state immediately so
    // a second tab doesn't need a manual refresh.
    const onStorage = (e: StorageEvent) => {
      if (!e.key || !e.key.startsWith('sb-') || !e.key.endsWith('-auth-token')) return;
      supabase.auth.getSession().then(({ data: { session } }) => {
        const isEmailVerified = Boolean(session?.user?.email_confirmed_at);
        setSession(isEmailVerified ? session : null);
        setUser(isEmailVerified ? session?.user ?? null : null);
        setEmailVerified(isEmailVerified);
        setLoading(false);
      }).catch(() => { /* ignore */ });
    };
    window.addEventListener('storage', onStorage);

    return () => {
      subscription.unsubscribe();
      window.removeEventListener('storage', onStorage);
      clearTimeout(initialSessionTimeout);
      clearTimeout(hardCeiling);
    };
  }, []);

  const signOut = async () => {
    manualSignOutInFlight = true;
    // Broadcast to InventorySprint Chrome extensions BEFORE we tear down the
    // Supabase session so their content scripts can forward the signal.
    try {
      window.postMessage({ type: "ARBIPRO_EXT_LOGOUT" }, window.location.origin);
      console.log("[arbipro-auth]", "web_logout_broadcasted");
    } catch (_) { /* ignore */ }

    // 1. Clear local session FIRST so the UI updates immediately, even if the
    //    auth server is slow/unreachable. Without this, a hanging global
    //    signOut() call leaves the user "stuck logged in".
    try {
      await supabase.auth.signOut({ scope: 'local' });
    } catch (e) {
      console.warn('Local sign-out failed', e);
    }
    setUser(null);
    setSession(null);
    setEmailVerified(false);

    // 2. Fire the global server-side sign-out in the background with a hard
    //    timeout. We don't await it — the user is already logged out locally.
    void (async () => {
      try {
        await Promise.race([
          supabase.auth.signOut({ scope: 'global' }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('global signOut timeout')), 4000)
          ),
        ]);
      } catch (error) {
        console.warn('Global sign-out failed or timed out (local session already cleared).', error);
      } finally {
        manualSignOutInFlight = false;
      }
    })();
  };

  return (
    <AuthContext.Provider value={{ user, session, emailVerified, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
