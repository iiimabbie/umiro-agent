export type GatewayServiceManager = "systemd" | "fallback";

export function isSystemdManaged(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.UMIRO_SERVICE_MANAGER === "systemd";
}

export function fallbackRestartEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { INVOCATION_ID: _invocationId, ...fallbackEnvironment } = environment;
  return { ...fallbackEnvironment, UMIRO_SERVICE_MANAGER: "fallback" };
}
