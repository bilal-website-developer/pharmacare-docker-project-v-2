import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Printer, RefreshCw, X } from 'lucide-react';
import { getBackend } from '../api/config';
import { UserRole } from '../types/pharmacy';
import { isAdminRole } from '../permissions';
import { getSupabaseErrorMessage } from '../utils/supabaseError';
import { supabase } from '../utils/supabase';
import { dispatchStockChanged } from '../utils/stockAlertsEvents';
import {
  loadPurchaseDetail,
  loadPurchaseExport,
  loadPurchaseHistory,
  voidPurchase as voidPurchaseApi,
} from '../data/purchases';
import type {
  PurchaseDetail as ApiPurchaseDetail,
  PurchaseHistoryRow,
} from '../data/purchases';

type PurchaseRow = PurchaseHistoryRow;
type PurchaseDetail = ApiPurchaseDetail;

interface PurchaseHistoryResult {
  rows: PurchaseRow[];
  total_count: number;
  total_paisa?: number;
  cash_paisa?: number;
  cash_count?: number;
  credit_paisa?: number;
  credit_count?: number;
  page: number;
  page_size: number | null;
  costVisible: boolean;
}

const PAGE_SIZE = 25;

function money(paisa: number) {
  const rupees = Math.floor(paisa / 100);
  const cents = String(Math.abs(paisa % 100)).padStart(2, '0');
  return `Rs ${rupees.toLocaleString('en-PK')}.${cents}`;
}

function moneyIfKnown(paisa: number | undefined) {
  return paisa === undefined ? '—' : money(paisa);
}

function karachiDate(value: string) {
  return new Intl.DateTimeFormat('en-PK', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  }).format(new Date(`${value.slice(0, 10)}T00:00:00+05:00`));
}

function safeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char] ?? char);
}

function karachiToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function PurchaseHistoryView({ currentRole }: { currentRole: UserRole }) {
  const [rows, setRows] = useState<PurchaseRow[]>([]);
  const [summary, setSummary] = useState<PurchaseHistoryResult | null>(null);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [paymentType, setPaymentType] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<PurchaseDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [costVisible, setCostVisible] = useState(false);

  const load = useCallback(async () => {
    if (getBackend() === 'api') {
      setLoading(true);
      setError('');
      try {
        const result = await loadPurchaseHistory({
          search,
          ...(paymentType ? { paymentType: paymentType as 'cash' | 'credit' } : {}),
          ...(dateFrom ? { dateFrom } : {}),
          ...(dateTo ? { dateTo } : {}),
          page,
          pageSize: PAGE_SIZE,
        });
        setRows(result.rows);
        setCostVisible(result.costVisible);
        setSummary({
          rows: result.rows,
          total_count: result.total_count,
          total_paisa: result.summary?.total_paisa,
          cash_paisa: result.summary?.cash_paisa,
          cash_count: result.summary?.cash_count,
          credit_paisa: result.summary?.credit_paisa,
          credit_count: result.summary?.credit_count,
          page: result.page,
          page_size: result.page_size,
          costVisible: result.costVisible,
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not load purchase history.');
      } finally {
        setLoading(false);
      }
      return;
    }
    if (!supabase) {
      setError('Supabase is not configured.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const { data, error: queryError } = await supabase.rpc('purchase_history', {
        p_search: search || null,
        p_payment_type: paymentType || null,
        p_date_from: dateFrom || null,
        p_date_to: dateTo || null,
        p_page: page,
        p_page_size: PAGE_SIZE,
        p_export: false,
      });
      if (queryError) throw queryError;
      const result = data as PurchaseHistoryResult;
      setRows(result.rows);
      setCostVisible(true);
      setSummary({ ...result, costVisible: true });
    } catch (caught) {
      setError(getSupabaseErrorMessage(caught, 'Could not load purchase history.'));
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, page, paymentType, search]);

  useEffect(() => { void load(); }, [load]);

  const openDetail = async (purchase: PurchaseRow) => {
    if (getBackend() === 'api') {
      setDetailLoading(true);
      setError('');
      try {
        const detail = await loadPurchaseDetail(purchase.id);
        setSelected(detail);
        setCostVisible(detail.total_paisa !== undefined);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not load purchase details.');
      } finally {
        setDetailLoading(false);
      }
      return;
    }
    if (!supabase) return setError('Supabase is not configured.');
    setDetailLoading(true);
    setError('');
    try {
      const { data, error: queryError } = await supabase.rpc('purchase_detail', { p_purchase_id: purchase.id });
      if (queryError) throw queryError;
      setSelected(data as PurchaseDetail);
      setCostVisible(true);
    } catch (caught) {
      setError(getSupabaseErrorMessage(caught, 'Could not load purchase details.'));
    } finally {
      setDetailLoading(false);
    }
  };

  const exportFiltered = async () => {
    if (getBackend() === 'supabase' && !supabase) return setError('Supabase is not configured.');
    setExporting(true);
    setError('');
    try {
      const XLSX = await import('@e965/xlsx');
      let purchases: PurchaseDetail[];
      if (getBackend() === 'api') {
        purchases = await loadPurchaseExport({
          search,
          ...(paymentType ? { paymentType: paymentType as 'cash' | 'credit' } : {}),
          ...(dateFrom ? { dateFrom } : {}),
          ...(dateTo ? { dateTo } : {}),
        });
      } else {
        const { data, error: queryError } = await supabase!.rpc('purchase_history', {
          p_search: search || null,
          p_payment_type: paymentType || null,
          p_date_from: dateFrom || null,
          p_date_to: dateTo || null,
          p_page: 1,
          p_page_size: PAGE_SIZE,
          p_export: true,
        });
        if (queryError) throw queryError;
        purchases = (data as PurchaseHistoryResult).rows as PurchaseDetail[];
      }
      const purchaseSheet = purchases.map((purchase) => ({
        'PR-ID': purchase.pr_no,
        Date: karachiDate(purchase.purchase_date),
        Supplier: purchase.supplier_name,
        'Invoice No.': purchase.invoice_number ?? '',
        Items: purchase.item_count,
        Subtotal: moneyIfKnown(purchase.subtotal_paisa),
        Discount: moneyIfKnown(purchase.discount_paisa),
        Total: moneyIfKnown(purchase.total_paisa),
        Payment: purchase.payment_type,
        Paid: moneyIfKnown(purchase.paid_paisa),
        Due: moneyIfKnown(purchase.due_paisa),
        'Created By': purchase.created_by,
        Status: purchase.status,
        Notes: purchase.notes ?? '',
      }));
      const itemSheet = purchases.flatMap((purchase) => purchase.items.map((item) => ({
        'PR-ID': purchase.pr_no,
        Product: item.product_name,
        Generic: item.generic_name,
        Unit: item.unit_name,
        Batch: item.batch_number,
        Expiry: item.expiry_date,
        Quantity: item.quantity,
        Bonus: item.bonus_qty,
        'Cost': item.unit_cost_paisa === undefined ? '' : money(item.unit_cost_paisa),
        'MRP': item.mrp_paisa === undefined ? '' : money(item.mrp_paisa),
        'Line Total': item.line_total_paisa === undefined ? '' : money(item.line_total_paisa),
      })));
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(purchaseSheet), 'Purchases');
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(itemSheet), 'Items');
      XLSX.writeFile(workbook, `purchase-history-${karachiToday()}.xlsx`);
    } catch (caught) {
      setError(getBackend() === 'api' && caught instanceof Error
        ? caught.message
        : getSupabaseErrorMessage(caught, 'Could not export purchase history.'));
    } finally {
      setExporting(false);
    }
  };

  const printPurchase = (purchase: PurchaseDetail) => {
    if (purchase.subtotal_paisa === undefined || purchase.discount_paisa === undefined
      || purchase.total_paisa === undefined || purchase.paid_paisa === undefined
      || purchase.due_paisa === undefined
      || purchase.items.some((item) => item.unit_cost_paisa === undefined
        || item.mrp_paisa === undefined || item.line_total_paisa === undefined)) {
      setNotice('Cost details are unavailable for this purchase.');
      return;
    }
    const printWindow = window.open('', '_blank', 'width=900,height=700');
    if (!printWindow) {
      setNotice('Allow pop-ups to print the purchase.');
      return;
    }
    const lineRows = purchase.items.map((item) => `<tr><td>${safeHtml(item.product_name)}<br><small>${safeHtml(item.generic_name)}</small></td><td>${safeHtml(item.batch_number)}</td><td>${safeHtml(item.expiry_date)}</td><td>${item.quantity}</td><td>${item.bonus_qty}</td><td>${money(item.unit_cost_paisa!)}</td><td>${money(item.mrp_paisa!)}</td><td>${money(item.line_total_paisa!)}</td></tr>`).join('');
    printWindow.document.write(`<!doctype html><html><head><title>${safeHtml(purchase.pr_no)}</title><style>body{font:14px Arial,sans-serif;color:#173c2a;margin:32px}header{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #147d43;padding-bottom:14px}header img{width:56px;height:56px;object-fit:contain}header .brand{display:flex;align-items:center;gap:12px}h1{margin:0;color:#147d43}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{border:1px solid #c8e0d0;padding:8px;text-align:left}th{background:#e8f7ed}.totals{margin:20px 0 0 auto;width:280px}.totals div{display:flex;justify-content:space-between;padding:4px}small{color:#526e5e}</style></head><body><header><div class="brand"><img src="${safeHtml(window.location.origin)}/pharma-care-192.png" alt="Pharma Care logo"><div><h1>PHARMA CARE</h1><strong>Stock Purchase</strong></div></div><div><strong>${safeHtml(purchase.pr_no)}</strong><br>${safeHtml(karachiDate(purchase.purchase_date))}</div></header><p><strong>Supplier:</strong> ${safeHtml(purchase.supplier_name)}<br><strong>Contact:</strong> ${safeHtml(purchase.supplier_contact)}<br><strong>Invoice:</strong> ${safeHtml(purchase.invoice_number)}</p><table><thead><tr><th>Product</th><th>Batch</th><th>Expiry</th><th>Qty</th><th>Bonus</th><th>Cost</th><th>MRP</th><th>Line total</th></tr></thead><tbody>${lineRows}</tbody></table><div class="totals"><div><span>Subtotal</span><strong>${money(purchase.subtotal_paisa)}</strong></div><div><span>Discount</span><strong>${money(purchase.discount_paisa)}</strong></div><div><span>Total</span><strong>${money(purchase.total_paisa)}</strong></div><div><span>Paid</span><strong>${money(purchase.paid_paisa)}</strong></div><div><span>Due</span><strong>${money(purchase.due_paisa)}</strong></div></div><p><strong>Notes:</strong> ${safeHtml(purchase.notes)}</p><script>window.onload=()=>window.print()</script></body></html>`);
    printWindow.document.close();
  };

  const voidPurchase = async (purchase: PurchaseRow) => {
    const reason = window.prompt(`Enter the reason for voiding ${purchase.pr_no}:`)?.trim();
    if (!reason) return;
    if (!window.confirm(`Void ${purchase.pr_no}? This cannot be undone.`)) return;
    if (getBackend() === 'api') {
      setError('');
      try {
        const updated = await voidPurchaseApi(purchase.id, reason);
        dispatchStockChanged();
        setNotice(`${purchase.pr_no} was voided.`);
        await load();
        if (selected?.id === purchase.id) setSelected(updated);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not void purchase.');
      }
      return;
    }
    if (!supabase) return setError('Supabase is not configured.');
    setError('');
    try {
      const { error: voidError } = await supabase.rpc('void_purchase', {
        p_purchase_id: purchase.id,
        p_reason: reason,
      });
      if (voidError) throw voidError;
      dispatchStockChanged();
      setNotice(`${purchase.pr_no} was voided.`);
      await load();
      if (selected?.id === purchase.id) setSelected({ ...selected, status: 'void', void_reason: reason });
    } catch (caught) {
      setError(getSupabaseErrorMessage(caught, 'Could not void purchase.'));
    }
  };

  return (
    <section className="mx-auto max-w-[1500px] space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 className="text-xl font-black text-text">Purchase History</h2><p className="mt-1 text-sm text-muted">View and manage previous stock-in records</p></div>
        <div className="flex gap-2">
              {costVisible && <button type="button" onClick={() => void exportFiltered()} disabled={exporting} className="rounded-control bg-primary px-3 py-2 text-sm font-bold text-white disabled:opacity-50"><Download className="mr-1 inline h-4 w-4" />{exporting ? 'Exporting…' : 'Export Excel'}</button>}
          <button type="button" aria-label="Refresh purchase history" onClick={() => void load()} disabled={loading} className="rounded-control border border-border bg-white p-2 text-muted disabled:opacity-50"><RefreshCw className="h-4 w-4" /></button>
        </div>
      </header>

      {costVisible && <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard label="TOTAL" value={moneyIfKnown(summary?.total_paisa)} />
        <SummaryCard label="CASH" value={moneyIfKnown(summary?.cash_paisa)} detail={`${summary?.cash_count ?? 0} purchases`} />
        <SummaryCard label="CREDIT" value={moneyIfKnown(summary?.credit_paisa)} detail={`${summary?.credit_count ?? 0} purchases`} />
      </div>}

      <section className="space-y-3 rounded-card border border-border bg-white p-4 shadow-sm">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_170px_160px_160px_auto]">
          <form onSubmit={(event) => { event.preventDefault(); setPage(1); setSearch(searchInput.trim()); }} className="flex gap-2">
            <input aria-label="Search by purchase ID or supplier" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search PR-ID or supplier" className="min-w-0 flex-1 rounded-control border border-border bg-surface px-3 py-2 text-sm" />
            <button type="submit" className="rounded-control border border-border px-3 text-sm font-semibold">Search</button>
          </form>
          <select aria-label="Payment filter" value={paymentType} onChange={(event) => { setPaymentType(event.target.value); setPage(1); }} className="rounded-control border border-border bg-surface px-3 py-2 text-sm">
            <option value="">All Payments</option><option value="cash">Cash</option><option value="credit">Credit</option>
          </select>
          <label className="text-xs font-semibold text-muted">Date from<input aria-label="Date from" type="date" value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); setPage(1); }} className="mt-1 w-full rounded-control border border-border bg-surface px-2 py-2 text-sm text-text" /></label>
          <label className="text-xs font-semibold text-muted">Date to<input aria-label="Date to" type="date" value={dateTo} onChange={(event) => { setDateTo(event.target.value); setPage(1); }} className="mt-1 w-full rounded-control border border-border bg-surface px-2 py-2 text-sm text-text" /></label>
          <button type="button" onClick={() => { setSearchInput(''); setSearch(''); setPaymentType(''); setDateFrom(''); setDateTo(''); setPage(1); }} className="rounded-control border border-border px-3 py-2 text-sm font-semibold text-text">Clear filters</button>
        </div>

        {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
        {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><span>{error}</span><button type="button" onClick={() => void load()} className="font-bold underline">Retry</button></div>}
        <div className="overflow-x-auto rounded-control border border-border">
          <table className="w-full min-w-[1200px] text-left text-xs">
            <thead className="bg-surface text-[10px] font-bold uppercase tracking-wide text-muted"><tr>
              {['PR-ID', 'Date', 'Supplier', 'Items', ...(costVisible ? ['Total', 'Discount'] : []), 'Payment', ...(costVisible ? ['Paid', 'Due'] : []), 'Created By', 'Status'].map((label) => <th key={label} className="px-3 py-3">{label}</th>)}
              <th className="px-3 py-3 text-right">Actions</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {loading ? Array.from({ length: 5 }, (_, index) => <tr key={index}><td colSpan={costVisible ? 12 : 8} className="visual-skeleton h-11 px-3" /></tr>)
                : error ? null
                  : rows.length === 0 ? <tr><td colSpan={costVisible ? 12 : 8} className="px-4 py-10 text-center text-sm text-muted">No purchases found.</td></tr>
                    : rows.map((purchase) => <tr key={purchase.id} className="cursor-pointer hover:bg-surface" onClick={() => void openDetail(purchase)}>
                      <td className="px-3 py-3 font-bold text-primary">{purchase.pr_no}</td>
                      <td className="px-3 py-3">{karachiDate(purchase.purchase_date)}</td>
                      <td className="px-3 py-3">{purchase.supplier_name}</td>
                      <td className="px-3 py-3">{purchase.item_count}</td>
                      {costVisible && <><td className="px-3 py-3">{moneyIfKnown(purchase.total_paisa)}</td><td className="px-3 py-3">{moneyIfKnown(purchase.discount_paisa)}</td></>}
                      <td className="px-3 py-3 capitalize">{purchase.payment_type}</td>
                      {costVisible && <><td className="px-3 py-3">{moneyIfKnown(purchase.paid_paisa)}</td><td className="px-3 py-3">{moneyIfKnown(purchase.due_paisa)}</td></>}
                      <td className="px-3 py-3">{purchase.created_by}</td>
                      <td className="px-3 py-3 capitalize">{purchase.status}</td>
                      <td className="px-3 py-3 text-right"><button type="button" onClick={(event) => { event.stopPropagation(); void openDetail(purchase); }} className="rounded-control border border-border px-2 py-1 font-semibold">View</button></td>
                    </tr>)}
            </tbody>
          </table>
        </div>
        <footer className="flex items-center justify-between text-xs text-muted">
          <span>{summary?.total_count ?? 0} purchases · Page {page} of {Math.max(1, Math.ceil((summary?.total_count ?? 0) / PAGE_SIZE))}</span>
          <div className="flex gap-2">
            <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((current) => current - 1)} className="rounded-control border border-border p-1.5 disabled:opacity-40"><ChevronLeft size={16} /></button>
            <button type="button" disabled={page >= Math.ceil((summary?.total_count ?? 0) / PAGE_SIZE) || loading} onClick={() => setPage((current) => current + 1)} className="rounded-control border border-border p-1.5 disabled:opacity-40"><ChevronRight size={16} /></button>
          </div>
        </footer>
      </section>

      {(selected || detailLoading) && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
        <section role="dialog" aria-modal="true" aria-labelledby="purchase-detail-title" className="max-h-[90vh] w-full max-w-5xl space-y-4 overflow-auto rounded-card border border-border bg-surface p-5 shadow-xl">
          {detailLoading ? <p className="py-12 text-center text-muted">Loading purchase details…</p> : selected && <>
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div><h3 id="purchase-detail-title" className="text-lg font-black text-text">{selected.pr_no}</h3><p className="text-sm text-muted">{selected.supplier_name} · {karachiDate(selected.purchase_date)}</p></div>
              <div className="flex gap-2">
                {selected.total_paisa !== undefined && <button type="button" onClick={() => printPurchase(selected)} className="rounded-control border border-border px-3 py-2 text-sm font-semibold"><Printer className="mr-1 inline h-4 w-4" /> Print</button>}
                {isAdminRole(currentRole) && selected.status === 'posted' && <button type="button" onClick={() => void voidPurchase(selected)} className="rounded-control border border-red-200 px-3 py-2 text-sm font-semibold text-danger">Void purchase</button>}
                <button type="button" aria-label="Close purchase details" onClick={() => setSelected(null)} className="rounded-control border border-border p-2"><X size={16} /></button>
              </div>
            </header>
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <p><strong>Supplier:</strong> {selected.supplier_name}<br />{selected.supplier_contact}<br />{selected.supplier_address}</p>
              <p><strong>Supplier invoice:</strong> {selected.invoice_number || '—'}<br /><strong>Payment:</strong> <span className="capitalize">{selected.payment_type}</span><br /><strong>Created by:</strong> {selected.created_by}</p>
            </div>
            <div className="overflow-x-auto rounded-control border border-border">
              <table className="w-full min-w-[900px] text-left text-xs">
                <thead className="bg-white text-muted"><tr>{['Product', 'Batch', 'Expiry', 'Qty', 'Bonus', ...(selected.total_paisa !== undefined ? ['Cost', 'MRP', 'Line Total'] : [])].map((label) => <th key={label} className="px-3 py-2">{label}</th>)}</tr></thead>
                <tbody className="divide-y divide-border">{selected.items.map((item, index) => <tr key={`${item.medicine_id}-${item.batch_number}-${index}`}>
                  <td className="px-3 py-2">{item.product_name}<small className="block text-muted">{item.generic_name} · {item.unit_name}</small></td><td className="px-3 py-2">{item.batch_number}</td><td className="px-3 py-2">{karachiDate(item.expiry_date)}</td><td className="px-3 py-2">{item.quantity}</td><td className="px-3 py-2">{item.bonus_qty}</td>{selected.total_paisa !== undefined && <><td className="px-3 py-2">{moneyIfKnown(item.unit_cost_paisa)}</td><td className="px-3 py-2">{moneyIfKnown(item.mrp_paisa)}</td><td className="px-3 py-2">{moneyIfKnown(item.line_total_paisa)}</td></>}
                </tr>)}</tbody>
              </table>
            </div>
            {selected.total_paisa !== undefined && <div className="space-y-1 text-right text-sm"><p>Subtotal: {moneyIfKnown(selected.subtotal_paisa)}</p><p>Discount: {moneyIfKnown(selected.discount_paisa)}</p><p className="text-lg font-black">Total: {money(selected.total_paisa)}</p><p>Paid: {moneyIfKnown(selected.paid_paisa)} · Due: {moneyIfKnown(selected.due_paisa)}</p></div>}
            <p className="text-sm"><strong>Notes:</strong> {selected.notes || '—'}</p>
            {selected.void_reason && <p className="text-sm text-danger"><strong>Void reason:</strong> {selected.void_reason}</p>}
          </>}
        </section>
      </div>}
    </section>
  );
}

function SummaryCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <section className="rounded-card border border-border bg-white p-4 shadow-sm"><p className="text-[10px] font-bold tracking-wide text-muted">{label}</p><p className="mt-1 text-lg font-black text-text">{value}</p>{detail && <p className="mt-1 text-xs text-muted">{detail}</p>}</section>;
}
