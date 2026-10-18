export type PlanType = 'monthly' | 'yearly' | 'one_time';
export type PanelFormErrors = Partial<Record<string, string>>;

export interface ShopAdminForm {
  shop_name: string;
  owner_name: string;
  phone: string;
  city: string;
  timezone: string;
  admin_full_name: string;
  admin_email: string;
  plan_type: PlanType;
  starts_at: string;
  expires_at: string;
  max_pcs: string;
  offline_grace_days: string;
  warning_days: string;
  renewal_notice_days: string;
}

export const SHOP_ADMIN_FIELDS = [
  'shop_name',
  'owner_name',
  'phone',
  'city',
  'timezone',
  'admin_full_name',
  'admin_email',
  'plan_type',
  'starts_at',
  'expires_at',
  'max_pcs',
  'offline_grace_days',
  'warning_days',
  'renewal_notice_days',
] as const;

function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? parsed
    : null;
}

export function addPlanPeriod(startDate: string, plan: Exclude<PlanType, 'one_time'>): string {
  const start = parseDate(startDate);
  if (!start) return '';
  const monthDelta = plan === 'monthly' ? 1 : 12;
  const targetMonth = start.getUTCMonth() + monthDelta;
  const targetYear = start.getUTCFullYear() + Math.floor(targetMonth / 12);
  const month = targetMonth % 12;
  const lastDay = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
  const result = new Date(Date.UTC(targetYear, month, Math.min(start.getUTCDate(), lastDay)));
  return result.toISOString().slice(0, 10);
}

export function initialShopAdminForm(today = new Date().toISOString().slice(0, 10)): ShopAdminForm {
  return {
    shop_name: '',
    owner_name: '',
    phone: '',
    city: '',
    timezone: 'Asia/Karachi',
    admin_full_name: '',
    admin_email: '',
    plan_type: 'monthly',
    starts_at: today,
    expires_at: addPlanPeriod(today, 'monthly'),
    max_pcs: '3',
    offline_grace_days: '14',
    warning_days: '7',
    renewal_notice_days: '7',
  };
}

export function changePlanDefaults(
  form: ShopAdminForm,
  plan: PlanType,
  startsAt = form.starts_at,
): ShopAdminForm {
  return {
    ...form,
    plan_type: plan,
    starts_at: startsAt,
    expires_at: plan === 'one_time'
      ? ''
      : addPlanPeriod(startsAt, plan),
  };
}

export function validateShopAdminForm(form: ShopAdminForm): PanelFormErrors {
  const errors: PanelFormErrors = {};
  const requiredFields = [
    'shop_name',
    'owner_name',
    'phone',
    'city',
    'timezone',
    'admin_full_name',
    'admin_email',
  ];
  for (const field of requiredFields) {
    if (!form[field as keyof ShopAdminForm].trim()) errors[field] = 'This field is required.';
  }
  if (form.admin_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.admin_email.trim())) {
    errors.admin_email = 'Enter a valid email address.';
  }
  if (!parseDate(form.starts_at)) errors.starts_at = 'Enter a valid start date.';
  if (form.plan_type !== 'one_time') {
    if (!parseDate(form.expires_at)) errors.expires_at = 'Enter a valid expiry date.';
    else if (parseDate(form.starts_at)
      && Date.parse(form.expires_at) <= Date.parse(form.starts_at)) {
      errors.expires_at = 'Expiry must be after the start date.';
    }
  } else if (form.expires_at) {
    errors.expires_at = 'One-time plans do not have an expiry date.';
  }

  const integerFields: Array<[keyof ShopAdminForm, number, number]> = [
    ['max_pcs', 1, 1000],
    ['offline_grace_days', 1, 60],
    ['warning_days', 0, 30],
    ['renewal_notice_days', 0, 30],
  ];
  for (const [field, minimum, maximum] of integerFields) {
    const value = Number(form[field]);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      errors[field] = `Enter a whole number from ${minimum} to ${maximum}.`;
    }
  }
  return errors;
}

export function slugForShopName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 63);
}

export function createShopRequest(form: ShopAdminForm): Record<string, unknown> {
  return {
    shop: {
      name: form.shop_name.trim(),
      slug: slugForShopName(form.shop_name),
      owner_name: form.owner_name.trim(),
      phone: form.phone.trim(),
      city: form.city.trim(),
      timezone: form.timezone.trim(),
    },
    admin: {
      full_name: form.admin_full_name.trim(),
      email: form.admin_email.trim().toLowerCase(),
    },
    licence: {
      plan_type: form.plan_type,
      starts_at: new Date(`${form.starts_at}T00:00:00.000Z`).toISOString(),
      expires_at: form.plan_type === 'one_time'
        ? null
        : new Date(`${form.expires_at}T00:00:00.000Z`).toISOString(),
      max_pcs: Number(form.max_pcs),
      offline_grace_days: Number(form.offline_grace_days),
      warning_days: Number(form.warning_days),
      renewal_notice_days: Number(form.renewal_notice_days),
    },
  };
}
