import type { ControlPlaneEnvironment, ControlPlaneStore, Filters, Row, TableName } from './types.ts';

const TABLES: ReadonlySet<TableName> = new Set([
  'shops',
  'licences',
  'activation_codes',
  'devices',
  'shop_admins',
  'support_sessions',
  'releases',
  'release_rollouts',
  'audit_log',
  'control_plane_rate_limits',
]);

export class PostgrestControlPlaneStore implements ControlPlaneStore {
  constructor(
    private readonly environment: ControlPlaneEnvironment,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async select(table: TableName, filters: Filters): Promise<Row[]> {
    return this.request<Row[]>(table, 'GET', filters);
  }

  async insert(table: TableName, row: Row): Promise<Row> {
    const rows = await this.request<Row[]>(table, 'POST', {}, row);
    const inserted = rows[0];
    if (!inserted) throw new Error('Control-plane insert returned no row');
    return inserted;
  }

  async update(table: TableName, filters: Filters, patch: Row): Promise<Row[]> {
    return this.request<Row[]>(table, 'PATCH', filters, patch);
  }

  async rpc(name: string, args: Row): Promise<unknown> {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('Unsupported control-plane RPC');
    const response = await this.fetcher(
      `${this.environment.SUPABASE_URL}/rest/v1/rpc/${name}`,
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(args),
      },
    );
    if (!response.ok) throw new Error(`Control-plane RPC failed (${response.status})`);
    return response.json();
  }

  async consumeRateLimit(
    keyHash: string,
    limit: number,
    windowSeconds: number,
    lockSeconds: number,
  ): Promise<boolean> {
    const response = await this.fetcher(
      `${this.environment.SUPABASE_URL}/rest/v1/rpc/control_plane_consume_rate_limit`,
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          p_key_hash: keyHash,
          p_limit: limit,
          p_window_seconds: windowSeconds,
          p_lock_seconds: lockSeconds,
        }),
      },
    );
    if (!response.ok) throw new Error(`Control-plane rate-limit RPC failed (${response.status})`);
    return response.json() as Promise<boolean>;
  }

  private async request<T>(
    table: TableName,
    method: 'GET' | 'POST' | 'PATCH',
    filters: Filters,
    body?: Row,
  ): Promise<T> {
    if (!TABLES.has(table)) throw new Error('Unsupported control-plane table');
    const url = new URL(`/rest/v1/${table}`, this.environment.SUPABASE_URL);
    url.searchParams.set('select', '*');
    for (const [key, value] of Object.entries(filters)) {
      if (value === null) url.searchParams.set(key, 'is.null');
      else if (typeof value === 'string' && value.startsWith('gt:')) {
        url.searchParams.set(key, `gt.${value.slice(3)}`);
      } else url.searchParams.set(key, `eq.${value}`);
    }
    const response = await this.fetcher(url, {
      method,
      headers: this.headers({
        'content-type': 'application/json',
        prefer: 'return=representation',
      }),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`Control-plane ${method} failed (${response.status})`);
    return response.json() as Promise<T>;
  }

  private headers(extra: Record<string, string>): HeadersInit {
    return {
      apikey: this.environment.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${this.environment.SUPABASE_SERVICE_ROLE_KEY}`,
      ...extra,
    };
  }
}
