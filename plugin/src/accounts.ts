import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";

export interface MeshtasticAccountConfig {
  enabled?: boolean;
  bridgeUrl?: string;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  allowFrom?: Array<string | number>;
  agentId?: string;
  dm?: {
    policy?: "open" | "allowlist" | "pairing" | "disabled";
    allowFrom?: Array<string | number>;
  };
}

export interface ResolvedMeshtasticAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: MeshtasticAccountConfig;
  bridgeUrl: string;
}

export function listMeshtasticAccountIds(cfg: OpenClawConfig): string[] {
  const meshtastic = cfg.channels?.["meshtastic"];
  if (!meshtastic?.enabled) {
    return [];
  }
  // Single account for now
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultMeshtasticAccountId(cfg: OpenClawConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

export function resolveMeshtasticAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedMeshtasticAccount {
  const { cfg, accountId } = params;
  const normalizedId = normalizeAccountId(accountId);
  const meshtastic = cfg.channels?.["meshtastic"] as MeshtasticAccountConfig | undefined;

  const enabled = meshtastic?.enabled !== false;
  const bridgeUrl =
    meshtastic?.bridgeUrl?.trim() || "http://meshtastic-bridge.openclaw.svc:5000";

  return {
    accountId: normalizedId,
    name: "Meshtastic",
    enabled,
    config: meshtastic || {},
    bridgeUrl,
  };
}
