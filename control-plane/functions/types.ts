export type TableName =
  | 'shops'
  | 'licences'
  | 'activation_codes'
  | 'devices'
  | 'shop_admins'
  | 'support_sessions'
  | 'releases'
  | 'release_rollouts'
  | 'audit_log'
  | 'control_plane_rate_limits';

export type Row = Record<string, unknown>;
export type Filters = Record<string, string | number | null>;

export interface ControlPlaneStore {
  select(table: TableName, filters: Filters): Promise<Row[]>;
  insert(table: TableName, row: Row): Promise<Row>;
  update(table: TableName, filters: Filters, patch: Row): Promise<Row[]>;
  rpc(name: string, args: Row): Promise<unknown>;
  consumeRateLimit(keyHash: string, limit: number, windowSeconds: number, lockSeconds: number): Promise<boolean>;
}

export interface ControlPlaneEnvironment {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  LICENSE_SIGNING_PRIVATE_KEY: string;
  LICENSE_SIGNING_PUBLIC_KEY: string;
  SUPPORT_SIGNING_PRIVATE_KEY: string;
  RATE_LIMIT_HASH_SECRET: string;
}

export interface ControlPlaneDependencies {
  store: ControlPlaneStore;
  environment: ControlPlaneEnvironment;
  fetcher?: typeof fetch;
  now?: () => Date;
}

export interface SignedLicence {
  payload: {
    shop_id: string;
    plan_type: 'monthly' | 'yearly' | 'one_time';
    starts_at: string;
    expires_at: string | null;
    max_pcs: number;
    offline_grace_days: number;
    warning_days: number;
    renewal_notice_days: number;
    issued_at: string;
    nonce: string;
  };
  signature: string;
}
