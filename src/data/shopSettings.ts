import { apiRequest } from '../api';
import type { BillingPreferences, PharmacyMemoSettings } from '../utils/receipt';

export interface ShopProfile {
  displayName: string;
  address: string;
  phone: string;
  city: string;
}

export interface ShopSettings {
  id: string;
  slug: string;
  name: string;
  profile: ShopProfile;
  receiptSettings: BillingPreferences;
  memoSettings: PharmacyMemoSettings;
  timeZone: string;
}

export interface ShopSettingsPatch {
  shopName?: string;
  profile?: Partial<ShopProfile>;
  receiptSettings?: Partial<BillingPreferences>;
  memoSettings?: Partial<PharmacyMemoSettings>;
}

const SETTINGS_KEYS = ['id', 'slug', 'name', 'profile', 'receiptSettings', 'memoSettings', 'timeZone'];
const PROFILE_KEYS = ['displayName', 'address', 'phone', 'city'];
const RECEIPT_KEYS = ['format', 'template'];
const MEMO_KEYS = [
  'storeName', 'address', 'phone', 'notes', 'terminalName', 'showBatchExpiry',
  'roundNet', 'printTax', 'duplicateLabel', 'numberDigits', 'autoPrint',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isStringRecord(value: unknown, keys: readonly string[]): value is Record<string, string> {
  return isRecord(value) && hasExactKeys(value, keys) && keys.every((key) => typeof value[key] === 'string');
}

function isSettings(value: unknown): value is ShopSettings {
  if (!isRecord(value) || !hasExactKeys(value, SETTINGS_KEYS)
    || typeof value.id !== 'string' || typeof value.slug !== 'string'
    || typeof value.name !== 'string' || typeof value.timeZone !== 'string'
    || !isStringRecord(value.profile, PROFILE_KEYS)) return false;

  const receipt = value.receiptSettings;
  if (!isRecord(receipt) || !hasExactKeys(receipt, RECEIPT_KEYS)
    || !['thermal58', 'thermal80', 'a4'].includes(String(receipt.format))
    || !['simple', 'classic', 'professional', 'modern', 'pharmacy-memo'].includes(String(receipt.template))) {
    return false;
  }

  const memo = value.memoSettings;
  if (!isRecord(memo) || !hasExactKeys(memo, MEMO_KEYS)
    || typeof memo.storeName !== 'string' || typeof memo.address !== 'string'
    || typeof memo.phone !== 'string' || !Array.isArray(memo.notes)
    || memo.notes.length !== 3 || !memo.notes.every((note) => typeof note === 'string')
    || typeof memo.terminalName !== 'string'
    || typeof memo.showBatchExpiry !== 'boolean'
    || !['none', '1', '5', '10'].includes(String(memo.roundNet))
    || typeof memo.printTax !== 'boolean' || typeof memo.duplicateLabel !== 'boolean'
    || typeof memo.autoPrint !== 'boolean'
    || !Number.isSafeInteger(memo.numberDigits)
    || Number(memo.numberDigits) < 1 || Number(memo.numberDigits) > 16) return false;

  return true;
}

function parseShopSettings(value: unknown): ShopSettings {
  if (!isSettings(value)) {
    throw new Error('The shop settings service returned an invalid response.');
  }
  return {
    ...value,
    profile: { ...value.profile },
    receiptSettings: { ...value.receiptSettings },
    memoSettings: { ...value.memoSettings, notes: [...value.memoSettings.notes] as [string, string, string] },
  };
}

export async function loadShopSettings(): Promise<ShopSettings> {
  return parseShopSettings(await apiRequest<unknown>('/api/shop/settings'));
}

export async function updateShopSettings(patch: ShopSettingsPatch): Promise<ShopSettings> {
  if (!isRecord(patch) || Object.keys(patch).length === 0
    || Object.keys(patch).some((key) => !['shopName', 'profile', 'receiptSettings', 'memoSettings'].includes(key))) {
    throw new Error('The shop settings update is invalid.');
  }
  return parseShopSettings(await apiRequest<unknown>('/api/shop/settings', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }));
}
