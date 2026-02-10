import type { OpenClawConfig } from "openclaw/plugin-sdk";
import EventSource from "eventsource";
import type { ResolvedMeshtasticAccount } from "./accounts.js";
import { getMeshtasticRuntime } from "./runtime.js";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";

export interface MeshtasticMonitorOptions {
  account: ResolvedMeshtasticAccount;
  config: OpenClawConfig;
  runtime: {
    log?: (message: string) => void;
    error?: (message: string) => void;
  };
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}

interface MeshtasticMessage {
  from: string;
  fromName: string;
  to: string;
  text: string;
  timestamp: number;
  type?: string;
  channel?: number;
  isDirect?: boolean;
}

function normalizeNodeId(raw: string): string {
  return raw.trim().toLowerCase();
}

function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalized = normalizeNodeId(senderId);
  return allowFrom.some((entry) => {
    const entryNorm = String(entry).trim().toLowerCase();
    return entryNorm === normalized;
  });
}

export async function startMeshtasticMonitor(
  params: MeshtasticMonitorOptions,
): Promise<() => void> {
  const { account, config, runtime, abortSignal, statusSink } = params;
  const core = getMeshtasticRuntime();
  const bridgeUrl = account.bridgeUrl;

  runtime.log?.(`[${account.accountId}] Starting Meshtastic SSE stream from ${bridgeUrl}`);

  const eventSource = new EventSource(`${bridgeUrl}/messages`);
  let stopped = false;

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    eventSource.close();
  };

  abortSignal.addEventListener("abort", cleanup);

  eventSource.onopen = () => {
    runtime.log?.(`[${account.accountId}] Connected to Meshtastic bridge`);
  };

  eventSource.onerror = (err: unknown) => {
    const msg = err instanceof Error ? err.message : JSON.stringify(err);
    runtime.error?.(`[${account.accountId}] SSE error: ${msg}`);
  };

  eventSource.onmessage = async (event) => {
    try {
      const msg: MeshtasticMessage = JSON.parse(event.data);

      // Skip connection events
      if (msg.type === "connected") {
        return;
      }

      if (!msg.text || !msg.from) {
        return;
      }

      statusSink?.({ lastInboundAt: Date.now() });

      const senderId = msg.from;
      const senderName = msg.fromName || msg.from;
      const rawBody = msg.text.trim();

      if (!rawBody) {
        return;
      }

      // DM policy check
      const dmPolicy = account.config.dm?.policy ?? account.config.dmPolicy ?? "allowlist";
      const configAllowFrom = (account.config.dm?.allowFrom ?? account.config.allowFrom ?? []).map(
        (v) => String(v),
      );

      if (dmPolicy === "disabled") {
        return;
      }

      const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(
        rawBody,
        config,
      );
      const storeAllowFrom =
        dmPolicy !== "open" || shouldComputeAuth
          ? await core.channel.pairing.readAllowFromStore("meshtastic").catch(() => [])
          : [];
      const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];

      const senderAllowed = isSenderAllowed(senderId, effectiveAllowFrom);
      const commandAuthorized = shouldComputeAuth
        ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
            useAccessGroups: config.commands?.useAccessGroups !== false,
            authorizers: [{ configured: effectiveAllowFrom.length > 0, allowed: senderAllowed }],
          })
        : undefined;

      if (dmPolicy !== "open" && !senderAllowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "meshtastic",
            id: senderId,
            meta: { name: senderName },
          });
          if (created) {
            runtime.log?.(`[${account.accountId}] pairing request from ${senderId}`);
            try {
              const pairingText = core.channel.pairing.buildPairingReply({
                channel: "meshtastic",
                idLine: `Your node ID: ${senderId}`,
                code,
              });
              await sendMeshtasticMessage({ bridgeUrl, to: senderId, text: pairingText });
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              runtime.error?.(`[${account.accountId}] pairing reply failed: ${String(err)}`);
            }
          }
        } else {
          runtime.log?.(
            `[${account.accountId}] blocked unauthorized sender ${senderId} (dmPolicy=${dmPolicy})`,
          );
        }
        return;
      }

      if (
        core.channel.commands.isControlCommandMessage(rawBody, config) &&
        commandAuthorized !== true
      ) {
        runtime.log?.(`[${account.accountId}] drop control command from ${senderId}`);
        return;
      }

      // Determine if DM or group/channel message
      const channelIndex = msg.channel ?? 0;
      const isDirect = msg.isDirect ?? false;
      const chatType = isDirect ? "direct" : "group";
      const peerId = isDirect ? senderId : `ch${channelIndex}`;

      const route = core.channel.routing.resolveAgentRoute({
        cfg: config,
        channel: "meshtastic",
        accountId: account.accountId,
        peer: { kind: isDirect ? "direct" : "group", id: peerId },
      });
      runtime.log?.(`[${account.accountId}] Route: agentId=${route.agentId}, sessionKey=${route.sessionKey}, matchedBy=${route.matchedBy}, isDirect=${isDirect}, peerId=${peerId}`);

      const storePath = core.channel.session.resolveStorePath(config.session?.store, {
        agentId: route.agentId,
      });
      const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
      const previousTimestamp = core.channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
      });

      const body = core.channel.reply.formatAgentEnvelope({
        channel: "Meshtastic",
        from: senderName,
        timestamp: msg.timestamp ? msg.timestamp * 1000 : undefined,
        previousTimestamp,
        envelope: envelopeOptions,
        body: rawBody,
      });

      // For group messages, reply target is the channel; for DMs, reply to sender
      const replyTo = isDirect ? senderId : `ch${channelIndex}`;
      const conversationLabel = isDirect ? senderName : `Mesh Channel ${channelIndex}`;

      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: `meshtastic:${senderId}`,
        To: `meshtastic:${replyTo}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: chatType,
        ConversationLabel: conversationLabel,
        SenderName: senderName,
        SenderId: senderId,
        CommandAuthorized: commandAuthorized,
        Provider: "meshtastic",
        Surface: "meshtastic",
        MessageSid: `${senderId}-${msg.timestamp}`,
        MessageSidFull: `${senderId}-${msg.timestamp}`,
        OriginatingChannel: "meshtastic",
        OriginatingTo: `meshtastic:${replyTo}`,
        // Store channel index for outbound routing
        MeshtasticChannelIndex: String(channelIndex),
      });

      void core.channel.session
        .recordSessionMetaFromInbound({
          storePath,
          sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
          ctx: ctxPayload,
        })
        .catch((err) => {
          runtime.error?.(`meshtastic: failed updating session meta: ${String(err)}`);
        });

      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg: config,
        agentId: route.agentId,
        channel: "meshtastic",
        accountId: route.accountId,
      });

      await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config,
        dispatcherOptions: {
          ...prefixOptions,
          deliver: async (payload) => {
            await deliverMeshtasticReply({
              payload,
              account,
              toNodeId: isDirect ? senderId : "^all",
              channelIndex,
              runtime,
              core,
              statusSink,
            });
          },
          onError: (err, info) => {
            runtime.error?.(
              `[${account.accountId}] Meshtastic ${info.kind} reply failed: ${String(err)}`,
            );
          },
        },
        replyOptions: {
          onModelSelected,
        },
      });
    } catch (err) {
      runtime.error?.(`[${account.accountId}] Error processing message: ${String(err)}`);
    }
  };

  return cleanup;
}

async function sendMeshtasticMessage(params: {
  bridgeUrl: string;
  to: string;
  text: string;
  channelIndex?: number;
}): Promise<void> {
  const { bridgeUrl, to, text, channelIndex = 0 } = params;
  const res = await fetch(`${bridgeUrl}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, text, channelIndex }),
  });
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Bridge send failed: ${error}`);
  }
}

async function deliverMeshtasticReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string; replyToId?: string };
  account: ResolvedMeshtasticAccount;
  toNodeId: string;
  channelIndex?: number;
  runtime: {
    log?: (message: string) => void;
    error?: (message: string) => void;
  };
  core: ReturnType<typeof getMeshtasticRuntime>;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, account, toNodeId, channelIndex = 0, runtime, core, statusSink } = params;

  if (!payload.text) {
    return;
  }

  const chunkLimit = 230; // Meshtastic message size limit
  const chunks = core.channel.text.chunkText(payload.text, chunkLimit);

  for (let i = 0; i < chunks.length; i++) {
    // LoRa needs time between transmissions — wait 3s between chunks
    if (i > 0) await new Promise((r) => setTimeout(r, 3000));
    try {
      await sendMeshtasticMessage({
        bridgeUrl: account.bridgeUrl,
        to: toNodeId,
        text: chunks[i],
        channelIndex,
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    } catch (err) {
      runtime.error?.(`[${account.accountId}] Send failed: ${String(err)}`);
    }
  }
}
