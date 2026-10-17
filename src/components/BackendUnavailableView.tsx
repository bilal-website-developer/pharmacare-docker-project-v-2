import { RefreshCw, WifiOff } from 'lucide-react';
import PharmaLogo from './PharmaLogo';

interface BackendUnavailableViewProps {
  onRetry: () => void;
  retrying: boolean;
}

export function BackendUnavailableView({ onRetry, retrying }: BackendUnavailableViewProps) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-4 py-8 text-text">
      <section className="w-full max-w-md rounded-card border border-border bg-white p-6 text-center shadow-lg">
        <PharmaLogo size={10} className="mx-auto" />
        <WifiOff aria-hidden="true" size={32} className="mx-auto mt-6 text-muted" />
        <h1 className="mt-4 text-xl font-bold">Application server unavailable</h1>
        <p className="mt-2 text-sm text-muted">
          Check that this computer is connected to the pharmacy server, then try again.
        </p>
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="mt-6 inline-flex items-center justify-center gap-2 rounded-control bg-primary px-4 py-2.5 text-sm font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait disabled:opacity-60"
        >
          <RefreshCw aria-hidden="true" size={16} className={retrying ? 'animate-spin' : ''} />
          {retrying ? 'Checking connection…' : 'Retry connection'}
        </button>
      </section>
    </main>
  );
}
