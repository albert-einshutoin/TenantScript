import type { DoctorReportV2, DoctorRuntimePrimitive } from "./doctor.js";

export interface CliRuntime {
  collectCloudflareDoctor?: (request: {
    databaseId: string;
    configPath: string;
    adminCursorSecretPresent: boolean;
    runtime: DoctorRuntimePrimitive;
  }) => Promise<DoctorReportV2>;
}
