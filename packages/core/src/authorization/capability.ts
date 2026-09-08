/**
 * Capability IDs are extensible because plugins add capabilities. Authorization
 * remains fail-closed: an ID must be present in the effective Authority.
 */
export type Capability = string;
/** Array-shaped so an Authority snapshot remains JSON/SQLite serializable. */
export type CapabilitySet = readonly Capability[];

export function capabilities(...values: readonly Capability[]): CapabilitySet {
  return [...new Set(values)];
}

export function hasCapability(set: CapabilitySet, capability: Capability): boolean {
  return set.includes(capability);
}
