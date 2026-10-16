import React, { useEffect, useMemo, useState } from 'react';
import { Check, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { getBackend } from '../../api';
import {
  approveSaleReturn,
  getReturnPolicySettings,
  loadPendingSaleReturns,
  loadSaleForReturn,
  processSaleReturn,
  rejectSaleReturn,
  requestSaleReturn,
  type PendingSaleReturn,
  type ReturnPolicySettings,
  type SaleForReturn,
  type SaleReturnDecision,
  type SaleReturnRequestItem,
} from '../../data/saleReturns';
import { getRestockEligibilityReason, type ReturnDisposition } from '../../data/returnLogic';
import { STOCK_CHANGED_EVENT } from '../../utils/stockAlertsEvents';

interface SaleReturnsPanelProps {
  canReview: boolean;
  canRestock: boolean;
}

interface DecisionDraft {
  disposition: ReturnDisposition;
  sealedIntact: boolean;
  restockUnitId: string;
  reason: string;
}

function formatMoney(paisa: number): string {
  return `Rs ${(paisa / 100).toLocaleString('en-PK', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function defaultDecision(reason: string): DecisionDraft {
  return { disposition: 'QUARANTINE', sealedIntact: false, restockUnitId: '', reason };
}

export const SaleReturnsPanel: React.FC<SaleReturnsPanelProps> = ({ canReview, canRestock }) => {
  const [open, setOpen] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [sale, setSale] = useState<SaleForReturn | null>(null);
  const [returnReason, setReturnReason] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<PendingSaleReturn[]>([]);
  const [decisions, setDecisions] = useState<Record<string, DecisionDraft>>({});
  const [policy, setPolicy] = useState<ReturnPolicySettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const requestedItems = useMemo<SaleReturnRequestItem[]>(() => {
    if (!sale) return [];
    return sale.items.flatMap((item) => item.allocations.flatMap((allocation) => {
      const quantity = Number(quantities[allocation.allocationId] ?? '');
      const remaining = Math.max(0, allocation.quantityBaseUnits - allocation.alreadyReturnedBaseUnits);
      if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > remaining) return [];
      return [{
        saleItemId: item.saleItemId,
        allocationId: allocation.allocationId,
        quantityBaseUnits: quantity,
      }];
    }));
  }, [quantities, sale]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setBusy(true);
    setError('');
    void Promise.all([
      getReturnPolicySettings(),
      canReview ? loadPendingSaleReturns() : Promise.resolve([]),
    ]).then(([nextPolicy, nextPending]) => {
      if (!active) return;
      setPolicy(nextPolicy);
      setPending(nextPending);
      setDecisions(Object.fromEntries(nextPending.flatMap((request) => request.items.map((item) => [
        item.id,
        decisions[item.id] ?? defaultDecision(request.reason),
      ]))));
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load return information.');
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => {
      active = false;
    };
  }, [canReview, open]);

  const refreshPending = async () => {
    setBusy(true);
    setError('');
    try {
      const [nextPolicy, nextPending] = await Promise.all([
        getReturnPolicySettings(),
        canReview ? loadPendingSaleReturns() : Promise.resolve([]),
      ]);
      setPolicy(nextPolicy);
      setPending(nextPending);
      setDecisions((current) => Object.fromEntries(nextPending.flatMap((request) => request.items.map((item) => [
        item.id,
        current[item.id] ?? defaultDecision(request.reason),
      ]))));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Could not refresh return information.');
    } finally {
      setBusy(false);
    }
  };

  const findSale = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    setSale(null);
    setQuantities({});
    try {
      setSale(await loadSaleForReturn(invoiceNumber.trim()));
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : 'Could not find the sale.');
    } finally {
      setBusy(false);
    }
  };

  const submitRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!sale || !returnReason.trim() || requestedItems.length === 0) {
      setError('Enter a reason and a valid quantity for at least one sold batch.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await requestSaleReturn(sale.id, returnReason.trim(), requestedItems);
      setNotice(`Return request ${result.id} was submitted for ${result.invoiceNumber}.`);
      setSale(null);
      setInvoiceNumber('');
      setReturnReason('');
      setQuantities({});
      if (canReview) await refreshPending();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not submit the return request.');
    } finally {
      setBusy(false);
    }
  };

  const decisionValidation = (request: PendingSaleReturn, itemId: string, itemIndex: number): string | null => {
    const item = request.items[itemIndex];
    const draft = decisions[itemId] ?? defaultDecision(request.reason);
    if (draft.disposition !== 'RESTOCK') return null;
    if (!canRestock) return 'Stock Inventory permission is required for restocking.';
    if (!policy) return 'Return settings have not loaded.';
    const reason = getRestockEligibilityReason({
      sealedIntact: draft.sealedIntact,
      drugClass: item.drugClass,
      storageCondition: item.storageCondition,
      saleDate: request.saleDate,
      expiryDate: item.expiryDate,
      returnWindowDays: policy.returnWindowDays,
      minimumShelfLifeDays: policy.minimumRestockShelfLifeDays,
      today: policy.today ?? new Date().toISOString().slice(0, 10),
    });
    if (reason) return reason;
    if (!draft.restockUnitId) return 'Select the original sealed package type.';
    const unit = item.medicineUnits.find((candidate) => candidate.id === draft.restockUnitId);
    if (!unit || item.quantityBaseUnits % unit.conversionFactor !== 0) {
      return 'Returned quantity must be a whole number of configured packages.';
    }
    return null;
  };

  const processRequest = async (request: PendingSaleReturn) => {
    const requestDecisions: SaleReturnDecision[] = request.items.map((item) => {
      const draft = decisions[item.id] ?? defaultDecision(request.reason);
      return {
        id: item.id,
        disposition: draft.disposition,
        sealedIntact: draft.sealedIntact,
        restockUnitId: draft.restockUnitId || null,
        reason: draft.reason.trim(),
      };
    });
    const invalidReason = request.items
      .map((item, index) => decisionValidation(request, item.id, index))
      .find((reason) => reason !== null);
    if (invalidReason) {
      setError(invalidReason);
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const completed = await processSaleReturn(request.id, requestDecisions);
      setNotice(
        `Return completed for ${completed.invoiceNumber}. Refund: ${formatMoney(completed.refundTotalPaisa)} (${completed.refundMethod.toLowerCase()}).`,
      );
      window.dispatchEvent(new CustomEvent(STOCK_CHANGED_EVENT));
      await refreshPending();
    } catch (processError) {
      setError(processError instanceof Error ? processError.message : 'Could not process the return.');
    } finally {
      setBusy(false);
    }
  };

  const approveRequest = async (request: PendingSaleReturn) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await approveSaleReturn(request.id);
      setNotice(`Return request for ${request.invoiceNumber} was approved.`);
      await refreshPending();
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : 'Could not approve the return request.');
    } finally {
      setBusy(false);
    }
  };

  const rejectRequest = async (request: PendingSaleReturn) => {
    const reason = window.prompt('Enter a reason for rejecting this return request:');
    if (reason === null) return;
    if (!reason.trim()) {
      setError('A rejection reason is required.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await rejectSaleReturn(request.id, reason.trim());
      setNotice(`Return request for ${request.invoiceNumber} was rejected.`);
      await refreshPending();
    } catch (rejectError) {
      setError(rejectError instanceof Error ? rejectError.message : 'Could not reject the return request.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-control border border-border bg-surface px-3 py-2 text-sm font-semibold text-text hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Medicine returns
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="sale-returns-title"
            className="flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-card border border-border bg-surface shadow-xl sm:max-w-3xl sm:rounded-card"
          >
            <header className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h2 id="sale-returns-title" className="text-lg font-bold text-text">Medicine returns</h2>
                <p className="text-sm text-muted">Find a saved sale and record the returned quantities.</p>
              </div>
              <button type="button" aria-label="Close medicine returns" onClick={() => setOpen(false)} className="rounded-control p-2 text-muted hover:bg-surface-muted">
                <X size={18} />
              </button>
            </header>
            <div className="min-h-0 space-y-5 overflow-y-auto p-4">
              {error && <p role="alert" className="rounded-control border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-text">{error}</p>}
              {notice && <p role="status" className="rounded-control border border-success/40 bg-success/10 px-3 py-2 text-sm text-text">{notice}</p>}

              <form onSubmit={findSale} className="flex flex-col gap-2 sm:flex-row">
                <label className="sr-only" htmlFor="return-invoice-number">Invoice number</label>
                <input
                  id="return-invoice-number"
                  value={invoiceNumber}
                  onChange={(event) => setInvoiceNumber(event.target.value)}
                  placeholder="Invoice number (for example INV-...)"
                  className="min-w-0 flex-1 rounded-control border border-border bg-surface px-3 py-2 text-text"
                  required
                />
                <button disabled={busy} className="inline-flex items-center justify-center gap-2 rounded-control bg-primary px-4 py-2 font-semibold text-white disabled:opacity-60">
                  {busy && <LoaderCircle className="animate-spin" size={16} />} Find sale
                </button>
              </form>

              {sale && (
                <form onSubmit={submitRequest} className="space-y-3 rounded-card border border-border p-3">
                  <div className="flex flex-wrap justify-between gap-2">
                    <div>
                      <h3 className="font-bold text-text">{sale.invoiceNumber}</h3>
                      <p className="text-sm text-muted">{sale.customerName} · {new Date(sale.saleDate).toLocaleDateString()}</p>
                    </div>
                    <p className="text-sm font-semibold text-text">Original bill {formatMoney(sale.totalPaisa)}</p>
                  </div>
                  {sale.items.map((item) => (
                    <div key={item.saleItemId} className="space-y-2 rounded-control border border-border p-3">
                      <p className="font-semibold text-text">{item.productName} · {item.unitName}</p>
                      {item.allocations.map((allocation) => {
                        const available = Math.max(0, allocation.quantityBaseUnits - allocation.alreadyReturnedBaseUnits);
                        return (
                          <label key={allocation.allocationId} className="grid grid-cols-1 items-center gap-1 text-sm text-text sm:grid-cols-[1fr_8rem]">
                            <span>{allocation.batchNumber} · expires {allocation.expiryDate} · {available} smallest units available</span>
                            <input
                              type="number"
                              min={0}
                              max={available}
                              step={1}
                              value={quantities[allocation.allocationId] ?? ''}
                              onChange={(event) => setQuantities((current) => ({
                                ...current,
                                [allocation.allocationId]: event.target.value,
                              }))}
                              aria-label={`Quantity to return from batch ${allocation.batchNumber}`}
                              placeholder="Quantity"
                              className="w-full rounded-control border border-border bg-surface px-2 py-1.5 text-text"
                            />
                          </label>
                        );
                      })}
                    </div>
                  ))}
                  <label className="block text-sm font-medium text-text">
                    Reason for return
                    <textarea value={returnReason} onChange={(event) => setReturnReason(event.target.value)} required rows={2} className="mt-1 w-full rounded-control border border-border bg-surface px-3 py-2 text-text" />
                  </label>
                  <button disabled={busy || requestedItems.length === 0} className="w-full rounded-control bg-primary px-4 py-2 font-bold text-white disabled:opacity-60 sm:w-auto">
                    Submit return request
                  </button>
                </form>
              )}

              {canReview && (
                <section className="space-y-3 border-t border-border pt-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold text-text">Return requests ({pending.length})</h3>
                    <button type="button" onClick={() => void refreshPending()} disabled={busy} aria-label="Refresh pending returns" className="rounded-control p-2 text-muted hover:bg-surface-muted">
                      <RefreshCw size={16} />
                    </button>
                  </div>
                  {pending.length === 0 && <p className="text-sm text-muted">No return requests awaiting approval.</p>}
                  {pending.map((request) => (
                    <article key={request.id} className="space-y-3 rounded-card border border-border p-3">
                      <div className="flex flex-wrap justify-between gap-2">
                        <div>
                          <h4 className="font-bold text-text">{request.invoiceNumber}</h4>
                          <p className="text-sm text-muted">{request.customerName} · requested by {request.requestedBy}</p>
                          {request.status && <p className="text-xs font-semibold text-muted">{request.status}</p>}
                          <p className="text-sm text-text">{request.reason}</p>
                        </div>
                      </div>
                      {request.items.map((item, itemIndex) => {
                        const draft = decisions[item.id] ?? defaultDecision(request.reason);
                        const validation = decisionValidation(request, item.id, itemIndex);
                        return (
                          <div key={item.id} className="space-y-2 rounded-control bg-surface-muted p-3">
                            <p className="font-semibold text-text">{item.productName} · {item.quantityBaseUnits} smallest units · batch {item.batchNumber}</p>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                              <label className="text-sm text-text">
                                Disposition
                                <select
                                  value={draft.disposition}
                                  onChange={(event) => setDecisions((current) => ({
                                    ...current,
                                    [item.id]: { ...draft, disposition: event.target.value as ReturnDisposition },
                                  }))}
                                  className="mt-1 w-full rounded-control border border-border bg-surface px-2 py-2"
                                >
                                  <option value="QUARANTINE">Quarantine (not sellable)</option>
                                  <option value="WRITE_OFF">Write off</option>
                                  {canRestock && <option value="RESTOCK">Restock original batch</option>}
                                </select>
                              </label>
                              {draft.disposition === 'RESTOCK' && (
                                <label className="text-sm text-text">
                                  Restocked sealed package
                                  <select
                                    value={draft.restockUnitId}
                                    onChange={(event) => setDecisions((current) => ({
                                      ...current,
                                      [item.id]: { ...draft, restockUnitId: event.target.value },
                                    }))}
                                    className="mt-1 w-full rounded-control border border-border bg-surface px-2 py-2"
                                  >
                                    <option value="">Select package</option>
                                    {item.medicineUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name} ({unit.conversionFactor})</option>)}
                                  </select>
                                </label>
                              )}
                            </div>
                            {draft.disposition === 'RESTOCK' && (
                              <label className="flex items-center gap-2 text-sm text-text">
                                <input
                                  type="checkbox"
                                  checked={draft.sealedIntact}
                                  onChange={(event) => setDecisions((current) => ({
                                    ...current,
                                    [item.id]: { ...draft, sealedIntact: event.target.checked },
                                  }))}
                                />
                                Original pack is sealed and intact
                              </label>
                            )}
                            {draft.disposition === 'RESTOCK' && validation && <p className="text-sm text-warning">{validation}</p>}
                            <label className="block text-sm text-text">
                              Decision reason
                              <input
                                value={draft.reason}
                                onChange={(event) => setDecisions((current) => ({
                                  ...current,
                                  [item.id]: { ...draft, reason: event.target.value },
                                }))}
                                className="mt-1 w-full rounded-control border border-border bg-surface px-2 py-2"
                              />
                            </label>
                          </div>
                        );
                      })}
                      <div className="flex flex-wrap gap-2">
                        {getBackend() === 'api' && request.status === 'PENDING' ? (
                          <>
                            <button type="button" onClick={() => void approveRequest(request)} disabled={busy} className="inline-flex items-center gap-2 rounded-control bg-primary px-3 py-2 text-sm font-bold text-white disabled:opacity-60">
                              <Check size={15} /> Approve return
                            </button>
                            <button type="button" onClick={() => void rejectRequest(request)} disabled={busy} className="rounded-control border border-border px-3 py-2 text-sm font-semibold text-text hover:bg-surface-muted disabled:opacity-60">
                              Reject request
                            </button>
                          </>
                        ) : (
                          <>
                            <button type="button" onClick={() => void processRequest(request)} disabled={busy} className="inline-flex items-center gap-2 rounded-control bg-primary px-3 py-2 text-sm font-bold text-white disabled:opacity-60">
                              <Check size={15} /> Process return
                            </button>
                            {!(getBackend() === 'api' && request.status === 'APPROVED') && (
                              <button type="button" onClick={() => void rejectRequest(request)} disabled={busy} className="rounded-control border border-border px-3 py-2 text-sm font-semibold text-text hover:bg-surface-muted disabled:opacity-60">
                                Reject request
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </article>
                  ))}
                </section>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
};
