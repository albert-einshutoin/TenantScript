import type { DoctorReportV2, DoctorRuntimePrimitive } from "./doctor.js";

export interface CliRuntime {
  collectCloudflareDoctor?: (request: {
    workerName: string;
    databaseId: string;
    runtime: DoctorRuntimePrimitive;
  }) => Promise<DoctorReportV2>;
}
