import { getSupabaseErrorMessage } from '../utils/supabaseError';
import { supabase } from '../utils/supabase';
import { apiRequest, getBackend } from '../api';
import { isStockAlertsSummary, type StockAlertsSummary } from './stockAlertLogic';

interface ApiStockAlertItem {
  medicineId: string;
  name: string;
  strength: string | null;
  genericName: string;
  stockBaseUnits: string;
  minStockAlert: number;
  kind: 'low' | 'out';
}

interface ApiStockAlertsSummary {
  lowCount: number;
  outCount: number;
  generatedAt: string;
  items: ApiStockAlertItem[];
}

function isApiStockAlertItem(value: unknown): value is ApiStockAlertItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 7
    && typeof item.medicineId === 'string'
    && typeof item.name === 'string'
    && (typeof item.strength === 'string' || item.strength === null)
    && typeof item.genericName === 'string'
    && typeof item.stockBaseUnits === 'string'
    && /^\d+$/.test(item.stockBaseUnits)
    && Number.isSafeInteger(Number(item.stockBaseUnits))
    && typeof item.minStockAlert === 'number'
    && Number.isSafeInteger(item.minStockAlert)
    && Number(item.minStockAlert) > 0
    && (item.kind === 'low' || item.kind === 'out');
}

function isApiStockAlertsSummary(value: unknown): value is ApiStockAlertsSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  return Object.keys(summary).length === 4
    && typeof summary.lowCount === 'number'
    && Number.isSafeInteger(summary.lowCount)
    && Number(summary.lowCount) >= 0
    && typeof summary.outCount === 'number'
    && Number.isSafeInteger(summary.outCount)
    && Number(summary.outCount) >= 0
    && typeof summary.generatedAt === 'string'
    && Number.isFinite(Date.parse(summary.generatedAt))
    && Array.isArray(summary.items)
    && summary.items.every(isApiStockAlertItem);
}

function toStockAlertsSummary(summary: ApiStockAlertsSummary): StockAlertsSummary {
  return {
    low_count: summary.lowCount,
    out_count: summary.outCount,
    generated_at: summary.generatedAt,
    items: summary.items.map((item) => ({
      medicine_id: item.medicineId,
      name: item.name,
      strength: item.strength,
      generic_name: item.genericName,
      stock: Number(item.stockBaseUnits),
      min_stock_alert: item.minStockAlert,
      kind: item.kind,
    })),
  };
}

export async function loadStockAlertsSummary(limit = 50): Promise<StockAlertsSummary> {
  if (getBackend() === 'api') {
    const data = await apiRequest<unknown>(`/api/stock/alerts/summary?limit=${encodeURIComponent(limit)}`);
    if (!isApiStockAlertsSummary(data)) {
      throw new Error('The stock alerts service returned an invalid response.');
    }
    const summary = toStockAlertsSummary(data);
    if (!isStockAlertsSummary(summary)) {
      throw new Error('The stock alerts service returned an invalid response.');
    }
    return summary;
  }

  if (!supabase) {
    throw new Error(getSupabaseErrorMessage(new Error('Supabase is not configured.'), 'Could not load stock alerts.'));
  }

  const { data, error } = await supabase.rpc('stock_alerts_summary', { p_limit: limit });
  if (error) {
    throw new Error(getSupabaseErrorMessage(error, 'Could not load stock alerts.'));
  }
  if (!isStockAlertsSummary(data)) {
    throw new Error(getSupabaseErrorMessage(
      new Error('The stock alerts service returned an invalid response.'),
      'Could not load stock alerts.',
    ));
  }
  return data;
}
