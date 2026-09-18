// Public config — safe to ship in extension.
// Only the publishable anon key + project URL. NEVER add service role / Keepa / AWS keys here.
self.INVSPRNT_CFG = {
  SUPABASE_URL: "https://mstibdszibcheodvnprm.supabase.co",
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc",
  APP_URL: "https://inventorysprint.com",
  CACHE_TTL_MS: 10 * 60 * 1000, // 10 minutes per-ASIN cache
};
