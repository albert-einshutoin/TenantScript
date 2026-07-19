/// <reference types="@cloudflare/workers-types" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ARTIFACTS: R2Bucket;
    PROBE_DO: DurableObjectNamespace;
    ADMIN_MUTATION_RATE_LIMITER_DO: DurableObjectNamespace;
    TEST_MIGRATIONS: D1Migration[];
  }
}

declare module "cloudflare:workers" {
  interface Env {
    DB: D1Database;
    ARTIFACTS: R2Bucket;
    PROBE_DO: DurableObjectNamespace;
    ADMIN_MUTATION_RATE_LIMITER_DO: DurableObjectNamespace;
    TEST_MIGRATIONS: D1Migration[];
  }

  interface ProvidedEnv {
    DB: D1Database;
    ARTIFACTS: R2Bucket;
    TEST_MIGRATIONS: D1Migration[];
  }
}
