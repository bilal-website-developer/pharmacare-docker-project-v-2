import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../utils/supabase';
import { getBackend } from '../api';
import { loadMyPrintRequests } from '../data/printRequests';
import { parsePrintRequestRecord, PrintRequestRecord } from '../utils/printRequestTypes';

function statusClass(status: PrintRequestRecord['status']) {
  if (status === 'approved') return 'bg-green-100 text-green-800';
  if (status === 'rejected') return 'bg-red-100 text-red-800';
  return 'bg-amber-100 text-amber-800';
}

export function MyPrintRequestsView({ userId }: { userId: string }) {
  const [requests, setRequests] = useState<PrintRequestRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusToast, setStatusToast] = useState('');
  const knownStatuses = useRef<Map<string, PrintRequestRecord['status']> | null>(null);

  const refresh = useCallback(async () => {
    try {
      let parsed: PrintRequestRecord[];
      if (getBackend() === 'api') {
        parsed = await loadMyPrintRequests();
      } else {
        if (!supabase) throw new Error('Supabase is not configured.');
        const { data, error: queryError } = await supabase
          .from('print_requests')
          .select('id,type,receipt_ref,payload,requested_by,requested_at,status,decided_by,decided_at,note,printed_at')
          .eq('requested_by', userId)
          .order('requested_at', { ascending: false })
          .limit(100);
        if (queryError) throw new Error(queryError.message);
        if (!Array.isArray(data)) throw new Error('The print-request list response is invalid.');
        parsed = data.map(parsePrintRequestRecord);
      }
      const nextStatuses = new Map(parsed.map((request) => [request.id, request.status]));
      const previous = knownStatuses.current;
      if (previous) {
        const changed = parsed.find((request) => {
          const oldStatus = previous.get(request.id);
          return oldStatus !== undefined && oldStatus !== request.status;
        });
        if (changed) {
          setStatusToast(
            `Your ${changed.type} print request ${changed.receipt_ref} was ${changed.status}.${changed.note ? ` Admin note: ${changed.note}` : ''}`,
          );
        }
      }
      knownStatuses.current = nextStatuses;
      setRequests(parsed);
      setError('');
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : 'Could not parse print requests.');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 20_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  return (
    <section className="mx-auto max-w-5xl space-y-4">
      <header className="rounded-card border border-border bg-white p-5 shadow-sm">
        <h2 className="text-xl font-black text-text">My print requests</h2>
        <p className="mt-1 text-sm text-muted">Approval status and any note from the administrator.</p>
      </header>
      {statusToast && <p role="status" className="visual-toast rounded-control border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-text">{statusToast}</p>}
      {error && <p role="alert" className="rounded-control border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
      <div className="overflow-x-auto rounded-card border border-border bg-white shadow-sm">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-border bg-surface text-[11px] font-bold uppercase tracking-wide text-muted">
            <tr>
              <th className="px-5 py-3">Type</th>
              <th className="px-5 py-3">Receipt</th>
              <th className="px-5 py-3">Requested</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3">Admin note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading ? <tr><td colSpan={5} className="px-5 py-8 text-center text-muted">Loading requests…</td></tr>
              : requests.length === 0 ? <tr><td colSpan={5} className="px-5 py-8 text-center text-muted">No print requests yet.</td></tr>
                : requests.map((request) => (
                  <tr key={request.id}>
                    <td className="px-5 py-4 capitalize">{request.type}</td>
                    <td className="px-5 py-4 font-mono">{request.receipt_ref}</td>
                    <td className="px-5 py-4">{new Date(request.requested_at).toLocaleString()}</td>
                    <td className="px-5 py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-bold capitalize ${statusClass(request.status)}`}>{request.status}</span></td>
                    <td className="px-5 py-4 text-muted">{request.note || '—'}</td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">This list refreshes every 20 seconds.</p>
    </section>
  );
}
