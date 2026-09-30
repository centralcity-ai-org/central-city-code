export type CheckStatus = 'pass' | 'fail' | 'unknown';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface DoctorReport {
  schemaVersion: 1;
  observedAt: string;
  target: string | null;
  checks: DoctorCheck[];
  overall: 'pass' | 'fail';
  tested: {
    authentication: false;
    userConsent: false;
    runtimeExecution: false;
    modelQuality: false;
  };
  note?: string;
}

export interface DoctorOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export function runDoctor(target: string, options?: DoctorOptions): Promise<DoctorReport>;
