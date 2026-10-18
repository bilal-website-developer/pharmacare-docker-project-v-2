import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, Pencil, Plus, Trash2, X } from 'lucide-react';
import { ROLE_LABELS, UserRole } from '../types/pharmacy';
import {
  MODULES,
  hasPosPrintToggles,
  PermissionKey,
  ROLE_DEFAULT_PERMISSIONS,
  setModulePermission,
  setPosPrintPermission,
} from '../permissions';
import { getBackend } from '../api/config';
import { changeOwnPassword, invokeManageUsersApi } from '../data/manageUsers';
import { supabase } from '../utils/supabase';

const MAX_USERS = 99;

interface ManagedUser {
  id: string;
  full_name: string | null;
  username: string | null;
  email: string | null;
  role: UserRole | null;
  is_active: boolean | null;
  permissions: PermissionKey[] | null;
  can_manage: boolean;
}

interface UserForm {
  full_name: string;
  username: string;
  email: string;
  password: string;
  role: UserRole;
  permissions: PermissionKey[];
  is_active: boolean;
}

const EMPTY_FORM: UserForm = {
  full_name: '',
  username: '',
  email: '',
  password: '',
  role: UserRole.CASHIER,
  permissions: [...ROLE_DEFAULT_PERMISSIONS[UserRole.CASHIER]],
  is_active: true,
};

export async function invokeManageUsers<T>(body: Record<string, unknown>): Promise<T> {
  if (getBackend() === 'api') return invokeManageUsersApi<T>(body);
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.functions.invoke('manage-users', { body });
  if (error) {
    const context = 'context' in error ? error.context : undefined;
    if (context instanceof Response) {
      const responseBody: unknown = await context.json().catch(() => null);
      if (typeof responseBody === 'object' && responseBody !== null && 'message' in responseBody) {
        throw new Error(String(responseBody.message));
      }
    }
    throw new Error(error.message);
  }
  return data as T;
}

function roleClass(role: UserRole) {
  switch (role) {
    case UserRole.CASHIER: return 'bg-blue-100 text-blue-800';
    case UserRole.MANAGER: return 'bg-orange-100 text-orange-800';
    case UserRole.ACCOUNTANT: return 'bg-teal-100 text-teal-800';
    case UserRole.ADMIN: return 'bg-purple-100 text-purple-800';
  }
}

export function ManageUsersView({
  currentUserId,
  currentRole,
  onChangePassword,
}: {
  currentUserId: string;
  currentRole: UserRole;
  onChangePassword: () => void;
}) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [currentCount, setCurrentCount] = useState(0);
  const [assignableRoles, setAssignableRoles] = useState<UserRole[]>([]);
  const [grantablePermissions, setGrantablePermissions] = useState<PermissionKey[]>([]);
  const [form, setForm] = useState<UserForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invokeManageUsers<{
        users?: ManagedUser[];
        currentCount?: number;
        assignable_roles?: UserRole[];
        grantable_permissions?: PermissionKey[];
      } | null>(
        { action: 'list' }
      );
      const hasRoleData = Array.isArray(result?.assignable_roles)
        && Array.isArray(result?.grantable_permissions);
      setUsers(Array.isArray(result?.users) ? result.users : []);
      setCurrentCount(typeof result?.currentCount === 'number' ? result.currentCount : 0);
      setAssignableRoles(Array.isArray(result?.assignable_roles) ? result.assignable_roles : []);
      setGrantablePermissions(Array.isArray(result?.grantable_permissions) ? result.grantable_permissions : []);
      if (!hasRoleData) {
        setNotice({
          text: 'The user service is out of date. Ask the admin to deploy manage-users.',
          error: true,
        });
      }
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : 'Could not load users.', error: true });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const startAdd = () => {
    setEditingId(null);
    setIsFormOpen(true);
    const role = assignableRoles[0] ?? UserRole.CASHIER;
    setForm({
      ...EMPTY_FORM,
      role,
      permissions: setModulePermission(
        ROLE_DEFAULT_PERMISSIONS[role].filter((permission) => grantablePermissions.includes(permission)),
        'pos',
        ROLE_DEFAULT_PERMISSIONS[role].includes('pos'),
        true,
      ).filter((permission) => grantablePermissions.includes(permission)),
    });
    setNotice(null);
  };

  const startEdit = (user: ManagedUser) => {
    if (!user.can_manage) return;
    const email = String(user.email ?? '');
    setEditingId(user.id);
    setIsFormOpen(true);
    setForm({
      full_name: String(user.full_name ?? ''),
      username: String(user.username ?? ''),
      email,
      password: '',
      role: Object.values(UserRole).includes(user.role as UserRole)
        ? user.role as UserRole
        : UserRole.CASHIER,
      permissions: Array.isArray(user.permissions) ? [...user.permissions] : [],
      is_active: user.is_active === true,
    });
    setNotice(null);
  };

  const cancelForm = () => {
    setEditingId(null);
    setIsFormOpen(false);
    setForm({ ...EMPTY_FORM, permissions: [...EMPTY_FORM.permissions] });
  };

  const handleSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fullName = form.full_name.trim();
    const username = form.username.trim();
    const email = form.email.trim();
    if (!fullName) return setNotice({ text: 'Full name is required.', error: true });
    if (!username) return setNotice({ text: 'Username is required.', error: true });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return setNotice({ text: 'Enter a valid email address.', error: true });
    }
    if (!editingId && form.password.length < 8) {
      return setNotice({ text: 'Password must be at least 8 characters.', error: true });
    }
    if (editingId && form.password && form.password.length < 8) {
      return setNotice({ text: 'Password must be at least 8 characters.', error: true });
    }

    setSaving(true);
    setNotice(null);
    try {
      const result = await invokeManageUsers<{ message: string }>({
        action: editingId ? 'update' : 'create',
        ...(editingId ? { id: editingId } : {}),
        full_name: fullName,
        username,
        email,
        ...(!editingId ? { password: form.password } : {}),
        role: form.role,
        permissions: form.role === UserRole.ADMIN
          ? MODULES.map(({ key }) => key)
          : form.permissions,
        is_active: form.is_active,
      });
      if (editingId && form.password) {
        try {
          await invokeManageUsers<{ message: string }>({
            action: 'reset_password',
            id: editingId,
            password: form.password,
          });
        } catch (error) {
          cancelForm();
          await refresh();
          setNotice({
            text: `Profile updated, but the password reset failed: ${error instanceof Error ? error.message : 'Unknown error.'}`,
            error: true,
          });
          return;
        }
      }
      cancelForm();
      setNotice({ text: result.message || 'User saved.', error: false });
      await refresh();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : 'Could not save user.', error: true });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (user: ManagedUser) => {
    if (!user.can_manage || user.id === currentUserId) return;
    if (!window.confirm(`Remove ${user.username}? They will no longer be able to log in.`)) return;
    setNotice(null);
    try {
      const result = await invokeManageUsers<{ message: string }>({ action: 'delete', id: user.id });
      setNotice({ text: result.message || 'User removed.', error: false });
      await refresh();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : 'Could not remove user.', error: true });
    }
  };

  return (
    <section className="mx-auto max-w-6xl space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-white p-5 shadow-sm">
        <div>
          <h2 className="text-xl font-black text-text">Users</h2>
          <p className="mt-1 text-sm text-muted">Shop Limit (Unlimited): {currentCount} / {MAX_USERS} users</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {currentRole !== UserRole.ADMIN && <button type="button" onClick={onChangePassword} className="inline-flex items-center gap-2 rounded-control bg-primary px-4 py-2.5 text-sm font-bold text-white hover:opacity-90">
            <KeyRound size={16} /> Change My Password
          </button>}
          {!isFormOpen && (
            <button type="button" disabled={currentCount >= MAX_USERS} onClick={startAdd} className="inline-flex items-center gap-2 rounded-control bg-blue-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
              <Plus size={17} /> Add User
            </button>
          )}
          {editingId && <button type="button" onClick={cancelForm} className="inline-flex items-center gap-2 rounded-control border border-border px-4 py-2.5 text-sm font-bold text-text hover:bg-surface"><X size={16} /> Cancel</button>}
        </div>
      </header>

      {notice && <p role={notice.error ? 'alert' : 'status'} className={`visual-toast rounded-control border px-4 py-3 text-sm ${notice.error ? 'border-red-200 bg-red-50 text-red-800' : 'border-green-200 bg-green-50 text-green-800'}`}>{notice.text}</p>}

      {isFormOpen && (
        <form onSubmit={(event) => void handleSave(event)} className="space-y-5 rounded-card border border-border bg-white p-5 shadow-sm">
          <h3 className="text-base font-bold text-text">{editingId ? 'Edit User' : 'Add User'}</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm font-semibold text-text">
              Full name *
              <input required value={form.full_name} onChange={(event) => setForm({ ...form, full_name: event.target.value })} className="w-full rounded-control border border-border bg-white px-3 py-2 text-sm font-normal" />
            </label>
            <label className="space-y-1.5 text-sm font-semibold text-text">
              Username *
              <input required value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} className="w-full rounded-control border border-border bg-white px-3 py-2 text-sm font-normal" />
            </label>
            <label className="space-y-1.5 text-sm font-semibold text-text">
              Email *
              <input required type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} className="w-full rounded-control border border-border bg-white px-3 py-2 text-sm font-normal" />
            </label>
            {!(editingId === currentUserId && currentRole === UserRole.ADMIN) && <label className="space-y-1.5 text-sm font-semibold text-text sm:col-span-2">
              {editingId ? 'Set New Password (optional)' : 'Password *'}
              <input type="password" autoComplete="new-password" required={!editingId} minLength={8} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={editingId ? 'Leave blank to keep the current password' : 'At least 8 characters'} className="w-full rounded-control border border-border bg-white px-3 py-2 text-sm font-normal" />
              {editingId && <span className="block text-xs font-normal text-muted">Passwords cannot be viewed. Setting a new password replaces the current one.</span>}
            </label>}
            <label className="space-y-1.5 text-sm font-semibold text-text sm:col-span-2">
              Role
              <select value={form.role} disabled={editingId === currentUserId} onChange={(event) => {
                const role = event.target.value as UserRole;
                setForm({
                  ...form,
                  role,
                  permissions: setModulePermission(
                    ROLE_DEFAULT_PERMISSIONS[role].filter((permission) => grantablePermissions.includes(permission)),
                    'pos',
                    ROLE_DEFAULT_PERMISSIONS[role].includes('pos'),
                    true,
                  ).filter((permission) => grantablePermissions.includes(permission)),
                });
              }} className="w-full rounded-control border border-border bg-white px-3 py-2 text-sm font-normal">
                {editingId === currentUserId && !assignableRoles.includes(form.role) && (
                  <option value={form.role}>{ROLE_LABELS[form.role]}</option>
                )}
                {assignableRoles.map((role) => (
                  <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                ))}
              </select>
            </label>
          </div>

          <fieldset disabled={editingId === currentUserId} className="rounded-control border border-border p-4 disabled:opacity-70">
            <legend className="px-2 text-sm font-bold text-text">Allowed Modules (Custom Permissions)</legend>
            {form.role === UserRole.ADMIN && <p className="mb-3 text-xs font-semibold text-muted">Admins can access every module.</p>}
            {form.role === UserRole.ADMIN && <p className="mb-3 text-xs font-semibold text-muted">Select the modules this admin is allowed to access.</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              {MODULES.filter(({ key }) => grantablePermissions.includes(key)).map(({ key, label }) => (
                <label key={key} className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={form.role === UserRole.ADMIN || form.permissions.includes(key)}
                    disabled={form.role === UserRole.ADMIN}
                    onChange={(event) => setForm({
                      ...form,
                      permissions: setModulePermission(
                        form.permissions,
                        key,
                        event.target.checked,
                        key === 'pos' && !editingId,
                      ),
                    })}
                    className="h-4 w-4 accent-green-700"
                  />
                  {label}
                </label>
              ))}
            </div>
            {getBackend() === 'api' && grantablePermissions.includes('stock_alerts') && (
              <label className="mt-3 flex items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  checked={form.role === UserRole.ADMIN || form.permissions.includes('stock_alerts')}
                  disabled={form.role === UserRole.ADMIN}
                  onChange={(event) => {
                    const permissions = new Set(form.permissions);
                    if (event.target.checked) permissions.add('stock_alerts');
                    else permissions.delete('stock_alerts');
                    setForm({ ...form, permissions: [...permissions] });
                  }}
                  className="h-4 w-4 accent-green-700"
                />
                Stock Alerts
              </label>
            )}
            {hasPosPrintToggles(form.permissions) && (
              <div className="mt-4 space-y-3 border-t border-border pt-4">
                {([
                  ['pos_print_sale', 'Print sale receipts'],
                  ['pos_print_payment', 'Print receiving-money receipts'],
                ] as const).map(([permission, label]) => {
                  const canChange = grantablePermissions.includes(permission)
                    || (editingId !== null && form.permissions.includes(permission));
                  return (
                    <label key={permission} className="flex items-center justify-between gap-3 text-sm text-text">
                      <span>{label}</span>
                      <span className="flex items-center gap-2">
                        <span className="text-xs font-bold text-muted">{form.permissions.includes(permission) ? 'Yes' : 'No'}</span>
                        <input
                          type="checkbox"
                          role="switch"
                          aria-label={label}
                          checked={form.permissions.includes(permission)}
                          disabled={!canChange}
                          onChange={(event) => setForm({
                            ...form,
                            permissions: setPosPrintPermission(form.permissions, permission, event.target.checked),
                          })}
                          className="h-4 w-4 accent-green-700"
                        />
                      </span>
                    </label>
                  );
                })}
                <p className="text-xs text-muted">New users can print sale receipts by default. Receiving-money receipts require separate approval.</p>
              </div>
            )}
          </fieldset>

          <label className="flex items-center gap-2 text-sm font-semibold text-text">
            <input type="checkbox" checked={form.is_active} disabled={editingId === currentUserId} onChange={(event) => setForm({ ...form, is_active: event.target.checked })} className="h-4 w-4 accent-green-700 disabled:opacity-50" />
            Active (can log in)
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className="rounded-control bg-blue-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-blue-700 disabled:cursor-wait disabled:opacity-60">{saving ? 'Saving…' : 'Save User'}</button>
            <button type="button" onClick={cancelForm} disabled={saving} className="rounded-control border border-border px-5 py-2.5 text-sm font-bold text-text hover:bg-surface">Cancel</button>
          </div>
        </form>
      )}

      <div className="overflow-x-auto rounded-card border border-border bg-white shadow-sm">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead className="border-b border-border bg-surface text-[11px] font-bold uppercase tracking-wide text-muted">
            <tr><th className="px-5 py-3">User Info</th><th className="px-5 py-3">Role</th><th className="px-5 py-3">Status</th><th className="px-5 py-3 text-right">Actions</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading ? <tr><td colSpan={4} className="visual-skeleton px-5 py-8 text-center text-muted">Loading users…</td></tr>
              : users.length === 0 ? <tr><td colSpan={4} className="px-5 py-8 text-center text-muted">No active profiles found.</td></tr>
                : users.map((user) => (
                  <tr key={user.id} className="users-table-row">
                    <td className="px-5 py-4">
                      <div className="font-bold text-text">{user.full_name} {user.id === currentUserId && <span className="ml-1 rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold text-muted">(You)</span>}</div>
                      <div className="mt-0.5 text-xs text-muted">{user.username} · {user.email}</div>
                    </td>
                    <td className="px-5 py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-bold capitalize ${roleClass(Object.values(UserRole).includes(user.role as UserRole) ? user.role as UserRole : UserRole.CASHIER)}`}>{user.role ? ROLE_LABELS[user.role] : ROLE_LABELS[UserRole.CASHIER]}</span></td>
                    <td className="px-5 py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${user.is_active === true ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>{user.is_active === true ? 'Active' : 'Inactive'}</span></td>
                    <td className="px-5 py-4">
                      <div className="flex justify-end gap-2">
                        {user.can_manage && <>
                          <button type="button" onClick={() => startEdit(user)} title={`Edit ${user.username}`} aria-label={`Edit ${user.username}`} className="rounded-control border border-border p-2 text-muted hover:bg-surface"><Pencil size={15} /></button>
                          {user.id !== currentUserId && <button type="button" onClick={() => void handleDelete(user)} title={`Delete ${user.username}`} aria-label={`Delete ${user.username}`} className="rounded-control border border-red-200 p-2 text-danger hover:bg-red-50"><Trash2 size={15} /></button>}
                        </>}
                      </div>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {currentCount >= MAX_USERS && !editingId && <p role="status" className="text-sm text-warning">The user limit has been reached.</p>}
    </section>
  );
}

export function ChangePasswordModal({
  email,
  onClose,
}: {
  email: string;
  onClose: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newPassword.length < 8) {
      setError(true);
      setMessage('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(true);
      setMessage('New password and confirmation do not match.');
      return;
    }
    if (getBackend() === 'api') {
      setSaving(true);
      setMessage('');
      try {
        await changeOwnPassword(currentPassword, newPassword);
        setError(false);
        setMessage('Password changed successfully.');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } catch (caught) {
        setError(true);
        setMessage(caught instanceof Error ? caught.message : 'Could not change the password.');
      } finally {
        setSaving(false);
      }
      return;
    }
    if (!supabase) {
      setError(true);
      setMessage('Supabase is not configured.');
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      const { error: verifyError } = await supabase.auth.signInWithPassword({ email, password: currentPassword });
      if (verifyError) throw new Error('Current password is incorrect.');
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) throw updateError;
      setError(false);
      setMessage('Password changed successfully.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (caught) {
      setError(true);
      setMessage(caught instanceof Error ? caught.message : 'Could not change the password.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="password-dialog-title" className="visual-modal-panel w-full max-w-md space-y-4 rounded-card bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between"><h2 id="password-dialog-title" className="text-lg font-bold text-text">Change My Password</h2><button type="button" onClick={onClose} aria-label="Close" className="text-muted">×</button></div>
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
          <label className="block text-sm font-semibold">Current password<input type="password" required autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} className="mt-1 w-full rounded-control border border-border px-3 py-2 font-normal" /></label>
          <label className="block text-sm font-semibold">New password<input type="password" required minLength={8} autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className="mt-1 w-full rounded-control border border-border px-3 py-2 font-normal" /></label>
          <label className="block text-sm font-semibold">Confirm new password<input type="password" required minLength={8} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="mt-1 w-full rounded-control border border-border px-3 py-2 font-normal" /></label>
          {message && <p role={error ? 'alert' : 'status'} className={`visual-toast text-sm ${error ? 'text-danger' : 'text-primary'}`}>{message}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="rounded-control border border-border px-4 py-2 text-sm font-semibold">Cancel</button>
            <button type="submit" disabled={saving} className="rounded-control bg-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-60">{saving ? 'Saving…' : 'Update Password'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
