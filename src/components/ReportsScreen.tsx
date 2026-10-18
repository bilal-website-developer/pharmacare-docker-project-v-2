import React from 'react';
import { EyeOff, ShoppingBag } from 'lucide-react';
import { CompletedSale, UserRole } from '../types/pharmacy';
import { formatPaisa } from '../data/businessReports';
import type { SalesReportSummary } from '../data/businessReports';

interface ReportsScreenProps {
  sales: CompletedSale[];
  currentRole: UserRole;
  apiMode?: boolean;
  businessReport?: SalesReportSummary | null;
  totalOrders?: number;
}

export const ReportsScreen: React.FC<ReportsScreenProps> = ({
  sales,
  currentRole,
  apiMode = false,
  businessReport,
  totalOrders,
}) => {
  const canSeeProfit = currentRole === UserRole.ADMIN || currentRole === UserRole.ACCOUNTANT;

  const postedSales = sales.filter((sale) => sale.status !== 'VOID');
  const totalRevenuePaisa = postedSales.reduce((sum, s) => sum + s.totalPaisa, 0);
  const hasCompleteSaleCosts = postedSales.every((sale) =>
    sale.items.every((item) => item.costPaisaPerUnit !== null)
  );
  const totalCostPaisa = canSeeProfit && hasCompleteSaleCosts
    ? postedSales.reduce((sum, sale) =>
        sum + sale.items.reduce(
          (itemSum, item) => itemSum + (item.costPaisaPerUnit ?? 0) * item.quantityInUnit,
          0,
        ), 0)
    : null;

  const grossProfitPaisa = totalCostPaisa === null ? null : totalRevenuePaisa - totalCostPaisa;
  const grossMarginPercent = grossProfitPaisa === null
    ? null
    : totalRevenuePaisa > 0
      ? ((grossProfitPaisa / totalRevenuePaisa) * 100).toFixed(1)
      : '0.0';
  const isCashier = currentRole === UserRole.CASHIER;

  return (
    <div className="space-y-6">
      {/* ── Cashier Security Notice if Cashier ──────────────────────────────── */}
      {isCashier && (
        <div className="bg-amber-50 border border-amber-200 p-4 rounded-xl text-amber-900 text-xs flex items-center gap-3">
          <EyeOff className="w-5 h-5 text-amber-600 shrink-0" />
          <div>
            <span className="font-bold">Strict Role-Based Access Control (RBAC):</span>
            <p className="mt-0.5">
              Cost and profit reporting is restricted for this role. Only gross revenue and transaction counters are displayed.
            </p>
          </div>
        </div>
      )}

      {/* ── KPI Cards ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="report-stat-card bg-white p-5 rounded-xl border border-emerald-200 shadow-xs">
          <span className="text-xs font-semibold text-emerald-700">Gross Sales Revenue</span>
          <div className="report-stat-value text-2xl font-bold font-mono text-emerald-950 mt-1">
            {businessReport
              ? formatPaisa(businessReport.grossSalesPaisa)
              : apiMode ? 'Unavailable' : `Rs ${(totalRevenuePaisa / 100).toFixed(2)}`}
          </div>
          <span className="text-[11px] text-emerald-600">
            {businessReport
              ? `Returns: ${formatPaisa(businessReport.returnsPaisa)} · Net: ${formatPaisa(businessReport.netSalesPaisa)}`
              : apiMode ? 'Report data is unavailable.' : 'Total processed counter sales'}
          </span>
        </div>

        <div className="report-stat-card bg-white p-5 rounded-xl border border-emerald-200 shadow-xs">
          <span className="text-xs font-semibold text-emerald-700">Invoices Processed</span>
          <div className="report-stat-value text-2xl font-bold font-mono text-emerald-950 mt-1">
            {businessReport?.saleCount ?? (apiMode ? '—' : postedSales.length)}
          </div>
          <span className="text-[11px] text-emerald-600">Sequential receipt numbers</span>
        </div>

        {canSeeProfit ? (
          <>
            <div className="report-stat-card bg-white p-5 rounded-xl border border-emerald-200 shadow-xs">
              <span className="text-xs font-semibold text-emerald-700">Gross Profit (Paisa)</span>
              <div className="report-stat-value text-2xl font-bold font-mono text-emerald-700 mt-1">
                {grossProfitPaisa === null ? 'Unavailable' : `Rs ${(grossProfitPaisa / 100).toFixed(2)}`}
              </div>
              <span className="text-[11px] text-emerald-600">Revenue minus COGS</span>
            </div>

            <div className="report-stat-card bg-white p-5 rounded-xl border border-emerald-200 shadow-xs">
              <span className="text-xs font-semibold text-emerald-700">Gross Margin %</span>
              <div className="report-stat-value text-2xl font-bold font-mono text-emerald-800 mt-1">
                {grossMarginPercent === null ? 'Unavailable' : `${grossMarginPercent}%`}
              </div>
              <span className="text-[11px] text-emerald-600">Profit percentage</span>
            </div>
          </>
        ) : (
          <div className="sm:col-span-2 bg-slate-50 p-5 rounded-xl border border-dashed border-slate-300 flex items-center justify-center text-xs text-slate-500 gap-2">
            <EyeOff className="w-4 h-4" /> Financial reporting is restricted for this role.
          </div>
        )}
      </div>

      {/* ── Completed Sales Table ──────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-emerald-200 overflow-hidden shadow-xs">
        <div className="p-4 border-b border-emerald-100 flex items-center justify-between">
          <h3 className="font-bold text-sm text-emerald-950 flex items-center gap-2">
            <ShoppingBag className="w-4 h-4 text-emerald-700" /> Recent Sales History
          </h3>
          <span className="text-xs text-emerald-700">{totalOrders ?? (apiMode ? '—' : sales.length)} total orders</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-emerald-50 text-emerald-950 font-semibold border-b border-emerald-200">
              <tr>
                <th className="py-2.5 px-3">Invoice #</th>
                <th className="py-2.5 px-3">Time</th>
                <th className="py-2.5 px-3">Customer</th>
                <th className="py-2.5 px-3">Cashier</th>
                <th className="py-2.5 px-3">Items</th>
                <th className="py-2.5 px-3">Method</th>
                <th className="py-2.5 px-3 text-right">Total (PKR)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-emerald-100 text-emerald-950">
              {sales.map((sale) => (
                <tr key={sale.id} className="sales-history-row hover:bg-emerald-50/30">
                  <td className="py-2.5 px-3 font-mono font-bold text-emerald-800">
                    {sale.invoiceNumber}
                    {sale.status === 'VOID' && (
                      <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 font-sans text-[9px] font-bold text-red-700">VOID</span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-slate-600 text-[11px]">{sale.timestamp}</td>
                  <td className="py-2.5 px-3 font-medium">{sale.customerName}</td>
                  <td className="py-2.5 px-3 text-slate-700">{sale.cashierName}</td>
                  <td className="py-2.5 px-3">
                    {sale.items.map((i) => `${i.productName} (x${i.quantityInUnit})`).join(', ')}
                  </td>
                  <td className="py-2.5 px-3">
                    <span className="sales-method-badge px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded font-semibold text-[10px]">
                      {sale.paymentMethod}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono font-bold text-emerald-900">
                    Rs {(sale.totalPaisa / 100).toFixed(2)}
                  </td>
                </tr>
              ))}
              {sales.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-xs text-slate-400">
                    No sales recorded yet. Process an order on the POS counter to populate this report.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
