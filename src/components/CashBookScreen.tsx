import React, { useState, useMemo } from 'react';
import {
  Wallet,
  ArrowDownLeft,
  ArrowUpRight,
  Plus,
  CheckCircle2,
  Lock,
} from 'lucide-react';
import { CashTransaction } from '../types/pharmacy';
import { parsePaisaInput } from '../data/finance';

interface CashBookScreenProps {
  transactions: CashTransaction[];
  onAddTransaction: (tx: CashTransaction) => void | Promise<void>;
}

export const CashBookScreen: React.FC<CashBookScreenProps> = ({
  transactions,
  onAddTransaction,
}) => {
  const [showExpenseModal, setShowExpenseModal] = useState(false);
  const [expenseDesc, setExpenseDesc] = useState('');
  const [expenseAmountPKR, setExpenseAmountPKR] = useState('');
  const [expenseError, setExpenseError] = useState('');

  // Shift closing drawer count
  const [actualDrawerCashPKR, setActualDrawerCashPKR] = useState('');
  const [shiftClosed, setShiftClosed] = useState(false);

  const totalInflowsPaisa = useMemo(() => {
    return transactions
      .filter((t) => !t.isOutflow)
      .reduce((sum, t) => sum + t.amountPaisa, 0);
  }, [transactions]);

  const totalOutflowsPaisa = useMemo(() => {
    return transactions
      .filter((t) => t.isOutflow)
      .reduce((sum, t) => sum + t.amountPaisa, 0);
  }, [transactions]);

  const expectedDrawerPaisa = totalInflowsPaisa - totalOutflowsPaisa;
  const actualDrawerPaisa = parsePaisaInput(actualDrawerCashPKR) ?? 0;
  const discrepancyPaisa = actualDrawerPaisa - expectedDrawerPaisa;

  const handleCreateExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountPaisa = parsePaisaInput(expenseAmountPKR);
    if (!expenseDesc.trim() || amountPaisa === null || amountPaisa <= 0) {
      setExpenseError('Enter a description and a positive amount with up to two decimal places.');
      return;
    }

    const newTx: CashTransaction = {
      id: `tx-${Date.now()}`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      type: 'EXPENSE',
      description: expenseDesc.trim(),
      amountPaisa,
      isOutflow: true,
      handledBy: 'Active Cashier',
    };

    setExpenseError('');
    try {
      await onAddTransaction(newTx);
      setShowExpenseModal(false);
      setExpenseDesc('');
      setExpenseAmountPKR('');
    } catch (error) {
      setExpenseError(error instanceof Error ? error.message : 'Could not record this expense.');
    }
  };

  return (
    <div className="space-y-6">
      {/* ── Summary Stats ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="report-stat-card bg-white p-5 rounded-xl border border-emerald-200 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-emerald-800">Total Cash Inflow</span>
            <div className="p-2 bg-emerald-100 text-emerald-800 rounded-lg">
              <ArrowDownLeft className="w-4 h-4" />
            </div>
          </div>
          <div className="report-stat-value text-2xl font-bold font-mono text-emerald-950 mt-2">
            Rs {(totalInflowsPaisa / 100).toFixed(2)}
          </div>
          <p className="text-[11px] text-emerald-600 mt-1">Includes Opening Float & Sales</p>
        </div>

        <div className="report-stat-card bg-white p-5 rounded-xl border border-emerald-200 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-red-800">Total Cash Expenses</span>
            <div className="p-2 bg-red-100 text-red-800 rounded-lg">
              <ArrowUpRight className="w-4 h-4" />
            </div>
          </div>
          <div className="report-stat-value text-2xl font-bold font-mono text-red-600 mt-2">
            Rs {(totalOutflowsPaisa / 100).toFixed(2)}
          </div>
          <p className="text-[11px] text-red-500 mt-1">Petty cash & operational vouchers</p>
        </div>

        <div className="report-stat-card bg-white p-5 rounded-xl border border-emerald-200 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-emerald-900">Expected In Drawer</span>
            <div className="p-2 bg-emerald-700 text-white rounded-lg">
              <Wallet className="w-4 h-4" />
            </div>
          </div>
          <div className="report-stat-value text-2xl font-bold font-mono text-emerald-800 mt-2">
            Rs {(expectedDrawerPaisa / 100).toFixed(2)}
          </div>
          <p className="text-[11px] text-emerald-600 mt-1">Paisa calculated balance</p>
        </div>
      </div>

      {/* ── Main Split: Transactions List & Shift Closing ──────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left 8 Cols: Transaction Log */}
        <div className="lg:col-span-8 bg-white p-5 rounded-xl border border-emerald-200 shadow-xs space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-emerald-100">
            <h3 className="text-base font-bold text-emerald-950 flex items-center gap-2">
              <Wallet className="w-5 h-5 text-emerald-700" /> Cash Book Entries (Today)
            </h3>
            <button
              onClick={() => setShowExpenseModal(true)}
              className="px-3.5 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg flex items-center gap-1 transition"
            >
              <Plus className="w-3.5 h-3.5" /> Record Expense
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-emerald-50 text-emerald-950 font-semibold border-b border-emerald-200">
                <tr>
                  <th className="py-2.5 px-3">Time</th>
                  <th className="py-2.5 px-3">Type</th>
                  <th className="py-2.5 px-3">Description</th>
                  <th className="py-2.5 px-3">Handled By</th>
                  <th className="py-2.5 px-3 text-right">Amount (PKR)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-emerald-100 text-emerald-950">
                {transactions.map((t) => (
                  <tr key={t.id} className="supplier-table-row hover:bg-emerald-50/40">
                    <td className="py-2.5 px-3 font-mono text-[11px] text-emerald-800">{t.time}</td>
                    <td className="py-2.5 px-3">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          t.isOutflow ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'
                        }`}
                      >
                        {t.type}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-slate-800">{t.description}</td>
                    <td className="py-2.5 px-3 text-slate-600">{t.handledBy}</td>
                    <td
                      className={`py-2.5 px-3 text-right font-mono font-bold ${
                        t.isOutflow ? 'text-red-600' : 'text-emerald-700'
                      }`}
                    >
                      {t.isOutflow ? '-' : '+'} Rs {(t.amountPaisa / 100).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right 4 Cols: Shift Closing Drawer Count */}
        <div className="lg:col-span-4 bg-white p-5 rounded-xl border border-emerald-200 shadow-xs space-y-4">
          <div className="pb-3 border-b border-emerald-100">
            <h3 className="text-base font-bold text-emerald-950 flex items-center gap-2">
              <Lock className="w-5 h-5 text-emerald-700" /> Shift Closing Reconciliation
            </h3>
            <p className="text-xs text-emerald-700/80 mt-1">
              Count cash physical notes at end of shift to detect discrepancies.
            </p>
          </div>

          <div className="space-y-3 text-xs">
            <div>
              <label className="block font-semibold text-emerald-900 mb-1">
                Physical Cash in Drawer (PKR):
              </label>
              <input
                type="number"
                placeholder="Count physical notes"
                value={actualDrawerCashPKR}
                onChange={(e) => setActualDrawerCashPKR(e.target.value)}
                className="w-full px-3 py-2 border border-emerald-300 rounded-lg text-base font-mono font-bold"
                disabled={shiftClosed}
              />
            </div>

            <div className="p-3 bg-emerald-50 rounded-lg border border-emerald-200 space-y-1.5 text-xs font-mono">
              <div className="flex justify-between text-emerald-900">
                <span>System Expected:</span>
                <span>Rs {(expectedDrawerPaisa / 100).toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-emerald-900 font-bold">
                <span>Physical Count:</span>
                <span>Rs {(actualDrawerPaisa / 100).toFixed(2)}</span>
              </div>
              <div className="border-t border-emerald-200 pt-1.5 flex justify-between font-bold">
                <span>Discrepancy:</span>
                <span
                  className={
                    discrepancyPaisa === 0
                      ? 'text-emerald-700'
                      : discrepancyPaisa > 0
                      ? 'text-blue-600'
                      : 'text-red-600'
                  }
                >
                  {discrepancyPaisa > 0 ? '+' : ''}
                  Rs {(discrepancyPaisa / 100).toFixed(2)}
                  {discrepancyPaisa < 0 && ' (SHORT)'}
                  {discrepancyPaisa > 0 && ' (OVER)'}
                </span>
              </div>
            </div>

            {shiftClosed ? (
              <div className="p-3 bg-emerald-100 text-emerald-900 rounded-lg text-xs font-semibold flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0" />
                Shift closed and reconciled successfully. Ledger locked.
              </div>
            ) : (
              <button
                onClick={() => setShiftClosed(true)}
                disabled={parsePaisaInput(actualDrawerCashPKR) === null || actualDrawerPaisa <= 0}
                className="w-full py-2.5 px-4 bg-emerald-700 hover:bg-emerald-800 text-white font-bold rounded-xl transition disabled:opacity-50"
              >
                Close Shift & Lock Register
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Record Expense Modal ──────────────────────────────────────────── */}
      {showExpenseModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateExpense}
            className="bg-white rounded-2xl max-w-sm w-full p-6 border border-emerald-200 shadow-xl space-y-4"
          >
            <h3 className="font-bold text-base text-red-950 flex items-center gap-2">
              <Plus className="w-5 h-5 text-red-700" /> Record Cash Expense Voucher
            </h3>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-800 mb-1">Expense Voucher Description *</label>
                <input
                  type="text"
                  placeholder="e.g. Electricity bill, cleaning supplies, tea"
                  value={expenseDesc}
                  onChange={(e) => setExpenseDesc(e.target.value)}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded-lg"
                  required
                  autoFocus
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-800 mb-1">Amount (PKR) *</label>
                <input
                  type="number"
                  placeholder="0"
                  value={expenseAmountPKR}
                  onChange={(e) => setExpenseAmountPKR(e.target.value)}
                  step="0.01"
                  className="w-full px-3 py-1.5 border border-slate-300 rounded-lg font-mono font-bold"
                  required
                />
              </div>
              {expenseError && <p role="alert" className="text-xs font-semibold text-red-700">{expenseError}</p>}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t">
              <button
                type="button"
                onClick={() => setShowExpenseModal(false)}
                className="px-3.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 text-xs font-bold text-white bg-red-600 hover:bg-red-700 rounded-lg"
              >
                Deduct from Cash Drawer
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
