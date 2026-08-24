import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(() => ({
  // Build identity for AppVersionGate. A deployed fix only reaches a browser
  // that loads the new bundle, so the app needs to be able to tell "the build I
  // am running" from "the build that is current" -- see
  // src/components/AppVersionGate.tsx for what that cost when it could not.
  //
  // Vercel and GitHub Actions both expose the commit SHA; a local build falls
  // back to a timestamp so dev never collides with a real deploy id.
  define: {
    __APP_BUILD_ID__: JSON.stringify(
      process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ||
        process.env.GITHUB_SHA?.slice(0, 12) ||
        `local-${Date.now().toString(36)}`,
    ),
  },
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    react(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
  },
  optimizeDeps: {
    include: ["@tanstack/react-query", "react", "react-dom"],
  },
}));
