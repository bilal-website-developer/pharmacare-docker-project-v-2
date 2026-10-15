const configuredBackend = import.meta.env?.VITE_BACKEND;

if (configuredBackend && configuredBackend !== 'api' && configuredBackend !== 'supabase') {
  throw new Error('VITE_BACKEND must be either "api" or "supabase".');
}

export type Backend = 'api' | 'supabase';

export function getBackend(): Backend {
  return configuredBackend === 'supabase' ? 'supabase' : 'api';
}

export function getShopSlug(): string {
  return import.meta.env?.VITE_SHOP_SLUG?.trim() ?? '';
}
