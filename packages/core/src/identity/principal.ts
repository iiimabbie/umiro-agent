export type PrincipalId = string;
export type PrincipalRole = "owner" | "member" | "guest" | "system";

export interface Principal {
  readonly id: PrincipalId;
  readonly kind: "human" | "system";
  readonly roles: readonly PrincipalRole[];
  /** Display-only metadata. Never use this field for authorization. */
  readonly displayName?: string;
}

export interface TransportIdentity {
  /** Transport name is adapter-owned; Core never imports transport-specific types. */
  readonly transport: string;
  readonly externalId: string;
  /** Null means the adapter must map the identity to a guest Principal. */
  readonly principalId: PrincipalId | null;
}

export interface ResolvedIdentity {
  readonly principal: Principal;
  readonly authority: import("../authorization/authority.js").Authority;
}

export interface IdentityResolver {
  resolve(identity: TransportIdentity): Promise<ResolvedIdentity>;
}

export function isOwner(principal: Principal): boolean {
  return principal.roles.includes("owner");
}
