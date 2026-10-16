import React, { Component, lazy, Suspense, useState, useEffect } from 'react';
import {
  Customer,
  CashTransaction,
  CompletedSale,
  PaymentMethod,
  LedgerEntry,
} from './types/pharmacy';
import {
  INITIAL_PRODUCTS,
} from './data/mockPharmacyData';
import {
  loadCustomerAccountsSummary,
  loadPosCustomers,
  loadSalesHistory,
  recordCustomerPayment,
  saveCustomer,
} from './data/sales';
import { Sidebar, NavItemKey } from './components/Sidebar';
import { TopNav } from './components/TopNav';
import { DashboardView } from './components/DashboardView';
import { LoginView } from './components/LoginView';
import type { ProductFilter } from './components/InventoryScreen';
import { AuthSession, refreshAuthSession, restoreAuthSession, signOut } from './utils/auth';
import { getBackend, isUnauthenticatedApiError } from './api';
import { supabase } from './utils/supabase';
import { isAdminRole, PermissionsProvider, usePermissions } from './permissions';
import {
  BillingPreferences,
  BillingTemplate,
  DEFAULT_PHARMACY_MEMO_SETTINGS,
  ReceiptFormat,
  PharmacyMemoSettings,
  readBillingPreferencesWithMigration,
  saveBillingPreferences,
} from './utils/receipt';
import {
  readCompanyName,
  readPharmacyMemoSettings,
  saveCompanyName,
  savePharmacyMemoSettings,
} from './utils/storeSettings';
import { loadShopSettings, updateShopSettings } from './data/shopSettings';
import type { ShopProfile } from './data/shopSettings';
import { createCashExpense, loadCashBook } from './data/finance';
import { loadPendingPrintCount } from './data/printRequests';
import PharmaLogo from './components/PharmaLogo';
import type { PrintReceiptHandler } from './utils/printWorkflow';
import { STOCK_CHANGED_EVENT } from './utils/stockAlertsEvents';

const POSBillingView = lazy(() => import('./components/POSBillingView').then(({ POSBillingView: View }) => ({ default: View })));
const InventoryScreen = lazy(() => import('./components/InventoryScreen').then(({ InventoryScreen: View }) => ({ default: View })));
const MasterDataView = lazy(() => import('./components/MasterDataView').then(({ MasterDataView: View }) => ({ default: View })));
const WhatsAppRemindersView = lazy(() => import('./components/WhatsAppRemindersView').then(({ WhatsAppRemindersView: View }) => ({ default: View })));
const CustomerLedgerScreen = lazy(() => import('./components/CustomerLedgerScreen').then(({ CustomerLedgerScreen: View }) => ({ default: View })));
const ReportsScreen = lazy(() => import('./components/ReportsScreen').then(({ ReportsScreen: View }) => ({ default: View })));
const CashBookScreen = lazy(() => import('./components/CashBookScreen').then(({ CashBookScreen: View }) => ({ default: View })));
const SettingsView = lazy(() => import('./components/SettingsView').then(({ SettingsView: View }) => ({ default: View })));
const SuppliersView = lazy(() => import('./components/SuppliersView').then(({ SuppliersView: View }) => ({ default: View })));
const StockPurchaseView = lazy(() => import('./components/StockPurchaseView').then(({ StockPurchaseView: View }) => ({ default: View })));
const PurchaseHistoryView = lazy(() => import('./components/PurchaseHistoryView').then(({ PurchaseHistoryView: View }) => ({ default: View })));
const HelpSupportView = lazy(() => import('./components/HelpSupportView').then(({ HelpSupportView: View }) => ({ default: View })));
const TrashBinView = lazy(() => import('./components/TrashBinView').then(({ TrashBinView: View }) => ({ default: View })));
const ManageUsersView = lazy(() => import('./components/ManageUsersView').then(({ ManageUsersView: View }) => ({ default: View })));
const ChangePasswordModal = lazy(() => import('./components/ManageUsersView').then(({ ChangePasswordModal: View }) => ({ default: View })));
const MyPrintRequestsView = lazy(() => import('./components/MyPrintRequestsView').then(({ MyPrintRequestsView: View }) => ({ default: View })));
const PrintRequestsAdminView = lazy(() => import('./components/PrintRequestsAdminView').then(({ PrintRequestsAdminView: View }) => ({ default: View })));
const TemplatePreviewModal = lazy(() => import('./components/TemplatePreviewModal').then(({ TemplatePreviewModal: View }) => ({ default: View })));
const EndOfDayModal = lazy(() => import('./components/EndOfDayModal').then(({ EndOfDayModal: View }) => ({ default: View })));

const NAV_PATHS: Record<NavItemKey, string> = {
  dashboard: '/',
  pos: '/pos',
  products: '/products',
  'master-data': '/categories',
  'stock-inventory': '/stock-inventory',
  customers: '/customers',
  'customer-ledger': '/customer-ledger',
  'whatsapp-reminders': '/whatsapp-reminders',
  'sales-history': '/sales-history',
  suppliers: '/suppliers',
  purchases: '/purchases',
  'purchase-history': '/purchase-history',
  expenses: '/expenses',
  reports: '/reports',
  'manage-users': '/users',
  'my-print-requests': '/my-print-requests',
  'print-requests': '/print-requests',
  settings: '/settings',
  'trash-bin': '/trash-bin',
  'help-support': '/help',
};

function routeToNavItem(pathname: string): NavItemKey | null {
  const match = Object.entries(NAV_PATHS).find(([, path]) => path === pathname);
  return match ? (match[0] as NavItemKey) : null;
}

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [authMessage, setAuthMessage] = useState('');

  useEffect(() => {
    let disposed = false;
    const handleApiSessionExpired = () => {
      setSession(null);
      setSessionChecked(true);
      setAuthMessage('Your session has expired. Sign in again.');
    };
    window.addEventListener('pharma-care:api-session-expired', handleApiSessionExpired);
    const client = getBackend() === 'supabase' ? supabase : null;
    const authListener = client?.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' && !disposed) {
        setSession(null);
        setSessionChecked(true);
      }
    });
    void restoreAuthSession()
      .then((profile) => {
        if (!disposed) setSession(profile);
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setSession(null);
          if (!isUnauthenticatedApiError(error)) {
            setAuthMessage(error instanceof Error ? error.message : 'Could not restore your session.');
          }
        }
      })
      .finally(() => {
        if (!disposed) setSessionChecked(true);
      });
    return () => {
      disposed = true;
      window.removeEventListener('pharma-care:api-session-expired', handleApiSessionExpired);
      authListener?.data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    const refreshProfile = async () => {
      try {
        const updated = await refreshAuthSession();
        setSession(updated);
        setAuthMessage('');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not verify your account.';
        setAuthMessage(message);
        if (
          isUnauthenticatedApiError(error) ||
          (error instanceof Error && error.name === 'ProfileLoadError') ||
          message.startsWith('Your account is disabled') ||
          message.startsWith('No profile exists') ||
          message.startsWith('Your profile has an invalid role') ||
          message.startsWith('Your session is no longer valid')
        ) {
          setSession(null);
          if (getBackend() === 'supabase') await supabase?.auth.signOut();
        }
      }
    };
    const intervalId = window.setInterval(() => void refreshProfile(), 2 * 60 * 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [session?.userId]);

  useEffect(() => {
    if (!session) return;
    let timeoutId: number;
    const expireSession = () => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        void (async () => {
          try {
            await signOut();
          } catch {
            window.alert('Could not end the inactive session. Please contact your administrator.');
            expireSession();
            return;
          }
          setSession(null);
          window.history.replaceState({}, '', '/login');
        })();
      }, 30 * 60 * 1000);
    };
    const activityEvents: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'mousemove', 'touchstart'];
    activityEvents.forEach((eventName) => window.addEventListener(eventName, expireSession));
    expireSession();
    return () => {
      window.clearTimeout(timeoutId);
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, expireSession));
    };
  }, [session?.userId]);

  const handleLogin = async (authenticatedSession: AuthSession) => {
    setAuthMessage('');
    setSession(authenticatedSession);
    window.history.replaceState({}, '', '/');
  };

  const handleLogout = async () => {
    try {
      await signOut();
    } catch (error) {
      window.alert(`Could not end the session: ${error instanceof Error ? error.message : 'Please try again.'}`);
      return;
    }
    setSession(null);
    window.history.replaceState({}, '', '/login');
  };

  if (!sessionChecked) {
    return <div className="app-loading flex min-h-screen items-center justify-center bg-surface"><PharmaLogo size={12} /></div>;
  }

  if (!session) {
    if (window.location.pathname !== '/login') window.history.replaceState({}, '', '/login');
    return (
      <LoginView
        onLogin={handleLogin}
        initialError={authMessage}
      />
    );
  }

  return (
    <AppErrorBoundary>
      <PharmacyApp
        key={session.userId}
        session={session}
        onLogout={handleLogout}
        authMessage={authMessage}
      />
    </AppErrorBoundary>
  );
}

function PharmacyApp({
  session,
  onLogout,
  authMessage,
}: {
  session: AuthSession;
  onLogout: () => void;
  authMessage: string;
}) {
  return (
    <PermissionsProvider role={session.role} permissions={session.permissions}>
      <PharmacyWorkspace session={session} onLogout={onLogout} authMessage={authMessage} />
    </PermissionsProvider>
  );
}

function PharmacyWorkspace({
  session,
  onLogout,
  authMessage,
}: {
  session: AuthSession;
  onLogout: () => void;
  authMessage: string;
}) {
  const { canPage } = usePermissions();
  const initialPath = window.location.pathname;
  const [activeItem, setActiveItem] = useState<NavItemKey>(
    routeToNavItem(initialPath) ?? 'dashboard'
  );
  const [isPageNotFound, setIsPageNotFound] = useState(
    initialPath !== '/' && initialPath !== '/login' && routeToNavItem(initialPath) === null
  );
  const [accessMessage, setAccessMessage] = useState('');
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [printNotice, setPrintNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [pendingPrintCount, setPendingPrintCount] = useState(0);

  const currentRole = session.role;
  const currentUserName = session.displayName;
  const canEditShopSettings = isAdminRole(currentRole)
    && (getBackend() !== 'api' || session.permissions.includes('manage_users'));
  const canEditShopIdentity = getBackend() !== 'api' || currentRole === 'super_admin';
  const handlePrintReceipt: PrintReceiptHandler = React.useCallback(
    async (type, payload, options) => {
      const { printReceipt } = await import('./utils/printWorkflow');
      return printReceipt(type, payload, {
        role: currentRole,
        permissions: session.permissions,
        onNotice: (text, error = false) => setPrintNotice({ text, error }),
      }, options);
    },
    [currentRole, session.permissions],
  );

  React.useEffect(() => {
    if (!isAdminRole(currentRole)) {
      setPendingPrintCount(0);
      return;
    }
    let disposed = false;
    let failureReported = false;
    const refreshCount = async () => {
      try {
        if (getBackend() === 'api') {
          const count = await loadPendingPrintCount();
          if (!disposed) {
            failureReported = false;
            setPendingPrintCount(count);
          }
          return;
        }
        if (!supabase) throw new Error('Supabase is not configured.');
        const { data, error } = await supabase.rpc('pending_print_count');
        if (error) throw new Error(error.message);
        if (typeof data !== 'number' || !Number.isFinite(data)) {
          throw new Error('The server returned an invalid pending print count.');
        }
        if (disposed) return;
        failureReported = false;
        setPendingPrintCount(data);
      } catch (error) {
        if (disposed) return;
        if (!failureReported) {
          setPrintNotice({
            text: `Could not refresh pending print requests: ${error instanceof Error ? error.message : 'Please try again.'}`,
            error: true,
          });
        }
        failureReported = true;
      }
    };
    void refreshCount();
    const interval = window.setInterval(() => { void refreshCount(); }, 20_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [currentRole]);

  React.useEffect(() => {
    if (!printNotice) return;
    const timeout = window.setTimeout(() => setPrintNotice(null), printNotice.error ? 9000 : 4500);
    return () => window.clearTimeout(timeout);
  }, [printNotice]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(`pharma-care.sidebarCollapsed.${session.displayName}`) === 'true';
    } catch {
      return false;
    }
  });
  const [billingState] = useState(readBillingPreferencesWithMigration);
  const [billingPreferences, setBillingPreferences] = useState<BillingPreferences>(billingState.preferences);
  const [previewTemplate, setPreviewTemplate] = useState<BillingTemplate>(
    billingPreferences.template
  );
  const [companyName, setCompanyName] = useState(readCompanyName);
  const [memoSettings, setMemoSettings] = useState<PharmacyMemoSettings>(() =>
    readPharmacyMemoSettings(companyName)
  );
  const [shopProfile, setShopProfile] = useState<ShopProfile>({
    displayName: '',
    address: '',
    phone: '',
    city: '',
  });
  const [memoMigrationToast, setMemoMigrationToast] = useState(billingState.migratedClassicDefault);

  useEffect(() => {
    if (getBackend() !== 'api' || !session) return;
    let active = true;
    setCompanyName('');
    setShopProfile({ displayName: '', address: '', phone: '', city: '' });
    setMemoSettings(DEFAULT_PHARMACY_MEMO_SETTINGS);
    setBillingPreferences({ template: 'pharmacy-memo', format: 'thermal80' });
    setPreviewTemplate('pharmacy-memo');
    void loadShopSettings()
      .then((settings) => {
        if (!active) return;
        setCompanyName(settings.name);
        setShopProfile(settings.profile);
        setMemoSettings(settings.memoSettings);
        setBillingPreferences(settings.receiptSettings);
        setPreviewTemplate(settings.receiptSettings.template);
      })
      .catch((error: unknown) => {
        if (active) {
          setPrintNotice({
            text: `Could not load shop settings: ${error instanceof Error ? error.message : 'The server returned an invalid response.'}`,
            error: true,
          });
        }
      });
    return () => {
      active = false;
    };
  }, [session?.userId]);

  useEffect(() => {
    try {
      localStorage.setItem(`pharma-care.sidebarCollapsed.${currentUserName}`, String(sidebarCollapsed));
    } catch {
      // Keep the selected layout for this page view if browser storage is unavailable.
    }
  }, [currentUserName, sidebarCollapsed]);

  useEffect(() => {
    const syncRoute = () => {
      const requested = routeToNavItem(window.location.pathname);
      if (!requested) {
        if (window.location.pathname === '/login') {
          window.history.replaceState({}, '', '/');
          setIsPageNotFound(false);
          setActiveItem('dashboard');
          return;
        }
        setIsPageNotFound(true);
        setAccessMessage('');
        return;
      }
      setIsPageNotFound(false);
      if (!canPage(requested)) {
        setAccessMessage('No access. Your account does not have permission to open that page.');
        setActiveItem('dashboard');
        window.history.replaceState({}, '', '/');
        return;
      }
      setAccessMessage('');
      setActiveItem(requested);
    };
    syncRoute();
    window.addEventListener('popstate', syncRoute);
    return () => window.removeEventListener('popstate', syncRoute);
  }, [canPage]);

  const navigateTo = React.useCallback((item: NavItemKey) => {
    if (!canPage(item)) {
      setAccessMessage('No access. Your account does not have permission to open that page.');
      setActiveItem('dashboard');
      window.history.replaceState({}, '', '/');
      return;
    }
    setAccessMessage('');
    setIsPageNotFound(false);
    setActiveItem(item);
    window.history.pushState({}, '', NAV_PATHS[item]);
  }, [canPage]);

  const [productFilter, setProductFilter] = React.useState<ProductFilter>(null);
  const [stockMedicineId, setStockMedicineId] = React.useState<string | null>(null);
  const [stockInitialTab, setStockInitialTab] = React.useState<'all' | 'near-expiry' | 'expired' | 'low-stock'>('all');
  const [stockNavigationKey, setStockNavigationKey] = React.useState(0);
  const [alertProductSearch, setAlertProductSearch] = React.useState<string | null>(null);
  const [alertProductsLowStockOnly, setAlertProductsLowStockOnly] = React.useState(false);
  const [alertProductNavigationKey, setAlertProductNavigationKey] = React.useState(0);
  const viewFilteredProducts = React.useCallback((filter: Exclude<ProductFilter, null>) => {
    setProductFilter(filter);
    navigateTo('products');
  }, [navigateTo]);
  const viewProductBatches = React.useCallback((medicineId: string | null, initialTab: 'all' | 'low-stock' = 'all') => {
    setStockMedicineId(medicineId);
    setStockInitialTab(initialTab);
    setStockNavigationKey((current) => current + 1);
    navigateTo('stock-inventory');
  }, [navigateTo]);
  const openStockAlertProducts = React.useCallback((searchText: string | null) => {
    setProductFilter(null);
    setAlertProductSearch(searchText);
    setAlertProductsLowStockOnly(true);
    setAlertProductNavigationKey((current) => current + 1);
    navigateTo('products');
  }, [navigateTo]);

  useEffect(() => {
    if (activeItem !== 'stock-inventory') {
      setStockMedicineId(null);
      setStockInitialTab('all');
    }
    if (activeItem !== 'products') {
      setAlertProductSearch(null);
      setAlertProductsLowStockOnly(false);
    }
  }, [activeItem]);

  // Main Datasets
  const products = INITIAL_PRODUCTS;
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [ledgerEntries, setLedgerEntries] = useState<Record<string, LedgerEntry[]>>({});
  const [transactions, setTransactions] = useState<CashTransaction[]>([]);
  const [completedSales, setCompletedSales] = useState<CompletedSale[]>([]);
  const [dataLoadError, setDataLoadError] = useState('');
  const refreshCashBook = React.useCallback(async () => {
    if (getBackend() !== 'api') return;
    const cashBook = await loadCashBook();
    setTransactions(cashBook.transactions);
  }, []);

  useEffect(() => {
    if (!session) {
      setCustomers([]);
      setLedgerEntries({});
      setTransactions([]);
      setCompletedSales([]);
      setDataLoadError('');
      return;
    }

    let active = true;
    setDataLoadError('');
    const reportLoadError = (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Could not load saved business data.';
      if (active) setDataLoadError((previous) => previous ? `${previous} ${message}` : message);
    };

    if (session.permissions.includes('customers')) {
      void loadCustomerAccountsSummary().then((accounts) => {
        if (!active) return;
        setCustomers(accounts.customers);
        setLedgerEntries(accounts.ledgerEntries);
      }).catch(reportLoadError);
    } else if (session.permissions.includes('pos')) {
      void loadPosCustomers().then((loadedCustomers) => {
        if (active) setCustomers(loadedCustomers);
      }).catch(reportLoadError);
    } else {
      setCustomers([]);
      setLedgerEntries({});
    }

    if (session.permissions.includes('sales_history')) {
      void loadSalesHistory().then((sales) => {
        if (active) setCompletedSales(sales);
      }).catch(reportLoadError);
    } else {
      setCompletedSales([]);
    }
    if (getBackend() === 'api' && session.permissions.includes('expenses')) {
      void refreshCashBook().catch(reportLoadError);
    }

    return () => {
      active = false;
    };
  }, [session?.userId, session?.permissions, refreshCashBook]);

  // Global Modals
  const [showTemplatePreview, setShowTemplatePreview] = useState(false);
  const [showCloseDayModal, setShowCloseDayModal] = useState(false);

  useEffect(() => {
    if (!memoMigrationToast) return;
    const timeout = window.setTimeout(() => setMemoMigrationToast(false), 6000);
    return () => window.clearTimeout(timeout);
  }, [memoMigrationToast]);

  const updateBillingPreferences = (preferences: BillingPreferences) => {
    if (getBackend() === 'api') {
      void updateShopSettings({ receiptSettings: preferences })
        .then((settings) => {
          setBillingPreferences(settings.receiptSettings);
          setPreviewTemplate(settings.receiptSettings.template);
        })
        .catch((error: unknown) => {
          setPrintNotice({
            text: `Could not save receipt settings: ${error instanceof Error ? error.message : 'The server returned an invalid response.'}`,
            error: true,
          });
        });
      return;
    }
    setBillingPreferences(preferences);
    if (!saveBillingPreferences(preferences)) {
      window.alert('Template preference could not be saved in this browser.');
    }
  };

  const updateMemoSettings = async (settings: PharmacyMemoSettings): Promise<boolean> => {
    if (getBackend() === 'api') {
      const editableSettings: Partial<PharmacyMemoSettings> = { ...settings };
      if (currentRole !== 'super_admin') {
        delete editableSettings.storeName;
        delete editableSettings.address;
        delete editableSettings.phone;
      }
      try {
        const result = await updateShopSettings({
          memoSettings: currentRole === 'super_admin'
            ? settings
            : editableSettings,
        });
        setMemoSettings(result.memoSettings);
        return true;
      } catch (error) {
        setPrintNotice({
          text: `Could not save Pharmacy Memo settings: ${error instanceof Error ? error.message : 'The server returned an invalid response.'}`,
          error: true,
        });
        return false;
      }
    }
    if (!savePharmacyMemoSettings(settings)) return false;
    setMemoSettings(settings);
    return true;
  };

  const updateCompanyName = async (name: string): Promise<boolean> => {
    if (getBackend() === 'api') {
      try {
        const result = await updateShopSettings({ shopName: name.trim() });
        setCompanyName(result.name);
        return true;
      } catch (error) {
        setPrintNotice({
          text: `Could not save the shop name: ${error instanceof Error ? error.message : 'The server returned an invalid response.'}`,
          error: true,
        });
        return false;
      }
    }
    if (!saveCompanyName(name)) return false;
    setCompanyName(name.trim());
    return true;
  };

  const updateShopProfile = async (profile: Pick<ShopProfile, 'phone' | 'city'>): Promise<boolean> => {
    if (getBackend() !== 'api') return true;
    try {
      const result = await updateShopSettings({ profile });
      setShopProfile(result.profile);
      return true;
    } catch (error) {
      setPrintNotice({
        text: `Could not save the shop profile: ${error instanceof Error ? error.message : 'The server returned an invalid response.'}`,
        error: true,
      });
      return false;
    }
  };
  const openTemplatePreview = (template: BillingTemplate) => {
    setPreviewTemplate(template);
    setShowTemplatePreview(true);
  };

  // Keyboard shortcut F1 for POS Billing
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F1') {
        e.preventDefault();
        navigateTo('pos');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSaleComplete = (sale: CompletedSale) => {
    setCompletedSales((prev) => [sale, ...prev]);
    window.dispatchEvent(new CustomEvent(STOCK_CHANGED_EVENT));

    if (getBackend() !== 'api' && sale.paymentMethod === PaymentMethod.CASH) {
      const tx: CashTransaction = {
        id: `tx-${Date.now()}`,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        type: 'SALE',
        description: `POS Bill ${sale.invoiceNumber}`,
        amountPaisa: sale.totalPaisa,
        isOutflow: false,
        handledBy: currentUserName,
      };
      setTransactions((prev) => [tx, ...prev]);
    }
    if (getBackend() === 'api' && session?.permissions.includes('expenses')) {
      void refreshCashBook().catch((error: unknown) => {
        setPrintNotice({
          text: `Sale completed, but cash book could not refresh: ${error instanceof Error ? error.message : 'Please refresh the screen.'}`,
          error: true,
        });
      });
    }

    if (session?.permissions.includes('pos')) {
      void loadPosCustomers().then(setCustomers).catch((error: unknown) => {
        setDataLoadError(error instanceof Error ? error.message : 'Could not refresh POS customers.');
      });
    }
    if (session?.permissions.includes('customers')) {
      void loadCustomerAccountsSummary().then((accounts) => {
        setCustomers(accounts.customers);
        setLedgerEntries(accounts.ledgerEntries);
      }).catch((error: unknown) => {
        setDataLoadError(error instanceof Error ? error.message : 'Could not refresh customer accounts.');
      });
    }
  };

  const handleRecordPayment = async (customerId: string, amountPaisa: number, note: string) => {
    const result = await recordCustomerPayment(customerId, amountPaisa, note);
    const customer = customers.find((c) => c.id === customerId);
    const tx: CashTransaction = {
      id: `tx-${Date.now()}`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      type: 'CREDIT_RECOVERY',
      description: `Payment from ${customer?.name || 'Customer'}`,
      amountPaisa,
      isOutflow: false,
      handledBy: currentUserName,
    };
    if (getBackend() !== 'api') setTransactions((prev) => [tx, ...prev]);
    else if (session?.permissions.includes('expenses')) {
      void refreshCashBook().catch((error: unknown) => {
        setPrintNotice({
          text: `Payment recorded, but cash book could not refresh: ${error instanceof Error ? error.message : 'Please refresh the screen.'}`,
          error: true,
        });
      });
    }
    if (session?.permissions.includes('customers')) {
      void loadCustomerAccountsSummary().then((accounts) => {
        setCustomers(accounts.customers);
        setLedgerEntries(accounts.ledgerEntries);
      }).catch((error: unknown) => {
        setDataLoadError(error instanceof Error ? error.message : 'Payment was recorded, but accounts could not refresh.');
      });
    }
    return result;
  };

  const handleAddCustomer = async (input: {
    name: string;
    phone: string;
    cnic: string;
    address: string;
    creditLimitPaisa: number;
  }): Promise<Customer> => {
    const customer = await saveCustomer(input);
    setCustomers((previous) => [...previous, customer]);
    setLedgerEntries((previous) => ({ ...previous, [customer.id]: [] }));
    return customer;
  };

  // Calculations for End of Day modal
  const postedSales = completedSales.filter((sale) => sale.status !== 'VOID');
  const cashSalesPKR =
    postedSales
      .filter((s) => s.paymentMethod === 'CASH')
      .reduce((sum, s) => sum + s.totalPaisa, 0) / 100;

  const creditSalesPKR =
    postedSales
      .filter((s) => s.paymentMethod === 'CREDIT')
      .reduce((sum, s) => sum + s.totalPaisa, 0) / 100;

  const totalSalesPKR = postedSales.reduce((sum, s) => sum + s.totalPaisa, 0) / 100;

  const expensesPKR =
    transactions
      .filter((t) => t.isOutflow)
      .reduce((sum, t) => sum + t.amountPaisa, 0) / 100;

  const hasCompleteSaleCosts = completedSales.every((sale) =>
    sale.items.every((item) => item.costPaisaPerUnit !== null)
  );
  const totalCostPKR = hasCompleteSaleCosts
    ? postedSales.reduce((sum, sale) =>
        sum + sale.items.reduce(
          (itemSum, item) => itemSum + (item.costPaisaPerUnit ?? 0) * item.quantityInUnit,
          0,
        ), 0) / 100
    : null;

  const grossProfitPKR = totalCostPKR === null
    ? null
    : Math.max(0, totalSalesPKR - totalCostPKR);
  const netCashInHandPKR = Math.max(0, cashSalesPKR - expensesPKR);

  const getPageTitle = (key: NavItemKey): string => {
    switch (key) {
      case 'dashboard':
        return 'DASHBOARD';
      case 'pos':
        return 'POS BILLING';
      case 'products':
        return 'PRODUCTS';
      case 'master-data':
        return 'MASTER DATA';
      case 'stock-inventory':
        return 'STOCK INVENTORY';
      case 'customers':
        return 'CUSTOMERS';
      case 'customer-ledger':
        return 'CUSTOMER LEDGER';
      case 'whatsapp-reminders':
        return 'WHATSAPP REMINDERS';
      case 'sales-history':
        return 'SALES HISTORY';
      case 'suppliers':
        return 'SUPPLIERS';
      case 'purchases':
        return 'PURCHASES';
      case 'purchase-history':
        return 'PURCHASE HISTORY';
      case 'expenses':
        return 'EXPENSES';
      case 'reports':
        return 'BUSINESS ANALYTICS';
      case 'manage-users':
        return 'MANAGE USERS';
      case 'my-print-requests':
        return 'MY PRINT REQUESTS';
      case 'print-requests':
        return 'PRINT REQUESTS';
      case 'settings':
        return 'SETTINGS';
      case 'trash-bin':
        return 'TRASH BIN';
      case 'help-support':
        return 'HELP & SUPPORT';
      default:
        return 'DEMO STORE';
    }
  };

  return (
    <div className="flex min-h-screen bg-surface font-inter text-text antialiased">
      {/* ── Fixed Pharmacy Green Sidebar ───────────────────────────────────── */}
      <Sidebar
        activeItem={activeItem}
        onSelectItem={navigateTo}
        isCollapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
        pendingPrintCount={pendingPrintCount}
      />

      {/* ── Main Workspace Content Pane ──────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {memoMigrationToast && <div role="status" className="fixed right-4 top-4 z-[60] rounded-control border border-primary/30 bg-surface px-4 py-3 text-sm font-semibold text-text shadow-lg">Pharmacy Memo is now your default receipt template. You can change it in Settings.</div>}
        {printNotice && <div role={printNotice.error ? 'alert' : 'status'} className={`visual-toast fixed bottom-4 right-4 z-[60] max-w-md rounded-control border px-4 py-3 text-sm shadow-lg ${printNotice.error ? 'border-red-200 bg-red-50 text-red-800' : 'border-primary/30 bg-white text-text'}`}>{printNotice.text}</div>}
        {authMessage && <p role="alert" className="border-b border-warning bg-warning/15 px-4 py-2 text-sm font-semibold text-text">{authMessage}</p>}
        {/* Top Header Strip */}
        <TopNav
          currentRole={currentRole}
          username={currentUserName}
          userId={session.userId}
          activeTitle={isPageNotFound ? 'PAGE NOT FOUND' : getPageTitle(activeItem)}
          onChangePassword={() => setShowPasswordDialog(true)}
          onLogout={onLogout}
          onOpenStockInventory={(medicineId) => viewProductBatches(medicineId, 'low-stock')}
          onOpenProducts={openStockAlertProducts}
        />

        {/* Dynamic Screen View */}
        <main className="pharmacy-page p-4 sm:p-6 flex-1 overflow-y-auto">
          {accessMessage && <p role="status" className="visual-toast mb-4 rounded-control border border-warning bg-warning/15 px-4 py-3 text-sm font-semibold text-text">{accessMessage}</p>}
          {isPageNotFound ? (
            <section className="mx-auto flex min-h-[50vh] max-w-xl flex-col items-center justify-center gap-4 text-center">
              <h1 className="text-2xl font-black text-text">Page not found</h1>
              <p className="text-sm text-muted">The page you requested does not exist.</p>
              <button
                type="button"
                onClick={() => navigateTo('dashboard')}
                className="rounded-control bg-primary px-4 py-2 text-sm font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Back to Dashboard
              </button>
            </section>
          ) : !canPage(activeItem) ? (
            <p role="alert" className="rounded-control border border-warning bg-warning/15 px-4 py-3 text-sm font-semibold text-text">No access. Redirecting to Dashboard.</p>
          ) : (
          <ScreenLoadBoundary key={activeItem}>
          <Suspense fallback={<ScreenLoading />}>
          <>
          {activeItem === 'dashboard' && (
            <DashboardView
              sales={completedSales}
              products={products}
              customers={customers}
              currentRole={currentRole}
              currentUserName={currentUserName}
              onNavigate={navigateTo}
              onOpenCloseDay={() => setShowCloseDayModal(true)}
            />
          )}

          {activeItem === 'pos' && (
            <POSBillingView
              customers={customers}
              currentUserId={session.userId}
              currentRole={currentRole}
              permissions={session.permissions}
              currentUserName={currentUserName}
              companyName={companyName}
              billingTemplate={billingPreferences.template}
              receiptFormat={billingPreferences.format}
              memoSettings={memoSettings}
              onPrintReceipt={handlePrintReceipt}
              onSaleComplete={handleSaleComplete}
              onOpenTemplatePreview={() => openTemplatePreview(billingPreferences.template)}
            />
          )}

          {activeItem === 'products' && (
            <InventoryScreen
              key={`stock-alert-products-${alertProductNavigationKey}`}
              mode="products"
              currentRole={currentRole}
              currentUserId={session.userId}
              initialFilter={productFilter}
              initialSearch={alertProductSearch}
              initialLowStockOnly={alertProductsLowStockOnly}
              onFilterApplied={() => setProductFilter(null)}
              onViewBatches={viewProductBatches}
            />
          )}

          {activeItem === 'master-data' && <MasterDataView onViewProducts={viewFilteredProducts} />}

          {activeItem === 'stock-inventory' && (
            <InventoryScreen
              key={`stock-inventory-${stockNavigationKey}`}
              mode="stock"
              currentRole={currentRole}
              initialMedicineId={stockMedicineId}
              initialStockTab={stockInitialTab}
              onClearMedicineFilter={() => setStockMedicineId(null)}
            />
          )}

          {activeItem === 'customers' && (
            <CustomerLedgerScreen
              customers={customers}
              ledgerEntries={ledgerEntries}
              onRecordPayment={handleRecordPayment}
              memoSettings={memoSettings}
              memoFormat={billingPreferences.format}
              currentUserName={currentUserName}
              currentRole={currentRole}
              onPrintReceipt={handlePrintReceipt}
              onAddCustomer={handleAddCustomer}
            />
          )}

          {activeItem === 'customer-ledger' && (
            <CustomerLedgerScreen
              customers={customers}
              ledgerEntries={ledgerEntries}
              onRecordPayment={handleRecordPayment}
              memoSettings={memoSettings}
              memoFormat={billingPreferences.format}
              currentUserName={currentUserName}
              currentRole={currentRole}
              onPrintReceipt={handlePrintReceipt}
              onAddCustomer={handleAddCustomer}
            />
          )}

          {activeItem === 'whatsapp-reminders' && (
            <WhatsAppRemindersView customers={customers} />
          )}

          {activeItem === 'sales-history' && (
            <ReportsScreen sales={completedSales} currentRole={currentRole} />
          )}

          {activeItem === 'expenses' && (
            <CashBookScreen
              transactions={transactions}
              onAddTransaction={async (tx) => {
                if (getBackend() !== 'api') {
                  setTransactions((previous) => [tx, ...previous]);
                  return;
                }
                await createCashExpense(tx.description, tx.amountPaisa);
                try {
                  await refreshCashBook();
                } catch (error) {
                  setPrintNotice({
                    text: `Expense recorded, but cash book could not refresh: ${error instanceof Error ? error.message : 'Please refresh the screen.'}`,
                    error: true,
                  });
                }
              }}
            />
          )}

          {activeItem === 'reports' && (
            <ReportsScreen sales={completedSales} currentRole={currentRole} />
          )}

          {activeItem === 'settings' && (
            <SettingsView
              sales={completedSales}
              currentUserName={currentUserName}
              activeTemplate={billingPreferences.template}
              canEditBilling={canEditShopSettings}
              canEditReceiptSettings={getBackend() !== 'api' || canEditShopSettings}
              maxMemoNumberDigits={getBackend() === 'api' ? 16 : 20}
              canEditShopIdentity={canEditShopIdentity}
              shopProfile={getBackend() === 'api' ? shopProfile : undefined}
              onSaveShopProfile={updateShopProfile}
              onTemplateChange={(template: BillingTemplate) =>
                updateBillingPreferences({ ...billingPreferences, template })
              }
              companyName={companyName}
              onSaveCompanyName={updateCompanyName}
              onOpenTemplatePreview={openTemplatePreview}
              memoSettings={memoSettings}
              onMemoSettingsChange={updateMemoSettings}
              memoFormat={billingPreferences.format}
              onPrintReceipt={handlePrintReceipt}
              onMemoFormatChange={(format) => updateBillingPreferences({ ...billingPreferences, format })}
            />
          )}

          {activeItem === 'suppliers' && <SuppliersView />}
          {activeItem === 'purchases' && (
            <StockPurchaseView userId={session.userId} onViewHistory={() => navigateTo('purchase-history')} />
          )}
          {activeItem === 'purchase-history' && <PurchaseHistoryView currentRole={currentRole} />}

          {activeItem === 'help-support' && <HelpSupportView username={currentUserName} role={currentRole} />}

          {activeItem === 'trash-bin' && <TrashBinView currentRole={currentRole} />}

          {activeItem === 'manage-users' && <ManageUsersView currentUserId={session.userId} currentRole={currentRole} onChangePassword={() => setShowPasswordDialog(true)} />}
          {activeItem === 'my-print-requests' && <MyPrintRequestsView userId={session.userId} />}
          {activeItem === 'print-requests' && <PrintRequestsAdminView onPrintReceipt={handlePrintReceipt} />}
          </>
          </Suspense>
          </ScreenLoadBoundary>
          )}
        </main>
      </div>

      {/* ── Global Template Preview Modal (Screenshots 1-4, 68-80) ─────────── */}
      {showTemplatePreview && (
        <Suspense fallback={<ScreenLoading />}>
          <TemplatePreviewModal
            companyName={companyName}
            initialTemplate={previewTemplate}
            initialFormat={billingPreferences.format}
            memoSettings={memoSettings}
            canApply={canEditShopSettings}
            onApply={(template: BillingTemplate, format: ReceiptFormat) => {
              updateBillingPreferences({ template, format });
              setShowTemplatePreview(false);
            }}
            onClose={() => setShowTemplatePreview(false)}
          />
        </Suspense>
      )}

      {/* ── End of Day Summary Modal (Screenshot 5) ─────────────────────────── */}
      {showCloseDayModal && (
        <Suspense fallback={<ScreenLoading />}>
          <EndOfDayModal
            onClose={() => setShowCloseDayModal(false)}
            cashSalesPKR={cashSalesPKR}
            creditSalesPKR={creditSalesPKR}
            totalSalesPKR={totalSalesPKR}
            expensesPKR={expensesPKR}
            purchasesPKR={0}
            grossProfitPKR={grossProfitPKR}
            netCashInHandPKR={netCashInHandPKR}
          />
        </Suspense>
      )}
      {showPasswordDialog && (
        <Suspense fallback={<ScreenLoading />}>
          <ChangePasswordModal email={session.email} onClose={() => setShowPasswordDialog(false)} />
        </Suspense>
      )}
    </div>
  );
}

function ScreenLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[30vh] flex-col items-center justify-center gap-3 rounded-card border border-border bg-surface p-6 text-text"
    >
      <span className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-primary" aria-hidden="true" />
      <span className="text-sm font-semibold">Loading page…</span>
    </div>
  );
}

class ScreenLoadBoundary extends Component<
  React.PropsWithChildren,
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <section role="alert" className="rounded-card border border-border bg-surface p-6 text-center text-text">
          <h2 className="font-bold">This page could not be loaded.</h2>
          <p className="mt-2 text-sm text-muted">Check your connection and retry.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 rounded-control bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Retry
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}

class AppErrorBoundary extends Component<
  React.PropsWithChildren,
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-surface p-6 text-text">
          <section className="max-w-md rounded-card border border-border bg-white p-7 text-center shadow-lg">
            <h1 className="text-lg font-bold">This page could not be displayed.</h1>
            <p className="mt-2 text-sm text-muted">Reload the app to try again.</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-5 rounded-control bg-primary px-4 py-2 text-sm font-semibold text-white"
            >
              Reload
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
