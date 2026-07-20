import { createCloudflareApiTransport, type CloudflareFetch } from "./cloudflare-api-transport.js";
import { createCloudflareDoctorCollector } from "./cloudflare-doctor-collector.js";
import { createCloudflareD1MigrationReader } from "./cloudflare-wrangler-d1-migration-runner.js";
import type { CliRuntime } from "./cli-runtime.js";

export function createBinaryDoctorRuntime(
  environment: Record<string, string | undefined>,
  fetchImpl: CloudflareFetch
): CliRuntime {
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = environment.CLOUDFLARE_API_TOKEN;
  if (accountId === undefined || apiToken === undefined) return {};

  try {
    const transport = createCloudflareApiTransport({ accountId, apiToken, fetch: fetchImpl });
    return {
      collectCloudflareDoctor: ({ workerName, databaseId, runtime }) =>
        createCloudflareDoctorCollector({
          transport,
          workerName,
          databaseId,
          migrationReader: createCloudflareD1MigrationReader({ transport, databaseId }),
          // This composition inspects one ordinary Worker deployment. Other runtime primitives
          // remain visible as unsupported until their own authoritative collectors exist.
          runtime: { configured: runtime, supported: ["cloudflare-workers"] }
        }).collect()
    };
  } catch {
    // Environment values are private deployment inputs. Invalid credentials/configuration are
    // represented only by the absence of the live dependency and never reflected by the CLI.
    return {};
  }
}
