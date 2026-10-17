import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { getBackend } from '../api';
import { loadTrashBinEvents, restoreTrashBinEvent } from '../data/trashBin';
import { UserRole } from '../types/pharmacy';
import { invokeManageUsers } from './ManageUsersView';
import { supabase } from '../utils/supabase';
import { filterTrashBinEvents, parseTrashBinEvent, TrashBinEvent, TrashFilter } from '../utils/trashBin';

const FILTERS: Array<{ value: TrashFilter; label: string }> = [
  { value: 'all', label: 'All activity' },
  { value: 'profile', label: 'Users' },
  { value: 'medicine', label: 'Products' },
  { value: 'supplier', label: 'Suppliers' },
  { value: 'purchase', label: 'Purchases' },
];

const ENTITY_LABELS: Record<TrashBinEvent['entity_type'], string> = {
  profile: 'User',
  medicine: 'Product',
  supplier: 'Supplier',
  purchase: 'Purchase',
  category: 'Category',
  brand: 'Manufacturer',
  medicine_unit: 'Product unit',
};

const ACTION_LABELS: Record<TrashBinEvent['action'], string> = {
  deleted: 'Deleted',
  deactivated: 'Deactivated',
  voided: 'Voided',
  restored: 'Restored',
};

export function TrashBinView({ currentRole }: { currentRole: UserRole }) {
  const [events, setEvents] = useState<TrashBinEvent[]>([]);
  const [filter, setFilter] = useState<TrashFilter>('all');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const refresh = useCallback(async () => {
    if (getBackend() === 'api') {
      try {
        setEvents(await loadTrashBinEvents());
        setNotice(null);
      } catch (caught) {
        setNotice({
          text: `Could not load Trash Bin activity: ${caught instanceof Error ? caught.message : 'Unknown error.'}`,
          error: true,
        });
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
    const { data, error } = await supabase.rpc('trash_bin_events_list');
    if (error) {
      setNotice({ text: `Could not load Trash Bin activity: ${error.message}`, error: true });
      setLoading(false);
      return;
    }
    try {
      if (!Array.isArray(data)) throw new Error('Trash Bin returned an invalid activity list.');
      setEvents(data.map(parseTrashBinEvent));
      setNotice(null);
    } catch (caught) {
      setNotice({
        text: caught instanceof Error ? caught.message : 'Could not parse Trash Bin activity.',
        error: true,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visibleEvents = useMemo(() => filterTrashBinEvents(events, filter), [events, filter]);

  const restore = async (event: TrashBinEvent) => {
    if (!event.can_restore || (getBackend() !== 'api' && !supabase)) return;
    setBusyId(event.id);
    setNotice(null);
    try {
      if (getBackend() === 'api') {
        await restoreTrashBinEvent(event);
        setNotice({ text: `${event.display_name} restored.`, error: false });
      } else if (event.entity_type === 'profile') {
        const result = await invokeManageUsers<{ message: string }>({
          action: 'restore',
          id: event.entity_id,
        });
        setNotice({ text: result.message || `${event.display_name} restored.`, error: false });
      } else if (event.entity_type === 'medicine' || event.entity_type === 'supplier') {
        const client = supabase;
        if (!client) throw new Error('Supabase is not configured.');
        const result = event.entity_type === 'medicine'
          ? await client.rpc('restore_trash_medicine', { p_medicine_id: event.entity_id })
          : await client.rpc('restore_trash_supplier', { p_supplier_id: event.entity_id });
        const { error } = result;
        if (error) throw new Error(error.message);
        setNotice({ text: `${event.display_name} restored.`, error: false });
      } else {
        return;
      }
      await refresh();
    } catch (caught) {
      setNotice({
        text: caught instanceof Error ? caught.message : 'Could not restore this item.',
        error: true,
      });
    } finally {
      setBusyId('');
    }
  };

  return (
    <section className="mx-auto max-w-6xl space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-white p-5 shadow-sm">
        <div>
          <h2 className="text-xl font-black text-text">Trash Bin</h2>
          <p className="mt-1 text-sm text-muted">Review who deleted, deactivated, voided, or restored records.</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-control border border-border px-3 py-2 text-sm font-bold text-text disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </header>

      {notice && (
        <p role={notice.error ? 'alert' : 'status'} className={`rounded-control border px-4 py-3 text-sm ${notice.error ? 'border-red-200 bg-red-50 text-red-800' : 'border-primary/30 bg-primary/5 text-text'}`}>
          {notice.text}
        </p>
      )}

      <nav aria-label="Filter Trash Bin activity" className="flex flex-wrap gap-2">
        {FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={filter === item.value}
            onClick={() => setFilter(item.value)}
            className={`rounded-control border px-3 py-2 text-sm font-bold ${
              filter === item.value
                ? 'border-primary bg-primary text-white'
                : 'border-border bg-white text-muted hover:bg-surface'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="overflow-x-auto rounded-card border border-border bg-white shadow-sm">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="border-b border-border bg-surface text-[11px] font-bold uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Who</th>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3 text-right">Restore</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-muted">Loading activity…</td></tr>
            ) : visibleEvents.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-muted">No matching Trash Bin activity.</td></tr>
            ) : visibleEvents.map((event) => {
              const protectedUser = event.entity_type === 'profile'
                && (currentRole === UserRole.SUPER_ADMIN
                  ? event.entity_role === UserRole.SUPER_ADMIN
                  : event.entity_role === UserRole.ADMIN || event.entity_role === UserRole.SUPER_ADMIN);
              const canRestore = event.can_restore && !protectedUser;
              return (
                <tr key={event.id}>
                  <td className="px-4 py-4">{ENTITY_LABELS[event.entity_type]}</td>
                  <td className="px-4 py-4 font-semibold text-text">{event.display_name}</td>
                  <td className="px-4 py-4">{ACTION_LABELS[event.action]}</td>
                  <td className="px-4 py-4">{event.actor_name || 'Unknown user'}</td>
                  <td className="px-4 py-4">{new Date(event.created_at).toLocaleString()}</td>
                  <td className="max-w-64 px-4 py-4 text-muted">{event.reason || '—'}</td>
                  <td className="px-4 py-4 text-right">
                    {canRestore ? (
                      <button
                        type="button"
                        disabled={busyId !== ''}
                        onClick={() => void restore(event)}
                        className="inline-flex items-center gap-1 rounded-control border border-primary/30 px-3 py-2 text-xs font-bold text-primary disabled:opacity-50"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {busyId === event.id ? 'Restoring…' : 'Restore'}
                      </button>
                    ) : event.action === 'voided' ? (
                      <span className="text-xs text-muted">Reversal required</span>
                    ) : (
                      <span className="text-xs text-muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">Purchase voids remain in the audit history and cannot be restored from here. Restoring a user is subject to account-role restrictions.</p>
    </section>
  );
}
