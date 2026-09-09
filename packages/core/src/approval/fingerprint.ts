import { createHash } from "node:crypto";
import type { AuthorizationDecisionRecord } from "../audit/records.js";
import type { Operation } from "../operation/entities.js";
import type { JsonValue } from "../ports/json.js";

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function exactOperationFingerprint(operation: Operation, decision: AuthorizationDecisionRecord): string {
  if (operation.id !== decision.operationId || operation.authorizationDecisionId !== decision.id) throw new TypeError("operation and authorization decision do not match");
  const payload = JSON.parse(JSON.stringify({
    version: 1,
    kind: operation.kind,
    input: operation.input,
    capability: operation.capability,
    authorizationTier: operation.authorizationTier,
    sideEffect: operation.sideEffect,
    principalId: decision.principalId,
    interactionRequirement: decision.interactionRequirement,
    resource: decision.resource ?? null,
  })) as JsonValue;
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}
