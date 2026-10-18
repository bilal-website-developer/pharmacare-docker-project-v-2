import { useEffect, useState } from 'react';
import { getBackend } from '../api';
import { loadLicenceBannerStatus, type LicenceBannerStatus } from '../data/licence';

export function LicenceBanners() {
  const [status, setStatus] = useState<LicenceBannerStatus | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (getBackend() !== 'api') return;
    let active = true;
    const refresh = async () => {
      try {
        const result = await loadLicenceBannerStatus();
        if (active) {
          setStatus(result);
          setError('');
        }
      } catch {
        if (active) setError('Licence status could not be verified. Contact the shop administrator.');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  if (getBackend() !== 'api') return null;
  const messages: Array<{ key: string; text: string; urgent?: boolean }> = [];
  if (status?.banners.renewal_notice) {
    messages.push({
      key: 'renewal-notice',
      text: 'This licence is nearing expiry. Please contact the shop owner to arrange renewal.',
    });
  }
  if (status?.banners.warning) {
    messages.push({
      key: 'warning',
      text: 'The licence has expired and is in its warning period. Shop work remains available during this period.',
    });
  }
  if (status?.status === 'suspended') {
    messages.push({
      key: 'suspended',
      text: 'This shop is suspended. New sales, purchases and stock changes are paused; viewing, printing, reports and backups remain available.',
      urgent: true,
    });
  } else if (status?.status === 'inactive' || status?.banners.inactive) {
    messages.push({
      key: 'inactive',
      text: 'The licence is inactive. New sales, purchases and stock changes are paused; viewing, printing, reports and backups remain available.',
      urgent: true,
    });
  }
  if (status?.banners.offline_warning) {
    messages.push({
      key: 'offline-warning',
      text: 'The shop has been offline beyond its grace period. This is a warning only and does not block work.',
    });
  }
  if (status?.banners.clock_warning) {
    messages.push({
      key: 'clock-warning',
      text: 'The device clock moved backwards. Licence checks are using the last-seen time until the clock is corrected.',
    });
  }

  return (
    <div className="mb-4 space-y-2" aria-live="polite">
      {error && <p role="alert" className="rounded-control border border-danger/30 bg-danger/10 px-4 py-3 text-sm font-semibold text-danger">{error}</p>}
      {messages.map(({ key, text, urgent }) => (
        <p
          key={key}
          role={urgent ? 'alert' : 'status'}
          className={`rounded-control border px-4 py-3 text-sm font-semibold ${
            urgent
              ? 'border-danger/30 bg-danger/10 text-danger'
              : 'border-primary/25 bg-primary/5 text-text'
          }`}
        >
          {text}
        </p>
      ))}
    </div>
  );
}
