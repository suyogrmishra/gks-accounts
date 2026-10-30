// Connection settings. The publishable (anon) key is safe to ship in a web page;
// access is enforced by the database's row-level security rules.
export const CONFIG = {
  supabaseUrl: 'https://ywukykjkkdsexqvksnvx.supabase.co',
  supabaseKey: 'sb_publishable_3kDTKWeSXH9seqbVDB3GXA_fXGdC1cN', // publishable key (Settings → API). Leave empty to run demo mode only.
  appName: 'GKS Accounts',
  // 'demo' = sample data in each browser only. Change to 'live' after running db/01–04 in Supabase.
  mode: 'demo',
};
