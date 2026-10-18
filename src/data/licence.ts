import { apiRequest, getBackend } from '../api';

export type LicenceBannerKey =
  | 'renewal_notice'
  | 'warning'
  | 'inactive'
  | 'offline_warning'
  | 'clock_warning';

export interface LicenceBannerStatus {
  status: 'ok' | 'inactive' | 'suspended';
  banners: Record<LicenceBannerKey, boolean>;
}

const BANNER_KEYS: readonly LicenceBannerKey[] = [
  'renewal_notice',
  'warning',
  'inactive',
  'offline_warning',
  'clock_warning',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function loadLicenceBannerStatus(): Promise<LicenceBannerStatus | null> {
  if (getBackend() !== 'api') return null;
  const value: unknown = await apiRequest('/api/licence/status');
  if (!isRecord(value) || !isRecord(value.banners)
    || (value.status !== 'ok' && value.status !== 'inactive' && value.status !== 'suspended')
    || Object.keys(value.banners).length !== BANNER_KEYS.length
    || typeof value.banners.renewal_notice !== 'boolean'
    || typeof value.banners.warning !== 'boolean'
    || typeof value.banners.inactive !== 'boolean'
    || typeof value.banners.offline_warning !== 'boolean'
    || typeof value.banners.clock_warning !== 'boolean') {
    throw new Error('The licence status service returned an invalid response.');
  }
  return {
    status: value.status,
    banners: {
      renewal_notice: value.banners.renewal_notice,
      warning: value.banners.warning,
      inactive: value.banners.inactive,
      offline_warning: value.banners.offline_warning,
      clock_warning: value.banners.clock_warning,
    },
  };
}
