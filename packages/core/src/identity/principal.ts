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
  readonly transport: "discord";
  readonly externalId: string;
  /** Null means the adapter must map the identity to a guest Principal. */
  readonly principalId: PrincipalId | null;
}

export function isOwner(principal: Principal): boolean {
  return principal.roles.includes("owner");
}
