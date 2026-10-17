import { useState, type FormEvent } from 'react';
import { Check, Eye, EyeOff, KeyRound, LockKeyhole, Store, UserRound } from 'lucide-react';
import { ApiError } from '../api';
import { completeFirstRunSetup } from '../data/setup';
import PharmaLogo from './PharmaLogo';

interface FirstRunSetupViewProps {
  onComplete: () => void;
}

const inputClass = 'w-full rounded-control border border-border bg-white px-3 py-2.5 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-accent';

function passwordChecks(password: string): Array<{ label: string; passed: boolean }> {
  const classes = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
  return [
    { label: 'At least 12 characters', passed: password.length >= 12 },
    { label: 'At least three character types', passed: classes >= 3 },
    { label: 'At least 8 different characters', passed: new Set(password).size >= 8 },
  ];
}

export function FirstRunSetupView({ onComplete }: FirstRunSetupViewProps) {
  const [setupCode, setSetupCode] = useState('');
  const [shopName, setShopName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [timeZone, setTimeZone] = useState('Asia/Karachi');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const checks = passwordChecks(password);
  const passwordsMatch = password.length > 0 && password === confirmation;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!checks.every((check) => check.passed)) {
      setError('Choose a stronger password that meets all listed requirements.');
      return;
    }
    if (!passwordsMatch) {
      setError('The password confirmation does not match.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await completeFirstRunSetup({
        setupCode,
        shopName,
        phone,
        address,
        timeZone,
        username,
        email,
        fullName,
        password,
      });
      setPassword('');
      setConfirmation('');
      setSetupCode('');
      onComplete();
    } catch (caught) {
      setError(caught instanceof ApiError
        ? caught.message
        : caught instanceof Error
          ? caught.message
          : 'Setup could not be completed. Please check the details and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-surface px-4 py-8 font-inter text-text sm:px-6">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6 text-center">
          <PharmaLogo size={10} className="mx-auto" />
          <h1 className="mt-4 text-2xl font-bold">Set up this pharmacy</h1>
          <p className="mt-2 text-sm text-muted">Create the shop and its first Super Admin account.</p>
        </header>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-6 rounded-card border border-border bg-white p-5 shadow-lg sm:p-7">
          <section aria-labelledby="shop-details-title">
            <h2 id="shop-details-title" className="mb-4 flex items-center gap-2 text-lg font-bold">
              <Store aria-hidden="true" size={19} className="text-primary" />
              Pharmacy details
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm font-semibold sm:col-span-2">
                Pharmacy name
                <input required maxLength={160} value={shopName} onChange={(event) => setShopName(event.target.value)} className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-semibold">
                Phone
                <input maxLength={80} autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-semibold">
                Shop time zone
                <input required maxLength={100} value={timeZone} onChange={(event) => setTimeZone(event.target.value)} className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-semibold sm:col-span-2">
                Address
                <textarea maxLength={1000} rows={2} value={address} onChange={(event) => setAddress(event.target.value)} className={inputClass} />
              </label>
            </div>
          </section>

          <section aria-labelledby="owner-details-title">
            <h2 id="owner-details-title" className="mb-4 flex items-center gap-2 text-lg font-bold">
              <UserRound aria-hidden="true" size={19} className="text-primary" />
              Super Admin account
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm font-semibold">
                Username
                <input required minLength={1} maxLength={64} autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-semibold">
                Full name
                <input required maxLength={160} autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-semibold sm:col-span-2">
                Email
                <input required type="email" maxLength={254} autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-semibold">
                Password
                <span className="relative block">
                  <LockKeyhole aria-hidden="true" size={17} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                  <input required type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className={`${inputClass} pl-10 pr-11`} />
                  <button type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? 'Hide password' : 'Show password'} className="absolute inset-y-0 right-0 px-3 text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    {showPassword ? <EyeOff aria-hidden="true" size={17} /> : <Eye aria-hidden="true" size={17} />}
                  </button>
                </span>
              </label>
              <label className="space-y-1.5 text-sm font-semibold">
                Confirm password
                <input required type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className={inputClass} />
              </label>
            </div>
            <ul aria-label="Password requirements" className="mt-3 space-y-1 text-xs">
              {checks.map((check) => (
                <li key={check.label} className={check.passed ? 'text-primary' : 'text-muted'}>
                  {check.passed ? '✓' : '•'} {check.label}
                </li>
              ))}
              <li className={passwordsMatch ? 'text-primary' : 'text-muted'}>
                {passwordsMatch ? '✓' : '•'} Passwords match
              </li>
            </ul>
          </section>

          <section aria-labelledby="setup-code-title">
            <h2 id="setup-code-title" className="mb-3 flex items-center gap-2 text-lg font-bold">
              <KeyRound aria-hidden="true" size={19} className="text-primary" />
              One-time setup code
            </h2>
            <label className="space-y-1.5 text-sm font-semibold">
              Enter the code shown by the installer
              <input required minLength={32} maxLength={128} autoComplete="off" spellCheck={false} value={setupCode} onChange={(event) => setSetupCode(event.target.value)} className={`${inputClass} font-mono`} />
            </label>
          </section>

          {error && <p role="alert" className="rounded-control border border-danger/30 bg-danger/5 px-3 py-2 text-sm font-medium text-danger">{error}</p>}
          <button
            type="submit"
            disabled={loading || !passwordsMatch || !checks.every((check) => check.passed)}
            className="flex w-full items-center justify-center gap-2 rounded-control bg-primary px-4 py-3 text-sm font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait disabled:opacity-60"
          >
            <Check aria-hidden="true" size={18} />
            {loading ? 'Creating pharmacy…' : 'Complete setup'}
          </button>
        </form>
      </div>
    </main>
  );
}
