export type SoulGuardianMode = "restore" | "alert" | "ignore";

export interface SoulGuardianTarget {
  readonly path: string;
  readonly mode: SoulGuardianMode;
}

export interface SoulGuardianConfig {
  readonly workspacePath: string;
  readonly targets: readonly SoulGuardianTarget[];
  readonly schedule: string;
}

export type SoulGuardianStatus = "ok" | "drift" | "missing" | "unapproved" | "ignored";

export interface SoulGuardianItem {
  readonly path: string;
  readonly mode: SoulGuardianMode;
  readonly status: SoulGuardianStatus;
  readonly approvedSha256?: string;
  readonly currentSha256?: string;
}

export interface SoulGuardianCheckResult {
  readonly ok: boolean;
  readonly items: readonly SoulGuardianItem[];
  readonly restored: readonly string[];
  readonly fingerprint: string;
}
