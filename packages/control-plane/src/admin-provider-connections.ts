import type { D1DatabaseLike } from "./storage.js";

export interface AdminProviderConnectionSummary {
  provider: "slack";
  id: string;
  workspaceId: string;
  workspaceName?: string;
  botUserId?: string;
  connectedAt: string;
}

export interface AdminProviderConnectionStore {
  readConnections: (request: {
    appId: string;
    tenantId: string;
  }) => Promise<readonly AdminProviderConnectionSummary[]>;
}

export function createD1AdminProviderConnectionStore(
  db: D1DatabaseLike
): AdminProviderConnectionStore {
  return {
    readConnections: async (request) => {
      // Secret references are intentionally absent from both SELECT and the public row type so an
      // accidental mapper change cannot move credential handles into the Admin response boundary.
      const rows = await db
        .prepare(
          [
            "SELECT c.id, c.workspace_id, c.workspace_name, c.bot_user_id, c.connected_at",
            "FROM slack_connections c JOIN tenants t ON t.id = c.tenant_id",
            "WHERE t.id = ?1 AND t.app_id = ?2",
            "ORDER BY c.connected_at DESC, c.id DESC"
          ].join(" ")
        )
        .bind(request.tenantId, request.appId)
        .all();
      return (rows.results as ProviderConnectionRow[]).map((row) => ({
        provider: "slack",
        id: row.id,
        workspaceId: row.workspace_id,
        ...(row.workspace_name === null ? {} : { workspaceName: row.workspace_name }),
        ...(row.bot_user_id === null ? {} : { botUserId: row.bot_user_id }),
        connectedAt: row.connected_at
      }));
    }
  };
}

interface ProviderConnectionRow {
  id: string;
  workspace_id: string;
  workspace_name: string | null;
  bot_user_id: string | null;
  connected_at: string;
}
