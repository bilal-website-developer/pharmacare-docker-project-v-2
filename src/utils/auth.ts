import { UserRole } from '../types/pharmacy';
import { isPermissionKey } from '../permissions';
import {
  apiRequest,
  clearApiAccessToken,
  getBackend,
  getShopSlug,
  restoreApiAccessToken,
  setApiAccessToken,
} from '../api';
import { supabase } from './supabase';

export interface AuthSession {
  userId: string;
  displayName: string;
  email: string;
  role: UserRole;
  permissions: string[];
}

interface ApiUser {
  id: string;
  username: string;
  email: string;
  fullName: string;
  role: string;
  permissions: string[];
}

interface ApiAuthResponse {
  accessToken: string;
  user: ApiUser;
}

interface ApiMeResponse {
  user: ApiUser;
}

function toApiAuthSession(value: unknown): AuthSession {
  if (
    typeof value !== 'object'
    || value === null
    || !('id' in value)
    || typeof value.id !== 'string'
    || !('role' in value)
    || typeof value.role !== 'string'
    || !Object.values(UserRole).includes(value.role as UserRole)
    || !('username' in value)
    || typeof value.username !== 'string'
    || !('email' in value)
    || typeof value.email !== 'string'
    || !('fullName' in value)
    || typeof value.fullName !== 'string'
  ) {
    throw new Error('The API returned an invalid user profile.');
  }
  const user = value as ApiUser;
  return {
    userId: user.id,
    displayName: user.fullName.trim() || user.username || user.email || 'User',
    email: user.email || '',
    role: user.role as UserRole,
    permissions: Array.isArray(user.permissions) ? user.permissions.filter(isPermissionKey) : [],
  };
}

export async function loadAuthSession(userId: string, authEmail?: string): Promise<AuthSession> {
  if (!supabase) throw new Error('Supabase is not configured.');

  const { data, error } = await supabase
    .from('profiles')
    .select('username,email,role,permissions,is_active,deleted_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    const profileError = new Error(`Could not load your profile: ${error.message}`);
    profileError.name = 'ProfileLoadError';
    throw profileError;
  }
  if (!data) throw new Error('No profile exists for this account. Contact the admin.');
  if (data.is_active !== true || data.deleted_at !== null) {
    await supabase.auth.signOut();
    throw new Error('Your account is disabled. Contact the admin.');
  }
  if (!Object.values(UserRole).includes(data.role as UserRole)) {
    throw new Error('Your profile has an invalid role. Contact the admin.');
  }

  return {
    userId,
    displayName: data.username || data.email || authEmail || 'User',
    email: data.email || authEmail || '',
    role: data.role as UserRole,
    permissions: Array.isArray(data.permissions) ? data.permissions.filter(isPermissionKey) : [],
  };
}

export async function signIn(email: string, password: string): Promise<AuthSession> {
  if (getBackend() === 'api') {
    const shopSlug = getShopSlug();
    if (!shopSlug) {
      throw new Error('API sign-in requires VITE_SHOP_SLUG to be set at build time.');
    }
    const response = await apiRequest<ApiAuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ shopSlug, usernameOrEmail: email, password }),
    });
    if (
      typeof response !== 'object'
      || response === null
      || typeof response.accessToken !== 'string'
      || !response.accessToken
    ) {
      throw new Error('The API returned an invalid sign-in response.');
    }
    const session = toApiAuthSession(response.user);
    setApiAccessToken(response.accessToken);
    return session;
  }

  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.user?.email) throw new Error('Authentication returned no user email.');
  try {
    return await loadAuthSession(data.user.id, data.user.email);
  } catch (profileError) {
    await supabase.auth.signOut();
    throw profileError;
  }
}

export async function restoreAuthSession(): Promise<AuthSession | null> {
  if (getBackend() === 'api') {
    if (!await restoreApiAccessToken()) return null;
    const response = await apiRequest<ApiMeResponse>('/api/auth/me');
    return toApiAuthSession(response.user);
  }

  if (!supabase) return null;
  const { data: authData, error: authError } = await supabase.auth.getSession();
  if (authError) throw authError;
  if (!authData.session) return null;
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!userData.user) throw new Error('Your session is no longer valid. Sign in again.');
  return loadAuthSession(userData.user.id, userData.user.email);
}

export async function refreshAuthSession(): Promise<AuthSession> {
  if (getBackend() === 'api') {
    const response = await apiRequest<ApiMeResponse>('/api/auth/me');
    return toApiAuthSession(response.user);
  }
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  if (!data.user) throw new Error('Your session is no longer valid. Sign in again.');
  return loadAuthSession(data.user.id, data.user.email);
}

export async function signOut(): Promise<void> {
  if (getBackend() === 'api') {
    try {
      await apiRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
      clearApiAccessToken();
    } catch (error) {
      clearApiAccessToken();
      throw error;
    }
    return;
  }
  if (!supabase) throw new Error('Supabase is not configured.');
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
