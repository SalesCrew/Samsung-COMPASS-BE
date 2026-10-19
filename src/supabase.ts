import { createClient } from '@supabase/supabase-js';

export const supabaseUrl = process.env.SUPABASE_URL ?? '';
export const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? '';
const secret = process.env.SUPABASE_SECRET_KEY ?? '';
if (!supabaseUrl || !publishableKey || !secret) throw new Error('Supabase backend environment is incomplete.');
export const authAdmin = createClient(supabaseUrl, secret, { auth: { persistSession: false, autoRefreshToken: false } });
export function userDatabase(token: string) {
  return createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: 'Bearer ' + token } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
export function publicAuth() {
  return createClient(supabaseUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

