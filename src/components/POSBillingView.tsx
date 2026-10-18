import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Search,
  ShoppingCart,
  Plus,
  Minus,
  Printer,
  AlertTriangle,
  CheckCircle2,
  Package,
  Sparkles,
  Barcode,
  X,
  Zap,
} from 'lucide-react';
import {
  DrugClass,
  PaymentMethod,
  CartItem,
  UserRole,
  Customer,
  CompletedSale,
  MAX_DISCOUNT_PAISA,
  ROLE_MAX_DISCOUNT,
} from '../types/pharmacy';
import { getBackend } from '../api';
import { allocateFefo, localIsoDate } from '../utils/fefo';
import {
  BillingTemplate,
  PharmacyMemoSettings,
  ReceiptFormat,
  buildMemoData,
} from '../utils/receipt';
import {
  buildPrintSnapshot,
  canPrintReceipt,
  PrintReceiptHandler,
} from '../utils/printWorkflow';
import { APP_NAME } from '../constants/brand';
import { DiscountBox } from './DiscountBox';
import { computeDiscount, DiscountMode, formatDiscountLimit } from '../utils/discount';
import { findProductByScan, normalizeScannedValue, useBarcodeScanner } from '../utils/useBarcodeScanner';
import { loadPosCatalog } from '../data/posCatalog';
import { getRequiredSmallestUnits, type PosCatalogProduct } from '../data/posCatalogLogic';
import { STOCK_CHANGED_EVENT } from '../utils/stockAlertsEvents';
import { getSaleDraftToken, loadPosCustomers, postSale, type PostSaleInput, type PrescriptionDetails } from '../data/sales';
import { SaleReturnsPanel } from './returns/SaleReturnsPanel';

interface POSBillingViewProps {
  customers: Customer[];
  currentUserId: string;
  currentRole: UserRole;
  permissions: readonly string[];
  currentUserName: string;
  companyName: string;
  billingTemplate: BillingTemplate;
  receiptFormat: ReceiptFormat;
  memoSettings: PharmacyMemoSettings;
  onPrintReceipt: PrintReceiptHandler;
  onSaleComplete: (sale: CompletedSale) => void;
  onOpenTemplatePreview: () => void;
}

export const POSBillingView: React.FC<POSBillingViewProps> = ({
  customers,
  currentUserId,
  currentRole,
  permissions,
  companyName,
  billingTemplate,
  receiptFormat,
  memoSettings,
  onPrintReceipt,
  onSaleComplete,
  onOpenTemplatePreview,
}) => {
  const [products, setProducts] = useState<PosCatalogProduct[]>([]);
  const [posCustomers, setPosCustomers] = useState(customers);
  const [posCustomerError, setPosCustomerError] = useState('');
  const [prescriptions, setPrescriptions] = useState<Record<string, PrescriptionDetails>>({});
  const catalogToday = products[0]?.catalogToday ?? localIsoDate();
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [catalogRetry, setCatalogRetry] = useState(0);
  // Top Tabs
  const [activeTopTab, setActiveTopTab] = useState<'sale' | 'quotation' | 'search-quote' | 'barcode'>(
    'sale'
  );

  // Search & Filter
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [selectedBrand, setSelectedBrand] = useState<string>('ALL');

  // Cart
  const [cart, setCart] = useState<CartItem[]>([]);
  const [cartLayout, setCartLayout] = useState<'2-stage' | 'dock' | 'side' | 'quick'>('dock');
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [walkInName, setWalkInName] = useState<string>('Walk-in Customer');

  // Checkout & Cash Tendered
  const [discount, setDiscount] = useState<{ mode: DiscountMode; value: string }>({ mode: 'percent', value: '' });
  const [discountNotice, setDiscountNotice] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'ONLINE' | 'CREDIT' | 'SPLIT'>('CASH');
  const [tenderedAmountPKR, setTenderedAmountPKR] = useState<number>(0);
  const [splitCashPaymentPKR, setSplitCashPaymentPKR] = useState<number>(0);
  const [isPostingSale, setIsPostingSale] = useState(false);
  const [saleDraftToken, setSaleDraftToken] = useState<string | null>(null);
  const [saleError, setSaleError] = useState('');
  const [printNotice, setPrintNotice] = useState('');
  const [barcodeInput, setBarcodeInput] = useState('');
  const { lastScanned, resetScan } = useBarcodeScanner({ enabled: activeTopTab === 'barcode' });

  useEffect(() => {
    let active = true;
    let requestSequence = 0;
    const refreshCatalog = () => {
      const requestId = ++requestSequence;
      setCatalogLoading(true);
      setCatalogError('');
      void loadPosCatalog()
        .then((catalog) => {
          if (active && requestId === requestSequence) setProducts(catalog);
        })
        .catch((error: unknown) => {
          if (active && requestId === requestSequence) {
            setProducts([]);
            setCatalogError(error instanceof Error ? error.message : 'Could not load the POS catalog.');
          }
        })
        .finally(() => {
          if (active && requestId === requestSequence) setCatalogLoading(false);
        });
    };
    const handleStockChanged = () => refreshCatalog();

    refreshCatalog();
    window.addEventListener(STOCK_CHANGED_EVENT, handleStockChanged);
    return () => {
      active = false;
      window.removeEventListener(STOCK_CHANGED_EVENT, handleStockChanged);
    };
  }, [currentUserId, catalogRetry]);

  useEffect(() => {
    if (getBackend() !== 'api') {
      setSaleDraftToken(null);
      return;
    }
    let active = true;
    void getSaleDraftToken()
      .then((token) => {
        if (active) setSaleDraftToken(token);
      })
      .catch((error: unknown) => {
        if (active) {
          setSaleDraftToken(null);
          setSaleError(error instanceof Error ? error.message : 'Unable to open a sale draft.');
        }
      });
    return () => {
      active = false;
    };
  }, [currentUserId]);

  // Modals
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  const [saleCompleteModal, setSaleCompleteModal] = useState<CompletedSale | null>(null);

  useEffect(() => {
    if (getBackend() !== 'api') {
      setPosCustomers(customers);
      setPosCustomerError('');
      return;
    }
    let active = true;
    setPosCustomers([]);
    setSelectedCustomerId('');
    void loadPosCustomers()
      .then((loadedCustomers) => {
        if (!active) return;
        setPosCustomers(loadedCustomers);
        setPosCustomerError('');
        setSelectedCustomerId((currentId) =>
          loadedCustomers.some((customer) => customer.id === currentId) ? currentId : '');
      })
      .catch((error: unknown) => {
        if (active) {
          setPosCustomerError(error instanceof Error ? error.message : 'Could not load POS customers.');
        }
      });
    return () => {
      active = false;
    };
  }, [currentUserId, customers]);

  const categories = useMemo(() => ['ALL', ...Array.from(new Set(products.map((p) => p.category)))], [products]);
  const brands = useMemo(() => ['ALL', ...Array.from(new Set(products.map((p) => p.company)))], [products]);

  // Financial calculations
  const subtotalPaisa = useMemo(() => cart.reduce((sum, item) => sum + item.lineTotalPaisa, 0), [cart]);
  const subtotalPKR = subtotalPaisa / 100;

  const maxAllowedDiscount = ROLE_MAX_DISCOUNT[currentRole];
  const discountResult = useMemo(() => computeDiscount({
    billPaisa: subtotalPaisa,
    mode: discount.mode,
    value: discount.value,
    maxPercent: maxAllowedDiscount,
    maxPaisa: MAX_DISCOUNT_PAISA,
  }), [subtotalPaisa, discount.mode, discount.value, maxAllowedDiscount]);
  const discountPaisa = discountResult.discountPaisa;
  const discountPKR = discountPaisa / 100;

  const unroundedTotalPaisa = discountResult.payablePaisa;
  const roundingUnitPaisa = billingTemplate === 'pharmacy-memo' && memoSettings.roundNet !== 'none'
    ? Number(memoSettings.roundNet) * 100
    : 0;
  const totalPaisa = roundingUnitPaisa
    ? Math.floor(unroundedTotalPaisa / roundingUnitPaisa + 0.5) * roundingUnitPaisa
    : unroundedTotalPaisa;
  const roundingPaisa = totalPaisa - unroundedTotalPaisa;
  const totalPKR = totalPaisa / 100;

  const handleDiscountChange = (next: { mode: DiscountMode; value: string }) => {
    const result = computeDiscount({
      billPaisa: subtotalPaisa,
      mode: next.mode,
      value: next.value,
      maxPercent: maxAllowedDiscount,
      maxPaisa: MAX_DISCOUNT_PAISA,
    });
    if (result.error) {
      setDiscount(next);
      setDiscountNotice(result.error);
      return;
    }
    if (result.limited) {
      const amount = formatDiscountLimit(result.maxDiscountPaisa ?? 0);
      setDiscountNotice(`${next.mode === 'amount' ? 'Maximum discount is' : 'Limited to'} Rs ${amount}`);
      setDiscount(next.mode === 'amount'
        ? { mode: 'amount', value: (result.discountPaisa / 100).toFixed(2) }
        : next);
      return;
    }
    setDiscount(next);
    setDiscountNotice('');
  };

  const tenderedAmountPaisa = Number.isFinite(tenderedAmountPKR)
    ? Math.max(0, Math.round(tenderedAmountPKR * 100))
    : 0;
  const changeDuePaisa = paymentMethod === 'CASH'
    ? Math.max(0, tenderedAmountPaisa - totalPaisa)
    : 0;
  const changeDuePKR = changeDuePaisa / 100;
  const previousTotalPaisa = useRef(totalPaisa);
  const selectPaymentMethod = (method: 'CASH' | 'ONLINE' | 'CREDIT' | 'SPLIT') => {
    setPaymentMethod(method);
    if (method === 'SPLIT') setSplitCashPaymentPKR(Math.floor(totalPaisa / 2) / 100);
  };

  useEffect(() => {
    if (cart.length === 0) {
      if (discount.value !== '' || discount.mode !== 'percent') setDiscount({ mode: 'percent', value: '' });
      if (discountNotice) setDiscountNotice('');
      return;
    }
    if (discountResult.limited && discount.mode === 'amount') {
      const clampedValue = (discountResult.discountPaisa / 100).toFixed(2);
      if (discount.value !== clampedValue) {
        setDiscount({ mode: 'amount', value: clampedValue });
        setDiscountNotice(`Maximum discount is Rs ${formatDiscountLimit(discountResult.maxDiscountPaisa ?? 0)}`);
      }
    } else if (discountResult.limited && discount.mode === 'percent' && !discountNotice) {
      setDiscountNotice(`Limited to Rs ${formatDiscountLimit(discountResult.maxDiscountPaisa ?? 0)}`);
    }
  }, [
    subtotalPaisa,
    cart.length,
    discount.mode,
    discount.value,
    discountResult.limited,
    discountResult.maxDiscountPaisa,
    discountNotice,
  ]);

  useEffect(() => {
    const previousTotal = previousTotalPaisa.current;
    previousTotalPaisa.current = totalPaisa;
    if (previousTotal > 0 && tenderedAmountPaisa === previousTotal) {
      setTenderedAmountPKR(totalPaisa / 100);
    }
  }, [totalPaisa, tenderedAmountPaisa]);

  // Add Product to Cart
  const handleAddToCart = (product: PosCatalogProduct) => {
    const existingItem = cart.find((item) => item.productId === product.id);
    const preferredUnit = existingItem
      ? product.units.find((unit) => unit.id === existingItem.unitId)
      : product.units.find((unit) => unit.isDefaultSaleUnit);
    const firstUnit = preferredUnit ?? product.units[0];
    if (!firstUnit) {
      setSaleError('This product has no configured sale unit.');
      return;
    }
    const unitsToTry = existingItem
      ? [firstUnit]
      : [
          firstUnit,
          ...product.units
            .filter((unit) => unit.id !== firstUnit.id)
            .sort((left, right) => left.conversionFactor - right.conversionFactor),
        ];
    let saleUnit: PosCatalogProduct['units'][number] | undefined;
    let targetBatch: PosCatalogProduct['batches'][number] | undefined;
    let lastAllocationError: unknown;
    const quantity = (existingItem?.quantityInUnit ?? 0) + 1;
    try {
      for (const unit of unitsToTry) {
        try {
          const allocation = allocateFefo(
            product.batches,
            getRequiredSmallestUnits(quantity, unit.conversionFactor),
            catalogToday,
          );
          saleUnit = unit;
          targetBatch = product.batches.find((batch) => batch.id === allocation[0].batchId);
          break;
        } catch (error) {
          lastAllocationError = error;
          if (existingItem) throw error;
        }
      }
      if (!saleUnit) throw lastAllocationError ?? new RangeError('No sale unit can be fulfilled from current stock.');
    } catch (error) {
      setSaleError(error instanceof Error ? error.message : 'Unable to allocate stock for this item.');
      return;
    }
    setSaleError('');

    setCart((prev) => {
      const idx = prev.findIndex((i) => i.productId === product.id);
      if (idx > -1) {
        const copy = [...prev];
        const item = copy[idx];
        const newQty = item.quantityInUnit + 1;
        copy[idx] = {
          ...item,
          quantityInUnit: newQty,
          lineTotalPaisa: newQty * item.mrpPaisaPerUnit,
        };
        return copy;
      }

      const newItem: CartItem = {
        productId: product.id,
        productName: product.brandName,
        genericName: product.genericName,
        batchId: targetBatch?.id || 'batch-1',
        batchNumber: targetBatch?.batchNumber || 'B-01',
        expiryDate: targetBatch?.expiryDate || '2027-12-31',
        drugClass: product.drugClass,
        unitId: saleUnit.id,
        unitName: saleUnit.name,
        conversionFactor: saleUnit.conversionFactor,
        quantityInUnit: 1,
        mrpPaisaPerUnit: saleUnit.pricePerUnitPaisa,
        costPaisaPerUnit: null,
        discountPercent: 0,
        lineTotalPaisa: saleUnit.pricePerUnitPaisa,
      };
      return [...prev, newItem];
    });
  };

  const updateQuantity = (idx: number, delta: number) => {
    const item = cart[idx];
    const product = products.find((candidate) => candidate.id === item?.productId);
    const unit = product?.units.find((candidate) => candidate.id === item.unitId);
    if (!item || !product || !unit) {
      setSaleError('The selected product or sale unit is no longer available. Refresh the POS catalog.');
      return;
    }
    const newQty = item.quantityInUnit + delta;
    if (newQty > 0) {
      try {
        allocateFefo(
          product.batches,
          getRequiredSmallestUnits(newQty, unit.conversionFactor),
          catalogToday,
        );
      } catch (error) {
        setSaleError(error instanceof Error ? error.message : 'Unable to allocate stock for this item.');
        return;
      }
    }
    setCart((prev) => {
      const copy = [...prev];
      if (newQty <= 0) return copy.filter((_, i) => i !== idx);
      copy[idx] = {
        ...item,
        quantityInUnit: newQty,
        lineTotalPaisa: newQty * item.mrpPaisaPerUnit,
      };
      return copy;
    });
    setSaleError('');
  };

  const changeCartUnit = (idx: number, unitId: string) => {
    const item = cart[idx];
    const product = products.find((candidate) => candidate.id === item?.productId);
    const unit = product?.units.find((candidate) => candidate.id === unitId);
    if (!item || !product || !unit) {
      setSaleError('The selected sale unit is unavailable. Refresh the POS catalog.');
      return;
    }
    try {
      allocateFefo(
        product.batches,
        getRequiredSmallestUnits(item.quantityInUnit, unit.conversionFactor),
        catalogToday,
      );
    } catch (error) {
      setSaleError(error instanceof Error ? error.message : 'Unable to allocate stock for this sale unit.');
      return;
    }

    setCart((prev) => prev.map((current, currentIndex) => currentIndex === idx
      ? {
          ...current,
          unitId: unit.id,
          unitName: unit.name,
          conversionFactor: unit.conversionFactor,
          mrpPaisaPerUnit: unit.pricePerUnitPaisa,
          lineTotalPaisa: current.quantityInUnit * unit.pricePerUnitPaisa,
        }
      : current));
    setSaleError('');
  };

  const filteredProducts = products.filter((p) => {
    const matchSearch =
      p.brandName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.genericName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.barcode?.includes(searchQuery) ?? false) ||
      p.code.toLowerCase().includes(searchQuery.toLowerCase());
    const matchCat = selectedCategory === 'ALL' || p.category === selectedCategory;
    const matchBrand = selectedBrand === 'ALL' || p.company === selectedBrand;
    return matchSearch && matchCat && matchBrand;
  });

  const submitBarcode = (rawValue: string) => {
    const normalized = normalizeScannedValue(rawValue);
    if (!normalized) {
      return;
    }

    const match = findProductByScan(products, normalized);
    if (!match) {
      setSaleError(`No product matches barcode "${normalized}".`);
      setBarcodeInput('');
      resetScan();
      return;
    }

    handleAddToCart(match);
    setBarcodeInput('');
    resetScan();
    setSearchQuery('');
    setSelectedCategory('ALL');
    setSelectedBrand('ALL');
  };

  useEffect(() => {
    if (!lastScanned) {
      return;
    }

    submitBarcode(lastScanned);
  }, [lastScanned]);

  const printSaleReceipt = async (sale: CompletedSale, autoPrint = false) => {
    try {
      const snapshot = buildPrintSnapshot(buildMemoData(sale, {
          role: currentRole,
          terminal: memoSettings.terminalName,
        }), {
          ...memoSettings,
          storeName: memoSettings.storeName || companyName,
        }, receiptFormat, billingTemplate);
      const result = await onPrintReceipt('sale', snapshot, { autoPrint });
      setPrintNotice('');
      return result === 'printed' || result === 'requested';
    } catch (error) {
      setPrintNotice(`Receipt printing failed. ${error instanceof Error ? error.message : 'The print document could not be opened.'}`);
      return false;
    }
  };

  const handleCompleteSale = () => {
    if (isPostingSale) return;
    if (cart.length === 0) return;
    const finalDiscount = computeDiscount({
      billPaisa: subtotalPaisa,
      mode: discount.mode,
      value: discount.value,
      maxPercent: maxAllowedDiscount,
      maxPaisa: MAX_DISCOUNT_PAISA,
    });
    if (finalDiscount.error) {
      setDiscountNotice(finalDiscount.error);
      return;
    }
    if (finalDiscount.limited) {
      setDiscountNotice(
        `${discount.mode === 'amount' ? 'Maximum discount is' : 'Limited to'} Rs ${formatDiscountLimit(finalDiscount.maxDiscountPaisa ?? 0)}`,
      );
      return;
    }

    let items: CartItem[];
    try {
      items = cart.map((item) => {
        const product = products.find((candidate) => candidate.id === item.productId);
        if (!product) throw new RangeError(`Product ${item.productName} is no longer available.`);
        const batchAllocations = allocateFefo(
          product.batches,
          getRequiredSmallestUnits(item.quantityInUnit, item.conversionFactor),
          catalogToday
        );
        const firstBatch = product.batches.find((batch) => batch.id === batchAllocations[0].batchId);
        if (!firstBatch) throw new RangeError(`No eligible batch is available for ${item.productName}.`);
        return {
          ...item,
          batchId: firstBatch.id,
          batchNumber: firstBatch.batchNumber,
          expiryDate: firstBatch.expiryDate,
          batchAllocations,
        };
      });
    } catch (error) {
      setSaleError(error instanceof Error ? error.message : 'Unable to allocate stock for this sale.');
      return;
    }

    setSaleError('');
    const customer = posCustomers.find((c) => c.id === selectedCustomerId);
    const splitCashPaisa = Math.round(splitCashPaymentPKR * 100);
    let payments: PostSaleInput['payments'];
    let tenderedPaisa: number;
    if (paymentMethod === 'CREDIT') {
      if (!customer) {
        setSaleError('Select a registered customer before making a credit sale.');
        return;
      }
      payments = [{ paymentMethod: PaymentMethod.CREDIT, amountPaisa: totalPaisa }];
      tenderedPaisa = 0;
    } else if (paymentMethod === 'ONLINE') {
      payments = [{ paymentMethod: PaymentMethod.EASYPAISA, amountPaisa: totalPaisa }];
      tenderedPaisa = totalPaisa;
    } else if (paymentMethod === 'SPLIT') {
      if (splitCashPaisa <= 0 || splitCashPaisa >= totalPaisa) {
        setSaleError('A split payment needs a positive cash amount and a positive online amount.');
        return;
      }
      payments = [
        { paymentMethod: PaymentMethod.CASH, amountPaisa: splitCashPaisa },
        { paymentMethod: PaymentMethod.EASYPAISA, amountPaisa: totalPaisa - splitCashPaisa },
      ];
      tenderedPaisa = totalPaisa;
    } else {
      tenderedPaisa = tenderedAmountPaisa || totalPaisa;
      if (tenderedPaisa < totalPaisa) {
        setSaleError('Tendered cash cannot be less than the bill total.');
        return;
      }
      payments = [{ paymentMethod: PaymentMethod.CASH, amountPaisa: totalPaisa }];
    }

    const saleItems: PostSaleInput['items'] = [];
    for (const item of items) {
      if (!item.unitId) {
        setSaleError(`Choose a configured sale unit for ${item.productName}.`);
        return;
      }
      const product = products.find((candidate) => candidate.id === item.productId);
      const requiresPrescription = getBackend() === 'api'
        && (product?.requiresPrescription === true
          || product?.drugClass === DrugClass.CONTROLLED
          || product?.drugClass === DrugClass.NARCOTIC);
      const prescription = prescriptions[item.productId];
      if (requiresPrescription && (!prescription
        || !prescription.prescriber.trim() || !prescription.patient.trim() || !prescription.reference.trim())) {
        setSaleError(`Enter prescriber, patient, and reference details for ${item.productName}.`);
        return;
      }
      saleItems.push({
        medicineId: item.productId,
        unitId: item.unitId,
        quantityInUnit: item.quantityInUnit,
        ...(requiresPrescription && prescription ? {
          prescription: {
            prescriber: prescription.prescriber.trim(),
            patient: prescription.patient.trim(),
            reference: prescription.reference.trim(),
          },
        } : {}),
      });
    }
    const saleInput: PostSaleInput = {
      ...(saleDraftToken ? { saleDraftToken } : {}),
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? walkInName,
      items: saleItems,
      discountPaisa,
      roundingPaisa,
      tenderedPaisa,
      payments,
    };

    setIsPostingSale(true);
    void postSale(saleInput).then((sale) => {
      onSaleComplete(sale);
      setShowCheckoutModal(false);
      setSaleCompleteModal(sale);
      if (memoSettings.autoPrint) {
        if (canPrintReceipt(currentRole, permissions, 'sale')) {
          window.setTimeout(() => { void printSaleReceipt(sale, true); }, 0);
        } else {
          setPrintNotice('Auto-print is disabled for this account. Use Request print to ask an admin.');
        }
      }
      setCart([]);
      setSaleDraftToken(null);
      if (getBackend() === 'api') {
        void getSaleDraftToken()
          .then(setSaleDraftToken)
          .catch((error: unknown) => {
            setSaleError(error instanceof Error ? error.message : 'Unable to open the next sale draft.');
          });
      }
      setDiscount({ mode: 'percent', value: '' });
      setTenderedAmountPKR(0);
      setPrescriptions({});
    }).catch((error: unknown) => {
      setSaleError(error instanceof Error ? error.message : 'Could not complete the sale.');
    }).finally(() => setIsPostingSale(false));
  };

  const requiredPrescriptionProducts = Array.from(new Map(cart
    .map((item) => products.find((product) => product.id === item.productId))
    .filter((product): product is PosCatalogProduct => product !== undefined)
    .filter((product) => getBackend() === 'api'
      && (product.requiresPrescription === true
        || product.drugClass === DrugClass.CONTROLLED
        || product.drugClass === DrugClass.NARCOTIC))
    .map((product) => [product.id, product])).values());

  return (
    <div className="space-y-4">
      {saleError && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {saleError}
        </div>
      )}
      {printNotice && <p role="status" className="rounded-control border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-text">{printNotice}</p>}
      {/* ── Top Tabs (Sale, Quotation, Search Quotation, Barcode Scan) ──────── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1.5 bg-white p-1 rounded-xl border border-slate-200/90 shadow-xs">
          <button
            onClick={() => setActiveTopTab('sale')}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
              activeTopTab === 'sale'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <span>🟦 Sale</span>
          </button>
          <button
            onClick={() => setActiveTopTab('quotation')}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
              activeTopTab === 'quotation'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <span>📄 Quotation</span>
          </button>
          <button
            onClick={() => setActiveTopTab('search-quote')}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
              activeTopTab === 'search-quote'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <span>🔍 Search Quotation</span>
          </button>
          <button
            onClick={() => setActiveTopTab('barcode')}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
              activeTopTab === 'barcode'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Barcode className="w-3.5 h-3.5" />
            <span>Barcode Scan</span>
          </button>
        </div>

        {/* Template Preview Launcher */}
        <button
          onClick={onOpenTemplatePreview}
          className="px-3.5 py-1.5 text-xs font-bold bg-white hover:bg-slate-50 border border-slate-300 text-slate-800 rounded-xl shadow-xs flex items-center gap-1.5 transition"
        >
          <Sparkles className="w-3.5 h-3.5 text-blue-600" />
          <span>Quick View Template Preview</span>
        </button>
      </div>

      {/* ── Main Split View ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left 7 Cols: Product Catalog & Fast Search */}
        <div className="lg:col-span-7 space-y-3">
          {catalogError && (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 flex items-center justify-between gap-3">
              <span>{catalogError}</span>
              <button
                type="button"
                onClick={() => setCatalogRetry((retry) => retry + 1)}
                className="shrink-0 rounded-lg border border-red-300 bg-white px-2.5 py-1 font-bold text-red-800"
              >
                Retry
              </button>
            </div>
          )}
          {/* Search Bar & Filters (Matching Screenshot 7) */}
          <div className="bg-white p-3 rounded-2xl border border-slate-200/90 shadow-xs flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Search products / brand (F2)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-blue-600 font-medium"
                autoFocus
              />
            </div>

            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-blue-600 bg-white text-slate-800"
            >
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c === 'ALL' ? 'All Categories' : c}
                </option>
              ))}
            </select>

            <select
              value={selectedBrand}
              onChange={(e) => setSelectedBrand(e.target.value)}
              className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-blue-600 bg-white text-slate-800"
            >
              {brands.map((b) => (
                <option key={b} value={b}>
                  {b === 'ALL' ? 'All Brands' : b}
                </option>
              ))}
            </select>
          </div>

          {activeTopTab === 'barcode' && (
            <div className="rounded-2xl border border-blue-200 bg-blue-50/60 p-3 shadow-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-bold text-blue-700">
                  <Barcode className="h-4 w-4" />
                  Barcode scanner mode
                </div>
                <button
                  type="button"
                  onClick={() => setBarcodeInput('')}
                  className="rounded-lg border border-blue-200 bg-white px-2 py-1 text-[10px] font-semibold text-blue-700"
                >
                  Clear
                </button>
              </div>

              <div className="mt-2 flex gap-2">
                <input
                  type="text"
                  value={barcodeInput}
                  placeholder="Scan barcode or type here"
                  onChange={(event) => setBarcodeInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                    }
                  }}
                  className="flex-1 rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs font-medium text-slate-800 focus:outline-blue-600"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => submitBarcode(barcodeInput)}
                  className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-bold text-white shadow-xs hover:bg-blue-700"
                >
                  Add item
                </button>
              </div>

              <p className="mt-2 text-[10px] text-slate-600">
                Keyboard scanner input is captured automatically and matched against the product barcode or internal code.
              </p>
            </div>
          )}

          {/* Product Chips Grid (Matching Screenshot 7) */}
          <div className="pos-product-grid grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-[580px] overflow-y-auto pr-1">
            {catalogLoading && products.length === 0 && (
              <div role="status" className="col-span-full rounded-xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-500">
                Loading live product catalog...
              </div>
            )}
            {filteredProducts.map((p) => {
              const defaultUnit = p.units.find((u) => u.isDefaultSaleUnit) || p.units[0];
              const totalStock = p.batches.reduce((sum, b) => sum + b.quantitySmallestUnit, 0);

              return (
                <button
                  key={p.id}
                  onClick={() => handleAddToCart(p)}
                  className="pos-product-card bg-white p-3 rounded-xl border border-slate-200/90 hover:border-blue-500 shadow-xs hover:shadow-sm text-left transition flex flex-col justify-between group h-28"
                >
                  <div>
                    <span className="font-bold text-xs text-slate-900 group-hover:text-blue-600 transition block truncate">
                      {p.brandName}
                    </span>
                    {p.strength && (
                      <span className="text-[10px] text-slate-500 block truncate">{p.strength}</span>
                    )}
                    <span className="text-[10px] text-slate-500 block truncate">
                      {p.genericName} • {p.company}
                    </span>
                  </div>

                  <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
                    <div>
                      <span className="text-xs font-mono font-black text-slate-900 block">
                        Rs. {(defaultUnit.pricePerUnitPaisa / 100).toFixed(0)}
                      </span>
                      <span className="text-[9px] text-slate-500 font-mono">
                        Stock: {totalStock}
                      </span>
                    </div>
                    <span className="pos-add-indicator w-6 h-6 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-xs group-hover:bg-blue-600 group-hover:text-white transition">
                      +
                    </span>
                  </div>
                </button>
              );
            })}
            {!catalogLoading && !catalogError && filteredProducts.length === 0 && (
              <div className="col-span-full rounded-xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-500">
                {products.length === 0 ? 'No sellable products are available.' : 'No products match your search.'}
              </div>
            )}
          </div>
        </div>

        {/* Right 5 Cols: Cart & Checkout Bar (Matching Screenshot 7, 8, 61, 62) */}
        <div className="lg:col-span-5 bg-white p-4 rounded-2xl border border-slate-200/90 shadow-xs flex flex-col justify-between">
          <div>
            {/* Top Cart Header & Layout Switches (Matching Screenshot 7) */}
            <div className="flex items-center justify-between pb-2.5 border-b border-slate-100 mb-3">
              <div className="flex items-center gap-2">
                <ShoppingCart className="w-4 h-4 text-blue-600" />
                <span className="pos-cart-count text-xs font-black text-slate-900" key={cart.reduce((sum, i) => sum + i.quantityInUnit, 0)}>
                  Cart ({cart.reduce((sum, i) => sum + i.quantityInUnit, 0)})
                </span>
              </div>

              {/* Layout Switcher Pills */}
              <div className="flex items-center bg-slate-100 p-0.5 rounded-lg text-[10px] font-bold text-slate-600">
                <button
                  onClick={() => setCartLayout('2-stage')}
                  className={`px-2 py-0.5 rounded ${
                    cartLayout === '2-stage' ? 'bg-blue-600 text-white shadow-xs' : ''
                  }`}
                >
                  2-Stage
                </button>
                <button
                  onClick={() => setCartLayout('dock')}
                  className={`px-2 py-0.5 rounded ${
                    cartLayout === 'dock' ? 'bg-blue-600 text-white shadow-xs' : ''
                  }`}
                >
                  Dock
                </button>
                <button
                  onClick={() => setCartLayout('side')}
                  className={`px-2 py-0.5 rounded ${
                    cartLayout === 'side' ? 'bg-blue-600 text-white shadow-xs' : ''
                  }`}
                >
                  Side
                </button>
                <button
                  onClick={() => setCartLayout('quick')}
                  className={`px-2 py-0.5 rounded ${
                    cartLayout === 'quick' ? 'bg-blue-600 text-white shadow-xs' : ''
                  }`}
                >
                  Quick
                </button>
              </div>
              <SaleReturnsPanel
                canReview={(currentRole === UserRole.MANAGER || currentRole === UserRole.ADMIN)
                  && permissions.includes('sales_history')}
                canRestock={permissions.includes('stock_inventory')}
              />
            </div>

            {/* Customer Select Row (Matching Screenshot 7) */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div className="relative">
                <select
                  value={selectedCustomerId}
                  onChange={(e) => setSelectedCustomerId(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-blue-600 bg-white font-medium text-slate-800"
                >
                  <option value="">👤 Walk-in Customer</option>
                  {posCustomers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {posCustomerError && <p role="status" className="mt-1 text-xs text-warning">{posCustomerError}</p>}
              </div>

              <input
                type="text"
                placeholder="Walk-in Name"
                value={walkInName}
                onChange={(e) => setWalkInName(e.target.value)}
                className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-blue-600"
              />
            </div>

            {/* Cart Items List (Matching Screenshot 8) */}
            <div className="space-y-1.5 max-h-[240px] overflow-y-auto pr-1">
              {cart.length === 0 ? (
                <div className="py-12 text-center text-slate-400 text-xs">
                  <Package className="w-8 h-8 mx-auto mb-1 text-slate-300" />
                  Cart is empty
                  <p className="text-[10px] text-slate-400">Click products on left panel to add</p>
                </div>
              ) : (
                cart.map((item, idx) => (
                  <div
                    key={`${item.productId}-${idx}`}
                    className="pos-cart-item p-2 rounded-xl bg-slate-50 border border-slate-200/80 flex items-center justify-between text-xs"
                  >
                    <div className="flex-1 pr-2 truncate">
                      <div className="font-bold text-slate-900 truncate">{item.productName}</div>
                      <div className="text-[10px] text-slate-500 font-mono">
                        Rs. {(item.mrpPaisaPerUnit / 100).toFixed(0)} × {item.quantityInUnit} · {item.unitName}
                      </div>
                      {products.find((product) => product.id === item.productId)?.units.length ? (
                        <label className="mt-1 block max-w-44">
                          <span className="sr-only">Sale unit for {item.productName}</span>
                          <select
                            value={item.unitId ?? ''}
                            onChange={(event) => changeCartUnit(idx, event.target.value)}
                            className="w-full rounded border border-slate-300 bg-white px-1.5 py-1 text-[10px] text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                          >
                            {products.find((product) => product.id === item.productId)?.units.map((unit) => (
                              <option key={unit.id} value={unit.id}>
                                {unit.name} · {unit.conversionFactor} base units · Rs. {(unit.pricePerUnitPaisa / 100).toFixed(2)}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                    </div>

                    <div className="flex items-center gap-2">
                      <div className="flex items-center border border-slate-300 rounded bg-white">
                        <button
                          onClick={() => updateQuantity(idx, -1)}
                          className="px-1.5 py-0.5 text-slate-600 hover:bg-slate-100"
                        >
                          <Minus className="w-2.5 h-2.5" />
                        </button>
                        <span className="px-1.5 font-mono font-bold text-xs">
                          {item.quantityInUnit}
                        </span>
                        <button
                          onClick={() => updateQuantity(idx, 1)}
                          className="px-1.5 py-0.5 text-slate-600 hover:bg-slate-100"
                        >
                          <Plus className="w-2.5 h-2.5" />
                        </button>
                      </div>

                      <span className="font-mono font-bold text-slate-900 min-w-[50px] text-right">
                        Rs. {(item.lineTotalPaisa / 100).toFixed(0)}
                      </span>

                      <button
                        onClick={() => updateQuantity(idx, -item.quantityInUnit)}
                        className="text-slate-400 hover:text-red-500 p-0.5"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* ── Bottom Dock Checkout Panel (Matching Screenshot 8, 61, 62) ─── */}
          <div className="mt-4 pt-3 border-t border-slate-200 space-y-2.5">
            {/* Subtotal & Quick Discount Row */}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-slate-600 font-medium">
                Subtotal ({cart.reduce((sum, i) => sum + i.quantityInUnit, 0)} sale units):{' '}
                <strong className="text-slate-900 font-mono">Rs. {subtotalPKR.toFixed(0)}</strong>
              </span>
              <div className="flex items-center gap-1.5 text-slate-600 font-semibold">
                <span>Disc:</span>
                <label className="inline-flex items-center gap-1 rounded-control border border-border bg-surface px-2 text-text focus-within:ring-2 focus-within:ring-accent">
                  <span className="text-muted">Rs.</span>
                  <input
                    aria-label="Cart discount amount"
                    type="text"
                    inputMode="decimal"
                    value={discount.mode === 'amount' ? discount.value : discountPKR.toFixed(2)}
                    disabled={cart.length === 0}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (!/^\d*(?:\.\d{0,2})?$/.test(value)) {
                        setDiscountNotice('Enter a valid discount.');
                        return;
                      }
                      handleDiscountChange({ mode: 'amount', value });
                    }}
                    className="w-20 min-w-0 bg-transparent py-1 font-mono text-text outline-none disabled:cursor-not-allowed"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => handleDiscountChange({ mode: 'amount', value: '' })}
                  className="rounded-control px-1.5 py-1 text-xs font-semibold text-muted hover:bg-surface disabled:cursor-not-allowed"
                  disabled={cart.length === 0}
                >
                  Clear
                </button>
                {cart.length === 0 && <span className="text-muted">Add items first</span>}
              </div>

              {/* Quick Discount Pills */}
              <div className="pos-discount-options flex items-center gap-1 text-[10px]">
                {[0, 2, 5, 10, 15, 20].map((pct) => (
                  <button
                    key={pct}
                    onClick={() => handleDiscountChange({ mode: 'percent', value: String(pct) })}
                    disabled={cart.length === 0}
                    aria-pressed={discount.mode === 'percent' && Number(discount.value || 0) === pct}
                    className={`px-1.5 py-0.5 rounded font-bold transition ${
                      discount.mode === 'percent' && Number(discount.value || 0) === pct
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                    }`}
                  >
                    {pct === 0 ? '0' : `${pct}%`}
                  </button>
                ))}
              </div>
            </div>
            {discountNotice && cart.length > 0 && (
              <p role="alert" className="text-xs font-semibold text-danger">{discountNotice}</p>
            )}

            {/* NET TOTAL */}
            <div className="flex items-center justify-between py-1 bg-slate-50 px-2.5 rounded-lg border border-slate-200">
              <span className="text-xs font-black uppercase text-slate-700 tracking-wider">
                NET TOTAL
              </span>
              <span className="pos-total-value text-base font-black font-mono text-slate-950" key={totalPKR}>
                Rs. {totalPKR.toFixed(2)}
              </span>
            </div>

            {/* Tendered Cash & Quick Cash Pills (Matching Screenshot 62) */}
            {paymentMethod === 'CASH' && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <div className="flex flex-1 items-center gap-1">
                  <span className="text-[11px] font-semibold text-muted">Tendered:</span>
                  <input
                    type="number"
                    min={totalPKR}
                    step="0.01"
                    placeholder="0"
                    value={tenderedAmountPKR || ''}
                    onChange={(e) => setTenderedAmountPKR(Number(e.target.value))}
                    className="w-20 rounded-control border border-border bg-surface px-2 py-1 font-mono text-xs font-bold text-text"
                  />
                  <button
                    type="button"
                    onClick={() => setTenderedAmountPKR(totalPKR)}
                    className="rounded-control bg-primary px-2 py-1 text-[10px] font-bold text-white"
                  >
                    Exact
                  </button>
                </div>
                <div className="flex items-center gap-1 text-[10px]">
                  {[50, 100, 500, 1000, 5000].map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => setTenderedAmountPKR(amt)}
                      className="rounded-control border border-border bg-surface px-1.5 py-0.5 font-semibold text-text hover:bg-surface-muted"
                    >
                      Rs.{amt}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {paymentMethod === 'SPLIT' && (
              <p className="text-xs text-muted">Set cash and online amounts in the checkout window.</p>
            )}

            {/* Change Due Banner (Wapis Karein) (Matching Screenshot 10, 62) */}
            {changeDuePKR > 0 && (
              <div className="p-2 bg-emerald-50 rounded-lg border border-emerald-300 text-xs flex items-center justify-between text-emerald-950">
                <span className="font-bold flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-emerald-600" />
                  Wapis Karein (Change Due):
                </span>
                <span className="text-sm font-black font-mono text-emerald-800">
                  Rs. {changeDuePKR.toFixed(2)}
                </span>
              </div>
            )}

            {/* Payment Methods Chips (Matching Screenshot 61) */}
            <div className="pos-payment-methods grid grid-cols-4 gap-1.5 text-xs pt-1">
              <button
                onClick={() => selectPaymentMethod('CASH')}
                aria-pressed={paymentMethod === 'CASH'}
                className={`py-1 rounded-lg border font-bold text-[11px] transition ${
                  paymentMethod === 'CASH'
                    ? 'bg-emerald-600 text-white border-emerald-700'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                }`}
              >
                Cash
              </button>
              <button
                onClick={() => selectPaymentMethod('ONLINE')}
                aria-pressed={paymentMethod === 'ONLINE'}
                className={`py-1 rounded-lg border font-bold text-[11px] transition ${
                  paymentMethod === 'ONLINE'
                    ? 'bg-blue-600 text-white border-blue-700'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                }`}
              >
                Online
              </button>
              <button
                onClick={() => selectPaymentMethod('CREDIT')}
                aria-pressed={paymentMethod === 'CREDIT'}
                className={`py-1 rounded-lg border font-bold text-[11px] transition ${
                  paymentMethod === 'CREDIT'
                    ? 'bg-amber-600 text-white border-amber-700'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                }`}
              >
                Credit
              </button>
              <button
                onClick={() => selectPaymentMethod('SPLIT')}
                aria-pressed={paymentMethod === 'SPLIT'}
                className={`py-1 rounded-lg border font-bold text-[11px] transition ${
                  paymentMethod === 'SPLIT'
                    ? 'bg-purple-600 text-white border-purple-700'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                }`}
              >
                Split
              </button>
            </div>

            {/* Charge / Complete Sale Button (Matching Screenshot 8, 62) */}
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={() => setShowCheckoutModal(true)}
                disabled={cart.length === 0}
                className="pos-charge-button relative flex-1 overflow-hidden py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white font-black text-xs rounded-xl shadow-md shadow-blue-600/25 flex items-center justify-center gap-1.5 transition disabled:opacity-50"
              >
                <Zap className="w-3.5 h-3.5" />
                <span>Charge Rs. {totalPKR.toFixed(2)} (F4)</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Pharma Care checkout modal ─────────────────────────────────────── */}
      {showCheckoutModal && (
        <div className="pos-modal-backdrop fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div
            className="pos-modal-panel flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setShowCheckoutModal(false);
              } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
                event.preventDefault();
                handleCompleteSale();
              }
            }}
          >
            {/* Modal Header */}
            <div className="bg-blue-600 text-white p-4 flex items-center justify-between">
              <div>
                <span className="text-[10px] font-bold text-blue-200 uppercase tracking-wider block">
                  {APP_NAME.toUpperCase()} CHECKOUT
                </span>
                <span className="text-base font-black">
                  Total Payable: Rs. {totalPKR.toFixed(2)}
                </span>
              </div>
              <button
                onClick={() => setShowCheckoutModal(false)}
                className="text-white/80 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex min-h-0 flex-col space-y-4 overflow-y-auto p-5 text-xs">
              <div className="order-1 text-slate-600 font-medium">
                Customer: <strong>{walkInName}</strong>
              </div>

              <DiscountBox
                billPaisa={subtotalPaisa}
                discount={discount}
                maxPercent={maxAllowedDiscount}
                maxPaisa={MAX_DISCOUNT_PAISA}
                notice={discountNotice}
                onChange={handleDiscountChange}
              />

              {requiredPrescriptionProducts.length > 0 && (
                <fieldset className="order-2 space-y-3 rounded-control border border-border bg-surface-muted p-3">
                  <legend className="px-1 font-bold text-text">Prescription details required</legend>
                  {requiredPrescriptionProducts.map((product) => {
                    const details = prescriptions[product.id] ?? { prescriber: '', patient: '', reference: '' };
                    return (
                      <div key={product.id} className="space-y-2">
                        <p className="font-semibold text-text">{product.brandName}</p>
                        <label className="block text-muted">Prescriber
                          <input
                            value={details.prescriber}
                            onChange={(event) => setPrescriptions((current) => ({
                              ...current,
                              [product.id]: { ...details, prescriber: event.target.value },
                            }))}
                            className="mt-1 w-full rounded-control border border-border bg-surface px-3 py-2 text-text"
                            maxLength={160}
                            aria-required="true"
                          />
                        </label>
                        <label className="block text-muted">Patient
                          <input
                            value={details.patient}
                            onChange={(event) => setPrescriptions((current) => ({
                              ...current,
                              [product.id]: { ...details, patient: event.target.value },
                            }))}
                            className="mt-1 w-full rounded-control border border-border bg-surface px-3 py-2 text-text"
                            maxLength={160}
                            aria-required="true"
                          />
                        </label>
                        <label className="block text-muted">Prescription reference
                          <input
                            value={details.reference}
                            onChange={(event) => setPrescriptions((current) => ({
                              ...current,
                              [product.id]: { ...details, reference: event.target.value },
                            }))}
                            className="mt-1 w-full rounded-control border border-border bg-surface px-3 py-2 text-text"
                            maxLength={160}
                            aria-required="true"
                          />
                        </label>
                      </div>
                    );
                  })}
                </fieldset>
              )}

              {paymentMethod === 'CASH' && <div className="order-2">
                <div className="flex justify-between font-bold text-slate-700 mb-1">
                  <span>RECEIVED / TENDERED AMOUNT</span>
                  <span className="font-mono">Bill: Rs. {totalPKR.toFixed(2)}</span>
                </div>
                <input
                  type="number"
                  step="0.01"
                  placeholder="0"
                  value={tenderedAmountPKR || ''}
                  onChange={(e) => setTenderedAmountPKR(Number(e.target.value))}
                  className="w-full px-3 py-2 text-base font-black font-mono border-2 border-blue-500 rounded-xl focus:outline-none"
                />
              </div>}
              {paymentMethod === 'SPLIT' && (
                <div className="order-2 grid grid-cols-1 gap-3 rounded-control border border-border bg-surface-muted p-3 sm:grid-cols-2">
                  <label className="text-sm font-semibold text-text">
                    Cash portion (Rs)
                    <input
                      type="number"
                      min="0.01"
                      max={Math.max(0, totalPKR - 0.01)}
                      step="0.01"
                      value={splitCashPaymentPKR || ''}
                      onChange={(event) => setSplitCashPaymentPKR(Number(event.target.value))}
                      className="mt-1 w-full rounded-control border border-border bg-surface px-3 py-2 font-mono text-text"
                    />
                  </label>
                  <p className="self-end text-sm text-text">
                    Online portion: Rs. {(Math.max(0, totalPaisa - Math.round(splitCashPaymentPKR * 100)) / 100).toFixed(2)}
                  </p>
                  <p className="text-xs text-muted sm:col-span-2">Both amounts must be greater than zero. Split payments record exact cash and online portions.</p>
                </div>
              )}

              {/* Quick Cash pills */}
              {paymentMethod === 'CASH' && <div className="order-3 flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => setTenderedAmountPKR(totalPKR)}
                  className="px-2.5 py-1 text-[11px] font-bold bg-emerald-600 text-white rounded-lg"
                >
                  Exact (Rs. {totalPKR.toFixed(2)})
                </button>
                {[100, 500, 1000, 5000].map((amt) => (
                  <button
                    key={amt}
                    onClick={() => setTenderedAmountPKR(amt)}
                    className="px-2.5 py-1 text-[11px] font-semibold bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg border border-slate-200"
                  >
                    Rs. {amt}
                  </button>
                ))}
              </div>}

              {/* Change Banner */}
              {discountPaisa > 0 && (
                <div className="order-5 flex items-center justify-between rounded-control border border-border bg-surface px-3 py-2 font-semibold text-text">
                  <span>Discount</span>
                  <span className="font-mono">-Rs. {discountPKR.toFixed(2)}</span>
                </div>
              )}

              {changeDuePaisa > 0 && (
                <div className="order-6 p-2.5 bg-emerald-50 rounded-xl border border-emerald-300 flex items-center justify-between text-emerald-950">
                  <span className="font-bold">Wapis Karein (Change Due):</span>
                  <span className="text-base font-black font-mono text-emerald-700">
                    Rs. {changeDuePKR.toFixed(2)}
                  </span>
                </div>
              )}

              {/* Payment Method Selector */}
              <div className="order-7">
                <span className="text-[10px] font-bold text-slate-500 uppercase block mb-1">
                  PAYMENT METHOD
                </span>
                <div className="grid grid-cols-4 gap-1.5 text-xs">
                  {(['CASH', 'ONLINE', 'CREDIT', 'SPLIT'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => selectPaymentMethod(m)}
                      className={`py-1.5 rounded-lg border font-bold text-[11px] ${
                        paymentMethod === m
                          ? 'bg-blue-600 text-white border-blue-700'
                          : 'bg-slate-50 text-slate-700 border-slate-200'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>

              <div className="order-8 pt-2 flex items-center gap-2">
                <button
                  onClick={() => setShowCheckoutModal(false)}
                  className="flex-1 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl"
                >
                  ← Back to Cart
                </button>
                <button
                  onClick={handleCompleteSale}
                  disabled={isPostingSale}
                  className="flex-1 py-2.5 text-xs font-black text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-md transition disabled:opacity-60"
                >
                  {isPostingSale ? 'Saving sale…' : `✓ Complete Sale (Rs. ${totalPKR.toFixed(2)})`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Sale Complete Dialog (Matching Screenshot 11 & 65) ─────────────── */}
      {saleCompleteModal && (
        <div className="pos-modal-backdrop fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="pos-modal-panel bg-white rounded-2xl max-w-xs w-full p-6 text-center space-y-4 shadow-2xl border border-slate-200">
            <div className="pos-sale-success relative w-12 h-12 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto">
              <CheckCircle2 className="pos-success-check w-8 h-8" />
            </div>

            <div>
              <h3 className="text-base font-black text-slate-900">Sale Complete!</h3>
              <p className="text-xs text-slate-500">{saleCompleteModal.paymentMethod} sale</p>
            </div>

            {saleCompleteModal.changePaisa > 0 && (
              <div className="p-3 bg-emerald-600 text-white rounded-xl">
                <span className="text-[10px] font-bold uppercase tracking-wider block">
                  WAPIS KAREIN (CHANGE DUE)
                </span>
                <span className="text-xl font-black font-mono">
                  Rs. {(saleCompleteModal.changePaisa / 100).toFixed(0)}
                </span>
                <div className="text-[10px] text-emerald-100 mt-1">
                  Paid Rs. {(saleCompleteModal.amountTenderedPaisa / 100).toFixed(0)} • Total Rs.{' '}
                  {(saleCompleteModal.totalPaisa / 100).toFixed(0)}
                </div>
              </div>
            )}

            <div className="py-2 border-y border-slate-100 text-xs space-y-1">
              <div className="flex justify-between text-slate-500">
                <span>Invoice:</span>
                <span className="font-mono font-bold text-slate-800">
                  {saleCompleteModal.invoiceNumber}
                </span>
              </div>
              <div className="flex justify-between font-bold text-slate-900">
                <span>Total:</span>
                <span className="font-mono">
                  Rs. {(saleCompleteModal.totalPaisa / 100).toFixed(0)}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  void printSaleReceipt(saleCompleteModal).then((completed) => {
                    if (completed) setSaleCompleteModal(null);
                  });
                }}
                className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 transition"
              >
                <Printer className="w-4 h-4" /> {canPrintReceipt(currentRole, permissions, 'sale') ? 'Print Receipt' : 'Request print'}
              </button>
              <button
                onClick={() => setSaleCompleteModal(null)}
                className="w-full py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-100 rounded-lg"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
