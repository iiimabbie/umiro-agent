import type { PrincipalId } from "../identity/principal.js";
import type { Artifact, ArtifactVisibility } from "./entities.js";

export interface CreateArtifactRequest {
  readonly artifact: Artifact;
}

export interface ArtifactStore {
  createArtifact(request: CreateArtifactRequest): Promise<void>;
  getArtifact(id: string): Promise<Artifact | undefined>;
  listArtifacts(ownerPrincipalId?: PrincipalId): Promise<readonly Artifact[]>;
  updateArtifactState(id: string, state: Artifact["state"], updatedAt: string): Promise<void>;
  updateArtifactExtractedText?(id: string, text: string, updatedAt: string): Promise<void>;
  updateArtifactLocation?(request: { readonly artifactId: string; readonly location: string; readonly filename?: string; readonly size: number; readonly sha256: string; readonly updatedAt: string }): Promise<void>;
  deleteArtifact(id: string, deletedAt: string): Promise<void>;
  canAccessArtifact(artifact: Artifact, principalId: PrincipalId, visibility: ArtifactVisibility): boolean;
}
