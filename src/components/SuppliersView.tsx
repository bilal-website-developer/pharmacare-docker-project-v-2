import React, { FormEvent, useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Save, Truck, X } from 'lucide-react';
import { getBackend } from '../api';
import {
  deactivateSupplier as deactivateSupplierRequest,
  listSuppliers as listSuppliersRequest,
  saveSupplier as saveSupplierRequest,
  type Supplier,
  type SupplierInput,
} from '../data/suppliers';
import { supabase } from '../utils/supabase';

type SupplierForm = SupplierInput;

const EMPTY_FORM: SupplierForm = {
  name: '',
  contact: '',
  address: '',
  licence_or_tax_number: '',
  payment_terms: 'CASH',
};

function describeError(error: { message: string; code?: string }): string {
  if (error.code === '42501' || error.code === 'PGRST301') {
    return 'Supabase denied this request. Check the suppliers table Row Level Security policies for this app user.';
  }
  return error.message;
}

function describeUnknownError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return describeError({
      message: String(error.message),
      code: 'code' in error ? String(error.code) : undefined,
    });
  }
  return 'The request could not be completed. Check your network connection and try again.';
}

export const SuppliersView: React.FC = () => {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [form, setForm] = useState<SupplierForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canUseSupplierForm = getBackend() === 'api' || Boolean(supabase);

  const loadSuppliers = useCallback(async () => {
    if (getBackend() === 'supabase' && !supabase) {
      setError('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then restart the app.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    try {
      setSuppliers(await listSuppliersRequest());
    } catch (queryError) {
      setError(describeUnknownError(queryError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSuppliers();
  }, [loadSuppliers]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const name = form.name.trim();
    if (!name) {
      setError('Supplier name is required.');
      return;
    }

    setSaving(true);
    setError('');
    setNotice('');
    const values: SupplierForm = {
      name,
      contact: form.contact.trim(),
      address: form.address.trim(),
      licence_or_tax_number: form.licence_or_tax_number.trim(),
      payment_terms: form.payment_terms.trim(),
    };

    try {
      await saveSupplierRequest(editingId, values);
      setNotice(editingId ? 'Supplier updated.' : 'Supplier added.');
      resetForm();
      await loadSuppliers();
    } catch (saveError) {
      setError(describeUnknownError(saveError));
    } finally {
      setSaving(false);
    }
  };

  const editSupplier = (supplier: Supplier) => {
    setForm({
      name: supplier.name,
      contact: supplier.contact,
      address: supplier.address,
      licence_or_tax_number: supplier.licence_or_tax_number,
      payment_terms: supplier.payment_terms,
    });
    setEditingId(supplier.id);
    setError('');
    setNotice('');
  };

  const deactivateSupplier = async (supplier: Supplier) => {
    if (!window.confirm(`Deactivate ${supplier.name}? The supplier record will be kept.`)) return;

    setError('');
    setNotice('');
    try {
      await deactivateSupplierRequest(supplier.id);

      setSuppliers((current) =>
        current.map((item) => item.id === supplier.id ? { ...item, is_active: false } : item)
      );
      setNotice('Supplier deactivated.');
    } catch (deactivateError) {
      setError(describeUnknownError(deactivateError));
    }
  };

  return (
    <section className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold text-text">
            <Truck aria-hidden="true" className="h-5 w-5 text-primary" />
            Suppliers
          </h2>
          <p className="mt-1 text-xs text-muted">Manage supplier contact and payment details.</p>
        </div>
        <button
          type="button"
          onClick={() => void loadSuppliers()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-control border border-border bg-white px-3 py-2 text-xs font-semibold text-text hover:bg-surface disabled:opacity-50"
        >
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
          Refresh
        </button>
      </header>

      {error && (
        <p role="alert" className="visual-toast rounded-control border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="visual-toast rounded-control border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {notice}
        </p>
      )}

      {canUseSupplierForm && (
        <form onSubmit={handleSubmit} className="space-y-4 rounded-card border border-border bg-white p-5 shadow-xs">
          <h3 className="text-sm font-bold text-text">{editingId ? 'Edit supplier' : 'Add supplier'}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs font-semibold text-text">
              Supplier name *
              <input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className="w-full rounded-control border border-border px-3 py-2 font-normal" />
            </label>
            <label className="space-y-1 text-xs font-semibold text-text">
              Contact
              <input value={form.contact} onChange={(event) => setForm({ ...form, contact: event.target.value })} className="w-full rounded-control border border-border px-3 py-2 font-normal" />
            </label>
            <label className="space-y-1 text-xs font-semibold text-text">
              Licence / tax number
              <input value={form.licence_or_tax_number} onChange={(event) => setForm({ ...form, licence_or_tax_number: event.target.value })} className="w-full rounded-control border border-border px-3 py-2 font-normal" />
            </label>
            <label className="space-y-1 text-xs font-semibold text-text">
              Payment terms
              <input value={form.payment_terms} onChange={(event) => setForm({ ...form, payment_terms: event.target.value })} placeholder="CASH, 7 days, 30 days" className="w-full rounded-control border border-border px-3 py-2 font-normal" />
            </label>
            <label className="space-y-1 text-xs font-semibold text-text sm:col-span-2">
              Address
              <textarea rows={2} value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} className="w-full rounded-control border border-border px-3 py-2 font-normal" />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            {editingId && (
              <button type="button" onClick={resetForm} className="inline-flex items-center gap-1 rounded-control border border-border px-3 py-2 text-xs font-semibold text-text">
                <X aria-hidden="true" className="h-4 w-4" /> Cancel
              </button>
            )}
            <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-control bg-primary px-4 py-2 text-xs font-bold text-white disabled:opacity-50">
              {editingId ? <Save aria-hidden="true" className={`h-4 w-4 ${saving ? 'supplier-saving-icon' : ''}`} /> : <Plus aria-hidden="true" className={`h-4 w-4 ${saving ? 'supplier-saving-icon' : ''}`} />}
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add supplier'}
            </button>
          </div>
        </form>
      )}

      <div className="overflow-x-auto rounded-card border border-border bg-white shadow-xs">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="bg-surface text-[10px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Supplier</th>
              <th className="px-4 py-3">Contact</th>
              <th className="px-4 py-3">Licence / Tax No.</th>
              <th className="px-4 py-3">Payment terms</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading ? (
              <tr><td colSpan={6} className="visual-skeleton px-4 py-8 text-center text-muted">Loading suppliers…</td></tr>
            ) : suppliers.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted"><span className="supplier-empty-state inline-flex items-center justify-center gap-2"><Truck aria-hidden="true" className="supplier-empty-truck h-5 w-5" />{getBackend() === 'api' ? 'No suppliers found.' : "No suppliers were returned. If suppliers already exist, check the table's Supabase Row Level Security SELECT policy."}</span></td></tr>
            ) : suppliers.map((supplier) => (
              <tr key={supplier.id} className={`supplier-table-row ${!supplier.is_active ? 'bg-surface/60 text-muted' : ''}`}>
                <td className="px-4 py-3">
                  <div className="font-semibold text-text">{supplier.name}</div>
                  <div className="mt-1 max-w-xs truncate text-[11px] text-muted">{supplier.address || 'No address'}</div>
                </td>
                <td className="px-4 py-3">{supplier.contact || '—'}</td>
                <td className="px-4 py-3">{supplier.licence_or_tax_number || '—'}</td>
                <td className="px-4 py-3">{supplier.payment_terms || '—'}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${supplier.is_active ? 'bg-green-100 text-green-800' : 'bg-slate-200 text-slate-600'}`}>
                    {supplier.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => editSupplier(supplier)} className="rounded-control border border-border px-2.5 py-1.5 font-semibold text-text hover:bg-surface">
                      Edit
                    </button>
                    {supplier.is_active && (
                      <button type="button" onClick={() => void deactivateSupplier(supplier)} className="rounded-control border border-red-200 px-2.5 py-1.5 font-semibold text-red-700 hover:bg-red-50">
                        Deactivate
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
