import { createControlPlaneHandler, createEnvironmentStore, type FunctionName } from './router.ts';
import type { ControlPlaneEnvironment } from './types.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

const functionNames: ReadonlySet<string> = new Set([
  'activate',
  'heartbeat',
  'get-licence',
  'get-release',
  'support-token',
  'support-allow',
  'support-end',
  'create-shop',
  'extend-licence',
  'suspend',
  'change-plan',
  'approve-release',
  'withdraw-release',
  'panel-data',
  'create-release',
]);

function readEnvironment(): ControlPlaneEnvironment {
  const required = (name: keyof ControlPlaneEnvironment): string => {
    const value = Deno.env.get(name);
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };
  return {
    SUPABASE_URL: required('SUPABASE_URL'),
    SUPABASE_ANON_KEY: required('SUPABASE_ANON_KEY'),
    SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),
    LICENSE_SIGNING_PRIVATE_KEY: required('LICENSE_SIGNING_PRIVATE_KEY'),
    LICENSE_SIGNING_PUBLIC_KEY: required('LICENSE_SIGNING_PUBLIC_KEY'),
    SUPPORT_SIGNING_PRIVATE_KEY: required('SUPPORT_SIGNING_PRIVATE_KEY'),
    RATE_LIMIT_HASH_SECRET: required('RATE_LIMIT_HASH_SECRET'),
  };
}

const environment = readEnvironment();
const store = await createEnvironmentStore(environment);

Deno.serve(async (request) => {
  const name = new URL(request.url).pathname.split('/').filter(Boolean).pop();
  if (!name || !functionNames.has(name)) {
    return new Response(JSON.stringify({ error: 'FUNCTION_NOT_FOUND' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return createControlPlaneHandler(name as FunctionName, { store, environment })(request);
});
