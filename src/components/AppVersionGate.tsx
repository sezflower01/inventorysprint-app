import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { globalBroadcastChannel } from "@/lib/realtime/scopedChannel";
import { isAppBusy, appBusyKeys, subscribeAppBusy } from "@/lib/appBusy";

/**
 * Reloads this tab when a newer build ships.
 *
 * WHY THIS EXISTS
 * ---------------
 * A deployed frontend fix only reaches a browser when that browser loads the
 * new bundle. A tab left open does not -- it keeps running the JavaScript it
 * downloaded whenever it was opened, indefinitely.
 *
 * On 2026-08-23 that cost a full day. A fix for a query that scanned 64,421
 * rows was written, deployed and verified, while three machines in different
 * locations sat on the Repricer page running the previous bundle. Each one
 * kept firing the old query every 15 minutes -- two concurrent statements, each
 * holding one of PostgREST's 31 connection slots for the full statement
 * timeout. That is what eventually exhausted the API pool and froze the app,
 * hours after the fix was live. The only remedy was physically visiting each
 * machine, because nothing in the running code was listening for a reason to
 * reload.
 *
 * This is that listener.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not force a reload on a tab that is mid-edit. The repricer table
 * holds min/max price, cost and ROI values in local component state until they
 * are saved, so a reload there is indistinguishable from discarding the user's
 * work. AssignmentsTable already defers its own 15-minute refresh for exactly
 * this reason; `appBusy` is the bridge that lets this component see the same
 * signal from the app root.
 *
 * Three outcomes, in order of preference:
 *
 *   idle              -> reload immediately, invisible to the user
 *   busy, tab hidden  -> reload as soon as it goes to the background AND idle;
 *                        nothing visible is lost, and the user returns to a
 *                        current build without ever seeing a prompt
 *   busy, tab visible -> a persistent toast with a Reload button. The user
 *                        decides. Never auto-reloaded out from under them.
 */

// Injected at build time by vite.config.ts. Falls back so a dev server or an
// unexpected build path degrades to "never reload" rather than to a crash or a
// reload loop.
declare const __APP_BUILD_ID__: string;
const APP_BUILD_ID: string =
  typeof __APP_BUILD_ID__ === "string" ? __APP_BUILD_ID__ : "";

const TOAST_ID = "app-version-reload";

export function AppVersionGate() {
  // Survives re-renders: once a reload is decided, further broadcasts are
  // ignored. Without this, a repeated broadcast would re-prompt every time.
  const handledRef = useRef(false);

  useEffect(() => {
    const channel = supabase.channel(globalBroadcastChannel("app-version"));

    channel
      .on("broadcast", { event: "reload" }, ({ payload }) => {
        const incoming = String((payload as { buildId?: unknown })?.buildId ?? "");

        // No build id on either side means we cannot tell old from new, and
        // reloading on an unknown is how you build a reload loop.
        if (!incoming || !APP_BUILD_ID) return;
        if (incoming === APP_BUILD_ID) return; // already current
        if (handledRef.current) return;
        handledRef.current = true;

        if (!isAppBusy()) {
          window.location.reload();
          return;
        }

        console.log(
          `[AppVersionGate] New build ${incoming} available; deferring reload, busy:`,
          appBusyKeys(),
        );

        // Reload the moment the tab is backgrounded and no longer busy. The
        // user sees nothing; they come back to the current build.
        const tryQuietReload = () => {
          if (document.visibilityState === "hidden" && !isAppBusy()) {
            window.location.reload();
          }
        };
        document.addEventListener("visibilitychange", tryQuietReload);
        const unsubscribeBusy = subscribeAppBusy(tryQuietReload);

        toast("A new version of InventorySprint is available", {
          id: TOAST_ID,
          duration: Infinity,
          description:
            "Your current edits are safe. Reload when you're ready — or it will update on its own next time you switch away.",
          action: {
            label: "Reload now",
            onClick: () => {
              document.removeEventListener("visibilitychange", tryQuietReload);
              unsubscribeBusy();
              window.location.reload();
            },
          },
        });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return null;
}

export default AppVersionGate;
