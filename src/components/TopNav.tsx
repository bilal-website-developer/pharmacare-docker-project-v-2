import React, { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronDown, KeyRound, LogOut, Type } from 'lucide-react';
import { ROLE_LABELS, UserRole } from '../types/pharmacy';
import { supabase } from '../utils/supabase';
import { apiRequest, getBackend } from '../api';
import PharmaLogo from './PharmaLogo';
import { StockAlertBell } from './StockAlertBell';

interface TopNavProps {
  currentRole: UserRole;
  username: string;
  userId: string;
  activeTitle: string;
  onChangePassword: () => void;
  onLogout: () => void;
  onOpenStockInventory: (medicineId: string | null) => void;
  onOpenProducts: (searchText: string | null) => void;
}

const largeUiKey = (userName: string) => `pharma-care.largeUi.${userName}`;
type ServerHealth = 'checking' | 'online' | 'offline' | 'unreachable';

function readLargeUiPreference(userName: string): boolean {
  try {
    return localStorage.getItem(largeUiKey(userName)) === 'true';
  } catch {
    return false;
  }
}

export const TopNav: React.FC<TopNavProps> = ({
  currentRole,
  username,
  userId,
  activeTitle,
  onChangePassword,
  onLogout,
  onOpenStockInventory,
  onOpenProducts,
}) => {
  const [largeUi, setLargeUi] = useState(() => readLargeUiPreference(username));
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const profileButtonRef = useRef<HTMLButtonElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const [serverHealth, setServerHealth] = useState<ServerHealth>('checking');
  const [theme, setTheme] = useState<'light' | 'night'>(() =>
    document.documentElement.dataset.theme === 'night' ? 'night' : 'light'
  );
  const [animationsEnabled, setAnimationsEnabled] = useState(() =>
    document.documentElement.dataset.animations !== 'off'
  );

  useEffect(() => {
    document.documentElement.classList.toggle('large-ui', largeUi);
    try {
      localStorage.setItem(largeUiKey(username), String(largeUi));
    } catch {
      // The selected size remains active for this page view.
    }
  }, [username, largeUi]);

  useEffect(() => {
    if (!profileOpen) return;
    profileMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!profileRef.current?.contains(event.target as Node)) setProfileOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setProfileOpen(false);
        profileButtonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [profileOpen]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('pharma-care.theme', theme);
    } catch {
      // Keep the selected theme for this page view if browser storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.animations = animationsEnabled ? 'on' : 'off';
    try {
      localStorage.setItem('pharma-care.animations', String(animationsEnabled));
    } catch {
      // Keep the selected animation preference for this page view.
    }
  }, [animationsEnabled]);

  useEffect(() => {
    let active = true;
    const checkServerHealth = async () => {
      if (!navigator.onLine) {
        if (active) setServerHealth('offline');
        return;
      }
      if (getBackend() === 'api') {
        try {
          const health = await apiRequest<{ status: string }>('/api/health');
          if (active) setServerHealth(health.status === 'ok' ? 'online' : 'unreachable');
        } catch {
          if (active) setServerHealth('unreachable');
        }
        return;
      }
      if (!supabase) {
        if (active) setServerHealth('unreachable');
        return;
      }
      try {
        const { error } = await supabase.auth.getUser();
        if (!active) return;
        if (!error) {
          setServerHealth('online');
          return;
        }
        const status = 'status' in error && typeof error.status === 'number'
          ? error.status
          : undefined;
        setServerHealth(status !== undefined && status < 500 ? 'online' : 'unreachable');
      } catch {
        if (active) setServerHealth('unreachable');
      }
    };
    const handleOnline = () => void checkServerHealth();
    const handleOffline = () => setServerHealth('offline');
    void checkServerHealth();
    const intervalId = window.setInterval(() => void checkServerHealth(), 60_000);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      active = false;
      window.clearInterval(intervalId);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleProfileMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = profileMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    if (!items?.length) return;
    const currentIndex = Array.from(items).indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === 'ArrowDown'
      ? (currentIndex + 1) % items.length
      : (currentIndex <= 0 ? items.length - 1 : currentIndex - 1);
    items[nextIndex].focus();
  };

  const runProfileAction = (action: () => void) => {
    setProfileOpen(false);
    action();
  };

  return (
    <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-white/90 px-4 py-2.5 shadow-xs backdrop-blur-md sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <PharmaLogo size={2.6} layout="inline" className="pharma-brand header-pharma-logo" />
        <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted">
          {activeTitle}
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 sm:gap-3">
        <div className="flex items-center gap-1 rounded-full border border-border bg-surface p-0.5 text-[10px] font-semibold">
          <button
            type="button"
            aria-pressed={theme === 'light'}
            onClick={() => setTheme('light')}
            className={`rounded-full px-2 py-1.5 ${theme === 'light' ? 'bg-primary text-white' : 'text-muted'}`}
          >
            Light Mint
          </button>
          <button
            type="button"
            aria-pressed={theme === 'night'}
            onClick={() => setTheme('night')}
            className={`rounded-full px-2 py-1.5 ${theme === 'night' ? 'bg-primary text-white' : 'text-muted'}`}
          >
            Emerald Night
          </button>
        </div>

        <div className="flex items-center rounded-full border border-border bg-surface p-0.5 text-[10px] font-semibold">
          <button
            type="button"
            aria-pressed={!largeUi}
            onClick={() => setLargeUi(false)}
            className={`rounded-full px-2 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              !largeUi ? 'bg-primary text-white' : 'text-muted'
            }`}
          >
            Normal UI
          </button>
          <button
            type="button"
            aria-pressed={largeUi}
            onClick={() => setLargeUi(true)}
            className={`flex items-center gap-1 rounded-full px-2 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              largeUi ? 'bg-primary text-white' : 'text-muted'
            }`}
          >
            <Type className="h-3 w-3" />
            Large UI
          </button>
        </div>

        <button
          type="button"
          aria-pressed={animationsEnabled}
          onClick={() => setAnimationsEnabled((enabled) => !enabled)}
          className="rounded-full border border-border bg-surface px-2.5 py-1.5 text-[10px] font-semibold text-muted hover:text-text"
        >
          Animations: {animationsEnabled ? 'On' : 'Off'}
        </button>

        <StockAlertBell
          userId={userId}
          animationsEnabled={animationsEnabled}
          onOpenStockInventory={onOpenStockInventory}
          onOpenProducts={onOpenProducts}
        />

        <span
          role="status"
          aria-live="polite"
          className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[10px] font-bold sm:inline-flex ${
            serverHealth === 'online'
              ? 'border-border bg-surface text-primary'
              : 'border-warning bg-warning/15 text-text'
          }`}
        >
          <span className={`system-status-dot h-2 w-2 rounded-full ${serverHealth === 'online' ? 'bg-primary' : 'bg-warning'}`} />
          {serverHealth === 'online'
            ? 'AUTH ONLINE'
            : serverHealth === 'offline'
              ? 'OFFLINE'
              : serverHealth === 'checking'
                ? 'CHECKING AUTH'
                : 'AUTH UNREACHABLE'}
        </span>

        <div ref={profileRef} className="relative border-l border-border pl-2">
          <button
            ref={profileButtonRef}
            type="button"
            aria-label={`Profile actions for ${username}`}
            aria-haspopup="menu"
            aria-expanded={profileOpen}
            aria-controls="profile-actions-menu"
            onClick={() => setProfileOpen((open) => !open)}
            className="flex max-w-48 items-center gap-2 rounded-control p-1.5 text-left hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-white">
              {username.charAt(0).toUpperCase()}
            </span>
            <span className="hidden min-w-0 md:block">
              <span className="block max-w-36 truncate text-xs font-bold text-text">{username}</span>
              <span className="block text-[10px] font-semibold uppercase text-muted">{ROLE_LABELS[currentRole]}</span>
            </span>
            <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${profileOpen ? 'rotate-180' : ''}`} />
          </button>
          {profileOpen && (
            <div
              ref={profileMenuRef}
              id="profile-actions-menu"
              role="menu"
              aria-label="Profile actions"
              onKeyDown={handleProfileMenuKeyDown}
              className="absolute right-0 top-full z-50 mt-2 w-52 rounded-xl border border-border bg-surface p-2 shadow-lg"
            >
              <div className="mb-1 border-b border-border px-3 py-2 md:hidden">
                <div className="truncate text-xs font-bold text-text">{username}</div>
                <div className="text-[10px] font-semibold uppercase text-muted">{ROLE_LABELS[currentRole]}</div>
              </div>
              {currentRole !== UserRole.ADMIN && <button
                type="button"
                role="menuitem"
                onClick={() => runProfileAction(onChangePassword)}
                className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-left text-xs font-semibold text-text hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <KeyRound aria-hidden="true" className="h-4 w-4 text-muted" />
                Change Password
              </button>}
              <button
                type="button"
                role="menuitem"
                onClick={() => runProfileAction(onLogout)}
                className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-left text-xs font-semibold text-danger hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <LogOut aria-hidden="true" className="h-4 w-4" />
                Log out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
