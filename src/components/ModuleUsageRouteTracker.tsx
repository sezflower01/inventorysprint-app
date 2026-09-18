import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { MODULE_CATEGORIES } from "@/config/moduleCategories";
import { TOOLS } from "@/config/tools";
import { recordUsage } from "@/lib/moduleUsageTracker";

// Routes we don't want to track as "Most Used" entries.
const USAGE_TRACK_IGNORE = new Set<string>([
  "/", "/login", "/signup", "/signed-in", "/auth/callback",
  "/forgot-password", "/reset-password", "/complete-profile",
  "/tools", "/pricing", "/about", "/contact", "/download",
  "/privacy-policy", "/terms-of-service", "/support",
]);

const moduleLookup = new Map<string, string>();

for (const category of MODULE_CATEGORIES) {
  for (const module of category.modules) {
    if (module.path) moduleLookup.set(module.path, module.label);
  }
}

function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function humanizePath(path: string): string {
  const last = path.split("/").filter(Boolean).pop() || path;
  return last
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function matchesRoute(path: string, route: string): boolean {
  return path === route || path.startsWith(`${route}/`);
}

function resolveTrackedModule(path: string): { path: string; label: string } {
  const moduleMatch = [...moduleLookup.entries()]
    .filter(([route]) => matchesRoute(path, route))
    .sort(([a], [b]) => b.length - a.length)[0];

  if (moduleMatch) {
    const [route, label] = moduleMatch;
    return { path: route, label };
  }

  const toolMatch = TOOLS
    .filter((tool) => matchesRoute(path, tool.path))
    .sort((a, b) => b.path.length - a.path.length)[0];

  return {
    path: toolMatch?.path || path,
    label: toolMatch?.label || humanizePath(path),
  };
}

export default function ModuleUsageRouteTracker() {
  const location = useLocation();

  useEffect(() => {
    const path = normalizePath(location.pathname);
    if (!path || USAGE_TRACK_IGNORE.has(path)) return;

    const tracked = resolveTrackedModule(path);
    recordUsage(tracked.path, tracked.label);
  }, [location.pathname]);

  return null;
}