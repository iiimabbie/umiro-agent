import type { PrincipalId } from "../identity/principal.js";
import type { Artifact, ArtifactVisibility, ArtifactWorkspaceEntry } from "./entities.js";

export interface CreateArtifactRequest {
  readonly artifact: Artifact;
}

export interface ArtifactStore {
  createArtifact(request: CreateArtifactRequest): Promise<void>;
  getArtifact(id: string): Promise<Artifact | undefined>;
  listArtifacts(ownerPrincipalId?: PrincipalId): Promise<readonly Artifact[]>;
  updateArtifactState(id: string, state: Artifact["state"], updatedAt: string): Promise<void>;
  updateArtifactExtractedText?(id: string, text: string, updatedAt: string): Promise<void>;
  deleteArtifact(id: string, deletedAt: string): Promise<void>;
  canAccessArtifact(artifact: Artifact, principalId: PrincipalId, visibility: ArtifactVisibility): boolean;
  createArtifactWithWorkspaceEntry(request: CreateArtifactRequest & { readonly workspaceEntry: ArtifactWorkspaceEntry }): Promise<void>;
  getArtifactWorkspaceEntry(artifactId: string): Promise<ArtifactWorkspaceEntry | undefined>;
  getArtifactWorkspaceEntryByPath(relativePath: string): Promise<ArtifactWorkspaceEntry | undefined>;
  listArtifactWorkspaceEntries(): Promise<readonly ArtifactWorkspaceEntry[]>;
  updateArtifactWorkspaceLocation(request: { readonly artifactId: string; readonly relativePath: string; readonly filename: string; readonly device?: string; readonly inode?: string; readonly updatedAt: string }): Promise<void>;
  updateArtifactWorkspaceState(artifactId: string, state: ArtifactWorkspaceEntry["state"], updatedAt: string): Promise<void>;
}
