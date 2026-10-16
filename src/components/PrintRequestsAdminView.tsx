import { useCallback, useEffect, useMemo, useState } from 'react';
import { Minus, Pencil, Plus, Printer, RotateCcw, Trash2, X, XCircle } from 'lucide-react';
import { supabase } from '../utils/supabase';
import { getBackend } from '../api';
import { decidePrintRequest, loadAdminPrintRequests, modifyPrintRequest } from '../data/printRequests';
import { parsePaisaInput } from '../data/finance';
import { parsePrintSnapshot, PrintSnapshot } from '../utils/printSnapshot';
import { parsePrintRequestRecord, PrintRequestRecord } from '../utils/printRequestTypes';
import { PrintReceiptHandler } from '../utils/printWorkflow';
import { EditableReceiptLine, recalculateEditableReceipt } from '../utils/printRequestEditor';

function statusClass(status: PrintRequestRecord['status']) {
  if (status === 'approved') return 'bg-green-100 text-green-800';
  if (status === 'rejected') return 'bg-red-100 text-red-800';
  return 'bg-amber-100 text-amber-800';
}

export function PrintRequestsAdminView({ onPrintReceipt }: { onPrintReceipt: PrintReceiptHandler }) {
  const [requests, setRequests] = useState<PrintRequestRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [editingRequest, setEditingRequest] = useState<PrintRequestRecord | null>(null);
  const [draftLines, setDraftLines] = useState<EditableReceiptLine[]>([]);
  const [draftDiscount, setDraftDiscount] = useState('');
  const [newItemName, setNewItemName] = useState('');
  const [newItemPrice, setNewItemPrice] = useState('');
  const [editError, setEditError] = useState('');

  const refresh = useCallback(async () => {
    if (getBackend() === 'api') {
      try {
        setRequests(await loadAdminPrintRequests());
        setNotice(null);
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : 'Could not load print requests.', error: true });
      } finally {
        setLoading(false);
      }
      return;
    }
    if (!supabase) {
      setNotice({ text: 'Supabase is not configured.', error: true });
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from('print_requests')
      .select('id,type,receipt_ref,payload,requested_by,requested_at,status,decided_by,decided_at,note,printed_at')
      .order('requested_at', { ascending: false })
      .limit(200);
    if (error) {
      setNotice({ text: `Could not load print requests: ${error.message}`, error: true });
      setLoading(false);
      return;
    }
    try {
      if (!Array.isArray(data)) throw new Error('The print-request list response is invalid.');
      const parsed = data.map(parsePrintRequestRecord);
      const requesterIds = [...new Set(parsed.map((request) => request.requested_by))];
      let profileWarning: string | null = null;
      if (requesterIds.length > 0) {
        const { data: profiles, error: profileError } = await supabase
          .from('profiles')
          .select('id,full_name,username,email')
          .in('id', requesterIds);
        if (profileError) {
          profileWarning = `Could not load requester names: ${profileError.message}`;
        } else {
          const names = new Map((profiles ?? []).map((profile) => [
            profile.id,
            profile.username || profile.full_name || profile.email || 'Unknown user',
          ]));
          parsed.forEach((request) => {
            request.requester_name = names.get(request.requested_by) || 'Unknown user';
          });
        }
      }
      setRequests(parsed);
      setNotice(profileWarning ? { text: profileWarning, error: true } : null);
    } catch (parseError) {
      setNotice({ text: parseError instanceof Error ? parseError.message : 'Could not parse print requests.', error: true });
    } finally {
      setLoading(false);
    }
  }, []);

  const editPreview = useMemo((): { snapshot: PrintSnapshot | null; error: string } | null => {
    if (!editingRequest) return null;
    const discountPaisa = parsePaisaInput(draftDiscount || '0');
    if (discountPaisa === null) return { snapshot: null, error: 'Enter a valid discount amount.' };
    try {
      return {
        snapshot: recalculateEditableReceipt(
          parsePrintSnapshot(editingRequest.payload),
          draftLines,
          discountPaisa,
        ),
        error: '',
      };
    } catch (error) {
      return {
        snapshot: null,
        error: error instanceof Error ? error.message : 'The edited receipt is invalid.',
      };
    }
  }, [draftDiscount, draftLines, editingRequest]);

  const beginEdit = (request: PrintRequestRecord) => {
    try {
      const snapshot = parsePrintSnapshot(request.payload);
      if (request.type !== 'sale' || snapshot.data.kind !== 'SALE') {
        throw new Error('Only sale receipts can be modified.');
      }
      setEditingRequest(request);
      setDraftLines(snapshot.data.lines.map((line) => ({ ...line })));
      setDraftDiscount((snapshot.data.discountPaisa / 100).toFixed(2));
      setNewItemName('');
      setNewItemPrice('');
      setEditError('');
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : 'Could not open the receipt editor.',
        error: true,
      });
    }
  };

  const saveEdit = async () => {
    if (!editingRequest || !editPreview?.snapshot) {
      setEditError(editPreview?.error || 'Correct the receipt details before saving.');
      return;
    }
    if (getBackend() !== 'api' && !supabase) {
      setEditError('Supabase is not configured.');
      return;
    }
    setBusyId(editingRequest.id);
    setEditError('');
    try {
      let updatedPayload: unknown;
      if (getBackend() === 'api') {
        updatedPayload = (await modifyPrintRequest(editingRequest.id, editPreview.snapshot)).payload;
      } else {
        const { data, error } = await supabase!.rpc('modify_print_request', {
          p_request_id: editingRequest.id,
          p_lines: editPreview.snapshot.data.lines,
          p_discount_paisa: editPreview.snapshot.data.discountPaisa,
        });
        if (error) throw new Error(error.message);
        if (typeof data !== 'object' || data === null || !('payload' in data)) {
          throw new Error('The server did not return the updated receipt snapshot.');
        }
        updatedPayload = data.payload;
      }
      const updatedSnapshot = parsePrintSnapshot(updatedPayload);
      setRequests((current) => current.map((request) =>
        request.id === editingRequest.id ? { ...request, payload: updatedSnapshot } : request
      ));
      setEditingRequest(null);
      setNotice({ text: 'Receipt request updated. The completed sale was not changed.', error: false });
    } catch (error) {
      setEditError(error instanceof Error ? error.message : 'Could not save the receipt changes.');
    } finally {
      setBusyId('');
    }
  };

  const addItem = () => {
    const name = newItemName.trim();
    const ratePaisa = parsePaisaInput(newItemPrice);
    if (!name || ratePaisa === null) {
      setEditError('Enter an item name and a valid price.');
      return;
    }
    setDraftLines((current) => [...current, { qty: 1, name, ratePaisa }]);
    setNewItemName('');
    setNewItemPrice('');
    setEditError('');
  };

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 20_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const decide = async (request: PrintRequestRecord, decision: 'approved' | 'rejected', note: string | null) => {
    if (getBackend() !== 'api' && !supabase) return setNotice({ text: 'Supabase is not configured.', error: true });
    setBusyId(request.id);
    setNotice(null);
    try {
      const data = getBackend() === 'api'
        ? await decidePrintRequest(request.id, decision, note)
        : await (async () => {
          const result = await supabase!.rpc('decide_print_request', {
            p_request_id: request.id,
            p_decision: decision,
            p_note: note,
          });
          if (result.error) throw new Error(result.error.message);
          return result.data;
        })();
      if (decision === 'approved') {
        if (typeof data !== 'object' || data === null || !('payload' in data)) {
          throw new Error('Approval succeeded but no receipt snapshot was returned.');
        }
        const snapshot = parsePrintSnapshot(data.payload);
        await onPrintReceipt(request.type, snapshot, { approvedRequestId: request.id });
      }
      setNotice({
        text: decision === 'approved' ? 'Request approved. The receipt was sent to this computer’s print dialog.' : 'Request rejected.',
        error: false,
      });
      await refresh();
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : 'Could not decide or print this request.',
        error: true,
      });
      await refresh();
    } finally {
      setBusyId('');
    }
  };

  const approve = (request: PrintRequestRecord) => {
    void decide(request, 'approved', null);
  };

  const reject = (request: PrintRequestRecord) => {
    const note = window.prompt('Optional note for the requester:');
    if (note === null) return;
    void decide(request, 'rejected', note.trim() || null);
  };

  const printAgain = async (request: PrintRequestRecord) => {
    setBusyId(request.id);
    setNotice(null);
    try {
      const snapshot = parsePrintSnapshot(request.payload);
      await onPrintReceipt(request.type, snapshot, { approvedRequestId: request.id });
      setNotice({ text: 'Receipt sent to this computer’s print dialog again.', error: false });
      await refresh();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : 'Could not print this receipt again.', error: true });
    } finally {
      setBusyId('');
    }
  };

  return (
    <section className="mx-auto max-w-6xl space-y-4">
      <header className="rounded-card border border-border bg-white p-5 shadow-sm">
        <h2 className="text-xl font-black text-text">Print Requests</h2>
        <p className="mt-1 text-sm text-muted">Approve or reject receipt requests. Approved requests remain available to print again.</p>
      </header>
      {notice && <p role={notice.error ? 'alert' : 'status'} className={`visual-toast rounded-control border px-4 py-3 text-sm ${notice.error ? 'border-red-200 bg-red-50 text-red-800' : 'border-green-200 bg-green-50 text-green-800'}`}>{notice.text}</p>}
      <div className="overflow-x-auto rounded-card border border-border bg-white shadow-sm">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="border-b border-border bg-surface text-[11px] font-bold uppercase tracking-wide text-muted">
            <tr>
              <th className="px-5 py-3">Type</th>
              <th className="px-5 py-3">Receipt</th>
              <th className="px-5 py-3">Requester</th>
              <th className="px-5 py-3">Requested</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3">Note</th>
              <th className="px-5 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading ? <tr><td colSpan={7} className="px-5 py-8 text-center text-muted">Loading requests…</td></tr>
              : requests.length === 0 ? <tr><td colSpan={7} className="px-5 py-8 text-center text-muted">No print requests.</td></tr>
                : requests.map((request) => (
                  <tr key={request.id}>
                    <td className="px-5 py-4 capitalize">{request.type}</td>
                    <td className="px-5 py-4 font-mono">{request.receipt_ref}</td>
                    <td className="px-5 py-4">{request.requester_name || 'Unknown user'}</td>
                    <td className="px-5 py-4">{new Date(request.requested_at).toLocaleString()}</td>
                    <td className="px-5 py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-bold capitalize ${statusClass(request.status)}`}>{request.status}</span></td>
                    <td className="max-w-56 px-5 py-4 text-muted">{request.note || '—'}</td>
                    <td className="px-5 py-4 text-right">
                      <div className="inline-flex gap-2">
                        {request.status === 'pending' && <>
                          <button type="button" disabled={busyId === request.id} onClick={() => approve(request)} className="inline-flex items-center gap-1 rounded-control bg-primary px-3 py-2 text-xs font-bold text-white disabled:opacity-50"><Printer className="h-3.5 w-3.5" />Approve and print</button>
                          {request.type === 'sale' && <button type="button" disabled={busyId === request.id} onClick={() => beginEdit(request)} className="inline-flex items-center gap-1 rounded-control border border-primary/30 px-3 py-2 text-xs font-bold text-primary disabled:opacity-50"><Pencil className="h-3.5 w-3.5" />Modify</button>}
                          <button type="button" disabled={busyId === request.id} onClick={() => reject(request)} className="inline-flex items-center gap-1 rounded-control border border-red-200 px-3 py-2 text-xs font-bold text-red-700 disabled:opacity-50"><XCircle className="h-3.5 w-3.5" />Reject</button>
                        </>}
                        {request.status === 'approved' && <button type="button" disabled={busyId === request.id} onClick={() => void printAgain(request)} className="inline-flex items-center gap-1 rounded-control border border-primary/30 px-3 py-2 text-xs font-bold text-primary disabled:opacity-50"><RotateCcw className="h-3.5 w-3.5" />Print again</button>}
                      </div>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {editingRequest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="modify-print-request-title" className="max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-card border border-border bg-white p-5 shadow-xl">
            <header className="flex items-start justify-between gap-3">
              <div>
                <h3 id="modify-print-request-title" className="text-lg font-black text-text">Modify receipt request</h3>
                <p className="text-sm text-muted">{editingRequest.receipt_ref} · Changes apply to the receipt only, not the completed sale or stock.</p>
              </div>
              <button type="button" aria-label="Close editor" onClick={() => setEditingRequest(null)} className="rounded-control p-2 text-muted hover:bg-surface"><X className="h-4 w-4" /></button>
            </header>

            <div className="space-y-2">
              {draftLines.map((line, index) => (
                <div key={`${line.name}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2 rounded-control border border-border p-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-text">{line.name}</p>
                    <p className="text-xs text-muted">Rs. {(line.ratePaisa / 100).toFixed(2)} each</p>
                  </div>
                  <div className="inline-flex items-center rounded-control border border-border">
                    <button type="button" aria-label={`Decrease ${line.name} quantity`} onClick={() => setDraftLines((current) => current.flatMap((item, itemIndex) => itemIndex !== index ? [item] : item.qty <= 1 ? [] : [{ ...item, qty: item.qty - 1 }]))} className="p-1.5 text-muted hover:bg-surface"><Minus className="h-3 w-3" /></button>
                    <span className="min-w-7 text-center text-sm font-bold">{line.qty}</span>
                    <button type="button" aria-label={`Increase ${line.name} quantity`} onClick={() => setDraftLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, qty: item.qty + 1 } : item))} className="p-1.5 text-muted hover:bg-surface"><Plus className="h-3 w-3" /></button>
                  </div>
                  <strong className="min-w-20 text-right font-mono text-sm">Rs. {(line.qty * line.ratePaisa / 100).toFixed(2)}</strong>
                  <button type="button" aria-label={`Remove ${line.name}`} onClick={() => setDraftLines((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="p-1.5 text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" /></button>
                </div>
              ))}
            </div>

            <form className="grid grid-cols-[minmax(0,1fr)_9rem_auto] gap-2" onSubmit={(event) => { event.preventDefault(); addItem(); }}>
              <input aria-label="New item name" value={newItemName} onChange={(event) => setNewItemName(event.target.value)} placeholder="Add product name" className="min-w-0 rounded-control border border-border px-3 py-2 text-sm" />
              <input aria-label="New item price" inputMode="decimal" value={newItemPrice} onChange={(event) => setNewItemPrice(event.target.value)} placeholder="Price (Rs.)" className="rounded-control border border-border px-3 py-2 text-sm" />
              <button type="submit" className="inline-flex items-center gap-1 rounded-control border border-primary/30 px-3 py-2 text-sm font-bold text-primary"><Plus className="h-4 w-4" />Add item</button>
            </form>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
              <label className="flex items-center gap-2 text-sm font-semibold text-text">
                Discount (Rs.)
                <input aria-label="Receipt discount in rupees" inputMode="decimal" value={draftDiscount} onChange={(event) => { setDraftDiscount(event.target.value); setEditError(''); }} className="w-28 rounded-control border border-border px-2 py-1.5 font-mono" />
              </label>
              <p className="text-sm font-bold text-text">
                Updated total: {editPreview?.snapshot
                  ? `Rs. ${((editPreview.snapshot.data.lines.reduce((sum, line) => sum + line.qty * line.ratePaisa, 0)
                    - editPreview.snapshot.data.discountPaisa
                    + (editPreview.snapshot.data.salesTaxPaisa ?? 0)
                    + (editPreview.snapshot.data.roundingPaisa ?? 0)) / 100).toFixed(2)}`
                  : '—'}
              </p>
            </div>
            {editError && <p role="alert" className="rounded-control border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{editError}</p>}
            {editPreview?.error && <p role="alert" className="text-sm text-red-700">{editPreview.error}</p>}
            <footer className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditingRequest(null)} className="rounded-control border border-border px-4 py-2 text-sm font-bold text-muted">Cancel</button>
              <button type="button" disabled={busyId === editingRequest.id || !editPreview?.snapshot} onClick={() => void saveEdit()} className="rounded-control bg-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{busyId === editingRequest.id ? 'Saving…' : 'Save changes'}</button>
            </footer>
          </section>
        </div>
      )}
      <p className="text-xs text-muted">Requests refresh every 20 seconds. A cancelled print dialog leaves the request approved.</p>
    </section>
  );
}
