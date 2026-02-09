import {
  DEFAULT_ACCOUNT_ID,
  getChatChannelMeta,
  missingTargetError,
  normalizeAccountId,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  listMeshtasticAccountIds,
  resolveDefaultMeshtasticAccountId,
  resolveMeshtasticAccount,
  type ResolvedMeshtasticAccount,
} from "./accounts.js";
import { startMeshtasticMonitor } from "./monitor.js";

const meta = getChatChannelMeta("meshtastic");

const formatAllowFromEntry = (entry: string) =>
  entry
    .trim()
    .toLowerCase()
    .replace(/^(meshtastic|mesh):/i, "");

function normalizeMeshtasticTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^(meshtastic|mesh):/i, "");
}

export const meshtasticPlugin: ChannelPlugin<ResolvedMeshtasticAccount> = {
  id: "meshtastic",
  meta: { ...meta },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 200, idleMs: 2000 },
  },
  reload: { configPrefixes: ["channels.meshtastic"] },
  config: {
    listAccountIds: (cfg) => listMeshtasticAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveMeshtasticAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultMeshtasticAccountId(cfg),
    isConfigured: (account) => Boolean(account.bridgeUrl),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.bridgeUrl),
      baseUrl: account.bridgeUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveMeshtasticAccount({ cfg, accountId });
      return (account.config.dm?.allowFrom ?? account.config.allowFrom ?? []).map((entry) =>
        String(entry),
      );
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map(formatAllowFromEntry),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const dmConfig = account.config.dm;
      const policy =
        dmConfig?.policy ?? account.config.dmPolicy ?? "allowlist";
      const allowFrom = dmConfig?.allowFrom ?? account.config.allowFrom ?? [];
      return {
        policy,
        allowFrom,
        allowFromPath: "channels.meshtastic.dm.",
        approveHint: "Run: openclaw pairing approve meshtastic <nodeId>",
        normalizeEntry: (raw) => formatAllowFromEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const policy = account.config.dm?.policy ?? account.config.dmPolicy ?? "allowlist";
      if (policy === "open") {
        warnings.push(
          "- Meshtastic DMs are open to anyone on the mesh network. Set channels.meshtastic.dm.policy=\"allowlist\".",
        );
      }
      return warnings;
    },
  },
  pairing: {
    idLabel: "meshtasticNodeId",
    normalizeAllowEntry: (entry) => formatAllowFromEntry(entry),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveMeshtasticAccount({ cfg });
      const nodeId = normalizeMeshtasticTarget(id) ?? id;
      const res = await fetch(`${account.bridgeUrl}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: nodeId,
          text: "✅ Pairing approved! You can now message the agent.",
        }),
      });
      if (!res.ok) {
        throw new Error(`Failed to send approval message: ${res.statusText}`);
      }
    },
  },
  messaging: {
    normalizeTarget: normalizeMeshtasticTarget,
    targetResolver: {
      looksLikeId: (raw, normalized) => {
        const value = normalized ?? raw.trim();
        return value.length > 0 && !value.includes("@");
      },
      hint: "<nodeId>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: null,
    chunkerMode: "text",
    textChunkLimit: 230,
    resolveTarget: ({ to, allowFrom, mode }) => {
      const trimmed = to?.trim() ?? "";
      const allowList = (allowFrom ?? [])
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => normalizeMeshtasticTarget(entry))
        .filter((entry): entry is string => Boolean(entry));

      if (trimmed) {
        const normalized = normalizeMeshtasticTarget(trimmed);
        if (!normalized) {
          if ((mode === "implicit" || mode === "heartbeat") && allowList.length > 0) {
            return { ok: true, to: allowList[0] };
          }
          return {
            ok: false,
            error: missingTargetError(
              "Meshtastic",
              "<nodeId> or channels.meshtastic.dm.allowFrom[0]",
            ),
          };
        }
        return { ok: true, to: normalized };
      }

      if (allowList.length > 0) {
        return { ok: true, to: allowList[0] };
      }
      return {
        ok: false,
        error: missingTargetError("Meshtastic", "<nodeId> or channels.meshtastic.dm.allowFrom[0]"),
      };
    },
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveMeshtasticAccount({ cfg, accountId });
      // Parse channelIndex from target if encoded (e.g., "ch0:^all" for broadcast)
      let channelIndex = 0;
      let actualTo = to;
      const chMatch = to.match(/^ch(\d+):(.+)$/);
      if (chMatch) {
        channelIndex = parseInt(chMatch[1], 10);
        actualTo = chMatch[2];
      }
      const res = await fetch(`${account.bridgeUrl}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: actualTo, text, channelIndex }),
      });
      if (!res.ok) {
        throw new Error(`Bridge send failed: ${res.statusText}`);
      }
      return {
        channel: "meshtastic",
        messageId: `${to}-${Date.now()}`,
        chatId: to,
      };
    },
    sendMedia: async ({ cfg, to, text, accountId }) => {
      // Meshtastic doesn't support media — send text fallback if available
      if (text) {
        const account = resolveMeshtasticAccount({ cfg, accountId });
        const res = await fetch(`${account.bridgeUrl}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to, text: text.slice(0, 230) }),
        });
        if (!res.ok) {
          throw new Error(`Bridge send failed: ${res.statusText}`);
        }
      }
      return {
        channel: "meshtastic",
        messageId: `${to}-${Date.now()}`,
        chatId: to,
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      baseUrl: snapshot.baseUrl ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    probeAccount: async ({ account }) => {
      const res = await fetch(`${account.bridgeUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        throw new Error(`Bridge health check failed: ${res.statusText}`);
      }
      const health = await res.json();
      return health;
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.bridgeUrl),
      baseUrl: account.bridgeUrl,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      dmPolicy: account.config.dm?.policy ?? account.config.dmPolicy ?? "allowlist",
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info(`[${account.accountId}] starting Meshtastic monitor`);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        baseUrl: account.bridgeUrl,
      });

      const unregister = await startMeshtasticMonitor({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });

      return () => {
        unregister?.();
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      };
    },
  },
};
