import { FormEvent, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import {
  Barcode, Download, FileUp, Grid2X2, List, Pencil, Plus, Printer, RefreshCw, ScanLine, Search, X,
} from 'lucide-react';
import { getBackend } from '../api';
import {
  assignMissingProductBarcodes,
  assignProductBarcode,
  importProductRows,
  loadAllProductsForExport,
  loadLowStockProductIds,
  loadProductCatalog,
  loadProductDuplicateIdentities,
  loadProductOptions,
  saveProduct as saveProductApi,
  updateProductFields,
  type ProductCatalogQuery,
} from '../data/products';
import { usePermissions } from '../permissions';
import type { LabelPrintItem } from './labels/LabelPrintDialog';
import { BarcodeScannerTest } from './BarcodeScannerTest';
import { fetchAllSupabaseRows } from '../utils/fetchAllSupabaseRows';
import { getSupabaseErrorMessage } from '../utils/supabaseError';
import { supabase } from '../utils/supabase';
import { dispatchStockChanged } from '../utils/stockAlertsEvents';
import { useBarcodeScanner } from '../utils/useBarcodeScanner';
import {
  BulkActionBar, ConfirmDialog, DataTable, ExpiryChip, FilterChip, KpiCard, StockBar, StatusChip,
  type DataTableColumn,
} from './inventory/InventoryUi';
import {
  parseProductCsv, previewProductCsv, type ProductImportPreviewRow,
} from './inventory/productImportLogic';
import {
  clearProductFilters,
  getActiveProductFilters,
  removeProductFilter,
  type ProductFilterKey,
} from './inventory/productFilterLogic';
import { StockInventory } from './inventory/StockInventory';

const PAGE_SIZE = 25;
const LabelPrintDialog = lazy(() => import('./labels/LabelPrintDialog').then(({ LabelPrintDialog: Dialog }) => ({ default: Dialog })));
const FIELD = 'w-full rounded-control border border-border bg-surface px-3 py-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
const FILTER_PILL = 'w-auto max-w-full rounded-full border px-3 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
const PANEL = 'rounded-xl border border-border bg-surface shadow-xs';
const BUTTON = 'inline-flex items-center justify-center gap-2 rounded-control bg-primary px-3 py-2 text-sm font-bold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const SECONDARY = 'inline-flex items-center justify-center gap-2 rounded-control border border-border bg-surface px-3 py-2 text-sm font-semibold text-text hover:bg-surface/80 disabled:opacity-50';

type ViewMode = 'products' | 'stock';
type StockInitialTab = 'all' | 'near-expiry' | 'expired' | 'low-stock';
export type ProductFilter = { field: 'category' | 'company'; value: string } | null;
type DrugClass = 'OTC' | 'RX' | 'CONTROLLED' | 'NARCOTIC';
type StorageCondition = 'ROOM_TEMPERATURE' | 'COOL' | 'COLD_REFRIGERATED';
type ProductsDisplayMode = 'table' | 'cards';

interface SavedProductView {
  id: string;
  name: string;
  search: string;
  category: string;
  manufacturer: string;
  drugClass: string;
  status: 'active' | 'inactive' | 'all';
  lowStockOnly: boolean;
  sortColumn: 'name' | 'stock' | 'expiry' | 'mrp';
  sortDirection: 'asc' | 'desc';
  hiddenColumns: string[];
}

interface MedicineUnit {
  id: string;
  name: string;
  conversion_factor: number;
  is_default_sale_unit: boolean;
  price_paisa: number;
  barcode: string | null;
}

interface Medicine {
  id: string;
  code: string;
  barcode: string | null;
  brand_name: string;
  generic_name: string;
  strength: string | null;
  category: string;
  company: string;
  drug_class: DrugClass;
  storage_condition: StorageCondition;
  rack_location: string;
  min_stock_alert: number;
  requires_prescription: boolean;
  is_active: boolean;
  units: MedicineUnit[];
  stock: number;
  latest_cost_paisa: number | null;
  margin_percent: number | string | null;
  nearest_expiry: string | null;
  mrp_paisa: number;
  default_unit_conversion: number;
}

interface CategoryOption {
  id: string;
  name: string;
}

interface ProductFormValues {
  code: string;
  barcode: string;
  brand_name: string;
  generic_name: string;
  strength: string;
  category: string;
  company: string;
  drug_class: DrugClass;
  storage_condition: StorageCondition;
  rack_location: string;
  min_stock_alert: string;
  requires_prescription: boolean;
  units: Array<{
    id?: string;
    name: string;
    conversion_factor: string;
    is_default_sale_unit: boolean;
    price_paisa: string;
    barcode: string;
  }>;
}

type ProductListRpcRow = Omit<Medicine, 'units'>;

interface ProductsListResponse {
  rows: ProductListRpcRow[];
  total_count: number;
  can_view_cost: boolean;
}

interface ProductsOverviewStats {
  total_active: number;
  low_stock: number;
  out_of_stock: number;
  expiring_90: number;
  stock_value_cost_paisa: number | string | null;
}

const today = () => new Date().toISOString().slice(0, 10);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProductsListResponse(value: unknown): value is ProductsListResponse {
  return isRecord(value)
    && Array.isArray(value.rows)
    && typeof value.total_count === 'number'
    && typeof value.can_view_cost === 'boolean'
    && value.rows.every((row) => isRecord(row)
      && typeof row.id === 'string'
      && typeof row.code === 'string'
      && (typeof row.barcode === 'string' || row.barcode === null)
      && typeof row.brand_name === 'string'
      && typeof row.generic_name === 'string'
      && (typeof row.strength === 'string' || row.strength === null)
      && typeof row.category === 'string'
      && typeof row.company === 'string'
      && ['OTC', 'RX', 'CONTROLLED', 'NARCOTIC'].includes(String(row.drug_class))
      && ['ROOM_TEMPERATURE', 'COOL', 'COLD_REFRIGERATED'].includes(String(row.storage_condition))
      && typeof row.rack_location === 'string'
      && typeof row.stock === 'number'
      && typeof row.min_stock_alert === 'number'
      && typeof row.mrp_paisa === 'number'
      && typeof row.default_unit_conversion === 'number'
      && typeof row.requires_prescription === 'boolean'
      && typeof row.is_active === 'boolean'
      && (typeof row.nearest_expiry === 'string' || row.nearest_expiry === null)
      && (row.latest_cost_paisa === null || typeof row.latest_cost_paisa === 'number')
      && (row.margin_percent === null || typeof row.margin_percent === 'number'));
}

function isProductsOverviewStats(value: unknown): value is ProductsOverviewStats {
  return isRecord(value)
    && typeof value.total_active === 'number'
    && typeof value.low_stock === 'number'
    && typeof value.out_of_stock === 'number'
    && typeof value.expiring_90 === 'number'
    && (value.stock_value_cost_paisa === null
      || typeof value.stock_value_cost_paisa === 'number'
      || typeof value.stock_value_cost_paisa === 'string');
}

function messageFor(error: unknown, fallback: string) {
  return getSupabaseErrorMessage(error, fallback);
}

function isBarcodeFunctionMissing(error: unknown) {
  if (!isRecord(error)) return false;
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  return code === 'PGRST202'
    || code === '42883'
    || (message.includes('assign_medicine_barcode') && /not found|does not exist|schema cache/i.test(message));
}

function money(paisa: number | string) {
  const amount = BigInt(paisa);
  const rupees = amount / 100n;
  const fraction = (amount % 100n).toString().padStart(2, '0');
  return `Rs ${rupees.toLocaleString('en-PK')}.${fraction}`;
}

function csvCell(value: string | number | boolean | null | undefined) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCsv(filename: string, headers: readonly string[], rows: readonly (readonly (string | number | boolean | null | undefined)[])[]) {
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function savedViewsStorageKey(userId: string) {
  return `pharma-care.products.saved-views.${userId}`;
}

function viewModeStorageKey(userId: string) {
  return `pharma-care.products.view-mode.${userId}`;
}

function readSavedViews(userId: string): SavedProductView[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(savedViewsStorageKey(userId)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SavedProductView => isRecord(item)
      && typeof item.id === 'string'
      && typeof item.name === 'string'
      && typeof item.search === 'string'
      && typeof item.category === 'string'
      && typeof item.manufacturer === 'string'
      && typeof item.drugClass === 'string'
      && ['active', 'inactive', 'all'].includes(String(item.status))
      && typeof item.lowStockOnly === 'boolean'
      && ['name', 'stock', 'expiry', 'mrp'].includes(String(item.sortColumn))
      && ['asc', 'desc'].includes(String(item.sortDirection))
      && Array.isArray(item.hiddenColumns)
      && item.hiddenColumns.every((column) => typeof column === 'string'));
  } catch {
    return [];
  }
}

function readDisplayMode(userId: string): ProductsDisplayMode {
  return localStorage.getItem(viewModeStorageKey(userId)) === 'cards' ? 'cards' : 'table';
}

function initialProductForm(medicine?: Medicine): ProductFormValues {
  return medicine ? {
    code: medicine.code,
    barcode: medicine.barcode ?? '',
    brand_name: medicine.brand_name,
    generic_name: medicine.generic_name,
    strength: medicine.strength ?? '',
    category: medicine.category,
    company: medicine.company,
    drug_class: medicine.drug_class,
    storage_condition: medicine.storage_condition,
    rack_location: medicine.rack_location,
    min_stock_alert: String(medicine.min_stock_alert),
    requires_prescription: medicine.requires_prescription,
    units: medicine.units.map((unit) => ({
      id: unit.id,
      name: unit.name,
      conversion_factor: String(unit.conversion_factor),
      is_default_sale_unit: unit.is_default_sale_unit,
      price_paisa: String(unit.price_paisa),
      barcode: unit.barcode ?? '',
    })),
  } : {
    code: '',
    barcode: '',
    brand_name: '',
    generic_name: '',
    strength: '',
    category: '',
    company: '',
    drug_class: 'OTC',
    storage_condition: 'ROOM_TEMPERATURE',
    rack_location: '',
    min_stock_alert: '0',
    requires_prescription: false,
    units: [{ name: '', conversion_factor: '1', is_default_sale_unit: true, price_paisa: '0', barcode: '' }],
  };
}

export function InventoryScreen({
  mode,
  currentRole: _currentRole,
  currentUserId,
  initialFilter = null,
  initialSearch = null,
  initialLowStockOnly = false,
  initialMedicineId = null,
  initialStockTab = 'all',
  onFilterApplied,
  onViewBatches,
  onClearMedicineFilter,
}: {
  mode: ViewMode;
  currentRole: string;
  currentUserId?: string;
  initialFilter?: ProductFilter;
  initialSearch?: string | null;
  initialLowStockOnly?: boolean;
  initialMedicineId?: string | null;
  initialStockTab?: StockInitialTab;
  onFilterApplied?: () => void;
  onViewBatches?: (medicineId: string) => void;
  onClearMedicineFilter?: () => void;
}) {
  return mode === 'products'
    ? <ProductsCatalog
      initialFilter={initialFilter}
      initialSearch={initialSearch}
      initialLowStockOnly={initialLowStockOnly}
      userId={currentUserId ?? 'unknown'}
      onFilterApplied={onFilterApplied}
      onViewBatches={onViewBatches}
    />
    : <StockInventory
      initialMedicineId={initialMedicineId}
      initialTab={initialStockTab}
      onClearMedicineFilter={onClearMedicineFilter}
    />;
}

function ProductsCatalog({
  initialFilter,
  initialSearch,
  initialLowStockOnly,
  userId,
  onFilterApplied,
  onViewBatches,
}: {
  initialFilter: ProductFilter;
  initialSearch: string | null;
  initialLowStockOnly: boolean;
  userId: string;
  onFilterApplied?: () => void;
  onViewBatches?: (medicineId: string) => void;
}) {
  const { can } = usePermissions();
  const canEditProducts = can('products');
  const canViewStockInventory = can('stock_inventory');
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [brands, setBrands] = useState<CategoryOption[]>([]);
  const [search, setSearch] = useState(initialSearch ?? '');
  const [searchInput, setSearchInput] = useState(initialSearch ?? '');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  const [classFilter, setClassFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState<'active' | 'inactive' | 'all'>('active');
  const [lowStockOnly, setLowStockOnly] = useState(initialLowStockOnly);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sortColumn, setSortColumn] = useState<'name' | 'stock' | 'expiry' | 'mrp'>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [displayMode, setDisplayMode] = useState<ProductsDisplayMode>(() => readDisplayMode(userId));
  const [savedViews, setSavedViews] = useState<SavedProductView[]>(() => readSavedViews(userId));
  const [selectedSavedView, setSelectedSavedView] = useState('');
  const [savedViewName, setSavedViewName] = useState('');
  const [hiddenColumnIds, setHiddenColumnIds] = useState<string[]>(['cost']);
  const [bulkCategory, setBulkCategory] = useState('');
  const [confirmBulkDeactivate, setConfirmBulkDeactivate] = useState(false);
  const [pendingStatusChange, setPendingStatusChange] = useState<{ medicine: Medicine; active: boolean } | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importPreview, setImportPreview] = useState<ProductImportPreviewRow[] | null>(null);
  const [skippedRows, setSkippedRows] = useState<ProductImportPreviewRow[]>([]);
  const [skippedLines, setSkippedLines] = useState<number[]>([]);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [overviewStats, setOverviewStats] = useState<ProductsOverviewStats | null>(null);
  const [canViewCost, setCanViewCost] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [optionsError, setOptionsError] = useState('');
  const [editing, setEditing] = useState<Medicine | null>(null);
  const [viewingMedicine, setViewingMedicine] = useState<Medicine | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState<ProductFormValues>(() => initialProductForm());
  const [generatingBarcodeId, setGeneratingBarcodeId] = useState<string | null>(null);
  const [labelDialogProducts, setLabelDialogProducts] = useState<LabelPrintItem[]>([]);
  const [scannerTestOpen, setScannerTestOpen] = useState(false);
  const [lastProductScan, setLastProductScan] = useState('');
  const {
    scanValue,
    lastScanned,
    lastRawValue,
    lastScanDurationMs,
    resetScan,
  } = useBarcodeScanner();
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!lastScanned) return;
    setSearchInput(lastScanned);
    setLastProductScan(lastScanned);
    resetScan();
  }, [lastScanned, resetScan]);

  useEffect(() => {
    setSavedViews(readSavedViews(userId));
    setDisplayMode(readDisplayMode(userId));
  }, [userId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setPage(1);
      setSearch(searchInput);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    localStorage.setItem(viewModeStorageKey(userId), displayMode);
  }, [displayMode, userId]);

  useEffect(() => {
    localStorage.setItem(savedViewsStorageKey(userId), JSON.stringify(savedViews));
  }, [savedViews, userId]);

  useEffect(() => {
    if (!initialFilter) return;
    if (initialFilter.field === 'category') setCategoryFilter(initialFilter.value);
    else setBrandFilter(initialFilter.value);
    setPage(1);
    onFilterApplied?.();
  }, [initialFilter, onFilterApplied]);

  useEffect(() => {
    setSearchInput(initialSearch ?? '');
    setSearch(initialSearch ?? '');
    setLowStockOnly(initialLowStockOnly);
    setPage(1);
  }, [initialSearch, initialLowStockOnly]);

  const loadOptions = useCallback(async () => {
    if (getBackend() === 'api') {
      const options = await loadProductOptions();
      setCategories(options.categories);
      setBrands(options.brands);
      setOptionsError('');
      return;
    }
    const client = supabase;
    if (!client) throw new Error('Supabase is not configured.');
    const [categoryRows, brandRows] = await Promise.all([
      fetchAllSupabaseRows((from, to) => client.from('categories').select('id,name').eq('is_active', true).order('name').range(from, to)),
      fetchAllSupabaseRows((from, to) => client.from('brands').select('id,name').eq('is_active', true).order('name').range(from, to)),
    ]);
    setCategories(categoryRows ?? []);
    setBrands(brandRows ?? []);
    setOptionsError('');
  }, []);

  const loadProducts = useCallback(async () => {
    if (getBackend() === 'api') {
      setLoading(true);
      setError('');
      try {
        const result = await loadProductCatalog({
          page,
          pageSize: PAGE_SIZE,
          search,
          categoryId: categories.find((item) => item.name === categoryFilter)?.id,
          brandId: brands.find((item) => item.name === brandFilter)?.id,
          drugClass: classFilter || undefined,
          active: activeFilter === 'active' ? 'true' : activeFilter === 'inactive' ? 'false' : 'all',
          lowStockOnly,
          sort: sortColumn,
          order: sortDirection,
        });
        setMedicines(result.rows);
        setTotalCount(result.total);
        setCanViewCost(result.canViewCost);
        setOverviewStats(result.stats);
      } catch (caught) {
        setError(messageFor(caught, 'Could not load products.'));
        setMedicines([]);
        setOverviewStats(null);
        setCanViewCost(false);
      } finally {
        setLoading(false);
      }
      return;
    }
    const client = supabase;
    if (!client) {
      setError('Supabase is not configured.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [listResult, statsResult] = await Promise.all([
        client.rpc('products_list', {
          p_search: search.trim() || null,
          p_category: categoryFilter || null,
          p_manufacturer: brandFilter || null,
          p_class: classFilter || null,
          p_status: activeFilter,
          p_low_only: lowStockOnly,
          p_sort_col: sortColumn,
          p_sort_dir: sortDirection,
          p_page: page,
          p_page_size: PAGE_SIZE,
        }),
        client.rpc('products_overview_stats'),
      ]);
      if (listResult.error) throw listResult.error;
      if (statsResult.error) throw statsResult.error;
      if (!isProductsListResponse(listResult.data)) {
        throw new Error('The product-list service returned an invalid response.');
      }
      if (!isProductsOverviewStats(statsResult.data)) {
        throw new Error('The product summary service returned an invalid response.');
      }

      setTotalCount(listResult.data.total_count);
      setCanViewCost(listResult.data.can_view_cost);
      setOverviewStats(statsResult.data);
      const productsPage = listResult.data.rows;
      if (!productsPage.length) {
        setMedicines([]);
        return;
      }
      const ids = productsPage.map((medicine) => medicine.id);
      const units = await fetchAllSupabaseRows((from, to) => client.from('medicine_units')
          .select('id,medicine_id,name,conversion_factor,is_default_sale_unit,price_paisa,barcode')
          .in('medicine_id', ids)
          .order('is_default_sale_unit', { ascending: false })
          .order('id')
          .range(from, to));

      const unitsByMedicine = new Map<string, MedicineUnit[]>();
      for (const unit of units ?? []) {
        const current = unitsByMedicine.get(unit.medicine_id) ?? [];
        current.push(unit);
        unitsByMedicine.set(unit.medicine_id, current);
      }
      setMedicines(productsPage.map((medicine) => ({
        ...medicine,
        units: unitsByMedicine.get(medicine.id) ?? [],
      })));
    } catch (caught) {
      setError(messageFor(caught, 'Could not load products.'));
      setMedicines([]);
      setOverviewStats(null);
      setCanViewCost(false);
    } finally {
      setLoading(false);
    }
  }, [activeFilter, brandFilter, categories, categoryFilter, classFilter, lowStockOnly, page, search, sortColumn, sortDirection]);

  useEffect(() => {
    void loadOptions().catch((caught) => setOptionsError(messageFor(caught, 'Could not load categories and manufacturers.')));
  }, [loadOptions]);

  useEffect(() => { void loadProducts(); }, [loadProducts]);

  useEffect(() => {
    setSelectedIds([]);
  }, [activeFilter, brandFilter, categoryFilter, classFilter, lowStockOnly, page, search, sortColumn, sortDirection]);

  const refresh = useCallback(async () => {
    setError('');
    const optionsLoad = loadOptions().catch((caught) => {
      setOptionsError(messageFor(caught, 'Could not load categories and manufacturers.'));
    });
    await Promise.all([optionsLoad, loadProducts()]);
  }, [loadOptions, loadProducts]);

  const saveCurrentView = () => {
    const name = savedViewName.trim();
    if (!name) {
      setNotice('Enter a name for this saved view.');
      return;
    }
    const view: SavedProductView = {
      id: crypto.randomUUID(),
      name,
      search: searchInput,
      category: categoryFilter,
      manufacturer: brandFilter,
      drugClass: classFilter,
      status: activeFilter,
      lowStockOnly,
      sortColumn,
      sortDirection,
      hiddenColumns: hiddenColumnIds,
    };
    setSavedViews((current) => [...current.filter((item) => item.name.toLowerCase() !== name.toLowerCase()), view]);
    setSelectedSavedView(view.id);
    setSavedViewName('');
    setNotice(`Saved view “${name}”.`);
  };

  const applySavedView = (id: string) => {
    const view = savedViews.find((item) => item.id === id);
    if (!view) return;
    setSearchInput(view.search);
    setSearch(view.search);
    setCategoryFilter(view.category);
    setBrandFilter(view.manufacturer);
    setClassFilter(view.drugClass);
    setActiveFilter(view.status);
    setLowStockOnly(view.lowStockOnly);
    setSortColumn(view.sortColumn);
    setSortDirection(view.sortDirection);
    setHiddenColumnIds(view.hiddenColumns);
    setPage(1);
    setSelectedSavedView(id);
  };

  const currentProductFilters = {
    search: searchInput,
    category: categoryFilter,
    manufacturer: brandFilter,
    drugClass: classFilter,
    status: activeFilter,
    lowStockOnly,
  };
  const activeProductFilters = getActiveProductFilters(currentProductFilters);
  const applyProductFilterState = (filters: typeof currentProductFilters) => {
    setPage(1);
    setSearchInput(filters.search);
    setSearch(filters.search);
    setCategoryFilter(filters.category);
    setBrandFilter(filters.manufacturer);
    setClassFilter(filters.drugClass);
    setActiveFilter(filters.status);
    setLowStockOnly(filters.lowStockOnly);
  };
  const handleRemoveProductFilter = (key: ProductFilterKey) => {
    applyProductFilterState(removeProductFilter(currentProductFilters, key));
  };
  const handleClearProductFilters = () => {
    applyProductFilterState(clearProductFilters());
    setSelectedSavedView('');
  };

  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const visibleMedicines = medicines;

  const listArguments = (requestedPage: number, pageSize: number) => ({
    p_search: search.trim() || null,
    p_category: categoryFilter || null,
    p_manufacturer: brandFilter || null,
    p_class: classFilter || null,
    p_status: activeFilter,
    p_low_only: lowStockOnly,
    p_sort_col: sortColumn,
    p_sort_dir: sortDirection,
    p_page: requestedPage,
    p_page_size: pageSize,
  });

  const productApiQuery = (requestedPage: number, pageSize: number): ProductCatalogQuery => ({
    page: requestedPage,
    pageSize,
    search,
    categoryId: categories.find((item) => item.name === categoryFilter)?.id,
    brandId: brands.find((item) => item.name === brandFilter)?.id,
    drugClass: classFilter || undefined,
    active: activeFilter === 'active' ? 'true' : activeFilter === 'inactive' ? 'false' : 'all',
    lowStockOnly,
    sort: sortColumn,
    order: sortDirection,
  });

  const loadFilteredProductsForExport = async () => {
    if (getBackend() === 'api') {
      let products = await loadAllProductsForExport(productApiQuery(1, 200));
      if (lowStockOnly) {
        const lowStockIds = await loadLowStockProductIds();
        products = products.filter((medicine) => lowStockIds.has(medicine.id));
      }
      const field = {
        name: 'brand_name',
        stock: 'stock',
        expiry: 'nearest_expiry',
        mrp: 'mrp_paisa',
      }[sortColumn] as 'brand_name' | 'stock' | 'nearest_expiry' | 'mrp_paisa';
      products.sort((left, right) => {
        const leftValue = left[field];
        const rightValue = right[field];
        const compared = leftValue === null
          ? (rightValue === null ? 0 : 1)
          : rightValue === null
            ? -1
            : typeof leftValue === 'number' && typeof rightValue === 'number'
              ? leftValue - rightValue
              : String(leftValue).localeCompare(String(rightValue));
        return (sortDirection === 'asc' ? compared : -compared) || left.id.localeCompare(right.id);
      });
      return products;
    }
    const client = supabase;
    if (!client) throw new Error('Supabase is not configured.');
    const rows: Medicine[] = [];
    let requestedPage = 1;
    let expectedCount = 0;
    do {
      const { data, error: queryError } = await client.rpc('products_list', listArguments(requestedPage, 200));
      if (queryError) throw queryError;
      if (!isProductsListResponse(data)) throw new Error('The product export service returned an invalid response.');
      if (requestedPage === 1) expectedCount = data.total_count;
      if (data.total_count !== expectedCount) throw new Error('Products changed while the export was being prepared. Retry the export.');
      const productRows = data.rows;
      if (productRows.length === 0 && rows.length < expectedCount) {
        throw new Error('The product export ended before all filtered rows were returned.');
      }
      if (productRows.length) {
        const ids = productRows.map((medicine) => medicine.id);
        const units = await fetchAllSupabaseRows((from, to) => client.from('medicine_units')
          .select('id,medicine_id,name,conversion_factor,is_default_sale_unit,price_paisa,barcode')
          .in('medicine_id', ids)
          .order('is_default_sale_unit', { ascending: false })
          .order('id')
          .range(from, to));
        const unitsByMedicine = new Map<string, MedicineUnit[]>();
        for (const unit of units) {
          const current = unitsByMedicine.get(unit.medicine_id) ?? [];
          current.push(unit);
          unitsByMedicine.set(unit.medicine_id, current);
        }
        rows.push(...productRows.map((medicine) => ({
          ...medicine,
          units: unitsByMedicine.get(medicine.id) ?? [],
        })));
      }
      requestedPage += 1;
    } while (rows.length < expectedCount);
    return rows;
  };

  const exportHeaders = (includeCost: boolean) => [
    'code', 'barcode', 'brand_name', 'generic_name', 'strength', 'category', 'company',
    'drug_class', 'storage_condition', 'rack_location', 'min_stock_alert', 'stock',
    'nearest_expiry', 'requires_prescription', 'is_active', 'unit_name', 'conversion_factor',
    'price_paisa', 'unit_barcode',
    ...(includeCost ? ['latest_cost_paisa', 'margin_percent'] : []),
  ];

  const exportValues = (productsToExport: readonly Medicine[], includeCost: boolean) => productsToExport.map((medicine) => {
    const unit = medicine.units.find((item) => item.is_default_sale_unit);
    return [
      medicine.code, medicine.barcode, medicine.brand_name, medicine.generic_name,
      medicine.strength, medicine.category, medicine.company, medicine.drug_class,
      medicine.storage_condition, medicine.rack_location, medicine.min_stock_alert,
      medicine.stock, medicine.nearest_expiry, medicine.requires_prescription,
      medicine.is_active, unit?.name ?? '', unit?.conversion_factor ?? '',
      unit?.price_paisa ?? '', unit?.barcode ?? '',
      ...(includeCost ? [medicine.latest_cost_paisa, medicine.margin_percent] : []),
    ];
  });

  const exportProducts = async (format: 'csv' | 'xlsx', selectedOnly = false) => {
    if (exporting) return;
    setExporting(true);
    setNotice('');
    try {
      const productsToExport = selectedOnly
        ? medicines.filter((medicine) => selectedIds.includes(medicine.id))
        : await loadFilteredProductsForExport();
      if (!productsToExport.length) {
        setNotice(selectedOnly ? 'Select products on this page before exporting.' : 'There are no products matching these filters to export.');
        return;
      }
      const headers = exportHeaders(canViewCost);
      const rows = exportValues(productsToExport, canViewCost);
      const dateStamp = today();
      if (format === 'csv') {
        downloadCsv(`pharma-care-products-${dateStamp}.csv`, headers, rows);
      } else {
        const XLSX = await import('@e965/xlsx');
        const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Products');
        XLSX.writeFile(workbook, `pharma-care-products-${dateStamp}.xlsx`);
      }
      setNotice(`Exported ${productsToExport.length} product${productsToExport.length === 1 ? '' : 's'} to ${format.toUpperCase()}.`);
    } catch (caught) {
      setNotice(messageFor(caught, 'Could not export products.'));
    } finally {
      setExporting(false);
    }
  };

  const downloadImportTemplate = () => {
    downloadCsv('pharma-care-products-template.csv', [
      'code', 'barcode', 'brand_name', 'generic_name', 'strength', 'category', 'company',
      'drug_class', 'storage_condition', 'rack_location', 'min_stock_alert',
      'requires_prescription', 'is_active', 'unit_name', 'conversion_factor',
      'price_paisa', 'unit_barcode',
    ], []);
  };

  const downloadSkippedRows = (rows = skippedRows) => {
    if (!rows.length) return setNotice('There are no skipped rows to download.');
    const headers = Object.keys(rows[0].values);
    downloadCsv(
      `pharma-care-products-skipped-${today()}.csv`,
      [...headers, 'import_errors'],
      rows.map((row) => [...headers.map((header) => row.values[header] ?? ''), row.errors.join('; ')]),
    );
  };

  const prepareImportPreview = async (file: File) => {
    if (getBackend() !== 'api' && !supabase) {
      setNotice('Supabase is not configured.');
      return;
    }
    setImporting(true);
    setNotice('');
    try {
      const parsedRows = parseProductCsv(await file.text());
      if (parsedRows.length > 2000) throw new Error('CSV import is limited to 2000 product rows.');
      if (getBackend() === 'api') {
        const existing = await loadProductDuplicateIdentities();
        const existingCategoryNames = new Set(categories.map((item) => item.name.trim().toLocaleLowerCase()));
        const existingBrandNames = new Set(brands.map((item) => item.name.trim().toLocaleLowerCase()));
        const preview = previewProductCsv(parsedRows, existing);
        setSkippedLines([]);
        setImportPreview(preview.map((row) => ({
          ...row,
          errors: [
            ...row.errors,
            ...(existingCategoryNames.has((row.values.category ?? '').trim().toLocaleLowerCase())
              ? []
              : ['Category must already exist in master data.']),
            ...(existingBrandNames.has((row.values.company ?? '').trim().toLocaleLowerCase())
              ? []
              : ['Manufacturer must already exist in master data.']),
          ],
        })));
        return;
      }
      const localPreview = previewProductCsv(parsedRows, []);
      const client = supabase;
      if (!client) throw new Error('Supabase is not configured.');
      const { data, error: previewError } = await client.rpc('products_import_preview', {
        rows: localPreview.map(({ line, values }) => ({ ...values, line })),
      });
      if (previewError) throw previewError;
      if (!Array.isArray(data) || data.some((row) => !isRecord(row)
        || typeof row.line !== 'number' || typeof row.duplicate_in_database !== 'boolean')) {
        throw new Error('The import-preview service returned an invalid response.');
      }
      const databaseDuplicates = new Set<number>();
      for (const row of data) {
        if (isRecord(row) && row.duplicate_in_database === true && typeof row.line === 'number') {
          databaseDuplicates.add(row.line);
        }
      }
      setSkippedLines([]);
      setImportPreview(localPreview.map((row) => ({
        ...row,
        errors: databaseDuplicates.has(row.line)
          ? [...row.errors, 'This product duplicates a database record.']
          : row.errors,
      })));
    } catch (caught) {
      setNotice(messageFor(caught, 'Could not prepare the CSV import preview.'));
      setImportPreview(null);
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  const importProducts = async () => {
    if ((getBackend() !== 'api' && !supabase) || !importPreview) return;
    const validRows = importPreview.filter((row) => !skippedLines.includes(row.line) && row.errors.length === 0);
    const rowsToSkip = importPreview.filter((row) => skippedLines.includes(row.line) || row.errors.length > 0)
      .map((row) => skippedLines.includes(row.line) && row.errors.length === 0
        ? { ...row, errors: ['Skipped by user.'] }
        : row);
    if (validRows.length === 0) {
      if (rowsToSkip.length) {
        setSkippedRows(rowsToSkip);
        setNotice('No rows were imported. Download the skipped rows, correct the file, and try again.');
      } else {
        setNotice('There are no valid rows to import. Correct the CSV errors and try again.');
      }
      return;
    }
    setImporting(true);
    setNotice('');
    try {
      if (getBackend() === 'api') {
        const result = await importProductRows(validRows.map((row) => row.values));
        const previewLineByImportLine = new Map(validRows.map((row, index) => [index + 2, row.line]));
        const importFailures = result.rowErrors.flatMap((item) => {
          const originalLine = previewLineByImportLine.get(item.line);
          const row = validRows.find((candidate) => candidate.line === originalLine);
          return row ? [{ ...row, errors: [`Import failed (${item.code}).`] }] : [];
        });
        const skipped = [...rowsToSkip, ...importFailures];
        setSkippedRows(skipped);
        dispatchStockChanged();
        await loadProducts();
        setSelectedIds([]);
        setNotice(`Imported ${result.importedCount} product${result.importedCount === 1 ? '' : 's'}; skipped ${skipped.length} row${skipped.length === 1 ? '' : 's'}.`);
        setImportPreview(null);
        setSkippedLines([]);
        return;
      }
      const client = supabase;
      if (!client) throw new Error('Supabase is not configured.');
      const { data, error: importError } = await client.rpc('products_bulk_import', {
        rows: validRows.map(({ line, values }) => ({ ...values, line })),
      });
      if (importError) throw importError;
      dispatchStockChanged();
      if (!isRecord(data) || typeof data.imported_count !== 'number') {
        throw new Error('The import service returned an invalid response.');
      }
      setSkippedRows(rowsToSkip);
      await loadProducts();
      setSelectedIds([]);
      setNotice(`Imported ${data.imported_count} product${data.imported_count === 1 ? '' : 's'}; skipped ${rowsToSkip.length} row${rowsToSkip.length === 1 ? '' : 's'}.`);
      setImportPreview(null);
      setSkippedLines([]);
    } catch (caught) {
      setNotice(messageFor(caught, 'Could not import products. No rows were imported.'));
    } finally {
      setImporting(false);
    }
  };

  const applyBulkUpdate = async (action: 'category' | 'deactivate', value: string | null = null) => {
    if ((getBackend() !== 'api' && !supabase) || selectedIds.length === 0) return;
    setImporting(true);
    setNotice('');
    try {
      if (getBackend() === 'api') {
        const updates = action === 'deactivate'
          ? { isActive: false }
          : { categoryId: categories.find((item) => item.name === value)?.id };
        if (action === 'category' && !updates.categoryId) {
          throw new Error('Choose a valid category before updating products.');
        }
        const results = await Promise.allSettled(selectedIds.map((id) => updateProductFields(id, updates)));
        const updated = results.filter((result) => result.status === 'fulfilled').length;
        const failed = results.length - updated;
        dispatchStockChanged();
        setSelectedIds([]);
        setConfirmBulkDeactivate(false);
        setNotice(failed
          ? `Updated ${updated} product${updated === 1 ? '' : 's'}; ${failed} could not be updated. Refresh and review the selection.`
          : `Updated ${updated} product${updated === 1 ? '' : 's'}.`);
        await loadProducts();
        return;
      }
      const client = supabase;
      if (!client) throw new Error('Supabase is not configured.');
      const { data, error: updateError } = await client.rpc('products_bulk_update', {
        ids: selectedIds,
        action,
        value,
      });
      if (updateError) throw updateError;
      dispatchStockChanged();
      if (typeof data !== 'number') throw new Error('The bulk-update service returned an invalid response.');
      setSelectedIds([]);
      setConfirmBulkDeactivate(false);
      setNotice(`Updated ${data} product${data === 1 ? '' : 's'}.`);
      await loadProducts();
    } catch (caught) {
      setNotice(messageFor(caught, 'Could not update the selected products.'));
    } finally {
      setImporting(false);
    }
  };

  const toLabelPrintItem = (medicine: Medicine): LabelPrintItem => {
    const defaultUnit = medicine.units.find((unit) => unit.is_default_sale_unit) ?? medicine.units[0];
    return {
      id: medicine.id,
      brand_name: medicine.brand_name,
      generic_name: medicine.generic_name,
      strength: medicine.strength,
      code: medicine.code,
      barcode: medicine.barcode,
      price_paisa: defaultUnit ? defaultUnit.price_paisa : null,
      expiry: medicine.nearest_expiry,
    };
  };

  const openBarcodePrint = (productsToPrint: Medicine[]) => {
    if (!productsToPrint.length) {
      setNotice('There are no products on this page to print.');
      return;
    }
    const productsWithBarcodes = productsToPrint.filter((medicine) => medicine.barcode?.trim());
    if (!productsWithBarcodes.length) {
      setNotice('No selected product has a barcode. Make a barcode before printing labels.');
      return;
    }
    if (productsWithBarcodes.length !== productsToPrint.length) {
      setNotice('Products without a barcode were skipped. Make a barcode before printing their labels.');
    } else {
      setNotice('');
    }
    setLabelDialogProducts(productsWithBarcodes.map(toLabelPrintItem));
  };

  const printBarcodes = () => {
    const productsToPrint = selectedIds.length
      ? medicines.filter((medicine) => selectedIds.includes(medicine.id))
      : visibleMedicines;
    openBarcodePrint(productsToPrint);
  };

  const printBarcodeForMedicine = (medicine: Medicine) => {
    if (!medicine.barcode?.trim()) {
      setNotice(`${medicine.brand_name} has no barcode. Make a barcode before printing labels.`);
      return;
    }
    openBarcodePrint([medicine]);
  };

  const generateBarcodeForMedicine = async (medicine: Medicine) => {
    if (!canEditProducts) {
      setNotice('Products permission is required to make a barcode.');
      return;
    }
    if (getBackend() !== 'api' && !supabase) {
      setNotice('Supabase is not configured.');
      return;
    }
    setGeneratingBarcodeId(medicine.id);
    setNotice('');
    try {
      if (getBackend() === 'api') {
        const barcode = await assignProductBarcode(medicine.id);
        setNotice(`Generated barcode ${barcode} for ${medicine.brand_name}.`);
        setViewingMedicine((current) => current?.id === medicine.id ? { ...current, barcode } : current);
        await loadProducts();
        return;
      }
      const client = supabase;
      if (!client) throw new Error('Supabase is not configured.');
      const { data, error: barcodeError } = await client.rpc('assign_medicine_barcode', {
        p_medicine_id: medicine.id,
        p_barcode: null,
        p_replace: false,
      });
      if (barcodeError) {
        if (isBarcodeFunctionMissing(barcodeError)) {
          setNotice('Barcode generation is not enabled on this database yet');
          return;
        }
        throw barcodeError;
      }
      if (typeof data !== 'string' || !data) throw new Error('The barcode service returned an invalid response.');
      setNotice(`Generated barcode ${data} for ${medicine.brand_name}.`);
      setViewingMedicine((current) => current?.id === medicine.id ? { ...current, barcode: data } : current);
      await loadProducts();
    } catch (caught) {
      setNotice(messageFor(caught, `Could not generate a barcode for ${medicine.brand_name}.`));
    } finally {
      setGeneratingBarcodeId((current) => (current === medicine.id ? null : current));
    }
  };

  const generateMissingBarcodes = async () => {
    if (!canEditProducts) {
      setNotice('Products permission is required to make barcodes.');
      return;
    }
    if (getBackend() !== 'api' && !supabase) {
      setNotice('Supabase is not configured.');
      return;
    }
    if (getBackend() === 'api') {
      setImporting(true);
      setNotice('');
      try {
        if (selectedIds.length > 0) {
          const results = await Promise.allSettled(selectedIds.map((id) => assignProductBarcode(id)));
          const assigned = results.filter((result) => result.status === 'fulfilled').length;
          const failed = results.length - assigned;
          setNotice(`Generated ${assigned} barcode${assigned === 1 ? '' : 's'}; ${failed} failed.`);
          setSelectedIds([]);
        } else {
          const result = await assignMissingProductBarcodes();
          setNotice(
            result.assigned || result.skipped || result.failed
              ? `Generated ${result.assigned} barcode${result.assigned === 1 ? '' : 's'}; skipped ${result.skipped}; failed ${result.failed}.`
              : 'No barcodes were generated.',
          );
        }
        await loadProducts();
      } catch (caught) {
        setNotice(messageFor(caught, 'Could not generate missing product barcodes.'));
      } finally {
        setImporting(false);
      }
      return;
    }
    const client = supabase;
    if (!client) {
      setNotice('Supabase is not configured.');
      return;
    }
    const ids = selectedIds.length > 0
      ? selectedIds
      : medicines.filter((medicine) => !medicine.barcode).map((medicine) => medicine.id);
    if (!ids.length) {
      setNotice('There are no missing product barcodes to generate.');
      return;
    }
    setImporting(true);
    setNotice('');
    try {
      const { data, error: bulkError } = await client.rpc('assign_missing_barcodes', {
        p_medicine_ids: ids,
      });
      if (bulkError) {
        if (isBarcodeFunctionMissing(bulkError)) {
          setNotice('Barcode generation is not enabled on this database yet');
          return;
        }
        throw bulkError;
      }
      if (!isRecord(data)) {
        throw new Error('The missing-barcode service returned an invalid response.');
      }
      const assigned = typeof data.assigned === 'number' ? data.assigned : 0;
      const skipped = typeof data.skipped === 'number' ? data.skipped : 0;
      const failed = typeof data.failed === 'number' ? data.failed : 0;
      setSelectedIds([]);
      setNotice(
        assigned || skipped || failed
          ? `Generated ${assigned} barcode${assigned === 1 ? '' : 's'}; skipped ${skipped}; failed ${failed}.`
          : 'No barcodes were generated.',
      );
      await loadProducts();
    } catch (caught) {
      setNotice(messageFor(caught, 'Could not generate missing product barcodes.'));
    } finally {
      setImporting(false);
    }
  };

  const openCreate = () => {
    setEditing(null);
    setForm(initialProductForm());
    setShowForm(true);
    setNotice('');
  };

  const openEdit = (medicine: Medicine) => {
    setViewingMedicine(null);
    setEditing(medicine);
    setForm(initialProductForm(medicine));
    setShowForm(true);
    setNotice('');
  };

  const changeUnit = (index: number, patch: Partial<ProductFormValues['units'][number]>) => {
    setForm((current) => ({
      ...current,
      units: current.units.map((unit, unitIndex) => {
        if (unitIndex === index) return { ...unit, ...patch };
        return patch.is_default_sale_unit ? { ...unit, is_default_sale_unit: false } : unit;
      }),
    }));
  };

  const saveProduct = async (event: FormEvent) => {
    event.preventDefault();
    if (getBackend() !== 'api' && !supabase) return setNotice('Supabase is not configured.');
    const minStock = Number(form.min_stock_alert);
    const units = form.units.map((unit) => ({
      ...(unit.id ? { id: unit.id } : {}),
      name: unit.name.trim(),
      conversion_factor: Number(unit.conversion_factor),
      is_default_sale_unit: unit.is_default_sale_unit,
      price_paisa: Number(unit.price_paisa),
      barcode: unit.barcode.trim() || null,
    }));
    if (!form.code.trim() || !form.brand_name.trim() || !form.generic_name.trim() || !form.category || !form.company) {
      return setNotice('Code, brand name, generic name, category, and manufacturer are required.');
    }
    if (!Number.isSafeInteger(minStock) || minStock < 0 || minStock > 2147483647) {
      return setNotice('Minimum stock must be a non-negative whole number.');
    }
    if (units.some((unit) => !unit.name || !Number.isSafeInteger(unit.conversion_factor) || unit.conversion_factor <= 0 || unit.conversion_factor > 2147483647 || !Number.isSafeInteger(unit.price_paisa) || unit.price_paisa < 0 || unit.price_paisa > 2147483647)) {
      return setNotice('Every unit needs a name, positive whole-number conversion factor, and valid non-negative paisa price.');
    }
    if (units.filter((unit) => unit.is_default_sale_unit).length !== 1) {
      return setNotice('Choose exactly one default sale unit.');
    }
    setSaving(true);
    setNotice('');
    try {
      if (getBackend() === 'api') {
        const categoryId = categories.find((item) => item.name === form.category)?.id;
        const brandId = brands.find((item) => item.name === form.company)?.id;
        if (!categoryId || !brandId) {
          throw new Error('Choose an active category and manufacturer.');
        }
        await saveProductApi({
          id: editing?.id ?? null,
          code: form.code.trim(),
          barcode: form.barcode.trim() || null,
          name: form.brand_name.trim(),
          genericName: form.generic_name.trim(),
          strength: form.strength.trim() || null,
          categoryId,
          brandId,
          drugClass: form.drug_class,
          storageCondition: form.storage_condition,
          rackLocation: form.rack_location.trim(),
          minStockAlert: minStock,
          requiresPrescription: form.requires_prescription,
          isActive: editing?.is_active ?? true,
          units: units.map((unit) => ({
            ...(unit.id ? { id: unit.id } : {}),
            name: unit.name,
            conversionFactorBaseUnits: unit.conversion_factor,
            isDefaultSaleUnit: unit.is_default_sale_unit,
            pricePaisa: unit.price_paisa,
            barcode: unit.barcode,
          })),
          existingUnitIds: editing?.units.map((unit) => unit.id) ?? [],
        });
        dispatchStockChanged();
        setShowForm(false);
        setNotice(editing ? 'Product updated.' : 'Product added.');
        await loadProducts();
        return;
      }
      const client = supabase;
      if (!client) throw new Error('Supabase is not configured.');
      const { error: saveError } = await client.rpc('save_medicine', {
        p_medicine_id: editing?.id ?? null,
        p_values: {
          code: form.code.trim(),
          barcode: form.barcode.trim() || null,
          brand_name: form.brand_name.trim(),
          generic_name: form.generic_name.trim(),
          strength: form.strength.trim() || null,
          category: form.category,
          company: form.company,
          drug_class: form.drug_class,
          storage_condition: form.storage_condition,
          rack_location: form.rack_location.trim(),
          min_stock_alert: minStock,
          requires_prescription: form.requires_prescription,
          is_active: editing?.is_active ?? true,
        },
        p_units: units,
      });
      if (saveError) throw saveError;
      dispatchStockChanged();
      setShowForm(false);
      setNotice(editing ? 'Product updated.' : 'Product added.');
      await loadProducts();
    } catch (caught) {
      setNotice(messageFor(caught, 'Could not save product.'));
    } finally {
      setSaving(false);
    }
  };

  const changeProductStatus = async (medicine: Medicine, active: boolean) => {
    if (getBackend() !== 'api' && !supabase) {
      setNotice('Supabase is not configured.');
      return;
    }
    setImporting(true);
    setNotice('');
    try {
      if (getBackend() === 'api') {
        await updateProductFields(medicine.id, { isActive: active });
        dispatchStockChanged();
        setPendingStatusChange(null);
        setNotice(`${medicine.brand_name} ${active ? 'activated' : 'deactivated'}.`);
        await loadProducts();
        return;
      }
      const client = supabase;
      if (!client) throw new Error('Supabase is not configured.');
      const { error: updateError } = await client.rpc('products_bulk_update', {
        ids: [medicine.id],
        action: active ? 'activate' : 'deactivate',
        value: null,
      });
      if (updateError) throw updateError;
      dispatchStockChanged();
      setPendingStatusChange(null);
      setNotice(`${medicine.brand_name} ${active ? 'activated' : 'deactivated'}.`);
      await loadProducts();
    } catch (caught) {
      setNotice(messageFor(caught, `Could not ${active ? 'activate' : 'deactivate'} product.`));
    } finally {
      setImporting(false);
    }
  };

  const renderProductActions = (medicine: Medicine) => (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Actions for ${medicine.brand_name}`}>
      <button
        type="button"
        className={`${SECONDARY} px-2 py-1.5 text-xs`}
        disabled={!canEditProducts}
        title={canEditProducts ? 'Edit product' : 'Products permission is required to edit'}
        aria-label={`Edit ${medicine.brand_name}`}
        onClick={() => openEdit(medicine)}
      >
        <Pencil size={14} /> Edit
      </button>
      <button
        type="button"
        className={`${SECONDARY} px-2 py-1.5 text-xs`}
        disabled={!medicine.barcode?.trim()}
        title={medicine.barcode?.trim() ? 'Print barcode' : 'Make a barcode before printing'}
        aria-label={`Print barcode for ${medicine.brand_name}`}
        onClick={() => printBarcodeForMedicine(medicine)}
      >
        <Printer size={14} /> Print barcode
      </button>
      <button
        type="button"
        className={`${SECONDARY} px-2 py-1.5 text-xs`}
        disabled={!canEditProducts || Boolean(medicine.barcode?.trim()) || generatingBarcodeId === medicine.id}
        title={!canEditProducts
          ? 'Products permission is required to make a barcode'
          : medicine.barcode?.trim()
            ? 'This product already has a barcode'
            : 'Make barcode'}
        aria-label={`Make barcode for ${medicine.brand_name}`}
        onClick={() => void generateBarcodeForMedicine(medicine)}
      >
        <Barcode size={14} /> {generatingBarcodeId === medicine.id ? 'Making…' : 'Make barcode'}
      </button>
    </div>
  );

  const productColumns: DataTableColumn<Medicine>[] = [
    {
      id: 'product',
      header: 'Product',
      sortable: true,
      sortDirection: sortColumn === 'name' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none',
      onSort: () => {
        setPage(1);
        if (sortColumn === 'name') setSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc');
        else { setSortColumn('name'); setSortDirection('asc'); }
      },
      render: (medicine) => (
        <div className="min-w-44">
          <button type="button" className="block text-left font-bold text-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => setViewingMedicine(medicine)}>{medicine.brand_name}</button>
          <span className="block text-xs text-muted">{medicine.generic_name}{medicine.strength ? ` · ${medicine.strength}` : ''}</span>
          <span className="text-xs text-muted">{medicine.code}</span>
          {medicine.barcode && <span className="mt-1 flex items-center gap-1 text-xs text-muted"><Barcode size={13} />{medicine.barcode}</span>}
        </div>
      ),
    },
    {
      id: 'barcode',
      header: 'Barcode',
      render: (medicine) => {
        if (medicine.barcode) {
          return <span className="flex items-center gap-1 text-xs text-muted"><Barcode size={13} /> {medicine.barcode}</span>;
        }
        return <span className="text-xs text-muted">Not assigned</span>;
      },
    },
    {
      id: 'product-actions',
      header: 'Product actions',
      hideable: false,
      render: renderProductActions,
    },
    {
      id: 'category',
      header: 'Category',
      render: (medicine) => medicine.category,
    },
    {
      id: 'class',
      header: 'Class',
      render: (medicine) => <StatusChip variant={medicine.drug_class === 'CONTROLLED' || medicine.drug_class === 'NARCOTIC' ? 'warning' : 'neutral'}>{medicine.drug_class}</StatusChip>,
    },
    {
      id: 'mrp',
      header: 'MRP',
      sortable: true,
      sortDirection: sortColumn === 'mrp' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none',
      onSort: () => {
        setPage(1);
        if (sortColumn === 'mrp') setSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc');
        else { setSortColumn('mrp'); setSortDirection('asc'); }
      },
      render: (medicine) => {
        const unit = medicine.units.find((item) => item.is_default_sale_unit);
        return unit ? money(unit.price_paisa) : <span className="text-warning">No unit configured</span>;
      },
    },
    {
      id: 'stock',
      header: 'Stock',
      sortable: true,
      sortDirection: sortColumn === 'stock' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none',
      onSort: () => {
        setPage(1);
        if (sortColumn === 'stock') setSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc');
        else { setSortColumn('stock'); setSortDirection('asc'); }
      },
      render: (medicine) => <StockBar quantity={medicine.stock} reorderLevel={medicine.min_stock_alert} />,
    },
    {
      id: 'expiry',
      header: 'Nearest expiry',
      sortable: true,
      sortDirection: sortColumn === 'expiry' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none',
      onSort: () => {
        setPage(1);
        if (sortColumn === 'expiry') setSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc');
        else { setSortColumn('expiry'); setSortDirection('asc'); }
      },
      render: (medicine) => <ExpiryChip expiryDate={medicine.nearest_expiry} quantity={medicine.stock} />,
    },
    ...(canViewCost ? [
      {
        id: 'cost',
        header: 'Unit cost',
        initiallyHidden: true,
        render: (medicine: Medicine) => medicine.latest_cost_paisa === null
          ? '—'
          : money(medicine.latest_cost_paisa * medicine.default_unit_conversion),
      },
      {
        id: 'margin',
        header: 'Margin',
        initiallyHidden: false,
        render: (medicine: Medicine) => medicine.margin_percent === null
          ? '—'
          : `${typeof medicine.margin_percent === 'number'
            ? medicine.margin_percent.toLocaleString(undefined, { maximumFractionDigits: 2 })
            : medicine.margin_percent}%`,
      },
    ] : []),
  ];

  return (
    <div className="space-y-3.5">
      <section className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-[26px] font-black leading-tight text-text">Products</h2>
          <p className="mt-0.5 text-[13px] text-muted">Track products, active stock and nearest batch expiry</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canEditProducts && <>
            <input
              ref={importInputRef}
              type="file"
              accept=".csv,text/csv"
              aria-label="Choose product CSV"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void prepareImportPreview(file);
              }}
            />
            <button type="button" className={SECONDARY} disabled={importing} onClick={() => importInputRef.current?.click()}><FileUp size={16} /> Import CSV</button>
          </>}
          <button type="button" className={SECONDARY} disabled={exporting} onClick={() => void exportProducts('csv')}><Download size={16} /> Export</button>
          {canEditProducts && <button type="button" className={BUTTON} onClick={openCreate}><Plus size={16} /> Add product</button>}
          <details className="relative">
            <summary className={`${SECONDARY} cursor-pointer list-none`}>More</summary>
            <div className="absolute right-0 z-20 mt-2 grid min-w-48 gap-1 rounded-control border border-border bg-surface p-2 shadow-lg">
              <button type="button" className={`${SECONDARY} justify-start`} aria-label="Refresh products" onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} /> Refresh</button>
              <button type="button" className={`${SECONDARY} justify-start`} disabled={exporting} onClick={() => void exportProducts('xlsx')}><Download size={16} /> Export XLSX</button>
              <button type="button" className={`${SECONDARY} justify-start`} onClick={printBarcodes}><Printer size={16} /> Print barcodes</button>
              <button type="button" className={`${SECONDARY} justify-start`} onClick={() => setScannerTestOpen(true)}><ScanLine size={16} /> Scanner test</button>
              {canEditProducts && <button type="button" className={`${SECONDARY} justify-start`} onClick={() => void generateMissingBarcodes()}><Barcode size={16} /> Generate missing barcodes</button>}
              {canEditProducts && <button type="button" className={`${SECONDARY} justify-start`} onClick={downloadImportTemplate}><Download size={16} /> CSV template</button>}
              {skippedRows.length > 0 && <button type="button" className={`${SECONDARY} justify-start`} onClick={() => downloadSkippedRows()}><Download size={16} /> Skipped rows ({skippedRows.length})</button>}
            </div>
          </details>
        </div>
      </section>

      {labelDialogProducts.length > 0 && (
        <Suspense fallback={
          <div role="status" aria-live="polite" className="fixed inset-0 z-50 flex items-center justify-center bg-surface/90 p-4 text-text">
            <span className="rounded-card border border-border bg-surface px-5 py-4 text-sm font-semibold shadow-lg">Loading barcode labels…</span>
          </div>
        }>
          <LabelPrintDialog
            open
            products={labelDialogProducts}
            onClose={() => setLabelDialogProducts([])}
          />
        </Suspense>
      )}
      <BarcodeScannerTest
        open={scannerTestOpen}
        scanValue={scanValue}
        lastRawValue={lastRawValue}
        lastScanned={lastProductScan}
        lastScanDurationMs={lastScanDurationMs}
        onClose={() => setScannerTestOpen(false)}
      />

      <section aria-label="Product summary" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard compact label="Total products" value={(overviewStats?.total_active ?? 0).toLocaleString()} detail="active" />
        <KpiCard compact label="Low stock" value={(overviewStats?.low_stock ?? 0).toLocaleString()} detail="below reorder level" valueClassName="text-warning" />
        <KpiCard compact label="Out of stock" value={(overviewStats?.out_of_stock ?? 0).toLocaleString()} detail="needs purchase" valueClassName="text-danger" />
        <KpiCard compact label="Expiring in 90 days" value={(overviewStats?.expiring_90 ?? 0).toLocaleString()} detail="batches" valueClassName="text-warning" />
        {canViewCost && <KpiCard compact label="Stock value" value={money(overviewStats?.stock_value_cost_paisa ?? 0)} detail="at cost" />}
      </section>

      <section aria-label="Product search and filters" className={`${PANEL} grid gap-3 p-3`}>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-56 flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted" />
            <input className={`${FIELD} pl-9`} aria-label="Search products" placeholder="Search product, generic, code or barcode" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} />
          </label>
          <div role="group" aria-label="Product display mode" className="inline-flex shrink-0 rounded-control border border-border p-0.5">
            <button type="button" className={`${displayMode === 'table' ? BUTTON : SECONDARY} rounded-control px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`} aria-label="Table view" aria-pressed={displayMode === 'table'} onClick={() => setDisplayMode('table')}><List size={16} /><span>Table</span></button>
            <button type="button" className={`${displayMode === 'cards' ? BUTTON : SECONDARY} rounded-control px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`} aria-label="Card view" aria-pressed={displayMode === 'cards'} onClick={() => setDisplayMode('cards')}><Grid2X2 size={16} /><span>Cards</span></button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Filter category" className={`${FILTER_PILL} min-w-32 ${categoryFilter ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-surface text-text'}`} value={categoryFilter} onChange={(event) => { setPage(1); setCategoryFilter(event.target.value); }}>
            <option value="">Category</option>{categories.map((item) => <option key={item.id} value={item.name}>Category: {item.name}</option>)}
          </select>
          <select aria-label="Filter manufacturer" className={`${FILTER_PILL} min-w-36 ${brandFilter ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-surface text-text'}`} value={brandFilter} onChange={(event) => { setPage(1); setBrandFilter(event.target.value); }}>
            <option value="">Manufacturer</option>{brands.map((item) => <option key={item.id} value={item.name}>Manufacturer: {item.name}</option>)}
          </select>
          <select aria-label="Filter medicine class" className={`${FILTER_PILL} min-w-28 ${classFilter ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-surface text-text'}`} value={classFilter} onChange={(event) => { setPage(1); setClassFilter(event.target.value); }}>
            <option value="">Class</option><option value="OTC">Class: OTC</option><option value="RX">Class: Rx</option><option value="CONTROLLED">Class: Controlled (including narcotics)</option>
          </select>
          <select aria-label="Filter active status" className={`${FILTER_PILL} min-w-28 ${activeFilter !== 'active' ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-surface text-text'}`} value={activeFilter} onChange={(event) => { setPage(1); setActiveFilter(event.target.value as typeof activeFilter); }}>
            <option value="active">Status: Active</option><option value="inactive">Status: Inactive</option><option value="all">Status: All</option>
          </select>
          <label className={`inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-full border px-3 py-2 text-sm font-semibold focus-within:ring-2 focus-within:ring-accent ${lowStockOnly ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-surface text-text'}`}>
            <input type="checkbox" checked={lowStockOnly} onChange={(event) => { setPage(1); setLowStockOnly(event.target.checked); }} className="h-4 w-4 accent-accent" />
            Low stock only
          </label>
          <select aria-label="Saved product views" className={`${FILTER_PILL} min-w-32 border-border bg-surface text-text`} value={selectedSavedView} onChange={(event) => applySavedView(event.target.value)}>
            <option value="">Saved views</option>{savedViews.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
          </select>
          <details className="relative shrink-0">
            <summary className={`${SECONDARY} cursor-pointer list-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}>Save view</summary>
            <div className="absolute right-0 z-20 mt-2 grid min-w-56 gap-2 rounded-control border border-border bg-surface p-3 shadow-lg">
              <input aria-label="Saved view name" className={FIELD} placeholder="Name current filters" value={savedViewName} onChange={(event) => setSavedViewName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveCurrentView(); } }} />
              <button type="button" className={`${BUTTON} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`} onClick={saveCurrentView}>Save view</button>
              {selectedSavedView && <button type="button" className={SECONDARY} onClick={() => {
                setSavedViews((current) => current.filter((view) => view.id !== selectedSavedView));
                setSelectedSavedView('');
                setNotice('Saved view removed.');
              }}>Delete view</button>}
            </div>
          </details>
          <details className="relative shrink-0">
            <summary className={`${SECONDARY} cursor-pointer list-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}>More filters</summary>
            <div className="absolute right-0 z-20 mt-2 grid min-w-52 gap-2 rounded-control border border-border bg-surface p-3 shadow-lg">
              <label className="grid gap-1 text-xs font-semibold text-muted">Sort products
                <select aria-label="Sort products" className={FIELD} value={sortColumn} onChange={(event) => { setPage(1); setSortColumn(event.target.value as typeof sortColumn); }}>
                  <option value="name">Name</option><option value="stock">Stock</option><option value="expiry">Expiry</option><option value="mrp">MRP</option>
                </select>
              </label>
              <button type="button" className={`${SECONDARY} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`} aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`} onClick={() => { setPage(1); setSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc'); }}>
                {sortDirection === 'asc' ? 'Ascending' : 'Descending'}
              </button>
            </div>
          </details>
        </div>

        {activeProductFilters.length > 0 && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Active product filters">
            {activeProductFilters.map(({ key, label }) => (
              <FilterChip key={key} onRemove={() => handleRemoveProductFilter(key)} removeLabel={`Remove ${label} filter`}>{label}</FilterChip>
            ))}
            <span className="ml-auto text-sm font-semibold text-muted" aria-live="polite">
              {totalCount.toLocaleString()} {totalCount === 1 ? 'product' : 'products'}
            </span>
            <button type="button" className="rounded-control px-2 py-1 text-sm font-semibold text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={handleClearProductFilters}>
              Clear all
            </button>
          </div>
        )}
      </section>

      {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"><span>{error}</span><button type="button" className={SECONDARY} disabled={loading} onClick={() => void loadProducts()}>Retry products</button></div>}
      {optionsError && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"><span>{optionsError}</span><button type="button" className={SECONDARY} onClick={() => void loadOptions().catch((caught) => setOptionsError(messageFor(caught, 'Could not load categories and manufacturers.')))}>Retry filters</button></div>}
      {notice && <div role="status" className="rounded-control border border-border bg-surface px-4 py-3 text-sm text-text">{notice}</div>}

      <DataTable
        label="Products"
        rows={medicines}
        columns={productColumns}
        getRowId={(medicine) => medicine.id}
        layout={displayMode}
        compact
        hiddenColumnIds={hiddenColumnIds}
        onHiddenColumnIdsChange={setHiddenColumnIds}
        loading={loading}
        emptyTitle={error ? 'Product data unavailable' : 'No products match these filters'}
        emptyDescription={error ? 'Use Retry products above to reload.' : 'Try changing the filters or add a product.'}
        selectedIds={canEditProducts ? selectedIds : undefined}
        onSelectionChange={canEditProducts ? setSelectedIds : undefined}
        pagination={{
          page,
          pageCount,
          totalCount,
          onPageChange: (nextPage) => {
            setSelectedIds([]);
            setPage(nextPage);
          },
        }}
        actions={[
          ...(canEditProducts ? [{ label: 'Edit product', onSelect: openEdit }] : []),
          ...(canViewStockInventory && onViewBatches ? [{ label: 'View batches', onSelect: (medicine: Medicine) => onViewBatches(medicine.id) }] : []),
          ...(canEditProducts ? [
            { label: 'Deactivate product', onSelect: (medicine: Medicine) => setPendingStatusChange({ medicine, active: false }), disabled: (medicine: Medicine) => !medicine.is_active },
            { label: 'Activate product', onSelect: (medicine: Medicine) => setPendingStatusChange({ medicine, active: true }), disabled: (medicine: Medicine) => medicine.is_active },
          ] : []),
        ]}
      />
      {canEditProducts && selectedIds.length > 0 && (
        <div className={`${PANEL} flex flex-wrap items-center gap-2 p-3`}>
          <label className="text-sm font-semibold text-text">New category
            <select aria-label="Bulk category" className={`${FIELD} ml-2 inline-block w-auto min-w-40`} value={bulkCategory} onChange={(event) => setBulkCategory(event.target.value)}>
              <option value="">Choose category</option>{categories.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
            </select>
          </label>
        </div>
      )}
      <BulkActionBar
        selectedCount={canEditProducts ? selectedIds.length : 0}
        onClear={() => setSelectedIds([])}
        actions={[
          { label: 'Update category', onClick: () => bulkCategory ? void applyBulkUpdate('category', bulkCategory) : setNotice('Choose a category before applying the bulk action.'), disabled: importing },
          { label: 'Deactivate selected', onClick: () => setConfirmBulkDeactivate(true), disabled: importing },
          { label: 'Export selected CSV', onClick: () => void exportProducts('csv', true), disabled: exporting },
          { label: 'Export selected XLSX', onClick: () => void exportProducts('xlsx', true), disabled: exporting },
        ]}
      />
      <ConfirmDialog
        open={confirmBulkDeactivate}
        title="Deactivate selected products?"
        description={`${selectedIds.length} product(s) will be unavailable for new purchases but remain in historical records.`}
        confirmLabel="Deactivate"
        destructive
        onCancel={() => setConfirmBulkDeactivate(false)}
        onConfirm={() => void applyBulkUpdate('deactivate')}
      />
      <ConfirmDialog
        open={pendingStatusChange !== null}
        title={`${pendingStatusChange?.active ? 'Activate' : 'Deactivate'} product?`}
        description={pendingStatusChange?.active
          ? `${pendingStatusChange.medicine.brand_name} will become available for new purchases.`
          : `${pendingStatusChange?.medicine.brand_name ?? 'This product'} will remain in history but become unavailable for new purchases.`}
        confirmLabel={pendingStatusChange?.active ? 'Activate' : 'Deactivate'}
        destructive={!pendingStatusChange?.active}
        onCancel={() => setPendingStatusChange(null)}
        onConfirm={() => pendingStatusChange && void changeProductStatus(pendingStatusChange.medicine, pendingStatusChange.active)}
      />
      {importPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section role="dialog" aria-modal="true" aria-labelledby="product-import-title" className={`${PANEL} w-full max-w-3xl space-y-4 p-5`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="product-import-title" className="text-lg font-black text-text">Review product CSV</h2>
                <p className="text-sm text-muted">
                  {importPreview.filter((row) => !row.errors.length && !skippedLines.includes(row.line)).length} ready of {importPreview.length} row(s).
                  {getBackend() === 'api'
                    ? ' Valid rows are imported individually; row-level failures are reported.'
                    : ' Valid rows import in one transaction.'}
                </p>
              </div>
              <button type="button" className={SECONDARY} aria-label="Close import preview" onClick={() => setImportPreview(null)}><X size={16} /></button>
            </div>
            <p className="rounded-control border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-text">
              {getBackend() === 'api'
                ? 'Categories and manufacturers must already exist in Master Data before importing. The import does not create reference data.'
                : 'Missing categories and manufacturers are created through the existing category/brand functions. Your account needs Categories permission if the import contains new values.'}
            </p>
            <div className="max-h-[50vh] space-y-2 overflow-y-auto">
              {importPreview.map((row) => (
                <article key={row.line} className="rounded-control border border-border p-3 text-sm">
                  <strong>Line {row.line}: {row.values.brand_name || 'Unnamed product'}</strong>
                  <p className="text-xs text-muted">{row.values.generic_name}{row.values.strength ? ` · ${row.values.strength}` : ''} · {row.values.company} · {row.values.drug_class || 'OTC'}</p>
                  {row.errors.length > 0 && <ul className="mt-1 list-disc pl-5 text-danger">{row.errors.map((message) => <li key={message}>{message}</li>)}</ul>}
                  {row.errors.length === 0 && <p className="mt-1 text-emerald-700">Ready to import</p>}
                  <button type="button" className={`${SECONDARY} mt-2`} onClick={() => setSkippedLines((current) => current.includes(row.line) ? current.filter((line) => line !== row.line) : [...current, row.line])}>
                    {skippedLines.includes(row.line) ? 'Include row' : 'Skip row'}
                  </button>
                </article>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className={SECONDARY} onClick={() => downloadSkippedRows(importPreview.filter((row) => row.errors.length > 0 || skippedLines.includes(row.line)).map((row) => skippedLines.includes(row.line) && row.errors.length === 0 ? { ...row, errors: ['Skipped by user.'] } : row))}>Download skipped rows</button>
              <button type="button" className={SECONDARY} onClick={() => setImportPreview(null)}>Cancel</button>
              <button type="button" className={BUTTON} disabled={importing || !importPreview.some((row) => row.errors.length === 0 && !skippedLines.includes(row.line))} onClick={() => void importProducts()}>
                {importing ? 'Importing…' : 'Import valid rows'}
              </button>
            </div>
          </section>
        </div>
      )}

      {viewingMedicine && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4">
          <section role="dialog" aria-modal="true" aria-labelledby="product-details-title" className={`${PANEL} w-full max-w-2xl space-y-4 p-5`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 id="product-details-title" className="text-lg font-black text-text">{viewingMedicine.brand_name}</h3>
                <p className="text-sm text-muted">{viewingMedicine.generic_name}{viewingMedicine.strength ? ` · ${viewingMedicine.strength}` : ''}</p>
              </div>
              <button type="button" aria-label="Close product details" className={SECONDARY} onClick={() => setViewingMedicine(null)}><X size={16} /></button>
            </div>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div><dt className="font-semibold text-muted">Product code</dt><dd className="text-text">{viewingMedicine.code}</dd></div>
              <div><dt className="font-semibold text-muted">Barcode</dt><dd className="break-all text-text">{viewingMedicine.barcode || 'Not assigned'}</dd></div>
              <div><dt className="font-semibold text-muted">Category</dt><dd className="text-text">{viewingMedicine.category}</dd></div>
              <div><dt className="font-semibold text-muted">Manufacturer</dt><dd className="text-text">{viewingMedicine.company}</dd></div>
              <div><dt className="font-semibold text-muted">Classification</dt><dd className="text-text">{viewingMedicine.drug_class}</dd></div>
              <div><dt className="font-semibold text-muted">Storage</dt><dd className="text-text">{viewingMedicine.storage_condition.replace(/_/g, ' ').toLowerCase()}</dd></div>
              <div className="sm:col-span-2">
                <dt className="font-semibold text-muted">Sale units</dt>
                <dd className="space-y-1 text-text">
                  {viewingMedicine.units.map((unit) => <div key={unit.id}>{unit.name}{unit.barcode ? ` · ${unit.barcode}` : ''}</div>)}
                </dd>
              </div>
            </dl>
            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
              <button type="button" className={SECONDARY} disabled={!canEditProducts} onClick={() => openEdit(viewingMedicine)}><Pencil size={15} /> Edit</button>
              <button type="button" className={SECONDARY} disabled={!viewingMedicine.barcode?.trim()} onClick={() => {
                setViewingMedicine(null);
                printBarcodeForMedicine(viewingMedicine);
              }}><Printer size={15} /> Print barcode</button>
              <button
                type="button"
                className={BUTTON}
                disabled={!canEditProducts || Boolean(viewingMedicine.barcode?.trim()) || generatingBarcodeId === viewingMedicine.id}
                onClick={() => void generateBarcodeForMedicine(viewingMedicine)}
              >
                <Barcode size={15} /> {generatingBarcodeId === viewingMedicine.id ? 'Making…' : 'Make barcode'}
              </button>
            </div>
          </section>
        </div>
      )}

      {showForm && <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4">
        <form onSubmit={(event) => void saveProduct(event)} className={`${PANEL} my-auto max-h-[95vh] w-full max-w-4xl space-y-4 overflow-y-auto p-5`}>
          <div className="flex items-start justify-between gap-3"><div><h3 className="text-lg font-black text-text">{editing ? 'Edit product' : 'Add product'}</h3><p className="text-sm text-muted">Initial stock is recorded through Purchases, not entered here.</p></div><button type="button" aria-label="Close product form" className={SECONDARY} onClick={() => setShowForm(false)}><X size={16} /></button></div>
          {notice && <p role="alert" className="rounded-control border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{notice}</p>}
          {(categories.length === 0 || brands.length === 0) && <p role="alert" className="rounded-control border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-text">Add at least one active category and manufacturer in Categories before saving a product.</p>}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-sm text-text">Product code *<input className={`${FIELD} mt-1`} required maxLength={80} value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} /></label>
            <label className="text-sm text-text">Brand / medicine name *<input className={`${FIELD} mt-1`} required maxLength={160} value={form.brand_name} onChange={(event) => setForm({ ...form, brand_name: event.target.value })} /></label>
            <label className="text-sm text-text">Generic name *<input className={`${FIELD} mt-1`} required maxLength={160} value={form.generic_name} onChange={(event) => setForm({ ...form, generic_name: event.target.value })} /></label>
            <label className="text-sm text-text">Strength<input className={`${FIELD} mt-1`} maxLength={100} value={form.strength} onChange={(event) => setForm({ ...form, strength: event.target.value })} placeholder="e.g. 500 mg" /></label>
            <label className="text-sm text-text">Category *<select className={`${FIELD} mt-1`} required value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}><option value="">Select category</option>{categories.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
            <label className="text-sm text-text">Manufacturer / brand *<select className={`${FIELD} mt-1`} required value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })}><option value="">Select manufacturer</option>{brands.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
            <label className="text-sm text-text">Barcode<input className={`${FIELD} mt-1`} maxLength={100} value={form.barcode} onChange={(event) => setForm({ ...form, barcode: event.target.value })} /></label>
            <label className="text-sm text-text">Classification<select className={`${FIELD} mt-1`} value={form.drug_class} onChange={(event) => setForm({ ...form, drug_class: event.target.value as DrugClass })}><option value="OTC">OTC</option><option value="RX">Prescription (Rx)</option><option value="CONTROLLED">Controlled</option><option value="NARCOTIC">Narcotic</option></select></label>
            <label className="text-sm text-text">Storage<select className={`${FIELD} mt-1`} value={form.storage_condition} onChange={(event) => setForm({ ...form, storage_condition: event.target.value as StorageCondition })}><option value="ROOM_TEMPERATURE">Room temperature</option><option value="COOL">Cool</option><option value="COLD_REFRIGERATED">Cold / refrigerated</option></select></label>
            <label className="text-sm text-text">Rack / shelf<input className={`${FIELD} mt-1`} maxLength={100} value={form.rack_location} onChange={(event) => setForm({ ...form, rack_location: event.target.value })} /></label>
            <label className="text-sm text-text">Low-stock threshold<input className={`${FIELD} mt-1`} type="number" min="0" step="1" required value={form.min_stock_alert} onChange={(event) => setForm({ ...form, min_stock_alert: event.target.value })} /></label>
            <label className="flex items-center gap-2 text-sm text-text"><input type="checkbox" checked={form.requires_prescription} onChange={(event) => setForm({ ...form, requires_prescription: event.target.checked })} /> Prescription required</label>
          </div>

          <div className="space-y-3 rounded-control border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="font-bold text-text">Units and sale prices</h4><p className="text-xs text-muted">Prices are integer paisa. Existing units are retained; add another unit if needed.</p></div><button type="button" className={SECONDARY} onClick={() => setForm((current) => ({ ...current, units: [...current.units, { name: '', conversion_factor: '1', is_default_sale_unit: current.units.length === 0, price_paisa: '0', barcode: '' }] }))}><Plus size={14} /> Add unit</button></div>
            {form.units.map((unit, index) => <div key={unit.id ?? `unit-${index}`} className="grid gap-2 rounded-control bg-surface p-3 sm:grid-cols-2 lg:grid-cols-5">
              <label className="text-xs text-text">Unit name *<input className={`${FIELD} mt-1`} required maxLength={100} value={unit.name} onChange={(event) => changeUnit(index, { name: event.target.value })} /></label>
              <label className="text-xs text-text">Base units per unit *<input className={`${FIELD} mt-1`} required type="number" min="1" step="1" value={unit.conversion_factor} onChange={(event) => changeUnit(index, { conversion_factor: event.target.value })} /></label>
              <label className="text-xs text-text">Sale price (paisa) *<input className={`${FIELD} mt-1`} required type="number" min="0" step="1" value={unit.price_paisa} onChange={(event) => changeUnit(index, { price_paisa: event.target.value })} /></label>
              <label className="text-xs text-text">Unit barcode<input className={`${FIELD} mt-1`} maxLength={100} value={unit.barcode} onChange={(event) => changeUnit(index, { barcode: event.target.value })} /></label>
              <label className="flex items-center gap-2 self-center text-sm text-text"><input type="radio" name="default-sale-unit" checked={unit.is_default_sale_unit} onChange={() => changeUnit(index, { is_default_sale_unit: true })} /> Default sale unit</label>
            </div>)}
          </div>
          <div className="flex justify-end gap-2"><button type="button" className={SECONDARY} onClick={() => setShowForm(false)}>Cancel</button><button type="submit" disabled={saving || categories.length === 0 || brands.length === 0} className={BUTTON}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Add product'}</button></div>
        </form>
      </div>}
    </div>
  );
}
