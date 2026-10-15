import React, { useState } from 'react';
import { Check, Eye, EyeOff, LockKeyhole, UserRound } from 'lucide-react';
import { signIn, type AuthSession } from '../utils/auth';
import PharmaLogo from './PharmaLogo';
import { APP_NAME } from '../constants/brand';

interface LoginViewProps {
  onLogin: (session: AuthSession) => Promise<void>;
  initialError?: string;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLogin, initialError = '' }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initialError);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const session = await signIn(email.trim(), password);
      await onLogin(session);
      setPassword('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sign-in failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-3 py-4 font-inter text-text sm:px-5">
      <div className="w-full max-w-md">
        <header className="mb-3 space-y-1.5 text-center">
          <PharmaLogo size={9} className="mx-auto" />
          <p className="text-xs text-muted">Sign in to {APP_NAME}</p>
        </header>
        <section className="overflow-hidden rounded-card border border-border bg-white shadow-lg">
          <div className="h-1.5 bg-primary" />
          <form onSubmit={(event) => void handleSubmit(event)} className="space-y-5 p-4 sm:p-5">
            <div>
              <label htmlFor="email" className="mb-1.5 block text-xs font-bold tracking-wide">
                EMAIL
              </label>
              <div className="relative">
                <UserRound aria-hidden="true" size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="w-full rounded-control border border-border bg-white py-2.5 pl-10 pr-3 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
              </div>
            </div>
            <div>
              <label htmlFor="password" className="mb-1.5 block text-xs font-bold tracking-wide">
                PASSWORD
              </label>
              <div className="relative">
                <LockKeyhole aria-hidden="true" size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full rounded-control border border-border bg-white py-2.5 pl-10 pr-11 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
                <button
                  type="button"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword((visible) => !visible)}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            {error && <p role="alert" className="text-sm font-medium text-danger">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-control bg-primary px-4 py-2.5 text-sm font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait disabled:opacity-60"
            >
              <Check size={17} aria-hidden="true" />
              {loading ? 'Signing in…' : 'Sign In to System'}
            </button>
            <p className="text-center text-xs text-muted">Forgot your password? Contact your administrator.</p>
          </form>
        </section>
      </div>
    </main>
  );
};
