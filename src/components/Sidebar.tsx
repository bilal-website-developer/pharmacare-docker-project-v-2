import React from 'react';
import {
  BarChart3, BellRing, ChevronLeft, ChevronRight, FileText, HelpCircle, History,
  Layers, LayoutDashboard, MessageSquare, Package, Printer, Receipt, Settings,
  ShoppingBag, ShoppingCart, ShieldCheck, Trash2, Truck, UserCheck, Wallet,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getBackend } from '../api';
import { ModuleKey, usePermissions } from '../permissions';
import PharmaLogo from './PharmaLogo';
import GlowCredit from './GlowCredit';

export type NavItemKey =
  | 'dashboard' | 'pos' | 'products' | 'master-data' | 'stock-inventory'
  | 'customers' | 'customer-ledger' | 'whatsapp-reminders' | 'sales-history'
  | 'suppliers' | 'purchases' | 'purchase-history' | 'expenses' | 'reports'
  | 'manage-users' | 'my-print-requests' | 'print-requests' | 'settings' | 'trash-bin'
  | 'help-support' | 'allow-support';

interface SidebarProps {
  activeItem: NavItemKey;
  onSelectItem: (key: NavItemKey) => void;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  pendingPrintCount: number;
}

interface NavEntry {
  key: NavItemKey;
  label: string;
  icon: LucideIcon;
  module?: ModuleKey;
  admin?: boolean;
  apiOnly?: boolean;
}

const GROUPS: Array<{ title: string; items: NavEntry[] }> = [
  { title: 'Main', items: [
    { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { key: 'pos', label: 'POS Billing', icon: ShoppingCart, module: 'pos' },
  ] },
  { title: 'Inventory & Products', items: [
    { key: 'products', label: 'Products', icon: Package, module: 'products' },
    { key: 'master-data', label: 'Categories', icon: Layers, module: 'categories' },
    { key: 'stock-inventory', label: 'Stock Inventory', icon: Package, module: 'stock_inventory' },
  ] },
  { title: 'Sales & Customers', items: [
    { key: 'customer-ledger', label: 'Customer Ledger', icon: FileText, module: 'customers' },
    { key: 'whatsapp-reminders', label: 'WhatsApp Reminders', icon: MessageSquare, module: 'customers' },
    { key: 'sales-history', label: 'Sales History', icon: History, module: 'sales_history' },
    { key: 'my-print-requests', label: 'My print requests', icon: BellRing },
  ] },
  { title: 'Procurement', items: [
    { key: 'suppliers', label: 'Suppliers', icon: Truck, module: 'suppliers' },
    { key: 'purchases', label: 'Purchases', icon: ShoppingBag, module: 'purchases' },
    { key: 'purchase-history', label: 'Purchase History', icon: Receipt, module: 'purchase_history' },
  ] },
  { title: 'Accounts & Admin', items: [
    { key: 'expenses', label: 'Expenses', icon: Wallet, module: 'expenses' },
    { key: 'reports', label: 'Business Analytics', icon: BarChart3, module: 'reports' },
    { key: 'manage-users', label: 'Manage Users', icon: UserCheck, module: 'manage_users' },
    { key: 'print-requests', label: 'Print Requests', icon: Printer, admin: true },
  ] },
  { title: 'Settings & System', items: [
    { key: 'settings', label: 'Settings', icon: Settings, admin: true },
    { key: 'trash-bin', label: 'Trash Bin', icon: Trash2, admin: true },
    { key: 'allow-support', label: 'Allow support', icon: ShieldCheck, admin: true, apiOnly: true },
    { key: 'help-support', label: 'Help & Support', icon: HelpCircle },
  ] },
];

export const Sidebar: React.FC<SidebarProps> = ({
  activeItem, onSelectItem, isCollapsed, onToggleCollapsed, pendingPrintCount,
}) => {
  const { isAdmin, can } = usePermissions();

  return (
    <aside
      data-collapsed={isCollapsed}
      className={`pharma-sidebar sticky top-0 flex h-screen shrink-0 select-none flex-col border-r border-white/10 text-white transition-none ${isCollapsed ? 'w-16' : 'w-64'}`}
    >
      <div className={`flex min-h-[72px] items-center border-b border-white/10 p-4 ${isCollapsed ? 'justify-center' : 'justify-between gap-3'}`}>
        <div className="pharma-brand flex min-w-0 items-center">
          {!isCollapsed && <PharmaLogo size={2.6} layout="inline" />}
        </div>
        <button
          type="button"
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!isCollapsed}
          title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggleCollapsed}
          className={`sidebar-collapse-control flex h-9 w-9 shrink-0 items-center justify-center rounded-control border border-white/15 text-white/80 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${isCollapsed ? 'absolute left-3 top-4' : ''}`}
        >
          {isCollapsed
            ? <ChevronRight aria-hidden="true" className="h-4 w-4" />
            : <ChevronLeft aria-hidden="true" className="h-4 w-4" />}
        </button>
      </div>

      <nav aria-label="Main navigation" className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-4 text-xs">
        {GROUPS.map(({ title, items }) => {
          const visibleItems = items.filter((item) =>
            (!item.apiOnly || getBackend() === 'api')
            && (item.admin ? isAdmin : item.module ? can(item.module) : true)
          );
          if (visibleItems.length === 0) return null;
          return (
            <div key={title} className="space-y-1">
              <div className="px-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">{title}</div>
              {visibleItems.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => onSelectItem(key)}
                  title={label}
                  aria-label={label}
                  aria-current={activeItem === key ? 'page' : undefined}
                  className={`sidebar-nav-item relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left font-medium transition ${activeItem === key ? 'bg-primary font-bold text-white shadow-md' : 'text-slate-300 hover:bg-white/10'}`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{label}</span>
                  {key === 'print-requests' && pendingPrintCount > 0 && (
                    <span className="ml-auto min-w-5 rounded-full bg-red-500 px-1.5 py-0.5 text-center text-[10px] font-black text-white">
                      {pendingPrintCount > 99 ? '99+' : pendingPrintCount}
                    </span>
                  )}
                </button>
              ))}
            </div>
          );
        })}
      </nav>

      {!isCollapsed && <div className="mt-auto border-t border-white/10 p-3">
        <GlowCredit />
      </div>}
    </aside>
  );
};
