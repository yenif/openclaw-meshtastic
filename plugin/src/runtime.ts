import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtimeInstance: PluginRuntime | null = null;

export function setMeshtasticRuntime(runtime: PluginRuntime): void {
  runtimeInstance = runtime;
}

export function getMeshtasticRuntime(): PluginRuntime {
  if (!runtimeInstance) {
    throw new Error("Meshtastic runtime not initialized");
  }
  return runtimeInstance;
}
