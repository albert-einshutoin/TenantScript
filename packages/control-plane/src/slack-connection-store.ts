import type { SecretRef } from "./secret-store.js";

export interface SlackConnectionRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  workspaceName?: string;
  botUserId?: string;
  secretRef: SecretRef;
  connectedAt: Date;
}

export interface SlackConnectionStore {
  upsertSlackConnection: (
    record: SlackConnectionRecord
  ) => Promise<SlackConnectionRecord> | SlackConnectionRecord;
  findSlackConnection: (query: {
    tenantId: string;
    workspaceId: string;
  }) => Promise<SlackConnectionRecord | null> | SlackConnectionRecord | null;
}

export interface InspectableSlackConnectionStore extends SlackConnectionStore {
  listConnections: () => readonly SlackConnectionRecord[];
}

export function createInMemorySlackConnectionStore(): InspectableSlackConnectionStore {
  const connections = new Map<string, SlackConnectionRecord>();

  return {
    upsertSlackConnection: (record) => {
      connections.set(connectionKey(record), cloneSlackConnection(record));
      return cloneSlackConnection(record);
    },
    findSlackConnection: (query) => {
      const record = connections.get(connectionKey(query));
      return record === undefined ? null : cloneSlackConnection(record);
    },
    listConnections: () =>
      [...connections.values()].map((connection) => cloneSlackConnection(connection))
  };
}

function connectionKey(query: { tenantId: string; workspaceId: string }): string {
  return `${query.tenantId}:${query.workspaceId}`;
}

function cloneSlackConnection(record: SlackConnectionRecord): SlackConnectionRecord {
  return {
    ...record,
    secretRef: { ...record.secretRef },
    connectedAt: new Date(record.connectedAt)
  };
}
