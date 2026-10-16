import { UserRole } from '../types/pharmacy';
import {
  printHtmlDocument,
  renderPharmacyMemo,
  renderReceipt,
  type ReceiptData,
} from './receipt';
import { supabase } from './supabase';
import { getBackend } from '../api';
import { markPrintRequestPrinted, submitPrintRequest } from '../data/printRequests';
import {
  canPrintReceipt,
  isPrintSnapshotSafe,
  parsePrintSnapshot,
  snapshotWithDuplicateLabel,
  type PrintRequestType,
  type PrintSnapshot,
} from './printSnapshot';

export type { PrintRequestType, PrintSnapshot } from './printSnapshot';
export { buildPrintSnapshot, canPrintReceipt } from './printSnapshot';

export interface PrintReceiptAccess {
  role: UserRole;
  permissions: readonly string[];
  onNotice: (message: string, error?: boolean) => void;
}

export interface PrintReceiptOptions {
  autoPrint?: boolean;
  approvedRequestId?: string;
}

export type PrintReceiptHandler = (
  type: PrintRequestType,
  payload: PrintSnapshot,
  options?: PrintReceiptOptions,
) => Promise<PrintReceiptResult>;

export type PrintReceiptResult = 'printed' | 'requested' | 'cancelled' | 'auto-print-disabled';

function classicReceiptData(snapshot: PrintSnapshot): ReceiptData {
  const { data, settings } = snapshot;
  const itemGrossPaisa = data.lines.reduce(
    (total, line) => total + Math.round(line.qty * line.ratePaisa),
    0,
  );
  const paymentAmountPaisa = data.amountReceivedPaisa ?? 0;
  const grossPaisa = data.kind === 'PAYMENT' ? paymentAmountPaisa : itemGrossPaisa;
  const totalPaisa = grossPaisa - data.discountPaisa + (data.salesTaxPaisa ?? 0) + (data.roundingPaisa ?? 0);
  const isPayment = data.kind === 'PAYMENT';
  const paidPaisa = isPayment
    ? data.amountReceivedPaisa ?? 0
    : data.paidPaisa ?? totalPaisa;
  const balanceDuePaisa = isPayment
    ? data.balanceAfterPaisa ?? 0
    : Math.max(0, totalPaisa - paidPaisa);
  const status: ReceiptData['status'] = balanceDuePaisa === 0
    ? 'PAID'
    : paidPaisa > 0 ? 'PARTIAL' : 'CREDIT';

  return {
    storeName: settings.storeName,
    address: settings.address,
    phone: settings.phone,
    invoiceNo: data.memoNo,
    dateTime: data.dateTime,
    cashierName: data.cashier,
    customerName: data.customerName ?? '',
    paymentMode: data.paymentMode ?? (isPayment ? 'PAYMENT' : data.kind),
    status,
    isDuplicate: data.isDuplicate,
    items: data.lines.map((line) => ({
      name: line.name,
      batchNo: line.batch ?? '',
      expiry: line.expiry ?? '',
      qty: line.qty,
      unit: '',
      unitPrice: line.ratePaisa,
      lineTotal: Math.round(line.qty * line.ratePaisa),
    })),
    subtotal: grossPaisa,
    discount: data.discountPaisa,
    total: totalPaisa,
    paid: paidPaisa,
    change: data.changePaisa ?? 0,
    balanceDue: balanceDuePaisa,
    footerEnglish: settings.notes.join(' '),
    footerUrdu: '',
  };
}

async function requestReceiptPrint(
  type: PrintRequestType,
  snapshot: PrintSnapshot,
): Promise<void> {
  const receiptRef = snapshot.data.memoNo.trim()
    || `${type}:${crypto.randomUUID()}`;
  if (getBackend() === 'api') {
    await submitPrintRequest(type, receiptRef, snapshot);
    return;
  }
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.rpc('request_print', {
    p_type: type,
    p_receipt_ref: receiptRef,
    p_payload: snapshot,
  });
  if (error) throw new Error(`Could not send print request: ${error.message}`);
  if (typeof data === 'object' && data !== null
    && 'reused_by_other' in data && data.reused_by_other === true) {
    throw new Error('A request for this receipt is already pending under another requester.');
  }
}

export async function printReceipt(
  type: PrintRequestType,
  payload: PrintSnapshot,
  access: PrintReceiptAccess,
  options: PrintReceiptOptions = {},
): Promise<PrintReceiptResult> {
  const snapshot = parsePrintSnapshot(payload);
  if ((type === 'payment') !== (snapshot.data.kind === 'PAYMENT')) {
    throw new Error('Receipt type does not match the receipt snapshot.');
  }
  if (!isPrintSnapshotSafe(snapshot)) {
    throw new Error('Receipt snapshot includes fields that cannot be printed or requested.');
  }

  const hasPermission = canPrintReceipt(access.role, access.permissions, type);
  if (!hasPermission) {
    if (options.autoPrint) {
      access.onNotice('Auto-print is disabled because this account needs admin approval.', true);
      return 'auto-print-disabled';
    }
    await requestReceiptPrint(type, snapshot);
    access.onNotice('Request sent to admin.');
    return 'requested';
  }

  const printSnapshot = options.approvedRequestId
    ? snapshotWithDuplicateLabel(snapshot)
    : snapshot;
  let html: string;
  try {
    html = printSnapshot.template === 'pharmacy-memo'
      ? renderPharmacyMemo(printSnapshot.data, printSnapshot.settings, printSnapshot.format)
      : renderReceipt(printSnapshot.template, printSnapshot.format, classicReceiptData(printSnapshot));
  } catch (error) {
    html = renderReceipt('classic', printSnapshot.format, classicReceiptData(printSnapshot));
    access.onNotice(
      `Pharmacy Memo could not be rendered; the existing Classic receipt was used instead. ${error instanceof Error ? error.message : ''}`,
      true,
    );
  }

  await printHtmlDocument(html);
  if (options.approvedRequestId) {
    if (getBackend() === 'api') {
      await markPrintRequestPrinted(options.approvedRequestId);
    } else {
      if (!supabase) throw new Error('Receipt was sent to the print dialog, but print tracking is unavailable because Supabase is not configured.');
      const { error } = await supabase.rpc('mark_printed_request', {
        p_request_id: options.approvedRequestId,
      });
      if (error) throw new Error(`Receipt was sent to the print dialog, but print tracking failed: ${error.message}`);
    }
  }
  return 'printed';
}
