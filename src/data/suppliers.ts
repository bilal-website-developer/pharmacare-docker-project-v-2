import { apiRequest, getBackend } from '../api';
import { fetchAllSupabaseRows } from '../utils/fetchAllSupabaseRows';
import { getSupabaseErrorMessage } from '../utils/supabaseError';
import { supabase } from '../utils/supabase';

export interface Supplier {
  id: string;
  name: string;
  contact: string;
  address: string;
  licence_or_tax_number: string;
  payment_terms: string;
  is_active: boolean;
  created_at: string;
}

export type SupplierInput = Pick<
  Supplier,
  'name' | 'contact' | 'address' | 'licence_or_tax_number' | 'payment_terms'
>;

interface ApiSupplier {
  id: string;
  name: string;
  contact: string;
  address: string;
  licenceOrTaxNumber: string;
  paymentTerms: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ApiSupplierPage {
  items: ApiSupplier[];
  page: number;
  pageSize: number;
  total: number;
}

const SUPPLIER_COLUMNS =
  'id, name, contact, address, licence_or_tax_number, payment_terms, is_active, created_at';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isApiSupplier(value: unknown): value is ApiSupplier {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.contact === 'string'
    && typeof value.address === 'string'
    && typeof value.licenceOrTaxNumber === 'string'
    && typeof value.paymentTerms === 'string'
    && typeof value.isActive === 'boolean'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function toSupplier(value: ApiSupplier): Supplier {
  return {
    id: value.id,
    name: value.name,
    contact: value.contact,
    address: value.address,
    licence_or_tax_number: value.licenceOrTaxNumber,
    payment_terms: value.paymentTerms,
    is_active: value.isActive,
    created_at: value.createdAt,
  };
}

function parseSupplierPage(value: unknown): ApiSupplierPage {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error('The supplier service returned an invalid response.');
  }
  const items = value.items.filter(isApiSupplier);
  if (items.length !== value.items.length
    || typeof value.page !== 'number'
    || !Number.isSafeInteger(value.page)
    || typeof value.pageSize !== 'number'
    || !Number.isSafeInteger(value.pageSize)
    || typeof value.total !== 'number'
    || !Number.isSafeInteger(value.total)) {
    throw new Error('The supplier service returned an invalid response.');
  }
  return {
    items,
    page: value.page,
    pageSize: value.pageSize,
    total: value.total,
  };
}

export async function listSuppliers(): Promise<Supplier[]> {
  if (getBackend() === 'api') {
    const pageSize = 200;
    const firstPage = parseSupplierPage(await apiRequest<unknown>(
      `/api/suppliers?active=all&page=1&pageSize=${pageSize}&sort=name&order=asc`,
    ));
    const result = firstPage.items.slice();
    for (let page = 2; result.length < firstPage.total; page += 1) {
      const nextPage = parseSupplierPage(await apiRequest<unknown>(
        `/api/suppliers?active=all&page=${page}&pageSize=${pageSize}&sort=name&order=asc`,
      ));
      if (nextPage.items.length === 0) {
        throw new Error('The supplier service returned an incomplete page.');
      }
      result.push(...nextPage.items);
    }
    return result.map(toSupplier);
  }

  const client = supabase;
  if (!client) {
    throw new Error(getSupabaseErrorMessage(new Error('Supabase is not configured.'), 'Could not load suppliers.'));
  }
  const rows = await fetchAllSupabaseRows((from, to) => client
    .from('suppliers')
    .select(SUPPLIER_COLUMNS)
    .order('name', { ascending: true })
    .range(from, to));
  return rows as Supplier[];
}

export async function saveSupplier(id: string | null, values: SupplierInput): Promise<void> {
  if (getBackend() === 'api') {
    const body = {
      name: values.name,
      contact: values.contact,
      address: values.address,
      licenceOrTaxNumber: values.licence_or_tax_number,
      paymentTerms: values.payment_terms,
    };
    const result = await apiRequest<unknown>(id ? `/api/suppliers/${encodeURIComponent(id)}` : '/api/suppliers', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(body),
    });
    if (!isApiSupplier(result)) throw new Error('The supplier service returned an invalid response.');
    return;
  }

  if (!supabase) {
    throw new Error(getSupabaseErrorMessage(new Error('Supabase is not configured.'), 'Could not save supplier.'));
  }
  const { error } = await supabase.rpc('save_supplier', {
    p_supplier_id: id,
    p_name: values.name,
    p_contact: values.contact,
    p_address: values.address,
    p_licence_or_tax_number: values.licence_or_tax_number,
    p_payment_terms: values.payment_terms,
  });
  if (error) throw error;
}

export async function deactivateSupplier(id: string): Promise<void> {
  if (getBackend() === 'api') {
    const result = await apiRequest<unknown>(`/api/suppliers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: false }),
    });
    if (!isApiSupplier(result)) throw new Error('The supplier service returned an invalid response.');
    return;
  }

  if (!supabase) {
    throw new Error(getSupabaseErrorMessage(new Error('Supabase is not configured.'), 'Could not deactivate supplier.'));
  }
  const { error } = await supabase.rpc('deactivate_supplier', { p_supplier_id: id });
  if (error) throw error;
}
