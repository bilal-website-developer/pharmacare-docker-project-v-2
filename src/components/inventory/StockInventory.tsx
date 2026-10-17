import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Download, FileSpreadsheet, History, RefreshCw, Search, SlidersHorizontal, X,
} from 'lucide-react';
import { getBackend } from '../../api';
import { supabase } from '../../utils/supabase';
import { getSupabaseErrorMessage } from '../../utils/supabaseError';
import { dispatchStockChanged } from '../../utils/stockAlertsEvents';
import {
  adjustStockBatch,
  listStockAdjustments,
  listStockBatches,
  loadStockExpiryBuckets,
  loadStockOverview,
  writeOffExpiredBatch,
  type StockInventoryBatch as StockBatchRow,
  type StockInventoryExpiryBucket as StockExpiryBucket,
  type StockInventoryList as StockListResponse,
  type StockInventoryMovements as StockMovementsResponse,
  type StockInventoryStats as StockOverviewStats,
} from '../../data/stockInventory';
import {
  ConfirmDialog, DataTable, EmptyState, ExpiryChip, FilterChip, KpiCard, SegmentedTabs,
  Skeleton, StockBar, StatusChip,
  type DataTableAction,
  type DataTableColumn,
} from './InventoryUi';
import { getStockAdjustmentPreview } from './stockInventoryLogic';

const PAGE_SIZE = 25;
const PICKER_PAGE_SIZE = 10;
const EXPORT_PAGE_SIZE = 500;
const FIELD = 'w-full rounded-control border border-border bg-surface px-3 py-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
const PANEL = 'rounded-xl border border-border bg-surface shadow-xs';
const BUTTON = 'inline-flex items-center justify-center gap-2 rounded-control bg-primary px-3 py-2 text-sm font-bold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const SECONDARY = 'inline-flex items-center justify-center gap-2 rounded-control border border-border bg-surface px-3 py-2 text-sm font-semibold text-text hover:bg-surface/80 disabled:cursor-not-allowed disabled:opacity-50';

type BatchTab = 'all' | 'near-expiry' | 'expired' | 'low-stock';
type StockTab = BatchTab | 'adjustment-log';
type StockSort = 'medicine_asc' | 'medicine_desc' | 'batch_asc' | 'batch_desc' | 'expiry_asc' | 'expiry_desc'
  | 'quantity_asc' | 'quantity_desc' | 'cost_asc' | 'cost_desc' | 'value_asc' | 'value_desc';
type ExpiryBucketKey = 'expired' | '0-30' | '31-60' | '61-90' | '90+';

type StockMovementRow = StockInventoryMovements['rows'][number];
type StockExpiryBucketsResponse = { buckets: StockExpiryBucket[] };

const BATCH_TABS: readonly { label: string; value: BatchTab }[] = [
  { label: 'All batches', value: 'all' },
  { label: 'Near-expiry', value: 'near-expiry' },
  { label: 'Expired', value: 'expired' },
  { label: 'Low stock', value: 'low-stock' },
];

const STOCK_TABS: readonly { label: string; value: StockTab }[] = [
  ...BATCH_TABS,
  { label: 'Adjustment log', value: 'adjustment-log' },
];

const EXPIRY_LABELS: Record<ExpiryBucketKey, string> = {
  expired: 'Expired',
  '0-30': '0-30 days',
  '31-60': '31-60 days',
  '61-90': '61-90 days',
  '90+': '90+ days',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPaisaValue(value: unknown): value is string | number | null {
  return value === null
    || (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function isStockBatchRow(value: unknown): value is StockBatchRow {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.medicine_id === 'string'
    && typeof value.medicine_name === 'string'
    && typeof value.generic_name === 'string'
    && typeof value.code === 'string'
    && typeof value.batch_number === 'string'
    && typeof value.expiry_date === 'string'
    && typeof value.received_date === 'string'
    && typeof value.quantity_remaining === 'number'
    && typeof value.status === 'string'
    && typeof value.min_stock_alert === 'number'
    && isPaisaValue(value.cost_paisa_per_base_unit)
    && isPaisaValue(value.mrp_paisa_per_base_unit)
    && isPaisaValue(value.stock_value_cost_paisa)
    && typeof value.is_sellable === 'boolean';
}

function isStockListResponse(value: unknown): value is StockListResponse {
  return isRecord(value)
    && Array.isArray(value.rows)
    && value.rows.every(isStockBatchRow)
    && typeof value.total_count === 'number'
    && typeof value.page === 'number'
    && typeof value.page_size === 'number'
    && typeof value.can_view_cost === 'boolean';
}

function isStockOverviewStats(value: unknown): value is StockOverviewStats {
  return isRecord(value)
    && isPaisaValue(value.stock_value_cost_paisa)
    && isPaisaValue(value.stock_value_mrp_paisa)
    && typeof value.expiring_30 === 'number'
    && typeof value.expired_batches === 'number'
    && isPaisaValue(value.expired_value_at_risk_paisa);
}

function isStockExpiryBucketsResponse(value: unknown): value is StockExpiryBucketsResponse {
  return isRecord(value)
    && Array.isArray(value.buckets)
    && value.buckets.every((bucket) => isRecord(bucket)
      && ['expired', '0-30', '31-60', '61-90', '90+'].includes(String(bucket.key))
      && typeof bucket.label === 'string'
      && typeof bucket.count === 'number'
      && typeof bucket.quantity_remaining === 'number');
}

function isStockMovementRow(value: unknown): value is StockMovementRow {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.batch_id === 'string'
    && typeof value.batch_number === 'string'
    && typeof value.medicine_id === 'string'
    && typeof value.medicine_name === 'string'
    && typeof value.generic_name === 'string'
    && typeof value.movement_type === 'string'
    && typeof value.quantity_delta === 'number'
    && typeof value.reason === 'string'
    && typeof value.created_at === 'string'
    && typeof value.actor_name === 'string';
}

function isStockMovementsResponse(value: unknown): value is StockMovementsResponse {
  return isRecord(value)
    && Array.isArray(value.rows)
    && value.rows.every(isStockMovementRow)
    && typeof value.total_count === 'number'
    && typeof value.page === 'number'
    && typeof value.page_size === 'number';
}

async function readRpc<T>(
  operation: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  isExpected: (value: unknown) => value is T,
  functionName: string,
): Promise<T> {
  const { data, error } = await operation;
  if (error) throw error;
  if (!isExpected(data)) throw new Error(`Unexpected response from ${functionName}.`);
  return data;
}

function money(paisa: number | string) {
  const amount = BigInt(paisa);
  const rupees = amount / 100n;
  const cents = String(amount % 100n).padStart(2, '0');
  return `Rs ${rupees.toLocaleString('en-PK')}.${cents}`;
}

function csvCell(value: string | number) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function stockErrorMessage(error: unknown, fallback: string) {
  if (getBackend() === 'api' && error instanceof Error) return error.message;
  return getSupabaseErrorMessage(error, fallback);
}

function stockListArgs({
  tab,
  search,
  sort,
  page,
  pageSize,
  medicineId,
  expiryBucket,
}: {
  tab: BatchTab;
  search: string;
  sort: StockSort;
  page: number;
  pageSize: number;
  medicineId: string | null;
  expiryBucket: ExpiryBucketKey | null;
}) {
  return {
    p_tab: tab,
    p_search: search || null,
    p_sort: sort,
    p_page: page,
    p_page_size: pageSize,
    p_medicine_id: medicineId,
    p_expiry_bucket: expiryBucket,
  };
}

export function StockInventory({
  initialMedicineId,
  initialTab = 'all',
  onClearMedicineFilter,
}: {
  initialMedicineId: string | null;
  initialTab?: BatchTab;
  onClearMedicineFilter?: () => void;
}) {
  const [tab, setTab] = useState<StockTab>(initialTab);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [sort, setSort] = useState<StockSort>('expiry_asc');
  const [page, setPage] = useState(1);
  const [expiryBucket, setExpiryBucket] = useState<ExpiryBucketKey | null>(null);
  const [rows, setRows] = useState<StockBatchRow[]>([]);
  const [movements, setMovements] = useState<StockMovementRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [movementCount, setMovementCount] = useState(0);
  const [tabCounts, setTabCounts] = useState<Record<StockTab, number>>({
    all: 0,
    'near-expiry': 0,
    expired: 0,
    'low-stock': 0,
    'adjustment-log': 0,
  });
  const [stats, setStats] = useState<StockOverviewStats | null>(null);
  const [expiryBuckets, setExpiryBuckets] = useState<StockExpiryBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [exporting, setExporting] = useState(false);
  const [adjusting, setAdjusting] = useState<StockBatchRow | null>(null);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [adjustmentError, setAdjustmentError] = useState('');
  const [confirmAdjustment, setConfirmAdjustment] = useState(false);
  const [writeOffBatch, setWriteOffBatch] = useState<StockBatchRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [movementBatch, setMovementBatch] = useState<StockBatchRow | null>(null);
  const [movementPage, setMovementPage] = useState(1);
  const [movementLoading, setMovementLoading] = useState(false);
  const [movementError, setMovementError] = useState('');
  const [movementReload, setMovementReload] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState('');
  const [appliedPickerSearch, setAppliedPickerSearch] = useState('');
  const [pickerPage, setPickerPage] = useState(1);
  const [pickerRows, setPickerRows] = useState<StockBatchRow[]>([]);
  const [pickerCount, setPickerCount] = useState(0);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState('');
  const loadSequence = useRef(0);
  const movementSequence = useRef(0);
  const pickerSequence = useRef(0);

  useEffect(() => {
    setTab(initialTab);
    setPage(1);
  }, [initialMedicineId, initialTab]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setAppliedSearch(search.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setAppliedPickerSearch(pickerSearch.trim());
      setPickerPage(1);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [pickerSearch]);

  const load = useCallback(async () => {
    const client = supabase;
    const apiMode = getBackend() === 'api';
    const sequence = ++loadSequence.current;
    if (!apiMode && !client) {
      setError('Supabase is not configured.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const activeBatchTab: BatchTab = tab === 'adjustment-log' ? 'all' : tab;
      const batchQuery = {
          tab: activeBatchTab,
          search: appliedSearch,
          sort,
          page,
          pageSize: PAGE_SIZE,
          medicineId: initialMedicineId,
          expiryBucket,
        };
      const batchResultPromise = apiMode
        ? listStockBatches(batchQuery)
        : readRpc(
          client!.rpc('stock_batches_list', stockListArgs(batchQuery)),
          isStockListResponse,
          'stock_batches_list',
        );
      const statsPromise = apiMode
        ? loadStockOverview()
        : readRpc(client!.rpc('stock_overview_stats'), isStockOverviewStats, 'stock_overview_stats');
      const bucketsPromise = apiMode
        ? loadStockExpiryBuckets()
        : readRpc(client!.rpc('stock_expiry_buckets'), isStockExpiryBucketsResponse, 'stock_expiry_buckets');
      const countPromises = BATCH_TABS.map(({ value }) => {
        const query = {
          tab: value,
          search: appliedSearch,
          sort,
          page: 1,
          pageSize: 1,
          medicineId: initialMedicineId,
          expiryBucket: null,
        };
        return apiMode
          ? listStockBatches(query)
          : readRpc(client!.rpc('stock_batches_list', stockListArgs(query)), isStockListResponse, 'stock_batches_list');
      });
      const activeMovementsPromise = tab === 'adjustment-log'
        ? apiMode
          ? listStockAdjustments({ page, pageSize: PAGE_SIZE, reason: appliedSearch || null })
          : readRpc(
            client!.rpc('stock_adjustments_log', {
              p_page: page,
              p_page_size: PAGE_SIZE,
              p_reason: appliedSearch || null,
              p_batch_id: null,
            }),
            isStockMovementsResponse,
            'stock_adjustments_log',
          )
        : null;
      const movementCountPromise = tab === 'adjustment-log'
        ? null
        : apiMode
          ? listStockAdjustments({ page: 1, pageSize: 1, reason: appliedSearch || null })
          : readRpc(
            client!.rpc('stock_adjustments_log', {
              p_page: 1,
              p_page_size: 1,
              p_reason: appliedSearch || null,
              p_batch_id: null,
            }),
            isStockMovementsResponse,
            'stock_adjustments_log',
          );
      const [batchResult, nextStats, nextBuckets, ...countResults] = await Promise.all([
        batchResultPromise,
        statsPromise,
        bucketsPromise,
        ...countPromises,
        ...(activeMovementsPromise ? [activeMovementsPromise] : []),
        ...(movementCountPromise ? [movementCountPromise] : []),
      ]);
      const counts = countResults.slice(0, BATCH_TABS.length) as StockListResponse[];
      const nextTabCounts: Record<StockTab, number> = {
        all: counts[0].total_count,
        'near-expiry': counts[1].total_count,
        expired: counts[2].total_count,
        'low-stock': counts[3].total_count,
        'adjustment-log': 0,
      };
      if (activeMovementsPromise) {
        const activeMovementResult = countResults[BATCH_TABS.length] as StockMovementsResponse;
        nextTabCounts['adjustment-log'] = activeMovementResult.total_count;
        if (sequence === loadSequence.current) {
          setMovements(activeMovementResult.rows);
          setMovementCount(activeMovementResult.total_count);
        }
      } else if (movementCountPromise) {
        const adjustmentCount = countResults[BATCH_TABS.length] as StockMovementsResponse;
        nextTabCounts['adjustment-log'] = adjustmentCount.total_count;
      }
      if (sequence !== loadSequence.current) return;
      setRows(batchResult.rows);
      setTotalCount(tab === 'adjustment-log' ? nextTabCounts['adjustment-log'] : batchResult.total_count);
      setStats(nextStats);
      setExpiryBuckets(nextBuckets.buckets);
      setTabCounts(nextTabCounts);
    } catch (caught) {
      if (sequence !== loadSequence.current) return;
      setError(stockErrorMessage(caught, 'Could not load stock inventory.'));
      setRows([]);
      setMovements([]);
      setTotalCount(0);
      setMovementCount(0);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [appliedSearch, expiryBucket, initialMedicineId, page, sort, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadPicker = useCallback(async () => {
    const client = supabase;
    const apiMode = getBackend() === 'api';
    const sequence = ++pickerSequence.current;
    if (!pickerOpen) return;
    if (!apiMode && !client) {
      setPickerError('Supabase is not configured.');
      setPickerLoading(false);
      return;
    }
    setPickerLoading(true);
    setPickerError('');
    try {
      const query = {
          tab: 'all',
          search: appliedPickerSearch,
          sort: 'expiry_asc',
          page: pickerPage,
          pageSize: PICKER_PAGE_SIZE,
          medicineId: initialMedicineId,
          expiryBucket: null,
        } as const;
      const response = apiMode
        ? await listStockBatches(query)
        : await readRpc(
          client!.rpc('stock_batches_list', stockListArgs(query)),
          isStockListResponse,
          'stock_batches_list',
        );
      if (sequence !== pickerSequence.current) return;
      setPickerRows(response.rows);
      setPickerCount(response.total_count);
    } catch (caught) {
      if (sequence !== pickerSequence.current) return;
      setPickerError(stockErrorMessage(caught, 'Could not load batches for adjustment.'));
      setPickerRows([]);
      setPickerCount(0);
    } finally {
      if (sequence === pickerSequence.current) setPickerLoading(false);
    }
  }, [appliedPickerSearch, initialMedicineId, pickerPage, pickerOpen]);

  useEffect(() => {
    void loadPicker();
  }, [loadPicker]);

  useEffect(() => {
    if (!movementBatch) return;
    const client = supabase;
    const apiMode = getBackend() === 'api';
    const sequence = ++movementSequence.current;
    if (!apiMode && !client) {
      setMovementError('Supabase is not configured.');
      setMovementLoading(false);
      return;
    }
    setMovementLoading(true);
    setMovementError('');
    const movementsPromise = apiMode
      ? listStockAdjustments({ page: movementPage, pageSize: PAGE_SIZE, batchId: movementBatch.id })
      : readRpc(
        client!.rpc('stock_adjustments_log', {
          p_page: movementPage,
          p_page_size: PAGE_SIZE,
          p_reason: null,
          p_batch_id: movementBatch.id,
        }),
        isStockMovementsResponse,
        'stock_adjustments_log',
      );
    void movementsPromise.then((response) => {
      if (sequence !== movementSequence.current) return;
      setMovements(response.rows);
      setMovementCount(response.total_count);
    }).catch((caught: unknown) => {
      if (sequence !== movementSequence.current) return;
      setMovementError(stockErrorMessage(caught, 'Could not load batch movements.'));
      setMovements([]);
      setMovementCount(0);
    }).finally(() => {
      if (sequence === movementSequence.current) setMovementLoading(false);
    });
  }, [movementBatch, movementPage, movementReload]);

  const openAdjustment = (batch: StockBatchRow) => {
    setAdjusting(batch);
    setDelta('');
    setReason('');
    setAdjustmentError('');
    setPickerOpen(false);
    setConfirmAdjustment(false);
  };

  const adjustmentPreview = adjusting
    ? getStockAdjustmentPreview(adjusting.quantity_remaining, delta)
    : null;

  const reviewAdjustment = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!adjusting || !adjustmentPreview) {
      setAdjustmentError('Enter a valid non-zero whole-number quantity change that keeps stock within range.');
      return;
    }
    if (!reason) {
      setAdjustmentError('Select a reason for this adjustment.');
      return;
    }
    setAdjustmentError('');
    setConfirmAdjustment(true);
  };

  const commitAdjustment = async () => {
    const client = supabase;
    const apiMode = getBackend() === 'api';
    if ((!apiMode && !client) || !adjusting || !adjustmentPreview || !reason || saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const resultingQuantity = apiMode
        ? await adjustStockBatch(adjusting.id, adjustmentPreview.delta, reason)
        : await (async () => {
          const { data, error: rpcError } = await client!.rpc('adjust_stock', {
            p_batch_id: adjusting.id,
            p_quantity_delta: adjustmentPreview.delta,
            p_reason: reason,
          });
          if (rpcError) throw rpcError;
          if (typeof data !== 'number') throw new Error('The stock adjustment response was invalid.');
          return data;
        })();
      dispatchStockChanged();
      if (resultingQuantity !== adjustmentPreview.resultingQuantity) {
        throw new Error('The stock adjustment response did not match the reviewed quantity.');
      }
      setAdjusting(null);
      setConfirmAdjustment(false);
      setNotice('Stock adjustment recorded.');
      await load();
    } catch (caught) {
      setAdjustmentError(stockErrorMessage(caught, 'Could not adjust stock.'));
      setConfirmAdjustment(false);
    } finally {
      setSaving(false);
    }
  };

  const commitWriteOff = async () => {
    const client = supabase;
    const apiMode = getBackend() === 'api';
    if ((!apiMode && !client) || !writeOffBatch || saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      if (apiMode) {
        await writeOffExpiredBatch(writeOffBatch.id);
      } else {
        const { error: rpcError } = await client!.rpc('write_off_expired_batch', {
          p_batch_id: writeOffBatch.id,
          p_reason: 'expired',
        });
        if (rpcError) throw rpcError;
      }
      dispatchStockChanged();
      setNotice(`Batch ${writeOffBatch.batch_number} written off. The batch remains in inventory history.`);
      setWriteOffBatch(null);
      await load();
    } catch (caught) {
      setError(stockErrorMessage(caught, 'Could not write off the expired batch.'));
      setWriteOffBatch(null);
    } finally {
      setSaving(false);
    }
  };

  const toggleSort = (field: 'medicine' | 'batch' | 'expiry' | 'quantity' | 'cost' | 'value') => {
    const ascending = `${field}_asc` as StockSort;
    const descending = `${field}_desc` as StockSort;
    setPage(1);
    setSort((current) => current === ascending ? descending : ascending);
  };

  const batchColumns = useMemo<DataTableColumn<StockBatchRow>[]>(() => {
    const sortable = (
      id: string,
      header: string,
      field: 'medicine' | 'batch' | 'expiry' | 'quantity' | 'cost' | 'value',
      render: (batch: StockBatchRow) => React.ReactNode,
    ): DataTableColumn<StockBatchRow> => {
      const ascending = `${field}_asc` as StockSort;
      const descending = `${field}_desc` as StockSort;
      return {
        id,
        header,
        render,
        sortable: true,
        sortDirection: sort === ascending ? 'ascending' : sort === descending ? 'descending' : 'none',
        onSort: () => toggleSort(field),
      };
    };
    const columns: DataTableColumn<StockBatchRow>[] = [
      sortable('medicine', 'Medicine', 'medicine', (batch) => (
        <div className="min-w-36">
          <strong className="block text-text">{batch.medicine_name}</strong>
          <span className="text-xs text-muted">{batch.generic_name} · {batch.code}</span>
        </div>
      )),
      sortable('batch', 'Batch', 'batch', (batch) => <span className="font-mono">{batch.batch_number}</span>),
      sortable('expiry', 'Expiry', 'expiry', (batch) => <ExpiryChip expiryDate={batch.expiry_date} quantity={batch.quantity_remaining} />),
      sortable('quantity', 'Quantity', 'quantity', (batch) => (
        <div className="min-w-28 space-y-1">
          <strong>{batch.quantity_remaining.toLocaleString()}</strong>
          <StockBar quantity={batch.quantity_remaining} reorderLevel={batch.min_stock_alert} />
        </div>
      )),
    ];
    if (rows.some((batch) => batch.cost_paisa_per_base_unit !== null)) {
      columns.push(sortable('cost', 'Cost', 'cost', (batch) => batch.cost_paisa_per_base_unit === null ? '—' : money(batch.cost_paisa_per_base_unit)));
    }
    if (rows.some((batch) => batch.stock_value_cost_paisa !== null)) {
      columns.push(sortable('value', 'Value', 'value', (batch) => batch.stock_value_cost_paisa === null ? '—' : money(batch.stock_value_cost_paisa)));
    }
    columns.push({
      id: 'status',
      header: 'Status',
      render: (batch) => {
        const variant = batch.status === 'ACTIVE' ? 'ok'
          : batch.status === 'NEAR_EXPIRY' ? 'warning'
            : ['EXPIRED', 'DAMAGED', 'RECALLED'].includes(batch.status) ? 'danger'
              : 'neutral';
        return <StatusChip variant={variant}>{batch.status.replaceAll('_', ' ')}</StatusChip>;
      },
    });
    return columns;
  }, [rows, sort]);

  const batchActions = useMemo<DataTableAction<StockBatchRow>[]>(() => [
    { label: 'Adjust', onSelect: openAdjustment },
    {
      label: 'View movements',
      onSelect: (batch) => {
        setMovementBatch(batch);
        setMovementPage(1);
        setMovementError('');
      },
    },
    {
      label: 'Write off',
      onSelect: setWriteOffBatch,
      disabled: (batch) => batch.quantity_remaining <= 0 || batch.status !== 'EXPIRED',
    },
  ], []);

  const movementColumns = useMemo<DataTableColumn<StockMovementRow>[]>(() => [
    {
      id: 'medicine',
      header: 'Medicine',
      render: (movement) => <strong>{movement.medicine_name}</strong>,
    },
    { id: 'batch', header: 'Batch', render: (movement) => <span className="font-mono">{movement.batch_number}</span> },
    { id: 'type', header: 'Movement', render: (movement) => <StatusChip variant="info">{movement.movement_type.replaceAll('_', ' ')}</StatusChip> },
    {
      id: 'quantity',
      header: 'Change',
      render: (movement) => (
        <strong className={movement.quantity_delta < 0 ? 'text-danger' : 'text-primary'}>
          {movement.quantity_delta > 0 ? '+' : ''}{movement.quantity_delta.toLocaleString()}
        </strong>
      ),
    },
    { id: 'reason', header: 'Reason', render: (movement) => movement.reason },
    { id: 'date', header: 'Date', render: (movement) => new Date(movement.created_at).toLocaleString() },
    { id: 'actor', header: 'By', render: (movement) => movement.actor_name },
  ], []);

  const exportRows = async (format: 'csv' | 'xlsx') => {
    const client = supabase;
    const apiMode = getBackend() === 'api';
    if ((!apiMode && !client) || exporting) return;
    setExporting(true);
    setError('');
    try {
      if (tab === 'adjustment-log') {
        const allMovements: StockMovementRow[] = [];
        let total = 0;
        let exportPage = 1;
        do {
          const response = apiMode
            ? await listStockAdjustments({
              page: exportPage,
              pageSize: EXPORT_PAGE_SIZE,
              reason: appliedSearch || null,
            })
            : await readRpc(
              client!.rpc('stock_adjustments_log', {
                p_page: exportPage,
                p_page_size: EXPORT_PAGE_SIZE,
                p_reason: appliedSearch || null,
                p_batch_id: null,
              }),
              isStockMovementsResponse,
              'stock_adjustments_log',
            );
          allMovements.push(...response.rows);
          total = response.total_count;
          if (response.rows.length === 0) break;
          exportPage += 1;
        } while (allMovements.length < total);
        const headers = ['Medicine', 'Batch', 'Movement', 'Quantity change', 'Reason', 'Date', 'By'];
        const rowsToExport = allMovements.map((movement) => [
          `${movement.medicine_name} (${movement.generic_name})`,
          movement.batch_number,
          movement.movement_type,
          movement.quantity_delta,
          movement.reason,
          movement.created_at,
          movement.actor_name,
        ]);
        await downloadData(format, `stock-adjustment-log-${dateStamp()}`, headers, rowsToExport);
      } else {
        const allBatches: StockBatchRow[] = [];
        let total = 0;
        let exportPage = 1;
        do {
          const query = {
              tab,
              search: appliedSearch,
              sort,
              page: exportPage,
              pageSize: EXPORT_PAGE_SIZE,
              medicineId: initialMedicineId,
              expiryBucket,
            };
          const response = apiMode
            ? await listStockBatches(query)
            : await readRpc(
              client!.rpc('stock_batches_list', stockListArgs(query)),
              isStockListResponse,
              'stock_batches_list',
            );
          allBatches.push(...response.rows);
          total = response.total_count;
          if (response.rows.length === 0) break;
          exportPage += 1;
        } while (allBatches.length < total);
        const includeCost = allBatches.some((batch) => batch.cost_paisa_per_base_unit !== null);
        const includeValue = allBatches.some((batch) => batch.stock_value_cost_paisa !== null);
        const headers = [
          'Medicine', 'Generic name', 'Code', 'Batch', 'Expiry', 'Quantity', 'Status',
          ...(includeCost ? ['Cost per base unit'] : []),
          ...(includeValue ? ['Stock value at cost'] : []),
        ];
        const rowsToExport = allBatches.map((batch) => [
          batch.medicine_name,
          batch.generic_name,
          batch.code,
          batch.batch_number,
          batch.expiry_date,
          batch.quantity_remaining,
          batch.status,
          ...(includeCost ? [batch.cost_paisa_per_base_unit ?? ''] : []),
          ...(includeValue ? [batch.stock_value_cost_paisa ?? ''] : []),
        ]);
        await downloadData(format, `stock-inventory-${dateStamp()}`, headers, rowsToExport);
      }
    } catch (caught) {
      setError(stockErrorMessage(caught, 'Could not export stock inventory.'));
    } finally {
      setExporting(false);
    }
  };

  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const movementPageCount = Math.max(1, Math.ceil(movementCount / PAGE_SIZE));
  const pickerPageCount = Math.max(1, Math.ceil(pickerCount / PICKER_PAGE_SIZE));
  const maxBucketCount = Math.max(1, ...expiryBuckets.map((bucket) => bucket.count));
  const selectTab = (nextTab: StockTab) => {
    setTab(nextTab);
    setPage(1);
    if (nextTab === 'adjustment-log') setExpiryBucket(null);
  };

  const selectExpiryBucket = (key: ExpiryBucketKey) => {
    setTab('all');
    setExpiryBucket(key);
    setPage(1);
  };

  return (
    <div className="space-y-4">
      <header className={`${PANEL} flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between`}>
        <div>
          <h1 className="text-2xl font-black text-text">Stock Inventory</h1>
          <p className="text-sm text-muted">Live batch balances from purchases and stock movements.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <details className="relative">
            <summary className={`${SECONDARY} list-none cursor-pointer`}>
              <Download size={16} /> {exporting ? 'Exporting…' : 'Export'}
            </summary>
            <div className="absolute right-0 z-20 mt-1 min-w-40 rounded-control border border-border bg-surface p-1 shadow-lg">
              <button type="button" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-text hover:bg-surface/80" disabled={exporting} onClick={() => void exportRows('csv')}>Export CSV</button>
              <button type="button" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-text hover:bg-surface/80" disabled={exporting} onClick={() => void exportRows('xlsx')}><FileSpreadsheet size={15} />Export XLSX</button>
            </div>
          </details>
          <button type="button" className={BUTTON} onClick={() => { setPickerOpen(true); setPickerError(''); }}><SlidersHorizontal size={16} />Adjust stock</button>
        </div>
      </header>

      {stats ? (
        <section aria-label="Stock overview" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {stats.stock_value_cost_paisa !== null && <KpiCard compact label="Stock value (cost)" value={money(stats.stock_value_cost_paisa)} detail="all active batches" />}
          <KpiCard compact label="Stock value (MRP)" value={money(stats.stock_value_mrp_paisa)} detail="potential sales" />
          <KpiCard compact label="Expiring in 30 days" value={stats.expiring_30.toLocaleString()} detail="batches" valueClassName="text-warning" />
          <KpiCard
            compact
            label="Expired"
            value={stats.expired_batches.toLocaleString()}
            detail={stats.expired_value_at_risk_paisa === null
              ? 'batches with remaining stock'
              : `${money(stats.expired_value_at_risk_paisa)} at risk`}
            valueClassName="text-danger"
          />
        </section>
      ) : loading ? (
        <section aria-label="Stock overview loading" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => <div key={index} className={PANEL}><Skeleton label="Loading stock overview" lines={3} /></div>)}
        </section>
      ) : null}

      {initialMedicineId && (
        <div className="flex flex-wrap items-center gap-2 rounded-control border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-text">
          <span>Showing batches for the selected product.</span>
          {onClearMedicineFilter && <button type="button" className={SECONDARY} onClick={onClearMedicineFilter}>Show all products</button>}
        </div>
      )}
      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <span>{error}</span>
          <button type="button" className={SECONDARY} disabled={loading} onClick={() => void load()}>Retry</button>
        </div>
      )}
      {notice && <div role="status" className="rounded-control border border-border bg-surface px-4 py-3 text-sm text-text">{notice}</div>}

      <section className={`${PANEL} space-y-3 p-3`}>
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <SegmentedTabs
            label="Stock inventory views"
            value={tab}
            tabs={STOCK_TABS.map((item) => ({
              ...item,
              label: item.value === 'near-expiry'
                ? `${item.label} (${tabCounts['near-expiry'].toLocaleString()})`
                : item.value === 'expired'
                  ? `${item.label} (${tabCounts.expired.toLocaleString()})`
                  : item.value === 'adjustment-log'
                    ? `${item.label} (${tabCounts['adjustment-log'].toLocaleString()})`
                    : item.label,
            }))}
            onChange={selectTab}
          />
          <label className="relative min-w-48 flex-1 xl:max-w-sm">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted" />
            <input
              className={`${FIELD} pl-9`}
              aria-label={tab === 'adjustment-log' ? 'Filter adjustment log by exact reason' : 'Search stock batches'}
              placeholder={tab === 'adjustment-log' ? 'Filter by exact reason' : 'Search medicine or batch'}
              value={search}
              onChange={(event) => { setPage(1); setSearch(event.target.value); }}
            />
          </label>
          <button type="button" aria-label="Refresh stock inventory" className={SECONDARY} onClick={() => void load()} disabled={loading}><RefreshCw size={16} /></button>
        </div>
        {expiryBucket && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-muted">Active expiry filter</span>
            <FilterChip onRemove={() => { setExpiryBucket(null); setPage(1); }} removeLabel="Clear expiry timeline filter">
              {EXPIRY_LABELS[expiryBucket]}
            </FilterChip>
          </div>
        )}
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          {tab === 'adjustment-log' ? (
            <DataTable
              label="Stock adjustment log"
              rows={movements}
              columns={movementColumns}
              getRowId={(movement) => movement.id}
              loading={loading}
              emptyTitle="No stock movements found"
              emptyDescription="Adjustments and write-offs matching this reason will appear here."
              layout="responsive"
              pagination={{
                page,
                pageCount,
                totalCount: movementCount,
                onPageChange: setPage,
              }}
            />
          ) : (
            <DataTable
              label="Stock batches"
              rows={rows}
              columns={batchColumns}
              getRowId={(batch) => batch.id}
              loading={loading}
              emptyTitle="No stock batches found"
              emptyDescription="Try another tab, search, or expiry timeline bucket."
              actions={batchActions}
              layout="responsive"
              pagination={{
                page,
                pageCount,
                totalCount,
                onPageChange: setPage,
              }}
            />
          )}
        </div>

        <aside className={`${PANEL} h-fit p-4`}>
          <div className="mb-3 flex items-center gap-2">
            <History size={18} className="text-primary" />
            <h2 className="font-bold text-text">Expiry timeline</h2>
          </div>
          {loading && expiryBuckets.length === 0 ? <Skeleton label="Loading expiry timeline" lines={5} /> : (
            <div className="space-y-2">
              {expiryBuckets.map((bucket) => (
                <button
                  key={bucket.key}
                  type="button"
                  onClick={() => selectExpiryBucket(bucket.key)}
                  aria-pressed={expiryBucket === bucket.key}
                  className={`flex w-full items-center gap-2 rounded-control p-1 text-left text-xs text-text ${expiryBucket === bucket.key ? 'bg-primary/10 ring-1 ring-primary/30' : 'hover:bg-surface/80'}`}
                >
                  <span className="w-16 shrink-0">{bucket.label}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-border">
                    <span
                      className={`block h-full rounded-full ${bucket.key === 'expired' ? 'bg-danger' : bucket.key === '0-30' ? 'bg-warning' : 'bg-primary'}`}
                      style={{ width: `${Math.max(bucket.count > 0 ? 3 : 0, (bucket.count / maxBucketCount) * 100)}%` }}
                    />
                  </span>
                  <strong className="w-8 text-right">{bucket.count.toLocaleString()}</strong>
                </button>
              ))}
            </div>
          )}
        </aside>
      </div>

      {pickerOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-black/50 p-4">
          <section role="dialog" aria-modal="true" aria-labelledby="stock-picker-title" className={`${PANEL} my-auto max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto p-5`}>
            <div className="flex items-start justify-between gap-3">
              <div><h2 id="stock-picker-title" className="text-lg font-black text-text">Choose a batch to adjust</h2><p className="text-sm text-muted">Find a batch, review the quantity change, and confirm before it is recorded.</p></div>
              <button type="button" aria-label="Close batch picker" className={SECONDARY} onClick={() => setPickerOpen(false)}><X size={16} /></button>
            </div>
            <label className="relative block">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted" />
              <input className={`${FIELD} pl-9`} aria-label="Search batches to adjust" placeholder="Search medicine or batch" value={pickerSearch} onChange={(event) => setPickerSearch(event.target.value)} />
            </label>
            {pickerError && <div role="alert" className="flex items-center justify-between gap-2 rounded-control bg-danger/10 p-3 text-sm text-danger"><span>{pickerError}</span><button type="button" className={SECONDARY} onClick={() => void loadPicker()}>Retry</button></div>}
            {pickerLoading ? <Skeleton label="Loading batches to adjust" lines={5} /> : pickerRows.length === 0 ? (
              <EmptyState title="No batches found" description="Search for another medicine or batch." />
            ) : (
              <div className="divide-y divide-border rounded-control border border-border">
                {pickerRows.map((batch) => (
                  <div key={batch.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <strong className="block truncate text-text">{batch.medicine_name}</strong>
                      <span className="text-xs text-muted">{batch.batch_number} · {batch.quantity_remaining.toLocaleString()} remaining</span>
                    </div>
                    <button type="button" className={SECONDARY} onClick={() => openAdjustment(batch)}>Select batch</button>
                  </div>
                ))}
              </div>
            )}
            {!pickerLoading && pickerCount > PICKER_PAGE_SIZE && (
              <div className="flex items-center justify-between text-sm text-muted">
                <span>{pickerCount.toLocaleString()} batches · Page {pickerPage} of {pickerPageCount}</span>
                <div className="flex gap-2">
                  <button type="button" className={SECONDARY} disabled={pickerPage <= 1} onClick={() => setPickerPage((current) => current - 1)}>Previous</button>
                  <button type="button" className={SECONDARY} disabled={pickerPage >= pickerPageCount} onClick={() => setPickerPage((current) => current + 1)}>Next</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {adjusting && (
        <div className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-black/50 p-4">
          <form onSubmit={reviewAdjustment} className={`${PANEL} my-auto w-full max-w-md space-y-4 p-5`}>
            <div className="flex items-start justify-between gap-3">
              <div><h2 className="text-lg font-black text-text">Adjust batch stock</h2><p className="text-sm text-muted">{adjusting.medicine_name} · {adjusting.batch_number}</p></div>
              <button type="button" aria-label="Close stock adjustment" className={SECONDARY} onClick={() => { setAdjusting(null); setConfirmAdjustment(false); }}><X size={16} /></button>
            </div>
            <p className="rounded-control border border-border bg-surface/70 px-3 py-2 text-sm text-text">Current quantity: <strong>{adjusting.quantity_remaining.toLocaleString()}</strong></p>
            <label className="block text-sm text-text">Quantity change *
              <span className="mt-1 block text-xs text-muted">Use a negative number to remove stock or a positive number to add stock.</span>
              <input className={`${FIELD} mt-2`} type="number" step="1" required value={delta} onChange={(event) => setDelta(event.target.value)} />
            </label>
            <label className="block text-sm text-text">Reason *
              <select className={`${FIELD} mt-1`} required value={reason} onChange={(event) => setReason(event.target.value)}>
                <option value="">Select a reason</option>
                <option value="damage">Damage</option>
                <option value="expired">Expired</option>
                <option value="counting error">Counting error</option>
                <option value="theft">Theft</option>
                <option value="other">Other</option>
              </select>
            </label>
            {adjustmentPreview && (
              <div className="rounded-control border border-primary/30 bg-primary/5 p-3 text-sm text-text">
                <p>Current quantity: <strong>{adjusting.quantity_remaining.toLocaleString()}</strong></p>
                <p>Change: <strong>{adjustmentPreview.delta > 0 ? '+' : ''}{adjustmentPreview.delta.toLocaleString()}</strong></p>
                <p>Resulting quantity: <strong>{adjustmentPreview.resultingQuantity.toLocaleString()}</strong></p>
              </div>
            )}
            {adjustmentError && <p role="alert" className="text-sm text-danger">{adjustmentError}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className={SECONDARY} onClick={() => setAdjusting(null)}>Cancel</button>
              <button type="submit" className={BUTTON}>Review adjustment</button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={confirmAdjustment}
        title="Confirm stock adjustment"
        description={adjusting && adjustmentPreview ? (
          <div className="space-y-1">
            <p>Current quantity: <strong>{adjusting.quantity_remaining.toLocaleString()}</strong></p>
            <p>Change: <strong>{adjustmentPreview.delta > 0 ? '+' : ''}{adjustmentPreview.delta.toLocaleString()}</strong></p>
            <p>Resulting quantity: <strong>{adjustmentPreview.resultingQuantity.toLocaleString()}</strong></p>
            <p>Reason: <strong>{reason}</strong></p>
          </div>
        ) : 'Review the quantity change before confirming.'}
        confirmLabel={saving ? 'Saving…' : 'Confirm adjustment'}
        onCancel={() => setConfirmAdjustment(false)}
        onConfirm={() => void commitAdjustment()}
      />

      <ConfirmDialog
        open={writeOffBatch !== null}
        title="Write off expired batch?"
        description={writeOffBatch
          ? `${writeOffBatch.medicine_name}, batch ${writeOffBatch.batch_number}: ${writeOffBatch.quantity_remaining.toLocaleString()} units will be written off as expired. The batch will remain in history.`
          : ''}
        confirmLabel={saving ? 'Writing off…' : 'Write off'}
        destructive
        onCancel={() => setWriteOffBatch(null)}
        onConfirm={() => void commitWriteOff()}
      />

      {movementBatch && (
        <div className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-black/50 p-4">
          <section role="dialog" aria-modal="true" aria-labelledby="batch-movements-title" className={`${PANEL} my-auto max-h-[90vh] w-full max-w-5xl space-y-4 overflow-y-auto p-5`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h2 id="batch-movements-title" className="text-lg font-black text-text">Batch movements</h2><p className="text-sm text-muted">{movementBatch.medicine_name} · {movementBatch.batch_number}</p></div>
              <div className="flex gap-2">
                <button type="button" className={SECONDARY} aria-label="Refresh batch movements" disabled={movementLoading} onClick={() => setMovementReload((current) => current + 1)}><RefreshCw size={15} /></button>
                <button type="button" aria-label="Close batch movements" className={SECONDARY} onClick={() => setMovementBatch(null)}><X size={16} /></button>
              </div>
            </div>
            {movementError && <div role="alert" className="flex items-center justify-between gap-2 rounded-control bg-danger/10 p-3 text-sm text-danger"><span>{movementError}</span><button type="button" className={SECONDARY} onClick={() => setMovementReload((current) => current + 1)}>Retry</button></div>}
            <DataTable
              label="Movements for selected batch"
              rows={movements}
              columns={movementColumns}
              getRowId={(movement) => movement.id}
              loading={movementLoading}
              emptyTitle="No movements found"
              emptyDescription="This batch has no recorded movements yet."
              layout="responsive"
              pagination={{
                page: movementPage,
                pageCount: movementPageCount,
                totalCount: movementCount,
                onPageChange: setMovementPage,
              }}
            />
          </section>
        </div>
      )}
    </div>
  );
}

async function downloadData(
  format: 'csv' | 'xlsx',
  filename: string,
  headers: string[],
  rows: Array<Array<string | number>>,
) {
  if (format === 'csv') {
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    return;
  }

  const XLSX = await import('@e965/xlsx');
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Stock');
  XLSX.writeFile(workbook, `${filename}.xlsx`);
}
