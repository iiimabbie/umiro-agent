import type { PrincipalId } from "../identity/principal.js";

export type ArtifactVisibility = "private" | "shared" | "public";
export type ArtifactState = "stored" | "pending_delivery" | "delivered" | "deleted";

export interface Artifact {
  readonly id: string;
  readonly ownerPrincipalId: PrincipalId;
  readonly visibility: ArtifactVisibility;
  readonly mediaType: string;
  readonly filename?: string;
  readonly size: number;
  readonly sha256: string;
  readonly location: string;
  readonly parentSource?: { readonly kind: string; readonly id: string };
  readonly state: ArtifactState;
  readonly createdAt: string;
  readonly updatedAt: string;
}
