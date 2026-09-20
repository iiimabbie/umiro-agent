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
  /** Bounded text derived at ingest for model input and rebuildable search. */
  readonly extractedText?: string;
  readonly parentSource?: { readonly kind: string; readonly id: string };
  readonly state: ArtifactState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ArtifactWorkspaceEntryState = "active" | "modified" | "missing" | "trashed";

/** Human-visible workspace projection of an immutable artifact blob. */
export interface ArtifactWorkspaceEntry {
  readonly artifactId: string;
  /** Path relative to the installation workspace (normally attachments/...). */
  readonly relativePath: string;
  readonly originalFilename: string;
  readonly state: ArtifactWorkspaceEntryState;
  readonly device?: string;
  readonly inode?: string;
  readonly materializedSha256: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
