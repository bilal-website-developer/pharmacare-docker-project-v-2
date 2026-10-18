import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import {
  changePlanDefaults,
  createShopRequest,
  initialShopAdminForm,
  slugForShopName,
  validateShopAdminForm,
  type PanelFormErrors,
  type PlanType,
  type ShopAdminForm,
} from './panel-domain';
import { errorMessage, invokeControlPlane, panelConfigurationError, supabase } from './client';

type Tab = 'shops' | 'audit' | 'releases';
type LicenceRow = {
  id: string;
  plan_type: PlanType;
  starts_at: string;
  expires_at: string | null;
  max_pcs: number;
  offline_grace_days: number;
  warning_days: number;
  renewal_notice_days: number;
  status: string;
};
type ShopRow = {
  id: string;
  name: string;
  slug: string;
  owner_name: string;
  phone: string;
  city: string;
  timezone: string;
  status: string;
  licences: LicenceRow[];
  admins: Array<{ email: string; full_name: string; status: string }>;
  devices: Array<{
    device_name: string;
    app_version: string | null;
    last_seen_at: string | null;
    status: string;
    health_counts?: Record<string, number>;
  }>;
};
type ReleaseRow = {
  id: string;
  version: string;
  channel: 'pilot' | 'stable';
  bundle_path: string;
  sha256: string;
  signature: string;
  notes: string;
  status: 'draft' | 'approved' | 'withdrawn';
  approved_at: string | null;
  created_at: string;
};
type AuditRow = {
  id: string;
  actor: string;
  action: string;
  shop_id: string | null;
  created_at: string;
};
type ShopPanelData = { shops: ShopRow[] };
type ReleasePanelData = { releases: ReleaseRow[] };
type AuditPanelData = { audit_log: AuditRow[] };
type Stage = 'login' | 'challenge' | 'enroll' | 'panel';
type TotpEnrollment = { factorId: string; qrCode: string; secret: string };
type ChangePlanForm = {
  plan_type: PlanType;
  starts_at: string;
  expires_at: string;
  max_pcs: string;
  offline_grace_days: string;
  warning_days: string;
  renewal_notice_days: string;
};

function dateInputValue(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : '';
}

function errorField(code: string): string | null {
  if (code.includes('TIMEZONE')) return 'timezone';
  if (code.includes('ADMIN_EMAIL')) return 'admin_email';
  if (code.includes('PLAN_TYPE')) return 'plan_type';
  if (code.includes('STARTS_AT')) return 'starts_at';
  if (code.includes('EXPIRY')) return 'expires_at';
  if (code.includes('MAX_PCS')) return 'max_pcs';
  if (code.includes('OFFLINE_GRACE')) return 'offline_grace_days';
  if (code.includes('WARNING_DAYS')) return 'warning_days';
  if (code.includes('RENEWAL_NOTICE')) return 'renewal_notice_days';
  if (code.includes('SHOP') || code.includes('SLUG')) return 'shop_name';
  if (code.includes('FULL_NAME')) return 'admin_full_name';
  return null;
}

function AuthPanel({
  client,
  stage,
  busy,
  message,
  enrollment,
  onLogin,
  onVerify,
  onEnroll,
}: {
  client: SupabaseClient;
  stage: Exclude<Stage, 'panel'>;
  busy: boolean;
  message: string;
  enrollment: TotpEnrollment | null;
  onLogin: (email: string, password: string) => void;
  onVerify: (code: string) => void;
  onEnroll: (code: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [factorId, setFactorId] = useState<string | null>(null);

  useEffect(() => {
    if (stage !== 'challenge') return;
    let cancelled = false;
    void client.auth.mfa.listFactors().then(({ data, error }) => {
      if (cancelled) return;
      if (error) return;
      const factor = data.totp.find((item) => item.status === 'verified');
      if (factor) setFactorId(factor.id);
    });
    return () => { cancelled = true; };
  }, [client, stage]);

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <p className="eyebrow">PHARMA CARE · DEVELOPER</p>
        <h1>Control plane</h1>
        <p className="muted">Secure administration for shop licences and releases.</p>
        {stage === 'login' && (
          <form className="stack" onSubmit={(event) => {
            event.preventDefault();
            onLogin(email.trim(), password);
          }}>
            <label>Email<input autoComplete="username" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label>Password<input autoComplete="current-password" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <button className="primary" disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
        )}
        {stage === 'challenge' && (
          <form className="stack" onSubmit={(event) => {
            event.preventDefault();
            onVerify(code);
          }}>
            <p>Enter the current code from your enrolled authenticator. The control panel requires verified two-factor authentication.</p>
            <label>Authenticator code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required value={code} onChange={(event) => setCode(event.target.value)} /></label>
            {factorId === null && <p className="muted">Loading the enrolled authenticator…</p>}
            <button className="primary" disabled={busy || factorId === null} type="submit">{busy ? 'Verifying…' : 'Verify and continue'}</button>
          </form>
        )}
        {stage === 'enroll' && (
          <form className="stack" onSubmit={(event) => {
            event.preventDefault();
            onEnroll(code);
          }}>
            <p>Enroll an authenticator before opening developer data.</p>
            {enrollment && (
              <div className="qr-panel">
                {enrollment.qrCode.startsWith('data:image/')
                  ? <img alt="Authenticator enrollment QR code" src={enrollment.qrCode} />
                  : <p>Scan this setup URI using your authenticator app.</p>}
                <label>Setup URI<input readOnly value={enrollment.qrCode.startsWith('otpauth://') ? enrollment.qrCode : enrollment.secret} /></label>
                <p className="muted">Keep the setup secret private; do not share it with shop staff.</p>
              </div>
            )}
            <label>Authenticator code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required value={code} onChange={(event) => setCode(event.target.value)} /></label>
            <button className="primary" disabled={busy || !enrollment} type="submit">{busy ? 'Enrolling…' : 'Verify authenticator'}</button>
          </form>
        )}
        {message && <p className="notice error" role="alert">{message}</p>}
      </section>
    </main>
  );
}

function ShopAdminFormView({
  client,
  onCreated,
}: {
  client: SupabaseClient;
  onCreated: () => void;
}) {
  const [form, setForm] = useState<ShopAdminForm>(() => initialShopAdminForm());
  const [errors, setErrors] = useState<PanelFormErrors>({});
  const [message, setMessage] = useState('');
  const [activationCode, setActivationCode] = useState('');
  const [busy, setBusy] = useState(false);

  const update = <K extends keyof ShopAdminForm>(field: K, value: ShopAdminForm[K]) => {
    setForm((current) => {
      if (field === 'plan_type') return changePlanDefaults(current, value as PlanType);
      if (field === 'starts_at') return changePlanDefaults(current, current.plan_type, String(value));
      return { ...current, [field]: value };
    });
    setErrors((current) => ({ ...current, [field]: '' }));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage('');
    setActivationCode('');
    const validationErrors = validateShopAdminForm(form);
    if (Object.keys(validationErrors).length) {
      setErrors(validationErrors);
      return;
    }
    setBusy(true);
    try {
      const result = await invokeControlPlane<{ activation_code: string }>(
        client,
        'create-shop',
        createShopRequest(form),
      );
      setActivationCode(result.activation_code);
      setForm(initialShopAdminForm());
      setErrors({});
      onCreated();
    } catch (error) {
      const code = errorMessage(error).toUpperCase();
      const field = errorField(code);
      if (field) setErrors({ [field]: 'The server rejected this value. Check the field and try again.' });
      setMessage(field ? '' : errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const field = (
    id: keyof ShopAdminForm,
    label: string,
    type = 'text',
    props: React.InputHTMLAttributes<HTMLInputElement> = {},
  ) => (
    <label htmlFor={id} className="field">
      <span>{label}</span>
      <input
        id={id}
        type={type}
        value={form[id]}
        aria-invalid={Boolean(errors[id])}
        aria-describedby={errors[id] ? `${id}-error` : undefined}
        onChange={(event) => update(id, event.target.value)}
        {...props}
      />
      {errors[id] && <small id={`${id}-error`} className="field-error">{errors[id]}</small>}
    </label>
  );

  return (
    <section className="card">
      <div className="section-heading">
        <div><p className="eyebrow">NEW SHOP</p><h2>Add Shop Admin</h2></div>
        <p className="muted">No shop password is created or stored here.</p>
      </div>
      {activationCode && (
        <div className="activation-result" role="status">
          <div><strong>One-time activation code</strong><p>Copy it now and deliver it securely to the shop owner. It expires in 7 days and will not be shown again.</p></div>
          <code>{activationCode}</code>
          <button className="quiet" type="button" onClick={() => setActivationCode('')}>Dismiss</button>
        </div>
      )}
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          {field('shop_name', 'Shop name', 'text', { required: true, maxLength: 160 })}
          <label className="field" htmlFor="slug">
            <span>Shop slug</span><input id="slug" readOnly value={slugForShopName(form.shop_name)} />
          </label>
          {field('owner_name', 'Owner name', 'text', { required: true, maxLength: 160 })}
          {field('phone', 'Phone', 'tel', { required: true, maxLength: 80 })}
          {field('city', 'City', 'text', { required: true, maxLength: 120 })}
          {field('timezone', 'Time zone', 'text', { required: true, maxLength: 100 })}
          {field('admin_full_name', 'Admin full name', 'text', { required: true, maxLength: 160 })}
          {field('admin_email', 'Admin email', 'email', { required: true, maxLength: 254 })}
          <label className="field" htmlFor="plan_type"><span>Plan type</span>
            <select id="plan_type" value={form.plan_type} onChange={(event) => update('plan_type', event.target.value as PlanType)}>
              <option value="monthly">Monthly</option><option value="yearly">Yearly</option><option value="one_time">One-time</option>
            </select>
            {errors.plan_type && <small className="field-error">{errors.plan_type}</small>}
          </label>
          {field('starts_at', 'Start date', 'date', { required: true })}
          {form.plan_type !== 'one_time' && field('expires_at', 'Expiry date', 'date', { required: true })}
          {form.plan_type === 'one_time' && <div className="field note-field">One-time licences do not expire.</div>}
          {field('max_pcs', 'Maximum PCs', 'number', { min: 1, max: 1000, step: 1, required: true })}
          {field('offline_grace_days', 'Offline grace days', 'number', { min: 1, max: 60, step: 1, required: true })}
          {field('warning_days', 'Warning days', 'number', { min: 0, max: 30, step: 1, required: true })}
          {field('renewal_notice_days', 'Renewal notice days', 'number', { min: 0, max: 30, step: 1, required: true })}
        </div>
        {message && <p className="notice error" role="alert">{message}</p>}
        <div className="form-actions"><button className="primary" disabled={busy} type="submit">{busy ? 'Creating shop…' : 'Create shop and activation code'}</button></div>
      </form>
    </section>
  );
}

function defaultChangePlan(licence?: LicenceRow): ChangePlanForm {
  const start = dateInputValue(licence?.starts_at) || new Date().toISOString().slice(0, 10);
  const plan = licence?.plan_type ?? 'monthly';
  const base = initialShopAdminForm(start);
  const form = changePlanDefaults(base, plan, start);
  return {
    plan_type: plan,
    starts_at: start,
    expires_at: dateInputValue(licence?.expires_at) || form.expires_at,
    max_pcs: String(licence?.max_pcs ?? 3),
    offline_grace_days: String(licence?.offline_grace_days ?? 14),
    warning_days: String(licence?.warning_days ?? 7),
    renewal_notice_days: String(licence?.renewal_notice_days ?? 7),
  };
}

function ShopList({
  client,
  data,
  onReload,
}: {
  client: SupabaseClient;
  data: ShopPanelData;
  onReload: () => void;
}) {
  const [selectedShop, setSelectedShop] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busyShop, setBusyShop] = useState<string | null>(null);
  const [planForms, setPlanForms] = useState<Record<string, ChangePlanForm>>({});
  const shops = useMemo(() => [...data.shops].sort((a, b) => a.name.localeCompare(b.name)), [data.shops]);

  const updatePlan = (shopId: string, field: keyof ChangePlanForm, value: string) => {
    const shop = shops.find((item) => item.id === shopId);
    if (!shop) return;
    setPlanForms((forms) => {
      const current = forms[shopId] ?? defaultChangePlan(shop.licences[0]);
      if (field === 'plan_type') {
        const updated = changePlanDefaults({
          ...initialShopAdminForm(current.starts_at),
          plan_type: current.plan_type,
          starts_at: current.starts_at,
          expires_at: current.expires_at,
        }, value as PlanType, current.starts_at);
        return { ...forms, [shopId]: { ...current, plan_type: value as PlanType, expires_at: updated.expires_at } };
      }
      if (field === 'starts_at') {
        const updated = changePlanDefaults({
          ...initialShopAdminForm(value),
          plan_type: current.plan_type,
          starts_at: current.starts_at,
          expires_at: current.expires_at,
        }, current.plan_type, value);
        return { ...forms, [shopId]: { ...current, starts_at: value, expires_at: updated.expires_at } };
      }
      return { ...forms, [shopId]: { ...current, [field]: value } };
    });
  };

  const runAction = async (shopId: string, operation: string, body: Record<string, unknown>) => {
    setBusyShop(shopId);
    setMessage('');
    try {
      await invokeControlPlane(client, operation, body);
      onReload();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusyShop(null);
    }
  };

  const savePlan = async (shop: ShopRow) => {
    const form = planForms[shop.id] ?? defaultChangePlan(shop.licences[0]);
    const licence = shop.licences[0];
    const parsed = {
      max_pcs: Number(form.max_pcs),
      offline_grace_days: Number(form.offline_grace_days),
      warning_days: Number(form.warning_days),
      renewal_notice_days: Number(form.renewal_notice_days),
    };
    if (!form.starts_at || (form.plan_type !== 'one_time' && !form.expires_at)
      || !Number.isInteger(parsed.max_pcs) || parsed.max_pcs < 1 || parsed.max_pcs > 1000
      || !Number.isInteger(parsed.offline_grace_days) || parsed.offline_grace_days < 1 || parsed.offline_grace_days > 60
      || !Number.isInteger(parsed.warning_days) || parsed.warning_days < 0 || parsed.warning_days > 30
      || !Number.isInteger(parsed.renewal_notice_days) || parsed.renewal_notice_days < 0 || parsed.renewal_notice_days > 30
      || (form.plan_type !== 'one_time' && Date.parse(form.expires_at) <= Date.parse(form.starts_at))) {
      setMessage('Check the plan dates, maximum PCs and licence day limits.');
      return;
    }
    if (licence && form.plan_type === licence.plan_type && form.expires_at
      && licence.expires_at && Date.parse(form.expires_at) > Date.parse(licence.expires_at)) {
      await runAction(shop.id, 'extend-licence', {
        shop_id: shop.id,
        expires_at: new Date(`${form.expires_at}T00:00:00.000Z`).toISOString(),
      });
      return;
    }
    await runAction(shop.id, 'change-plan', {
      shop_id: shop.id,
      plan_type: form.plan_type,
      starts_at: new Date(`${form.starts_at}T00:00:00.000Z`).toISOString(),
      expires_at: form.plan_type === 'one_time'
        ? null
        : new Date(`${form.expires_at}T00:00:00.000Z`).toISOString(),
      ...parsed,
    });
  };

  return (
    <section className="card">
      <div className="section-heading">
        <div><p className="eyebrow">SHOPS</p><h2>Shop licences</h2></div>
        <span className="count-pill">{shops.length} total</span>
      </div>
      {message && <p className="notice error" role="alert">{message}</p>}
      <div className="table-scroll">
        <table>
          <thead><tr><th>Shop</th><th>Admin</th><th>Plan</th><th>Expiry</th><th>PCs</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{shops.map((shop) => {
            const licence = shop.licences[0];
            const admin = shop.admins[0];
            return (
              <tr key={shop.id}>
                <td><strong>{shop.name}</strong><small>{shop.city} · {shop.timezone}</small></td>
                <td>{admin?.full_name ?? '—'}<small>{admin?.email ?? ''}</small></td>
                <td>{licence?.plan_type ?? '—'}<small>{licence?.status ?? 'No licence'}</small></td>
                <td>{licence?.expires_at ? dateInputValue(licence.expires_at) : 'Never'}</td>
                <td>{licence?.max_pcs ?? '—'}</td>
                <td><span className={`status status-${shop.status}`}>{shop.status}</span></td>
                <td className="table-actions">
                  <button className="quiet" type="button" onClick={() => setSelectedShop(selectedShop === shop.id ? null : shop.id)}>Manage</button>
                  {shop.status !== 'suspended' && <button className="danger-quiet" type="button" disabled={busyShop === shop.id} onClick={() => {
                    if (window.confirm(`Suspend ${shop.name}? This blocks new business writes.`)) {
                      void runAction(shop.id, 'suspend', { shop_id: shop.id });
                    }
                  }}>Suspend</button>}
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      {selectedShop && shops.filter((shop) => shop.id === selectedShop).map((shop) => {
        const licence = shop.licences[0];
        const form = planForms[shop.id] ?? defaultChangePlan(licence);
        return (
          <div className="shop-details" key={shop.id}>
            <div className="section-heading"><div><p className="eyebrow">LICENCE ACTIONS</p><h3>{shop.name}</h3></div><button className="quiet" type="button" onClick={() => setSelectedShop(null)}>Close</button></div>
            <p className="muted">{shop.owner_name} · {shop.phone} · {shop.slug}</p>
            <div className="device-strip">{shop.devices.map((device, index) => <span key={`${device.device_name}-${index}`}>{device.device_name}: {device.status}{device.last_seen_at ? ` · last seen ${new Date(device.last_seen_at).toLocaleString()}` : ''}</span>)}</div>
            <div className="form-grid compact">
              <label className="field"><span>Plan type</span><select value={form.plan_type} onChange={(event) => updatePlan(shop.id, 'plan_type', event.target.value)}><option value="monthly">Monthly</option><option value="yearly">Yearly</option><option value="one_time">One-time</option></select></label>
              <label className="field"><span>Start date</span><input type="date" value={form.starts_at} onChange={(event) => updatePlan(shop.id, 'starts_at', event.target.value)} /></label>
              {form.plan_type !== 'one_time' && <label className="field"><span>Expiry date</span><input type="date" value={form.expires_at} onChange={(event) => updatePlan(shop.id, 'expires_at', event.target.value)} /></label>}
              <label className="field"><span>Maximum PCs</span><input type="number" min="1" max="1000" value={form.max_pcs} onChange={(event) => updatePlan(shop.id, 'max_pcs', event.target.value)} /></label>
              <label className="field"><span>Offline grace days</span><input type="number" min="1" max="60" value={form.offline_grace_days} onChange={(event) => updatePlan(shop.id, 'offline_grace_days', event.target.value)} /></label>
              <label className="field"><span>Warning days</span><input type="number" min="0" max="30" value={form.warning_days} onChange={(event) => updatePlan(shop.id, 'warning_days', event.target.value)} /></label>
              <label className="field"><span>Renewal notice days</span><input type="number" min="0" max="30" value={form.renewal_notice_days} onChange={(event) => updatePlan(shop.id, 'renewal_notice_days', event.target.value)} /></label>
            </div>
            <div className="form-actions">
              <button className="primary" type="button" disabled={busyShop === shop.id} onClick={() => void savePlan(shop)}>{busyShop === shop.id ? 'Saving…' : 'Save / extend licence'}</button>
              {licence?.status === 'suspended' && <span className="muted">A suspended licence must be reissued through the server before it can be reactivated.</span>}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function AuditView({ rows }: { rows: AuditRow[] }) {
  return (
    <section className="card">
      <div className="section-heading"><div><p className="eyebrow">CONTROL PLANE</p><h2>Audit log</h2></div><span className="count-pill">{rows.length} events</span></div>
      <div className="table-scroll"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Shop ID</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}><td>{new Date(row.created_at).toLocaleString()}</td><td>{row.actor}</td><td>{row.action}</td><td className="mono">{row.shop_id ?? '—'}</td></tr>)}</tbody>
      </table></div>
      {rows.length === 0 && <p className="empty-state">No audit events have been recorded.</p>}
    </section>
  );
}

function ReleaseView({
  client,
  rows,
  onReload,
}: {
  client: SupabaseClient;
  rows: ReleaseRow[];
  onReload: () => void;
}) {
  const [form, setForm] = useState({ version: '', bundle_path: '', sha256: '', signature: '', notes: '' });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const action = async (name: string, body: Record<string, unknown>) => {
    setBusy(true);
    setMessage('');
    try {
      await invokeControlPlane(client, name, body);
      onReload();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const recordRelease = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!/^[a-f0-9]{64}$/.test(form.sha256)) {
      setMessage('SHA256 must be exactly 64 lowercase hexadecimal characters.');
      return;
    }
    if (!form.signature.trim()) {
      setMessage('Add the Ed25519 signature produced by the release signing workflow.');
      return;
    }
    await action('create-release', { ...form, sha256: form.sha256.trim() });
    setForm({ version: '', bundle_path: '', sha256: '', signature: '', notes: '' });
  };

  return (
    <section className="stack">
      <div className="card">
        <div className="section-heading"><div><p className="eyebrow">RELEASE MANAGEMENT</p><h2>Record a release</h2></div></div>
        <p className="muted">Recording only creates a draft. Build, scan, sign and publish the bundle using the release tools before approving it.</p>
        <form onSubmit={recordRelease}>
          <div className="form-grid">
            <label className="field"><span>Version</span><input required maxLength={80} value={form.version} onChange={(event) => setForm({ ...form, version: event.target.value })} /></label>
            <label className="field"><span>Bundle path / storage reference</span><input required maxLength={1000} value={form.bundle_path} onChange={(event) => setForm({ ...form, bundle_path: event.target.value })} /></label>
            <label className="field"><span>SHA256</span><input required minLength={64} maxLength={64} pattern="[a-f0-9]{64}" value={form.sha256} onChange={(event) => setForm({ ...form, sha256: event.target.value })} /></label>
            <label className="field"><span>Ed25519 signature</span><input required maxLength={1000} value={form.signature} onChange={(event) => setForm({ ...form, signature: event.target.value })} /></label>
            <label className="field full-width"><span>Release notes</span><textarea rows={3} maxLength={2000} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
          </div>
          {message && <p className="notice error" role="alert">{message}</p>}
          <div className="form-actions"><button className="primary" disabled={busy} type="submit">Record draft</button></div>
        </form>
      </div>
      <div className="card">
        <div className="section-heading"><div><p className="eyebrow">RELEASES</p><h2>Approval and rollout channel</h2></div><span className="count-pill">{rows.length} releases</span></div>
        <div className="table-scroll"><table><thead><tr><th>Version</th><th>Channel</th><th>Status</th><th>SHA256</th><th>Actions</th></tr></thead>
          <tbody>{rows.map((release) => <tr key={release.id}>
            <td><strong>{release.version}</strong><small>{release.notes || release.bundle_path}</small></td>
            <td>{release.channel}</td><td><span className={`status status-${release.status}`}>{release.status}</span></td>
            <td className="mono">{release.sha256.slice(0, 16)}…</td>
            <td className="table-actions">
              {release.status !== 'withdrawn' && release.channel !== 'pilot' && <button className="quiet" type="button" disabled={busy} onClick={() => void action('approve-release', { release_id: release.id, channel: 'pilot' })}>Approve pilot</button>}
              {release.status !== 'withdrawn' && release.channel !== 'stable' && <button className="quiet" type="button" disabled={busy} onClick={() => void action('approve-release', { release_id: release.id, channel: 'stable' })}>{release.status === 'draft' ? 'Approve stable' : 'Promote stable'}</button>}
              {release.status !== 'withdrawn' && <button className="danger-quiet" type="button" disabled={busy} onClick={() => void action('withdraw-release', { release_id: release.id })}>Withdraw</button>}
            </td>
          </tr>)}</tbody>
        </table></div>
        {rows.length === 0 && <p className="empty-state">No release drafts have been recorded.</p>}
      </div>
    </section>
  );
}

async function prepareSecondFactor(client: SupabaseClient): Promise<{
  stage: Exclude<Stage, 'panel'>;
  enrollment: TotpEnrollment | null;
}> {
  const { data: assurance, error: assuranceError } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assuranceError) throw assuranceError;
  if (assurance.currentLevel === 'aal2') return { stage: 'challenge', enrollment: null };

  const { data: factorData, error: factorsError } = await client.auth.mfa.listFactors();
  if (factorsError) throw factorsError;
  const verified = factorData.totp.find((factor) => factor.status === 'verified');
  if (verified) return { stage: 'challenge', enrollment: null };

  for (const factor of factorData.all.filter((candidate) => candidate.status === 'unverified')) {
    const { error } = await client.auth.mfa.unenroll({ factorId: factor.id });
    if (error) throw error;
  }
  const { data, error } = await client.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Pharma Care Control Plane',
  });
  if (error) throw error;
  return {
    stage: 'enroll',
    enrollment: {
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
    },
  };
}

export function ControlPanel() {
  const [stage, setStage] = useState<Stage>('login');
  const [session, setSession] = useState<Session | null>(null);
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [tab, setTab] = useState<Tab>('shops');
  const [panelData, setPanelData] = useState<ShopPanelData | ReleasePanelData | AuditPanelData | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const client = supabase;

  const loadTab = useCallback(async (selected: Tab, activeClient: SupabaseClient) => {
    setMessage('');
    const data = await invokeControlPlane<ShopPanelData | ReleasePanelData | AuditPanelData>(
      activeClient,
      'panel-data',
      { section: selected },
    );
    setPanelData(data);
  }, []);

  const finalizeSession = useCallback(async (clientSession: Session) => {
    if (!client) return;
    const secondFactor = await prepareSecondFactor(client);
    setSession(clientSession);
    setEnrollment(secondFactor.enrollment);
    setStage(secondFactor.stage);
    setMessage('');
    if (secondFactor.stage === 'challenge') {
      const { data: assurance } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assurance?.currentLevel === 'aal2') setStage('panel');
    }
  }, [client]);

  useEffect(() => {
    if (!client) return;
    let active = true;
    void client.auth.getSession().then(async ({ data, error }) => {
      if (!active) return;
      if (error) {
        setMessage(error.message);
        return;
      }
      if (!data.session) return;
      try {
        await finalizeSession(data.session);
      } catch (failure) {
        if (active) setMessage(errorMessage(failure));
      }
    });
    const { data: listener } = client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        setSession(null);
        setPanelData(null);
        setStage('login');
        setEnrollment(null);
      }
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [client, finalizeSession]);

  useEffect(() => {
    if (stage !== 'panel' || !client) return;
    let active = true;
    void loadTab(tab, client).catch((error: unknown) => {
      if (active) setMessage(errorMessage(error));
    });
    return () => { active = false; };
  }, [client, loadTab, stage, tab]);

  const runAuth = async (action: () => Promise<Session | null>) => {
    setBusy(true);
    setMessage('');
    try {
      const result = await action();
      if (result) await finalizeSession(result);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const login = (email: string, password: string) => {
    if (!client) return;
    void runAuth(async () => {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return data.session;
    });
  };

  const verifyFactor = (code: string) => {
    if (!client) return;
    void runAuth(async () => {
      const { data: factorData, error: listError } = await client.auth.mfa.listFactors();
      if (listError) throw listError;
      const factor = factorData.totp.find((candidate) => candidate.status === 'verified');
      if (!factor) throw new Error('No verified authenticator was found. Sign in again to enroll one.');
      const { error } = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
      if (error) throw error;
      const { data, error: sessionError } = await client.auth.getSession();
      if (sessionError) throw sessionError;
      return data.session;
    });
  };

  const enrollFactor = (code: string) => {
    if (!client || !enrollment) return;
    void runAuth(async () => {
      const { error } = await client.auth.mfa.challengeAndVerify({
        factorId: enrollment.factorId,
        code,
      });
      if (error) throw error;
      const { data, error: sessionError } = await client.auth.getSession();
      if (sessionError) throw sessionError;
      return data.session;
    });
  };

  const refreshData = async () => {
    if (client) await loadTab(tab, client);
  };

  if (panelConfigurationError || !client) {
    return <main className="auth-shell"><section className="auth-card"><p className="eyebrow">CONTROL PLANE</p><h1>Configuration required</h1><p className="notice">{panelConfigurationError}</p><p className="muted">Only the public Supabase URL and anon key belong in the browser. Service-role and signing keys must stay in the Edge Function environment.</p></section></main>;
  }

  if (stage !== 'panel' || !session) {
    return <AuthPanel client={client} stage={stage === 'panel' ? 'login' : stage} busy={busy} message={message} enrollment={enrollment} onLogin={login} onVerify={verifyFactor} onEnroll={enrollFactor} />;
  }

  return (
    <div className="panel-shell">
      <header className="topbar">
        <a className="brand" href="#"><span className="brand-mark">P</span><span>Pharma Care<small>Control plane</small></span></a>
        <div className="user-tools"><span>{session.user.email}</span><button className="quiet" type="button" onClick={() => void client.auth.signOut()}>Sign out</button></div>
      </header>
      <div className="panel-layout">
        <aside className="sidebar">
          <p className="eyebrow">WORKSPACE</p>
          {(['shops', 'audit', 'releases'] as const).map((item) => <button key={item} className={tab === item ? 'nav-item active' : 'nav-item'} onClick={() => setTab(item)} type="button">{item === 'shops' ? 'Shops & licences' : item === 'audit' ? 'Audit log' : 'Releases'}</button>)}
          <div className="sidebar-foot"><span className="secure-dot" />AAL2 developer session</div>
        </aside>
        <main className="workspace">
          <div className="workspace-heading"><div><p className="eyebrow">DEVELOPER CONSOLE</p><h1>{tab === 'shops' ? 'Shops & licences' : tab === 'audit' ? 'Audit log' : 'Releases'}</h1></div><button className="quiet" type="button" onClick={() => void refreshData()}>Refresh</button></div>
          {message && <p className="notice error" role="alert">{message}</p>}
          {tab === 'shops' && <>
            <ShopAdminFormView client={client} onCreated={() => { void refreshData(); }} />
            {panelData && 'shops' in panelData && <ShopList client={client} data={panelData} onReload={() => { void refreshData(); }} />}
          </>}
          {tab === 'audit' && panelData && 'audit_log' in panelData && <AuditView rows={panelData.audit_log} />}
          {tab === 'releases' && panelData && 'releases' in panelData && <ReleaseView client={client} rows={panelData.releases} onReload={() => { void refreshData(); }} />}
        </main>
      </div>
    </div>
  );
}
