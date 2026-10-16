import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, Minus, Pause, Play, Plus, RefreshCw, Search, Trash2, X,
} from 'lucide-react';
import { getBackend } from '../api/config';
import { usePermissions } from '../permissions';
import { getSupabaseErrorMessage } from '../utils/supabaseError';
import { supabase } from '../utils/supabase';
import { dispatchStockChanged } from '../utils/stockAlertsEvents';
import { loadPurchaseCatalog, postPurchase } from '../data/purchases';
import type { PurchaseCatalogProduct, PurchaseCatalogUnit, PurchaseSupplier } from '../data/purchases';

type PurchaseUnit = PurchaseCatalogUnit;
type PurchaseProduct = PurchaseCatalogProduct;
type Supplier = PurchaseSupplier;

interface CartLine {
  product: PurchaseProduct;
  unitId: string;
  quantity: number;
  bonusQty: number;
  batchNumber: string;
  expiryDate: string;
  rate: string;
  mrp: string;
}

interface PurchaseDraft {
  id: string;
  savedAt: string;
  supplierId: string;
  paymentType: 'cash' | 'credit';
  invoiceNumber: string;
  purchaseDate: string;
  discount: string;
  notes: string;
  lines: CartLine[];
}

const localDate = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const PRODUCT_PAGE_SIZE = 50;

function parsePaisa(value: string): number | null {
  const clean = value.trim().replace(/,/g, '');
  if (!/^\d*(\.\d{0,2})?$/.test(clean) || clean === '' || clean === '.') return null;
  const [rupees = '0', paisa = ''] = clean.split('.');
  const amount = Number(rupees) * 100 + Number((paisa + '00').slice(0, 2));
  return Number.isSafeInteger(amount) ? amount : null;
}

function paisaInput(value: number) {
  const rupees = Math.floor(value / 100);
  const paisa = String(value % 100).padStart(2, '0');
  return `${rupees}.${paisa}`;
}

function money(value: number) {
  const rupees = Math.floor(value / 100);
  const paisa = String(Math.abs(value % 100)).padStart(2, '0');
  return `Rs ${rupees.toLocaleString('en-PK')}.${paisa}`;
}

function draftKey(userId: string) {
  return `pharma-care.held-purchases.${userId}`;
}

function readDrafts(userId: string): PurchaseDraft[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(draftKey(userId)) ?? '[]');
    return Array.isArray(value) ? value as PurchaseDraft[] : [];
  } catch {
    return [];
  }
}

function unitFor(line: CartLine) {
  return line.product.units.find((unit) => unit.id === line.unitId) ?? line.product.units[0];
}

export function StockPurchaseView({
  userId,
  onViewHistory,
}: {
  userId: string;
  onViewHistory: () => void;
}) {
  const { can } = usePermissions();
  const canViewHistory = can('purchase_history');
  const [products, setProducts] = useState<PurchaseProduct[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [paymentType, setPaymentType] = useState<'cash' | 'credit'>('cash');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(localDate);
  const [today, setToday] = useState(localDate);
  const [discount, setDiscount] = useState('0.00');
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [brand, setBrand] = useState('ALL');
  const [productPage, setProductPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showHeld, setShowHeld] = useState(false);
  const [drafts, setDrafts] = useState<PurchaseDraft[]>(() => readDrafts(userId));
  const [notice, setNotice] = useState<{ text: string; error: boolean; viewHistory?: boolean } | null>(null);

  const refreshProducts = useCallback(async (): Promise<string | null> => {
    if (getBackend() === 'api') {
      setLoading(true);
      try {
        const catalog = await loadPurchaseCatalog();
        setProducts(catalog.products);
        setSuppliers(catalog.suppliers);
        setToday(catalog.today);
        setPurchaseDate((current) => current === localDate() ? catalog.today : current);
        return null;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not load products and suppliers.';
        setNotice({ text: message, error: true });
        return message;
      } finally {
        setLoading(false);
      }
    }
    if (!supabase) {
      setNotice({ text: 'Supabase is not configured.', error: true });
      setLoading(false);
      return 'Supabase is not configured.';
    }
    setLoading(true);
    try {
      const [{ data: catalog, error: catalogError }, { data: supplierRows, error: supplierError }] = await Promise.all([
        supabase.rpc('purchase_catalog'),
        supabase.from('suppliers').select('id,name').eq('is_active', true).order('name'),
      ]);
      if (catalogError) throw catalogError;
      if (supplierError) throw supplierError;
      setProducts((catalog ?? []) as PurchaseProduct[]);
      setSuppliers((supplierRows ?? []) as Supplier[]);
      setToday(localDate());
      return null;
    } catch (error) {
      const message = getSupabaseErrorMessage(error, 'Could not load products and suppliers.');
      setNotice({ text: message, error: true });
      return message;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refreshProducts(); }, [refreshProducts]);

  useEffect(() => {
    try {
      localStorage.setItem(draftKey(userId), JSON.stringify(drafts));
    } catch (error) {
      setNotice({ text: error instanceof Error ? `Could not save held purchases: ${error.message}` : 'Could not save held purchases.', error: true });
    }
  }, [drafts, userId]);

  const brands = useMemo(
    () => ['ALL', ...Array.from(new Set(products.map((product) => product.company).filter(Boolean))).sort()],
    [products],
  );
  const filteredProducts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return products.filter((product) =>
      (brand === 'ALL' || product.company === brand) &&
      (!query || [
        product.brand_name, product.generic_name, product.company, product.barcode ?? '', product.code,
      ].some((value) => value.toLowerCase().includes(query)))
    );
  }, [brand, products, search]);
  const productPageCount = Math.max(1, Math.ceil(filteredProducts.length / PRODUCT_PAGE_SIZE));
  const visibleProducts = filteredProducts.slice(
    (productPage - 1) * PRODUCT_PAGE_SIZE,
    productPage * PRODUCT_PAGE_SIZE,
  );
  const subtotal = cart.reduce((sum, line) => {
    const rate = parsePaisa(line.rate);
    return sum + (rate ?? 0) * line.quantity;
  }, 0);
  const discountPaisa = parsePaisa(discount);
  const total = subtotal - (discountPaisa ?? 0);

  const addProduct = (product: PurchaseProduct) => {
    if (!product.units.length) {
      setNotice({ text: `${product.brand_name} has no purchase unit configured. Add a medicine unit before purchasing it.`, error: true });
      return;
    }
    setCart((current) => {
      const existing = current.find((line) => line.product.id === product.id);
      if (existing) return current.map((line) => line.product.id === product.id
        ? { ...line, quantity: line.quantity + 1 }
        : line);
      const unit = product.units.find((item) => item.is_default_sale_unit) ?? product.units[0];
      return [...current, {
        product,
        unitId: unit.id,
        quantity: 1,
        bonusQty: 0,
        batchNumber: '',
        expiryDate: '',
        rate: product.last_cost_base_paisa === null
          ? ''
          : paisaInput(Math.round(product.last_cost_base_paisa * unit.conversion_factor)),
        mrp: paisaInput(unit.price_paisa),
      }];
    });
    setNotice(null);
  };

  const patchLine = (index: number, patch: Partial<CartLine>) => {
    setCart((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line));
  };

  const holdPurchase = () => {
    if (!cart.length) {
      setNotice({ text: 'Add at least one item before holding a purchase.', error: true });
      return;
    }
    const draft: PurchaseDraft = {
      id: crypto.randomUUID(),
      savedAt: new Date().toISOString(),
      supplierId,
      paymentType,
      invoiceNumber,
      purchaseDate,
      discount,
      notes,
      lines: cart,
    };
    setDrafts((current) => [draft, ...current]);
    clearForm();
    setNotice({ text: 'Purchase held on this device.', error: false });
  };

  const clearForm = () => {
    setCart([]);
    setSupplierId('');
    setPaymentType('cash');
    setInvoiceNumber('');
    setPurchaseDate(today);
    setDiscount('0.00');
    setNotes('');
  };

  const resumeDraft = (draft: PurchaseDraft) => {
    setCart(draft.lines);
    setSupplierId(draft.supplierId);
    setPaymentType(draft.paymentType);
    setInvoiceNumber(draft.invoiceNumber);
    setPurchaseDate(draft.purchaseDate);
    setDiscount(draft.discount);
    setNotes(draft.notes);
    setDrafts((current) => current.filter((item) => item.id !== draft.id));
    setShowHeld(false);
  };

  const savePurchase = async () => {
    if (!supplierId) return setNotice({ text: 'Select a supplier.', error: true });
    if (!cart.length) return setNotice({ text: 'Add at least one item to the cart.', error: true });
    if (!purchaseDate || purchaseDate > today) return setNotice({ text: 'Enter a valid purchase date.', error: true });
    if (discountPaisa === null || discountPaisa < 0) return setNotice({ text: 'Enter a valid non-negative discount.', error: true });
    if (discountPaisa > subtotal) return setNotice({ text: 'Discount cannot be greater than the subtotal.', error: true });
    for (const line of cart) {
      const rate = parsePaisa(line.rate);
      const mrp = parsePaisa(line.mrp);
      if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0 || line.quantity > 2147483647) return setNotice({ text: `Enter a valid quantity for ${line.product.brand_name}.`, error: true });
      if (!line.batchNumber.trim()) return setNotice({ text: `Enter a batch number for ${line.product.brand_name}.`, error: true });
      if (!line.expiryDate || line.expiryDate <= today || line.expiryDate <= purchaseDate) return setNotice({ text: `Enter a future expiry date for ${line.product.brand_name}.`, error: true });
      if (rate === null || rate < 0 || (getBackend() === 'supabase' && rate > 2147483647)) return setNotice({ text: `Enter a valid cost rate for ${line.product.brand_name}.`, error: true });
      if (mrp === null || mrp < 0 || (getBackend() === 'supabase' && mrp > 2147483647)) return setNotice({ text: `Enter a valid MRP for ${line.product.brand_name}.`, error: true });
      if (!Number.isSafeInteger(line.bonusQty) || line.bonusQty < 0 || line.bonusQty > 2147483647) return setNotice({ text: `Enter a valid bonus quantity for ${line.product.brand_name}.`, error: true });
    }
    if (!Number.isSafeInteger(subtotal) || (getBackend() === 'supabase' && subtotal > 2147483647)) return setNotice({ text: 'Purchase subtotal exceeds the supported limit.', error: true });
    if (getBackend() === 'supabase' && discountPaisa > 2147483647) return setNotice({ text: 'Discount exceeds the supported limit.', error: true });
    if (getBackend() === 'supabase' && !supabase) return setNotice({ text: 'Supabase is not configured.', error: true });

    setSaving(true);
    setNotice(null);
    try {
      let posted: { id: string; pr_no: string; total_paisa: number };
      if (getBackend() === 'api') {
        posted = await postPurchase({
          supplierId,
          invoiceNumber: invoiceNumber.trim(),
          purchaseDate,
          paymentType,
          discountPaisa: String(discountPaisa),
          notes: notes.trim(),
          items: cart.map((line) => ({
            medicineId: line.product.id,
            unitId: line.unitId,
            batchNumber: line.batchNumber.trim(),
            expiryDate: line.expiryDate,
            quantity: line.quantity,
            bonusQuantity: line.bonusQty,
            unitCostPaisa: String(parsePaisa(line.rate)),
            mrpPaisa: String(parsePaisa(line.mrp)),
          })),
        });
      } else {
        const { data, error } = await supabase!.rpc('post_purchase', {
          p_supplier_id: supplierId,
          p_invoice_number: invoiceNumber.trim() || null,
          p_purchase_date: purchaseDate,
          p_paid_paisa: paymentType === 'cash' ? total : 0,
          p_notes: notes.trim() || null,
          p_discount_paisa: discountPaisa,
          p_payment_type: paymentType,
          p_items: cart.map((line) => ({
            medicine_id: line.product.id,
            unit_id: line.unitId,
            batch_number: line.batchNumber.trim(),
            expiry_date: line.expiryDate,
            quantity: line.quantity,
            bonus_qty: line.bonusQty,
            unit_cost_paisa: parsePaisa(line.rate),
            mrp_paisa: parsePaisa(line.mrp),
          })),
        });
        if (error) throw error;
        posted = data as { id: string; pr_no: string; total_paisa: number };
      }
      dispatchStockChanged();
      clearForm();
      const refreshError = await refreshProducts();
      setNotice(refreshError
        ? { text: `${posted.pr_no} was saved, but product stock could not be refreshed: ${refreshError}`, error: true, viewHistory: true }
        : { text: `${posted.pr_no} saved successfully.`, error: false, viewHistory: true });
    } catch (error) {
      const message = getBackend() === 'api' && error instanceof Error
        ? error.message
        : getSupabaseErrorMessage(error, 'Purchase could not be saved. Your cart has been kept.');
      setNotice({ text: message, error: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mx-auto max-w-[1500px] space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-text">Stock Purchase</h2>
          <p className="mt-1 text-sm text-muted">{cart.length} {cart.length === 1 ? 'item' : 'items'} in cart</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setShowHeld(true)} className="rounded-control border border-border bg-white px-3 py-2 text-sm font-semibold text-text">
            <Play className="mr-1 inline h-4 w-4" /> Held purchases ({drafts.length})
          </button>
          <button type="button" onClick={() => void refreshProducts()} disabled={loading} aria-label="Refresh products" className="rounded-control border border-border bg-white p-2 text-muted disabled:opacity-50">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </header>

      {notice && <div role={notice.error ? 'alert' : 'status'} className={`rounded-control border px-4 py-3 text-sm ${notice.error ? 'border-red-200 bg-red-50 text-red-800' : 'border-green-200 bg-green-50 text-green-800'}`}>{notice.text}{notice.viewHistory && canViewHistory && <button type="button" onClick={onViewHistory} className="ml-3 inline-flex items-center gap-1 font-bold underline">View in Purchase History <ArrowRight size={14} /></button>}</div>}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(440px,0.8fr)]">
        <section className="space-y-4 rounded-card border border-border bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted" />
              <input aria-label="Search products" value={search} onChange={(event) => { setSearch(event.target.value); setProductPage(1); }} placeholder="Search product, generic, brand or barcode" className="w-full rounded-control border border-border bg-surface px-9 py-2 text-sm text-text" />
            </label>
            <select aria-label="Filter by brand" value={brand} onChange={(event) => { setBrand(event.target.value); setProductPage(1); }} className="rounded-control border border-border bg-surface px-3 py-2 text-sm text-text">
              {brands.map((item) => <option key={item} value={item}>{item === 'ALL' ? 'All Brands' : item}</option>)}
            </select>
          </div>
          {loading ? <p className="py-10 text-center text-sm text-muted">Loading products…</p>
            : filteredProducts.length === 0 ? <p className="py-10 text-center text-sm text-muted">No products found.</p>
              : <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                {visibleProducts.map((product) => (
                  <button key={product.id} type="button" onClick={() => addProduct(product)} className="rounded-control border border-border bg-surface p-4 text-left transition hover:border-primary">
                    <span className="block truncate font-bold text-text">{product.brand_name}</span>
                    <span className="mt-1 block truncate text-xs text-muted">{product.company} · {product.generic_name}</span>
                    <span className="mt-3 flex items-center justify-between text-xs"><span className="text-muted">Stock</span><strong className="text-primary">{product.stock.toLocaleString('en-PK')}</strong></span>
                    <span className="mt-1 flex items-center justify-between text-xs"><span className="text-muted">Last Cost</span><strong className="text-text">{product.last_cost_base_paisa === null ? '—' : money(Math.round(product.last_cost_base_paisa * (product.units.find((unit) => unit.is_default_sale_unit) ?? product.units[0])?.conversion_factor || 0))}</strong></span>
                    <span className="mt-3 flex items-center gap-1 text-xs font-bold text-primary"><Plus size={14} /> Add to cart</span>
                  </button>
                ))}
              </div>}
          {!loading && filteredProducts.length > PRODUCT_PAGE_SIZE && <footer className="flex items-center justify-between text-xs text-muted">
            <span>{filteredProducts.length} products · Page {productPage} of {productPageCount}</span>
            <div className="flex gap-2">
              <button type="button" disabled={productPage <= 1} onClick={() => setProductPage((page) => page - 1)} className="rounded-control border border-border px-3 py-1.5 disabled:opacity-50">Previous</button>
              <button type="button" disabled={productPage >= productPageCount} onClick={() => setProductPage((page) => page + 1)} className="rounded-control border border-border px-3 py-1.5 disabled:opacity-50">Next</button>
            </div>
          </footer>}
        </section>

        <section className="space-y-4 rounded-card border border-border bg-white p-4 shadow-sm">
          <h3 className="text-lg font-bold text-text">Purchase Cart</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold text-text sm:col-span-2">Supplier *
              <select value={supplierId} onChange={(event) => setSupplierId(event.target.value)} className="mt-1 w-full rounded-control border border-border bg-surface px-3 py-2 text-sm">
                <option value="">Select supplier</option>{suppliers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <fieldset className="flex rounded-control border border-border p-1 sm:col-span-2">
              {(['cash', 'credit'] as const).map((value) => <button key={value} type="button" onClick={() => setPaymentType(value)} aria-pressed={paymentType === value} className={`flex-1 rounded-control px-3 py-2 text-sm font-bold capitalize ${paymentType === value ? 'bg-primary text-white' : 'text-muted'}`}>{value} Paid</button>)}
            </fieldset>
            <label className="text-xs font-semibold text-text">Supplier Invoice No.
              <input value={invoiceNumber} onChange={(event) => setInvoiceNumber(event.target.value)} className="mt-1 w-full rounded-control border border-border bg-surface px-3 py-2 text-sm" />
            </label>
            <label className="text-xs font-semibold text-text">Purchase Date
              <input type="date" value={purchaseDate} onChange={(event) => setPurchaseDate(event.target.value)} className="mt-1 w-full rounded-control border border-border bg-surface px-3 py-2 text-sm" />
            </label>
          </div>

          {cart.length === 0 ? <p className="rounded-control border border-dashed border-border py-8 text-center text-sm text-muted">Add products to start a purchase.</p>
            : <div className="max-h-[50vh] space-y-3 overflow-auto">
              {cart.map((line, index) => {
                const unit = unitFor(line);
                const rate = parsePaisa(line.rate) ?? 0;
                return <article key={line.product.id} className="space-y-3 rounded-control border border-border bg-surface p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div><h4 className="font-bold text-text">{line.product.brand_name}</h4><p className="text-xs text-muted">{line.product.company}</p></div>
                    <button type="button" aria-label={`Remove ${line.product.brand_name}`} onClick={() => setCart((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="rounded-control p-1 text-danger"><X size={16} /></button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="text-[11px] font-semibold text-text">Unit
                      <select value={line.unitId} onChange={(event) => {
                        const nextUnit = line.product.units.find((item) => item.id === event.target.value);
                        if (nextUnit) patchLine(index, {
                          unitId: nextUnit.id,
                          rate: line.product.last_cost_base_paisa === null
                            ? ''
                            : paisaInput(Math.round(line.product.last_cost_base_paisa * nextUnit.conversion_factor)),
                          mrp: paisaInput(nextUnit.price_paisa),
                        });
                      }} className="mt-1 w-full rounded-control border border-border bg-white px-2 py-1.5 text-xs">
                        {line.product.units.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                    </label>
                    <label className="text-[11px] font-semibold text-text">Quantity
                      <span className="mt-1 flex items-center rounded-control border border-border bg-white">
                        <button type="button" aria-label="Decrease quantity" onClick={() => patchLine(index, { quantity: Math.max(1, line.quantity - 1) })} className="px-2 py-1.5"><Minus size={13} /></button>
                        <input type="number" min="1" step="1" value={line.quantity} onChange={(event) => patchLine(index, { quantity: event.target.value === '' ? 0 : Number(event.target.value) })} className="w-full min-w-0 border-0 bg-transparent p-1 text-center text-xs" />
                        <button type="button" aria-label="Increase quantity" onClick={() => patchLine(index, { quantity: line.quantity + 1 })} className="px-2 py-1.5"><Plus size={13} /></button>
                      </span>
                    </label>
                    <label className="text-[11px] font-semibold text-text">Rate (Rs) <span className="font-normal text-muted">Prev Cost {line.product.last_cost_base_paisa === null ? '—' : money(Math.round(line.product.last_cost_base_paisa * (unit?.conversion_factor ?? 1)))}</span>
                      <input inputMode="decimal" value={line.rate} onChange={(event) => patchLine(index, { rate: event.target.value })} className="mt-1 w-full rounded-control border border-border bg-white px-2 py-1.5 text-xs" />
                    </label>
                    <label className="text-[11px] font-semibold text-text">MRP (Rs)
                      <input inputMode="decimal" value={line.mrp} onChange={(event) => patchLine(index, { mrp: event.target.value })} className="mt-1 w-full rounded-control border border-border bg-white px-2 py-1.5 text-xs" />
                    </label>
                    <label className="text-[11px] font-semibold text-text">Batch No. *
                      <input value={line.batchNumber} onChange={(event) => patchLine(index, { batchNumber: event.target.value })} className="mt-1 w-full rounded-control border border-border bg-white px-2 py-1.5 text-xs" />
                    </label>
                    <label className="text-[11px] font-semibold text-text">Expiry Date *
                      <input type="date" min={today} value={line.expiryDate} onChange={(event) => patchLine(index, { expiryDate: event.target.value })} className="mt-1 w-full rounded-control border border-border bg-white px-2 py-1.5 text-xs" />
                    </label>
                    <label className="text-[11px] font-semibold text-text">Bonus / Free Qty
                      <input type="number" min="0" step="1" value={line.bonusQty} onChange={(event) => patchLine(index, { bonusQty: event.target.value === '' ? 0 : Number(event.target.value) })} className="mt-1 w-full rounded-control border border-border bg-white px-2 py-1.5 text-xs" />
                    </label>
                    <p className="self-end text-right text-xs font-bold text-text">Line total {money(rate * line.quantity)}</p>
                  </div>
                </article>;
              })}
            </div>}

          <label className="block text-xs font-semibold text-text">Notes
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} className="mt-1 w-full rounded-control border border-border bg-surface px-3 py-2 text-sm" />
          </label>
          <div className="space-y-2 border-t border-border pt-3 text-sm">
            <div className="flex justify-between"><span className="text-muted">Subtotal</span><strong>{money(subtotal)}</strong></div>
            <label className="flex items-center justify-between gap-3"><span className="text-muted">Disc (Rs)</span><input inputMode="decimal" value={discount} onChange={(event) => setDiscount(event.target.value)} className="w-36 rounded-control border border-border bg-surface px-2 py-1 text-right" /></label>
            <div className="flex justify-between text-lg font-black"><span>NET TOTAL</span><span>{money(total)}</span></div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <button type="button" onClick={holdPurchase} className="rounded-control border border-border px-2 py-2 text-xs font-bold text-text"><Pause className="mr-1 inline h-4 w-4" /> Hold</button>
            <button type="button" onClick={() => {
              if (window.confirm('Clear the current purchase cart?')) clearForm();
            }} className="rounded-control border border-border px-2 py-2 text-xs font-bold text-danger"><Trash2 className="mr-1 inline h-4 w-4" /> Clear</button>
            <button type="button" disabled={saving} onClick={() => void savePurchase()} className="rounded-control bg-primary px-2 py-2 text-xs font-bold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save Purchase'}</button>
          </div>
        </section>
      </div>

      {showHeld && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <section role="dialog" aria-modal="true" aria-labelledby="held-purchases-title" className="w-full max-w-xl space-y-4 rounded-card border border-border bg-surface p-5 shadow-xl">
          <div className="flex justify-between"><h3 id="held-purchases-title" className="font-bold text-text">Held purchases</h3><button type="button" onClick={() => setShowHeld(false)} aria-label="Close held purchases"><X /></button></div>
          {drafts.length === 0 ? <p className="py-6 text-center text-sm text-muted">No held purchases.</p> : drafts.map((draft) => <div key={draft.id} className="flex items-center justify-between gap-3 border-t border-border py-3">
            <div><p className="font-semibold text-text">{draft.lines.length} items · {draft.invoiceNumber || 'No invoice number'}</p><p className="text-xs text-muted">{new Date(draft.savedAt).toLocaleString()}</p></div>
            <div className="flex gap-2"><button type="button" onClick={() => resumeDraft(draft)} className="rounded-control bg-primary px-3 py-1.5 text-xs font-bold text-white">Resume</button><button type="button" aria-label="Delete held purchase" onClick={() => setDrafts((current) => current.filter((item) => item.id !== draft.id))} className="rounded-control border border-border p-1.5 text-danger"><Trash2 size={15} /></button></div>
          </div>)}
        </section>
      </div>}
    </section>
  );
}
