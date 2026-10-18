import { useCallback, useEffect, useState } from 'react';
import { Check, KeyRound, ShieldCheck, X } from 'lucide-react';
import {
  allowSupport,
  endSupportSession,
  loadSupportSessions,
  type SupportApproval,
  type SupportScope,
  type SupportSessionSummary,
} from '../data/support';

const scopeDescriptions: Record<SupportScope, string> = {
  diagnostics: 'Service status and masked aggregate health counts only.',
  read_only: 'The current read-only view is the same masked diagnostics report.',
  admin_actions: 'Includes the limited licence-refresh action.',
};

export function AllowSupportView() {
  const [scope, setScope] = useState<SupportScope>('diagnostics');
  const [approval, setApproval] = useState<SupportApproval | null>(null);
  const [sessions, setSessions] = useState<SupportSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  const refreshSessions = useCallback(async () => {
    const result = await loadSupportSessions();
    setSessions(result);
  }, []);

  useEffect(() => {
    let active = true;
    void loadSupportSessions()
      .then((result) => {
        if (active) setSessions(result);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not load support sessions.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const activeSession = sessions.find((session) => Date.parse(session.expiresAt) > now);

  const handleAllow = async () => {
    setSaving(true);
    setError('');
    setApproval(null);
    try {
      const next = await allowSupport(scope);
      setApproval(next);
      await refreshSessions();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not allow support.');
    } finally {
      setSaving(false);
    }
  };

  const handleEnd = async (session: SupportSessionSummary) => {
    setSaving(true);
    setError('');
    try {
      await endSupportSession(session.sessionId);
      if (approval?.sessionId === session.sessionId) setApproval(null);
      await refreshSessions();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not end the support session.');
      try {
        await refreshSessions();
      } catch (refreshError) {
        setError(`${caught instanceof Error ? caught.message : 'Could not end the support session.'} ${refreshError instanceof Error ? refreshError.message : 'The session list could not be refreshed.'}`);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mx-auto max-w-3xl space-y-5">
      <header>
        <h1 className="text-2xl font-black text-text">Allow support</h1>
        <p className="mt-1 text-sm text-muted">
          Create a time-limited, scoped support session without sharing any shop password.
        </p>
      </header>

      <section className="space-y-4 rounded-card border border-border bg-white p-5 shadow-sm">
        <label className="block space-y-1.5 text-sm font-semibold">
          Support access
          <select
            value={scope}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'diagnostics' || value === 'read_only' || value === 'admin_actions') {
                setScope(value);
              }
            }}
            className="w-full rounded-control border border-border bg-white px-3 py-2.5 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <option value="diagnostics">Diagnostics</option>
            <option value="read_only">Read-only</option>
            <option value="admin_actions">Admin actions</option>
          </select>
        </label>
        <p className="text-sm text-muted">{scopeDescriptions[scope]}</p>
        <p className="rounded-control border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-text">
          The six-digit code is valid for 30 minutes and shown only once. Never share your password or a cashier's credentials.
        </p>
        {error && <p role="alert" className="rounded-control border border-danger/30 bg-danger/10 px-3 py-2 text-sm font-semibold text-danger">{error}</p>}
        <button
          type="button"
          onClick={() => void handleAllow()}
          disabled={loading || saving || Boolean(activeSession)}
          className="inline-flex items-center gap-2 rounded-control bg-primary px-4 py-2.5 text-sm font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          <ShieldCheck aria-hidden="true" size={17} />
          {saving ? 'Please wait…' : activeSession ? 'Support session already active' : 'Allow support'}
        </button>
      </section>

      {approval && (
        <section aria-labelledby="support-code-title" className="space-y-3 rounded-card border border-primary/30 bg-white p-5 shadow-sm">
          <h2 id="support-code-title" className="flex items-center gap-2 text-lg font-bold text-text">
            <KeyRound aria-hidden="true" size={19} className="text-primary" />
            One-time support code
          </h2>
          <p className="font-mono text-3xl font-black tracking-[0.25em] text-primary" aria-label="Six-digit support code">
            {approval.code}
          </p>
          <p className="text-sm text-muted">Expires {new Date(approval.expiresAt).toLocaleString()} · Scope: {approval.scope.replace('_', ' ')}.</p>
          <p className="text-xs text-muted">This code is not saved in the browser. If you leave this page, end this session and create a new code if support still needs access.</p>
        </section>
      )}

      <section className="space-y-3 rounded-card border border-border bg-white p-5 shadow-sm">
        <h2 className="text-lg font-bold text-text">Support sessions</h2>
        {loading ? (
          <p role="status" className="text-sm text-muted">Loading support sessions…</p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-muted">There are no active or recently ended sessions.</p>
        ) : (
          <ul className="space-y-3">
            {sessions.map((session) => {
              const expired = Date.parse(session.expiresAt) <= now;
              return (
                <li key={session.sessionId} className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-border p-3">
                  <div>
                    <p className="font-semibold text-text">{session.scope.replace('_', ' ')} support</p>
                    <p className="text-xs text-muted">
                      {expired ? 'Expired' : session.startedAt ? 'In use' : 'Waiting for support'} · expires {new Date(session.expiresAt).toLocaleString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleEnd(session)}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 rounded-control border border-border px-3 py-2 text-sm font-semibold text-text hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
                  >
                    {saving ? <Check aria-hidden="true" size={15} /> : <X aria-hidden="true" size={15} />}
                    End session
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
