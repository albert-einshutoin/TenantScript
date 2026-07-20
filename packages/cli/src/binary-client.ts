import {
  createHttpAdminMutationClient,
  type AdminFetchLike,
  type AdminMutationClient
} from "./admin-http-client.js";

export interface BinaryAdminClient extends AdminMutationClient {
  rollbackInstallation: () => Promise<never>;
}

export function createBinaryAdminClient(
  environment: Record<string, string | undefined>,
  fetchImpl: AdminFetchLike
): BinaryAdminClient {
  const unavailable = () => Promise.reject(new Error("Admin mutation client is not configured"));
  const endpoint = environment.TENANTSCRIPT_CONTROL_PLANE_URL;
  const token = environment.TENANTSCRIPT_CONTROL_PLANE_TOKEN;
  if (endpoint === undefined || token === undefined) {
    return {
      rollbackInstallation: unavailable,
      rollbackAdminInstallation: unavailable,
      decideAdminApproval: unavailable
    };
  }
  try {
    return {
      rollbackInstallation: unavailable,
      ...createHttpAdminMutationClient({ baseUrl: endpoint, token, fetchImpl })
    };
  } catch {
    // Environment values may contain credentials or private deployment metadata. The public CLI
    // reports one stable configuration failure and never reflects the rejected value.
    return {
      rollbackInstallation: unavailable,
      rollbackAdminInstallation: unavailable,
      decideAdminApproval: unavailable
    };
  }
}
