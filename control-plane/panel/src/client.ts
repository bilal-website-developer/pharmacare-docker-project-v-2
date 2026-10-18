import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const panelConfigurationError = !supabaseUrl || !supabaseAnonKey
  ? 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to use the control panel.'
  : null;

export const supabase: SupabaseClient | null = panelConfigurationError
  ? null
  : createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  });

export async function invokeControlPlane<T>(
  client: SupabaseClient,
  functionName: string,
  body: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await client.functions.invoke<T>(functionName, { body });
  if (error) throw error;
  if (data === null) throw new Error('Control plane returned an empty response.');
  return data;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The request could not be completed. Please try again.';
}
