import { apiRequest } from '../api';

export interface FirstRunSetupInput {
  setupCode: string;
  shopName: string;
  phone: string;
  address: string;
  timeZone: string;
  username: string;
  email: string;
  fullName: string;
  password: string;
}

export interface SetupStatus {
  needsSetup: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function loadSetupStatus(): Promise<SetupStatus> {
  const value: unknown = await apiRequest('/api/setup/status');
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.needsSetup !== 'boolean') {
    throw new Error('The setup status service returned an invalid response.');
  }
  return { needsSetup: value.needsSetup };
}

export async function completeFirstRunSetup(input: FirstRunSetupInput): Promise<void> {
  const value: unknown = await apiRequest('/api/setup', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!isRecord(value) || Object.keys(value).length !== 1 || value.created !== true) {
    throw new Error('The setup service returned an invalid response.');
  }
}
