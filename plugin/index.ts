import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { meshtasticPlugin } from "./src/channel.js";
import { setMeshtasticRuntime } from "./src/runtime.js";
import type { ChannelDock } from "openclaw/plugin-sdk";

const meshtasticDock: ChannelDock = {
  id: "meshtastic",
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    media: false,
    threads: false,
    blockStreaming: true,
  },
  outbound: { textChunkLimit: 230 },
  config: {
    resolveAllowFrom: ({ cfg, accountId }) => {
      const meshtastic = cfg.channels?.["meshtastic"] as
        | { dm?: { allowFrom?: Array<string | number> }; allowFrom?: Array<string | number> }
        | undefined;
      return (meshtastic?.dm?.allowFrom ?? meshtastic?.allowFrom ?? []).map((entry) =>
        String(entry),
      );
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map((entry) => entry.trim().toLowerCase().replace(/^(meshtastic|mesh):/i, "")),
  },
};

const plugin = {
  id: "meshtastic",
  name: "Meshtastic",
  description: "OpenClaw Meshtastic mesh radio channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMeshtasticRuntime(api.runtime);
    api.registerChannel({ plugin: meshtasticPlugin, dock: meshtasticDock });
  },
};

export default plugin;
