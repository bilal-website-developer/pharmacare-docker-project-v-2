import React, { useState } from 'react';
import {
  Activity,
  ShoppingBag,
  TrendingUp,
  Calendar,
  Wallet,
  AlertTriangle,
  BadgeAlert,
  ShoppingCart,
  History,
  Boxes,
  Plus,
  ArrowRight,
  PackagePlus,
} from 'lucide-react';
import { BatchStatus, CompletedSale, Product, Customer, UserRole } from '../types/pharmacy';
import { salesForPeriod } from '../utils/salesReport';
import { formatPaisa } from '../data/businessReports';
import type { DashboardSummary } from '../data/businessReports';

interface DashboardViewProps {
  sales: CompletedSale[];
  products: Product[];
  customers: Customer[];
  currentRole: UserRole;
  currentUserName: string;
  apiMode: boolean;
  dashboardSummary?: DashboardSummary | null;
  onNavigate: (tab: any) => void;
  onOpenCloseDay: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  sales,
  products,
  customers,
  currentRole,
  currentUserName,
  apiMode,
  dashboardSummary,
  onNavigate,
  onOpenCloseDay,
}) => {
  const currentDate = new Date();
  const targetDateKey = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;
  const targetStorageKey = `pharma-care.salesTarget.${currentUserName}.${targetDateKey}`;
  const [salesTarget, setSalesTarget] = useState<number | null>(() => {
    try {
      const target = Number(localStorage.getItem(targetStorageKey));
      return Number.isFinite(target) && target > 0 ? target : null;
    } catch {
      return null;
    }
  });
  const [showTargetModal, setShowTargetModal] = useState(false);
  const [targetInput, setTargetInput] = useState('');
  const [targetError, setTargetError] = useState('');

  const canCloseDay = currentRole === UserRole.ADMIN || currentRole === UserRole.MANAGER;
  const canViewProfit = currentRole === UserRole.ADMIN || currentRole === UserRole.ACCOUNTANT;
  const todaySales = salesForPeriod(sales, 'today');
  const monthlySales = salesForPeriod(sales, 'month');

  const localTodaySalesPKR = todaySales.reduce((sum, s) => sum + s.totalPaisa, 0) / 100;
  const localCashSalesPKR =
    todaySales
      .filter((s) => s.paymentMethod === 'CASH')
      .reduce((sum, s) => sum + s.totalPaisa, 0) / 100;
  const localCreditSalesPKR =
    todaySales
      .filter((s) => s.paymentMethod === 'CREDIT')
      .reduce((sum, s) => sum + s.totalPaisa, 0) / 100;

  const localTodayProfitPKR = canViewProfit && todaySales.every((sale) =>
    sale.items.every((item) => item.costPaisaPerUnit !== null)
  )
    ? todaySales.reduce(
        (sum, sale) =>
          sum +
          sale.totalPaisa -
          sale.items.reduce(
            (itemSum, item) => itemSum + (item.costPaisaPerUnit ?? 0) * item.quantityInUnit,
            0
          ),
        0
      ) / 100
    : null;

  const localTotalReceivablesPKR =
    customers.reduce((sum, c) => sum + c.currentBalancePaisa, 0) / 100;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const localNearExpiryCount = products.reduce(
    (sum, product) =>
      sum +
      product.batches.filter((batch) => {
        const expiry = new Date(batch.expiryDate);
        expiry.setHours(0, 0, 0, 0);
        const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / 86400000);
        return batch.quantitySmallestUnit > 0 &&
          batch.status !== BatchStatus.EXPIRED &&
          daysLeft >= 0 &&
          daysLeft <= 30;
      }).length,
    0
  );
  const localExpiredCount = products.reduce(
    (sum, product) =>
      sum +
      product.batches.filter((batch) => {
        const expiry = new Date(batch.expiryDate);
        expiry.setHours(0, 0, 0, 0);
        return batch.quantitySmallestUnit > 0 &&
          (batch.status === BatchStatus.EXPIRED || expiry < today);
      }).length,
    0
  );

  const localLowStockCount = products.filter((p) => {
    const totalQty = p.batches.reduce((sum, b) => sum + b.quantitySmallestUnit, 0);
    return totalQty <= p.minStockAlert;
  }).length;
  const todaySalesPKR = apiMode
    ? toRupees(dashboardSummary?.todaySalesPaisa)
    : localTodaySalesPKR;
  const monthlySalesPKR = apiMode
    ? toRupees(dashboardSummary?.monthNetSalesPaisa)
    : monthlySales.reduce((sum, sale) => sum + sale.totalPaisa, 0) / 100;
  const todayProfitPKR = apiMode ? null : localTodayProfitPKR;
  const cashSalesPKR = apiMode
    ? toRupees(dashboardSummary?.cashSalesPaisa)
    : localCashSalesPKR;
  const creditSalesPKR = apiMode
    ? toRupees(dashboardSummary?.creditSalesPaisa)
    : localCreditSalesPKR;
  const totalReceivablesPKR = apiMode
    ? toRupees(dashboardSummary?.receivablesPaisa)
    : localTotalReceivablesPKR;
  const nearExpiryCount = apiMode ? dashboardSummary?.nearExpiryBatches ?? null : localNearExpiryCount;
  const expiredCount = apiMode ? dashboardSummary?.expiredBatches ?? null : localExpiredCount;
  const lowStockCount = apiMode ? dashboardSummary?.lowStockMedicines ?? null : localLowStockCount;
  const invoiceCount = apiMode ? dashboardSummary?.saleCount ?? null : todaySales.length;
  const targetProgress = salesTarget !== null && todaySalesPKR !== null
    ? Math.min(100, Math.round((todaySalesPKR / salesTarget) * 100))
    : null;

  function toRupees(paisa?: string): number | null {
    if (paisa === undefined) return null;
    const amount = Number(BigInt(paisa)) / 100;
    return Number.isSafeInteger(Number(BigInt(paisa))) ? amount : null;
  }

  function currencyLabel(paisa: string | undefined, value: number | null): string {
    return apiMode
      ? paisa === undefined ? 'Unavailable' : formatPaisa(paisa)
      : value === null ? 'Unavailable' : `Rs. ${value.toFixed(0)}`;
  }

  return (
    <div className="space-y-6">
      {/* ── Greeting Banner ──────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black text-slate-900 tracking-tight flex items-center gap-2">
            Assalam-o-Alaikum, {currentUserName.split(' ')[0]}!
          </h1>
          <p className="text-xs text-slate-500 font-medium mt-0.5">Today's Summary</p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          {canCloseDay && (
            <button
              onClick={onOpenCloseDay}
              className="px-4 py-2 bg-primary hover:opacity-90 text-white font-bold text-xs rounded-xl shadow-md flex items-center gap-2 transition"
            >
              <span>Close Day</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* ── Dashboard metrics ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3.5 md:grid-cols-4 xl:grid-cols-7">
        {/* 1. Today's Sales */}
        <div className="flex flex-col justify-between rounded-card border border-border bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/10 text-emerald-600 flex items-center justify-center">
              <ShoppingBag className="w-4 h-4" />
            </div>
            <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
              Today
            </span>
          </div>
          <div className="mt-3">
            <span className="text-[11px] font-medium text-slate-500 block">Today's Sales (Rs)</span>
            <span className="text-xl font-black text-slate-900 font-mono tracking-tight">
              {currencyLabel(dashboardSummary?.todaySalesPaisa, todaySalesPKR)}
            </span>
          </div>
        </div>

        {/* 2. Today's Profit (Gross) */}
        <div className="flex flex-col justify-between rounded-card border border-border bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <div className="w-8 h-8 rounded-xl bg-teal-500/10 text-teal-600 flex items-center justify-center">
              <TrendingUp className="w-4 h-4" />
            </div>
            <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded bg-teal-50 text-teal-700 border border-teal-200">
              Gross
            </span>
          </div>
          <div className="mt-3">
            <span className="text-[11px] font-medium text-slate-500 block">
              {canViewProfit ? "Today's Profit (Rs)" : "Today's Invoices"}
            </span>
            {canViewProfit ? (
              <span className="text-xl font-black text-slate-900 font-mono tracking-tight">
                {todayProfitPKR === null ? 'Unavailable' : `Rs. ${todayProfitPKR.toFixed(0)}`}
              </span>
            ) : (
              <span className="text-sm font-bold text-slate-700 flex items-center gap-1">
                <Activity className="w-3.5 h-3.5" /> {invoiceCount ?? '—'} invoices
              </span>
            )}
          </div>
        </div>

        {/* 3. Monthly Sales */}
        <div className="flex flex-col justify-between rounded-card border border-border bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <div className="w-8 h-8 rounded-xl bg-blue-500/10 text-blue-600 flex items-center justify-center">
              <Calendar className="w-4 h-4" />
            </div>
            <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
              This Month
            </span>
          </div>
          <div className="mt-3">
            <span className="text-[11px] font-medium text-slate-500 block">Monthly Sales (Rs)</span>
            <span className="text-xl font-black text-slate-900 font-mono tracking-tight">
              {currencyLabel(dashboardSummary?.monthNetSalesPaisa, monthlySalesPKR)}
            </span>
          </div>
        </div>

        {/* Near-expiry and expired stock alerts */}
        <div className="bg-white p-4 rounded-2xl border border-border shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <div className="w-8 h-8 rounded-xl bg-warning/10 text-warning flex items-center justify-center">
              <BadgeAlert className="w-4 h-4" />
            </div>
            <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded bg-warning/10 text-text border border-warning/30">
              Watch
            </span>
          </div>
          <div className="mt-3">
            <span className="text-[11px] font-medium text-muted block">Near-Expiry Batches</span>
            <span className="text-xl font-black text-text font-mono">{nearExpiryCount ?? '—'}</span>
          </div>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-border shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <div className="w-8 h-8 rounded-xl bg-danger/10 text-danger flex items-center justify-center">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded bg-danger/10 text-danger border border-danger/20">
              Alert
            </span>
          </div>
          <div className="mt-3">
            <span className="text-[11px] font-medium text-muted block">Expired Batches</span>
            <span className="text-xl font-black text-danger font-mono">{expiredCount ?? '—'}</span>
          </div>
        </div>

        {/* 4. Total Receivables */}
        <div className="flex flex-col justify-between rounded-card border border-border bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <div className="flex h-8 w-8 items-center justify-center rounded-control bg-warning/10 text-warning">
              <Wallet className="w-4 h-4" />
            </div>
            <span className="rounded border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-text">
              Pending
            </span>
          </div>
          <div className="mt-3">
            <span className="block text-[11px] font-medium text-muted">
              Total Receivables (Rs)
            </span>
            <span className="font-mono text-xl font-black tracking-tight text-text">
              {currencyLabel(dashboardSummary?.receivablesPaisa, totalReceivablesPKR)}
            </span>
          </div>
        </div>

        {/* 5. Low Stock Products */}
        <div className="flex flex-col justify-between rounded-card border border-border bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between">
            <div className="flex h-8 w-8 items-center justify-center rounded-control bg-danger/10 text-danger">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <span className="rounded border border-danger/20 bg-danger/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-danger">
              Alert
            </span>
          </div>
          <div className="mt-3">
            <span className="block text-[11px] font-medium text-muted">Low Stock Products</span>
            <span
              className={`text-xl font-black font-mono tracking-tight ${
                lowStockCount !== null && lowStockCount > 0 ? 'text-danger' : 'text-text'
              }`}
            >
              {lowStockCount ?? '—'}
            </span>
          </div>
        </div>
      </div>

      {/* ── Cash Sales vs Credit Split Bar (Matching Screenshot 1) ─────────── */}
      <div className="flex flex-col gap-3 rounded-card border border-border bg-white p-4 text-xs shadow-xs sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-xs bg-primary" />
          <span className="font-semibold text-muted">Cash Sales</span>
          <span className="font-mono font-bold text-text">
            {currencyLabel(dashboardSummary?.cashSalesPaisa, cashSalesPKR)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-xs bg-warning" />
          <span className="font-semibold text-muted">Credit</span>
          <span className="font-mono font-bold text-text">
            {currencyLabel(dashboardSummary?.creditSalesPaisa, creditSalesPKR)}
          </span>
        </div>
      </div>

      {/* ── Daily Sales Target Widget (Matching Screenshot 1) ───────────────── */}
      <div className="flex flex-col gap-3 rounded-card border border-border bg-white p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <Activity className="h-4 w-4 shrink-0 text-primary" />
            <span className="font-bold text-text">Daily Sales Target</span>
            <span className="text-[11px] text-muted">
              {salesTarget
                ? targetProgress === null || todaySalesPKR === null
                  ? `Target: Rs ${salesTarget.toLocaleString('en-PK')} · Sales total unavailable`
                  : `Target: Rs ${salesTarget.toLocaleString('en-PK')} · Achieved: Rs ${todaySalesPKR.toLocaleString('en-PK')} (${targetProgress}%)`
                : 'No target set. Set a daily goal to track progress.'}
            </span>
          </div>
          {salesTarget && targetProgress !== null && (
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-surface"
              role="progressbar"
              aria-label="Daily sales target progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={targetProgress}
            >
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${targetProgress}%` }}
              />
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            setTargetInput(salesTarget ? String(salesTarget) : '');
            setTargetError('');
            setShowTargetModal(true);
          }}
          className="flex shrink-0 items-center gap-1 self-start text-xs font-bold text-primary hover:opacity-80 sm:self-auto"
        >
          <Plus className="w-3.5 h-3.5" /> Set Target
        </button>
      </div>

      {/* ── Quick Actions Grid (Matching Screenshot 2) ─────────────────────── */}
      <div className="space-y-3">
        <h3 className="text-xs font-black text-slate-500 tracking-wider uppercase">
          Quick Actions
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
          {/* New Sale Button (Vibrant Blue) */}
          <button
            type="button"
            onClick={() => onNavigate('pos')}
            className="group flex flex-col items-center justify-center gap-2 rounded-card bg-primary p-5 text-white shadow-md transition hover:opacity-90"
          >
            <ShoppingCart className="w-6 h-6 group-hover:scale-110 transition-transform" />
            <span className="text-sm font-bold">New Sale</span>
          </button>

          {/* Add Medicine */}
          <button
            type="button"
            onClick={() => onNavigate('products')}
            className="group flex flex-col items-center justify-center gap-2 rounded-card border border-border bg-white p-5 text-text shadow-xs transition hover:bg-surface"
          >
            <PackagePlus className="w-6 h-6 text-primary group-hover:scale-110 transition-transform" />
            <span className="text-sm font-bold">Add Medicine</span>
          </button>

          {/* Sales History */}
          <button
            type="button"
            onClick={() => onNavigate('sales-history')}
            className="group flex flex-col items-center justify-center gap-2 rounded-card border border-border bg-white p-5 text-text shadow-xs transition hover:bg-surface"
          >
            <History className="w-6 h-6 text-slate-600 group-hover:scale-110 transition-transform" />
            <span className="text-sm font-bold">Sales History</span>
          </button>

          {/* Inventory */}
          <button
            type="button"
            onClick={() => onNavigate('stock-inventory')}
            className="group flex flex-col items-center justify-center gap-2 rounded-card border border-border bg-white p-5 text-text shadow-xs transition hover:bg-surface"
          >
            <Boxes className="w-6 h-6 text-primary group-hover:scale-110 transition-transform" />
            <span className="text-sm font-bold">Inventory</span>
          </button>
        </div>
      </div>

      {/* Target Modal */}
      {showTargetModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="visual-modal-panel w-full max-w-xs space-y-3 rounded-card border border-border bg-white p-5">
            <h4 className="text-sm font-bold text-text">Set Daily Sales Target</h4>
            <input
              type="number"
              placeholder="e.g. 50000"
              value={targetInput}
              onChange={(e) => setTargetInput(e.target.value)}
              className="w-full rounded-control border border-border bg-surface px-3 py-2 font-mono text-sm text-text"
              autoFocus
              aria-invalid={Boolean(targetError)}
            />
            {targetError && <p role="alert" className="text-xs text-danger">{targetError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowTargetModal(false)}
                className="rounded-control px-3 py-1.5 text-xs text-muted hover:bg-surface"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = Number(targetInput);
                  if (!Number.isFinite(target) || target <= 0) {
                    setTargetError('Enter a sales target greater than zero.');
                    return;
                  }
                  try {
                    localStorage.setItem(targetStorageKey, String(target));
                    setSalesTarget(target);
                    setTargetError('');
                  } catch {
                    setTargetError('Could not save the target in this browser.');
                    return;
                  }
                  setShowTargetModal(false);
                }}
                className="rounded-control bg-primary px-3.5 py-1.5 text-xs font-bold text-white hover:opacity-90"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
