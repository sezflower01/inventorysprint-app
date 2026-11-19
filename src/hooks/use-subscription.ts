import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export interface SubscriptionPlan {
  id: string;
  name: string;
  listing_limit: number;
  monthly_price: number;
  annual_price: number;
  sort_order: number;
  stripe_price_id?: string;
  stripe_product_id?: string;
  stripe_annual_price_id?: string;
  priority_star_cap: number;
  sp_api_calls_per_minute_cap: number;
}

export interface UserSubscription {
  plan_id: string;
  billing_interval: string;
  status: string;
  cancel_at_period_end?: boolean;
  current_period_end?: string;
  stripe_subscription_id?: string;
  trial_end_date?: string;
}

export interface AdminOverride {
  override_enabled: boolean;
  override_plan_id: string | null;
}

/**
 * ONE ANSWER PER USER, NOT ONE PER COMPONENT.
 *
 * useSubscription() is called from 20 places, and it used to issue its four
 * identity reads plus the listings-count RPC from EVERY instance. Measured on
 * /tools/repricer on 2026-11-19 (client caches cleared): 23 identity requests
 * -- user_roles 8, user_subscriptions 5, subscription_plans 5,
 * admin_subscription_override 5 -- for four facts that cannot differ between
 * callers, costing 13.9s of cumulative request time on the cold path.
 *
 * Nothing here is per-component, so the result is shared at module level:
 *  - an in-flight promise, so instances that mount in the same tick (which is
 *    what actually happens -- React mounts the whole page at once) join the
 *    first request instead of starting their own;
 *  - a short TTL, so navigating between pages does not re-ask. Plan and role
 *    data changes on the order of months, not seconds;
 *  - explicit invalidation on every write below, so a plan switch is visible
 *    immediately rather than up to TTL later, and refetch() always forces.
 *
 * Deliberately not persisted anywhere. This is a request-collapsing cache, not
 * a store: entitlement is re-read on reload, and the server remains the only
 * authority. It is keyed by user id so a sign-out/sign-in as someone else
 * cannot be served the previous user's plan.
 */
interface IdentitySnapshot {
  plans: SubscriptionPlan[];
  subscription: UserSubscription | null;
  override: AdminOverride | null;
  isAdmin: boolean;
  listings: { total: number; per_marketplace: Record<string, number> };
}

const IDENTITY_TTL_MS = 60_000;

let identityCache: { userId: string; at: number; value: IdentitySnapshot } | null = null;
let identityInFlight: { userId: string; promise: Promise<IdentitySnapshot> } | null = null;

export function invalidateSubscriptionCache() {
  identityCache = null;
  identityInFlight = null;
}

async function loadIdentity(userId: string): Promise<IdentitySnapshot> {
  const [plansRes, subRes, overrideRes, adminRes] = await Promise.all([
    supabase.from('subscription_plans').select('*').order('sort_order'),
    supabase
      .from('user_subscriptions')
      .select('plan_id, billing_interval, status, cancel_at_period_end, current_period_end, stripe_subscription_id, trial_end_date')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('admin_subscription_override')
      .select('override_enabled, override_plan_id')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase.from('user_roles').select('role').eq('user_id', userId).eq('role', 'admin').maybeSingle(),
  ]);

  // The listings count is a separate concern and must not be able to fail the
  // entitlement read: a count of 0 shows a wrong usage bar, a missing plan
  // locks the user out of the app.
  let listings = { total: 0, per_marketplace: {} as Record<string, number> };
  try {
    const { data, error } = await supabase.rpc('get_managed_listings_counts', { p_user_id: userId });
    if (!error && data) {
      const result = data as { total: number; per_marketplace: Record<string, number> };
      listings = { total: result.total || 0, per_marketplace: result.per_marketplace || {} };
    }
  } catch { /* leave the zeroed default */ }

  return {
    plans: (plansRes.data as SubscriptionPlan[]) || [],
    subscription: (subRes.data as UserSubscription | null) || null,
    override: (overrideRes.data as AdminOverride | null) || null,
    isAdmin: !!adminRes.data,
    listings,
  };
}

function getIdentity(userId: string, force: boolean): Promise<IdentitySnapshot> {
  if (force) {
    identityCache = null;
    identityInFlight = null;
  } else {
    if (identityCache && identityCache.userId === userId && Date.now() - identityCache.at < IDENTITY_TTL_MS) {
      return Promise.resolve(identityCache.value);
    }
    if (identityInFlight && identityInFlight.userId === userId) {
      return identityInFlight.promise;
    }
  }

  const promise = loadIdentity(userId)
    .then(value => {
      identityCache = { userId, at: Date.now(), value };
      return value;
    })
    .finally(() => {
      // Clear the slot either way: a failed read must not be remembered as
      // in-flight forever, and a successful one is now in identityCache.
      if (identityInFlight?.promise === promise) identityInFlight = null;
    });

  identityInFlight = { userId, promise };
  return promise;
}


export function useSubscription() {
  const { user } = useAuth();
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [subscription, setSubscription] = useState<UserSubscription | null>(null);
  const [override, setOverride] = useState<AdminOverride | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [activeListings, setActiveListings] = useState(0);
  const [marketplaceCounts, setMarketplaceCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [listingsLoading, setListingsLoading] = useState(true);

  const effectivePlanId = override?.override_enabled && override?.override_plan_id
    ? override.override_plan_id
    : subscription?.plan_id ?? 'tier_100';

  const effectivePlan = plans.find(p => p.id === effectivePlanId);

  // Trial & subscription status helpers
  const isTrial = subscription?.status === 'trial';
  const isExpired = subscription?.status === 'expired' || subscription?.status === 'cancelled' || subscription?.status === 'canceled';
  const isActive = subscription?.status === 'active' || subscription?.status === 'trialing';
  const trialEndDate = subscription?.trial_end_date ? new Date(subscription.trial_end_date) : null;
  const trialDaysRemaining = trialEndDate ? Math.max(0, Math.ceil((trialEndDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))) : null;
  const canUseRepricer = isActive || (isTrial && trialDaysRemaining !== null && trialDaysRemaining > 0) || isAdmin;

  const fetchAll = async (force = false) => {
    if (!user) {
      setPlans([]);
      setSubscription(null);
      setOverride(null);
      setIsAdmin(false);
      setActiveListings(0);
      setMarketplaceCounts({});
      setLoading(false);
      setListingsLoading(false);
      return;
    }

    setLoading(true);
    setListingsLoading(true);

    try {
      const snap = await getIdentity(user.id, force);
      setPlans(snap.plans);
      setSubscription(snap.subscription);
      setOverride(snap.override);
      setIsAdmin(snap.isAdmin);
      setActiveListings(snap.listings.total);
      setMarketplaceCounts(snap.listings.per_marketplace);
    } catch {
      setPlans([]);
      setSubscription(null);
      setOverride(null);
      setIsAdmin(false);
      setActiveListings(0);
      setMarketplaceCounts({});
    } finally {
      setLoading(false);
      setListingsLoading(false);
    }
  };

  useEffect(() => {
    void fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const switchOverridePlan = async (planId: string) => {
    if (!user) return;
    const { error } = await supabase
      .from('admin_subscription_override')
      .upsert({ user_id: user.id, override_enabled: true, override_plan_id: planId }, { onConflict: 'user_id' });
    if (!error) {
      invalidateSubscriptionCache();
      setOverride({ override_enabled: true, override_plan_id: planId });
    }
    return error;
  };

  const toggleOverride = async (enabled: boolean) => {
    if (!user) return;
    const { error } = await supabase
      .from('admin_subscription_override')
      .upsert({ user_id: user.id, override_enabled: enabled, override_plan_id: override?.override_plan_id ?? 'advanced' }, { onConflict: 'user_id' });
    if (!error) {
      invalidateSubscriptionCache();
      setOverride(prev => prev ? { ...prev, override_enabled: enabled } : { override_enabled: enabled, override_plan_id: 'advanced' });
    }
    return error;
  };

  const switchPlan = async (planId: string) => {
    if (!user) return;
    const { error } = await supabase
      .from('user_subscriptions')
      .upsert({ user_id: user.id, plan_id: planId, billing_interval: subscription?.billing_interval ?? 'monthly', status: 'active' }, { onConflict: 'user_id' });
    if (!error) {
      invalidateSubscriptionCache();
      setSubscription(prev => prev ? { ...prev, plan_id: planId } : { plan_id: planId, billing_interval: 'monthly', status: 'active' });
    }
    return error;
  };

  return {
    plans,
    subscription,
    override,
    isAdmin,
    activeListings,
    marketplaceCounts,
    loading,
    listingsLoading,
    effectivePlanId,
    effectivePlan,
    isTrial,
    isExpired,
    isActive,
    canUseRepricer,
    trialEndDate,
    trialDaysRemaining,
    switchOverridePlan,
    toggleOverride,
    switchPlan,
    refetch: () => fetchAll(true),
  };
}
