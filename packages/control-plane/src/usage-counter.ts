export interface DailyUsageKey {
  tenantId: string;
  pluginId: string;
  at: Date;
}

export interface RecordExecutionUsageRequest extends DailyUsageKey {
  cpuMs: number;
}

export interface DailyUsageRecord {
  tenantId: string;
  pluginId: string;
  date: string;
  executions: number;
  cpuMs: number;
}

export interface DailyUsageCounter {
  recordExecution: (request: RecordExecutionUsageRequest) => Promise<DailyUsageRecord>;
  getDailyUsage: (request: DailyUsageKey) => Promise<DailyUsageRecord>;
}

export interface DailyUsageCounterStorage {
  get: (key: string) => Promise<DailyUsageRecord | undefined> | DailyUsageRecord | undefined;
  put: (key: string, record: DailyUsageRecord) => Promise<void> | void;
}

export function createInMemoryDailyUsageCounter(): DailyUsageCounter {
  const records = new Map<string, DailyUsageRecord>();
  return createDurableObjectDailyUsageCounter({
    get: (key) => records.get(key),
    put: (key, record) => {
      records.set(key, record);
    }
  });
}

export function createDurableObjectDailyUsageCounter(
  storage: DailyUsageCounterStorage
): DailyUsageCounter {
  const locks = new Map<string, Promise<void>>();

  return {
    recordExecution: (request) =>
      withUsageLock(locks, usageKey(request), async () => {
        validateCpuMs(request.cpuMs);
        const key = usageKey(request);
        const current = (await storage.get(key)) ?? emptyUsageRecord(request);
        const updated = {
          ...current,
          executions: current.executions + 1,
          cpuMs: current.cpuMs + request.cpuMs
        };
        await storage.put(key, updated);
        return updated;
      }),
    getDailyUsage: async (request) =>
      (await storage.get(usageKey(request))) ?? emptyUsageRecord(request)
  };
}

async function withUsageLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => next,
    () => next
  );
  locks.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === tail) {
      locks.delete(key);
    }
  }
}

function emptyUsageRecord(key: DailyUsageKey): DailyUsageRecord {
  return {
    tenantId: key.tenantId,
    pluginId: key.pluginId,
    date: usageDate(key.at),
    executions: 0,
    cpuMs: 0
  };
}

function usageKey(key: DailyUsageKey): string {
  return `${key.tenantId}:${key.pluginId}:${usageDate(key.at)}`;
}

function usageDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function validateCpuMs(cpuMs: number): void {
  if (!Number.isFinite(cpuMs) || cpuMs < 0) {
    throw new Error("cpuMs must be a non-negative finite number");
  }
}
