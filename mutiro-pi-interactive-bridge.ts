import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  defineTool,
  getAgentDir,
  InteractiveMode,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { inspect } from "util";

/**
 * mutiro-pi-interactive-bridge.ts
 *
 * A Mutiro Chatbridge <-> Pi adapter using the real Pi InteractiveMode.
 *
 * It:
 * - spawns `mutiro agent host --mode=bridge`
 * - speaks NDJSON with the host over stdio
 * - keeps one persistent Pi session per Mutiro conversation
 * - runs the normal Pi TUI against the same underlying runtime
 * - exposes a small Mutiro-specific tool surface inside Pi
 *
 * Usage:
 *   npx tsx mutiro-pi-interactive-bridge.ts [path/to/agent/directory]
 */

const PROTOCOL_VERSION = "mutiro.agent.bridge.v1";

const TYPE_URLS = {
  addReactionRequest: "type.googleapis.com/mutiro.messaging.AddReactionRequest",
  bridgeCommandResult: "type.googleapis.com/mutiro.chatbridge.ChatBridgeCommandResult",
  bridgeInitializeCommand: "type.googleapis.com/mutiro.chatbridge.ChatBridgeInitializeCommand",
  bridgeMediaUploadCommand: "type.googleapis.com/mutiro.chatbridge.ChatBridgeMediaUploadCommand",
  bridgeSendMessageCommand: "type.googleapis.com/mutiro.chatbridge.ChatBridgeSendMessageCommand",
  bridgeSendVoiceMessageCommand: "type.googleapis.com/mutiro.chatbridge.ChatBridgeSendVoiceMessageCommand",
  bridgeMessageObservedResult: "type.googleapis.com/mutiro.chatbridge.ChatBridgeMessageObservedResult",
  bridgeSessionObservedResult: "type.googleapis.com/mutiro.chatbridge.ChatBridgeSessionObservedResult",
  bridgeSessionSnapshotResult: "type.googleapis.com/mutiro.chatbridge.ChatBridgeSessionSnapshotResult",
  bridgeSubscriptionSetCommand: "type.googleapis.com/mutiro.chatbridge.ChatBridgeSubscriptionSetCommand",
  bridgeTaskResult: "type.googleapis.com/mutiro.chatbridge.ChatBridgeTaskResult",
  bridgeTurnEndCommand: "type.googleapis.com/mutiro.chatbridge.ChatBridgeTurnEndCommand",
  forwardMessageRequest: "type.googleapis.com/mutiro.messaging.ForwardMessageRequest",
  recallGetRequest: "type.googleapis.com/mutiro.recall.RecallGetRequest",
  recallSearchRequest: "type.googleapis.com/mutiro.recall.RecallSearchRequest",
  sendSignalRequest: "type.googleapis.com/mutiro.signal.SendSignalRequest",
} as const;

const OPTIONAL_CAPABILITIES = [
  "message.send_voice",
  "signal.emit",
  "recall.search",
  "recall.get",
  "media.upload",
];

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: any) => void;
};

type SessionState = {
  sessionPath?: string;
  outputText: string;
  currentMessageId: string;
  recentMessages: any[];
  currentSenderUsername?: string;
  // Bridge tools are only allowed during a live Mutiro-owned turn. Local Pi
  // interactive prompts share the same session but do not get bridge powers.
  bridgePromptActive: boolean;
};

type BridgeExtras = {
  request_id?: string;
  conversation_id?: string;
  message_id?: string;
  reply_to_message_id?: string;
};

type ObservedTurn = {
  conversationId: string;
  messageId: string;
  replyToMessageId?: string;
  senderUsername: string;
  text: string;
};

const generateId = () => Math.random().toString(36).substring(2, 15);
const MAX_RECENT_MESSAGES = 30;
let writeBridgeLog = (_line: string) => {};

const toolTextResult = (text: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

const formatLogArg = (value: unknown) =>
  typeof value === "string" ? value : inspect(value, { depth: null, colors: false });

const logBridge = (...args: unknown[]) => {
  const message = args.map(formatLogArg).join(" ");
  writeBridgeLog(`[${new Date().toISOString()}] ${message}\n`);
};

const shortMessageId = (value?: string) => {
  const id = (value || "").trim();
  return id.length <= 8 ? id : id.slice(-8);
};

const REACTION_QUOTE_MAX_CHARS = 160;

const truncateReactionQuote = (raw: string): string => {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (collapsed.length <= REACTION_QUOTE_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, REACTION_QUOTE_MAX_CHARS - 1).trimEnd()}…`;
};

const extractBridgeMessageText = (message?: any, replyToMessagePreview?: string) => {
  if (!message) return "";
  const replyPreview = (replyToMessagePreview || "").trim();

  const parts: string[] = [];
  const push = (value?: string) => {
    const trimmed = (value || "").trim();
    if (trimmed) parts.push(trimmed);
  };

  push(message.text);

  for (const part of Array.isArray(message.parts) ? message.parts : []) {
    if (!part || typeof part !== "object") continue;

    switch (part.type) {
      case "text":
        push(part.text);
        break;
      case "audio":
        push(part.transcript);
        break;
      case "card":
        push(part.card_id ? `[Interactive card: ${part.card_id}]` : "[Interactive card]");
        break;
      case "card_action":
        push(`[Card interaction: card=${part.card_id || ""} action=${part.action_id || ""} data=${part.data_json || ""}]`);
        break;
      case "contact": {
        const meta = part.metadata || {};
        const username = (meta.contact_username || "").trim();
        if (!username) break;
        const displayName = (meta.contact_display_name || "").trim();
        const role = (meta.contact_member_type || "").trim() === "agent" ? "agent" : "user";
        push(`[Shared contact: ${displayName || username} (@${username}, ${role})]`);
        break;
      }
      case "reaction": {
        const emoji = (part.reaction || "").trim();
        if (!emoji) break;
        const removed = (part.reaction_operation || "").trim().toLowerCase() === "removed";
        const quote = truncateReactionQuote(replyPreview);
        if (quote) {
          push(removed
            ? `[reaction ${emoji} removed from message: "${quote}"]`
            : `[reaction ${emoji} received on message: "${quote}"]`);
        } else {
          const target = shortMessageId(message.reply_to_message_id);
          if (removed) {
            push(target ? `[removed reaction ${emoji} from #${target}]` : `[removed reaction ${emoji}]`);
          } else {
            push(target ? `[reacted ${emoji} to #${target}]` : `[reacted ${emoji}]`);
          }
        }
        break;
      }
      case "live_call": {
        const summary = (part.summary_text || "").trim();
        const actionItems = Array.isArray(part.action_items) ? part.action_items.map((item: string) => item.trim()).filter(Boolean) : [];
        const followUps = Array.isArray(part.follow_ups) ? part.follow_ups.map((item: string) => item.trim()).filter(Boolean) : [];
        if (!summary && actionItems.length === 0 && followUps.length === 0) break;
        const lines = [`[Voice call summary (call_id=${(part.call_id || "").trim()}, end_reason=${(part.end_reason || "").trim()})]`];
        if (summary) lines.push(summary);
        if (actionItems.length > 0) lines.push(`Action items:\n${actionItems.map((item: string) => `- ${item}`).join("\n")}`);
        if (followUps.length > 0) lines.push(`Follow-ups:\n${followUps.map((item: string) => `- ${item}`).join("\n")}`);
        push(lines.join("\n"));
        break;
      }
      case "image": {
        const caption = (part.metadata?.caption || "").trim();
        push(caption ? `[Image attachment: ${caption}]` : "[Image attachment]");
        break;
      }
      case "file": {
        const filename = (part.filename || "").trim();
        const caption = (part.metadata?.caption || "").trim();
        push(caption ? `[File attachment: ${filename || "attachment"} — ${caption}]` : `[File attachment: ${filename || "attachment"}]`);
        break;
      }
    }
  }

  return parts.join(" ").trim();
};

const buildMessageContextHeader = (turn: Omit<ObservedTurn, "text">) => {
  const lines = [
    "[message_context]",
    `- sender: ${turn.senderUsername}`,
    "- sender_role: user",
    `- message_id: ${turn.messageId}`,
    `- conversation_id: ${turn.conversationId}`,
  ];

  if (turn.replyToMessageId) {
    lines.push(`- reply_to_message_id: ${turn.replyToMessageId}`);
  }

  return lines.join("\n");
};

const BRIDGE_TURN_RULES = [
  "[bridge_rules]",
  "- This is a Mutiro bridge-owned turn, not a local Pi chat turn.",
  "- If you want to reply to the user, do it through Mutiro bridge tools such as send_message or send_voice_message.",
  "- After you have completed the bridge action you want, your final local Pi assistant text must be exactly NOOP.",
  "- Do not narrate that you sent a message.",
  "- Do not continue chatting locally after using a bridge tool.",
  "- If no outward Mutiro action is needed, your final local Pi assistant text must still be exactly NOOP.",
].join("\n");

const buildChatTurnPrompt = (turn: ObservedTurn) =>
  [buildMessageContextHeader(turn), "", BRIDGE_TURN_RULES, "", turn.text].join("\n");

const buildBridgeTaskPrompt = (taskText: string) =>
  [
    "[bridge_task]",
    "- This task is being executed on behalf of Mutiro.",
    "- If you communicate outward through bridge tools, your final local Pi assistant text must be exactly NOOP.",
    "- Do not narrate tool usage locally.",
    "",
    taskText,
  ].join("\n");

const captureBridgeRunSnapshot = (session: any) => ({
  entryCount: Array.isArray(session?.sessionManager?.getEntries?.()) ? session.sessionManager.getEntries().length : 0,
  messageCount: Array.isArray(session?.messages) ? session.messages.length : 0,
});

const rewriteBridgeUserPrompt = (session: any, snapshot: { entryCount: number; messageCount: number }, text: string) => {
  const cleanedText = (text || "").trim();
  if (!cleanedText) return;

  const stateMessages = session?.agent?.state?.messages;
  const stateMessage = Array.isArray(stateMessages) ? stateMessages[snapshot.messageCount] : undefined;
  if (stateMessage?.role === "user") {
    stateMessage.content = cleanedText;
  }

  const manager = session?.sessionManager as any;
  const entry = manager?.getEntries?.()?.[snapshot.entryCount];
  if (entry?.type === "message" && entry.message?.role === "user") {
    entry.message.content = cleanedText;
    if (manager.isPersisted?.() && manager._rewriteFile) {
      manager._rewriteFile();
    }
  }
};

const pruneBridgeRunArtifacts = (session: any, snapshot: { entryCount: number; messageCount: number }, keepNewEntries: number) => {
  const keepEntriesCount = snapshot.entryCount + keepNewEntries;
  const keepMessagesCount = snapshot.messageCount + keepNewEntries;

  if (Array.isArray(session?.agent?.state?.messages)) {
    session.agent.state.messages = session.agent.state.messages.slice(0, keepMessagesCount);
  }

  const manager = session?.sessionManager as any;
  if (!manager?.getEntries || !manager?.getHeader || !manager?._buildIndex) {
    return;
  }

  const header = manager.getHeader?.();
  const keptEntries = manager.getEntries().slice(0, keepEntriesCount);
  manager.fileEntries = header ? [header, ...keptEntries] : [...keptEntries];
  manager._buildIndex();
  if (manager.isPersisted?.() && manager._rewriteFile) {
    manager._rewriteFile();
  }
};

const normalizeOutputText = (value: string) => {
  const trimmed = (value || "").trim();
  const lowered = trimmed.toLowerCase();
  if (!trimmed) return "";
  if (lowered === "noop" || lowered === "noop.") return "";
  return trimmed;
};

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const trimRecentMessages = (messages: any[]) =>
  messages.length > MAX_RECENT_MESSAGES ? messages.slice(-MAX_RECENT_MESSAGES) : messages;

const appendRecentMessage = (state: SessionState | undefined, message: any) => {
  if (!state || !message || typeof message !== "object") return;
  state.recentMessages.push(cloneJson(message));
  state.recentMessages = trimRecentMessages(state.recentMessages);
};

const buildSyntheticBridgeMessage = (params: {
  conversationId: string;
  replyToMessageId?: string;
  senderUsername: string;
  text: string;
  metadata?: Record<string, string>;
}) => ({
  id: `pi-${generateId()}`,
  conversation_id: params.conversationId,
  reply_to_message_id: params.replyToMessageId || "",
  from: {
    username: params.senderUsername,
  },
  text: params.text,
  metadata: params.metadata || {},
});

const applyVoiceLanguage = (voiceName: string, language: string) => {
  const trimmedVoice = voiceName.trim();
  const trimmedLanguage = language.trim();
  if (!trimmedVoice || !trimmedLanguage) {
    return trimmedVoice;
  }

  const languageParts = trimmedLanguage.split("-");
  if (languageParts.length < 2) {
    return trimmedVoice;
  }

  const voiceParts = trimmedVoice.split("-");
  if (voiceParts.length < 4) {
    return trimmedVoice;
  }

  return `${languageParts[0]}-${languageParts[1]}-${voiceParts.slice(2).join("-")}`;
};

const buildCardJson = (components: any[], data?: Record<string, unknown>, cardId?: string) => {
  let rootId = components[0]?.id || "root";
  for (const component of components) {
    if (!component.parentId && !component.parent_id) {
      rootId = component.id;
      break;
    }
  }

  const lines = [
    JSON.stringify({
      surfaceUpdate: {
        surfaceId: "main",
        components,
        clearBefore: true,
      },
    }),
  ];

  if (data) {
    const contents = Object.keys(data).map((key) => ({
      key,
      valueString: typeof data[key] === "object" ? JSON.stringify(data[key]) : String(data[key]),
    }));
    lines.push(JSON.stringify({
      dataModelUpdate: {
        surfaceId: "main",
        contents,
      },
    }));
  }

  lines.push(JSON.stringify({
    beginRendering: {
      surfaceId: "main",
      root: rootId,
    },
  }));

  return {
    json_data: lines.join("\n"),
    version: "0.8",
    card_id: cardId || `pi-card-${generateId()}`,
  };
};

const isToolExecutionEvent = (event: any) =>
  typeof event?.type === "string" && event.type.startsWith("tool_execution");

const SESSION_MAP_FILENAME = ".mutiro-pi-interactive-sessions.json";

const buildSessionName = (conversationId: string, username?: string) => {
  const target = (username || "").trim().replace(/^@/, "");
  return target ? `mutiro:${conversationId} @${target}` : `mutiro:${conversationId}`;
};

const loadSessionMap = (targetDir: string): Record<string, { sessionPath: string; username?: string }> => {
  const filePath = path.join(targetDir, SESSION_MAP_FILENAME);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.conversations !== "object") {
      return {};
    }
    const conversations = parsed.conversations as Record<string, { sessionPath?: string; username?: string }>;
    return Object.fromEntries(
      Object.entries(conversations)
        .filter(([, value]) => typeof value?.sessionPath === "string" && value.sessionPath.trim())
        .map(([conversationId, value]) => [conversationId, {
          sessionPath: value.sessionPath!.trim(),
          username: (value.username || "").trim() || undefined,
        }]),
    );
  } catch {
    return {};
  }
};

const saveSessionMap = (
  targetDir: string,
  sessionStates: Map<string, SessionState>,
) => {
  const conversations = Object.fromEntries(
    Array.from(sessionStates.entries())
      .filter(([, state]) => !!state.sessionPath)
      .map(([conversationId, state]) => [conversationId, {
        sessionPath: state.sessionPath,
        username: state.currentSenderUsername,
      }]),
  );
  fs.writeFileSync(
    path.join(targetDir, SESSION_MAP_FILENAME),
    `${JSON.stringify({ conversations }, null, 2)}\n`,
    "utf8",
  );
};

// In bridge mode the Mutiro host writes slog JSON records to stderr. Parse
// each line and hand it to logBridge as `host: <msg> key=val ...` so the
// bridge log is readable instead of leaking raw Go-side records.
const HOST_ATTR_DROP = new Set(["time", "level", "msg", "component", "agent_username"]);

const formatHostAttrValue = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const normalizeHostLogLine = (raw: string): { level: "info" | "warn" | "error"; text: string } => {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed && typeof parsed.msg === "string") {
        const rawLevel = typeof parsed.level === "string" ? parsed.level.toLowerCase() : "info";
        const level = rawLevel === "error" ? "error" : rawLevel === "warn" || rawLevel === "warning" ? "warn" : "info";
        const attrs = Object.entries(parsed)
          .filter(([key]) => !HOST_ATTR_DROP.has(key))
          .map(([key, value]) => `${key}=${formatHostAttrValue(value)}`)
          .filter((entry) => entry.length > 2);
        const detail = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
        return { level, text: `host: ${parsed.msg}${detail}` };
      }
    } catch {
      // fall through to raw passthrough
    }
  }
  return { level: "info", text: `host: ${trimmed}` };
};

const createHostProcess = (targetDir: string) => {
  const hostProcess = spawn("mutiro", ["agent", "host", "--mode=bridge"], {
    cwd: targetDir,
    env: process.env,
  });

  const stderrReader = readline.createInterface({
    input: hostProcess.stderr,
    terminal: false,
  });
  stderrReader.on("line", (line) => {
    if (!line.trim()) return;
    const { level, text } = normalizeHostLogLine(line);
    logBridge(`[${level}]`, text);
  });

  hostProcess.on("exit", (code) => {
    stderrReader.close();
    logBridge(`[Bridge] Mutiro host exited with code ${code}`);
  });

  return hostProcess;
};

const createBridgeClient = (hostProcess: ChildProcessWithoutNullStreams) => {
  // request_id correlation is the whole transport contract here. Host requests
  // and brain-initiated operations both share the same NDJSON pipe.
  const pendingRequests = new Map<string, PendingRequest>();

  hostProcess.on("exit", (code) => {
    const error = new Error(`Mutiro host exited with code ${code ?? 0}`);
    for (const pending of pendingRequests.values()) {
      pending.reject(error);
    }
    pendingRequests.clear();
  });

  const send = (type: string, payload: any, extras: BridgeExtras = {}) => {
    const envelope = {
      protocol_version: PROTOCOL_VERSION,
      type,
      request_id: extras.request_id || generateId(),
      payload,
      ...extras,
    };
    hostProcess.stdin.write(`${JSON.stringify(envelope)}\n`);
  };

  const request = (type: string, payload: any, extras: BridgeExtras = {}) =>
    new Promise<any>((resolve, reject) => {
      const requestId = generateId();
      pendingRequests.set(requestId, { resolve, reject });
      send(type, payload, { ...extras, request_id: requestId });
    });

  const ack = (requestId: string, payloadType: string) => {
    // Ack the host request itself. This does not send a user-visible message.
    send("command_result", {
      "@type": TYPE_URLS.bridgeCommandResult,
      ok: true,
      response: { "@type": payloadType },
    }, { request_id: requestId });
  };

  const resolveResponse = (requestId: string | undefined, payload: any) => {
    if (!requestId || !pendingRequests.has(requestId)) return false;
    pendingRequests.get(requestId)!.resolve(payload?.response || payload);
    pendingRequests.delete(requestId);
    return true;
  };

  const rejectResponse = (requestId: string | undefined, error: any) => {
    if (!requestId || !pendingRequests.has(requestId)) return false;
    pendingRequests.get(requestId)!.reject(error);
    pendingRequests.delete(requestId);
    return true;
  };

  const sendError = (requestId: string | undefined, code: string, message: string, extras: BridgeExtras = {}) => {
    if (!requestId) return;
    const envelope = {
      protocol_version: PROTOCOL_VERSION,
      type: "error",
      request_id: requestId,
      error: {
        code,
        message,
      },
      ...extras,
    };
    hostProcess.stdin.write(`${JSON.stringify(envelope)}\n`);
  };

  return {
    ack,
    rejectResponse,
    request,
    resolveResponse,
    send,
    sendError,
  };
};

const createMutiroTools = (deps: {
  activeConversationIdRef: { current: string };
  sessionStates: Map<string, SessionState>;
  requestHost: ReturnType<typeof createBridgeClient>["request"];
}) => {
  const getConversationId = () => {
    const conversationId = deps.activeConversationIdRef.current;
    if (!conversationId) {
      throw new Error("No active Mutiro conversation is selected in the current Pi session.");
    }
    return conversationId;
  };

  const getState = () => {
    const state = deps.sessionStates.get(getConversationId());
    if (!state) {
      throw new Error("No session state is available for the active Mutiro conversation.");
    }
    return state;
  };

  const requireBridgeTurnActive = () => {
    const state = getState();
    if (!state.bridgePromptActive) {
      throw new Error("Mutiro bridge tools are only available while handling a live bridge turn.");
    }
    return state;
  };

  const replyTarget = (explicitReplyTo?: string) => explicitReplyTo || requireBridgeTurnActive().currentMessageId;

  return [
    // These tools are intentionally bridge-facing wrappers. The interactive Pi
    // session shares context with Mutiro, but outbound chat effects still go
    // through portable bridge commands so the host stays authoritative.
    defineTool({
      name: "send_message",
      label: "Send Message",
      description: "Send a text message to a Mutiro user.",
      parameters: Type.Object({
        username: Type.String({ description: "Target username (kept for Mutiro tool compatibility)." }),
        message: Type.String({ description: "Text to send immediately to the user." }),
        reply_to_message_id: Type.Optional(Type.String({ description: "Optional thread target. Defaults to the current user message." })),
      }),
      execute: async (_toolCallId, args) => {
        requireBridgeTurnActive();
        const normalizedMessage = normalizeOutputText(args.message);
        if (!normalizedMessage) {
          return toolTextResult("NOOP acknowledged. No message sent.");
        }
        const conversationId = getConversationId();
        const res = await deps.requestHost("message.send", {
          "@type": TYPE_URLS.bridgeSendMessageCommand,
          conversation_id: conversationId,
          reply_to_message_id: replyTarget(args.reply_to_message_id),
          text: { text: normalizedMessage },
        });
        return toolTextResult(`Message sent successfully: ${JSON.stringify(res, null, 2)}`);
      },
    }),
    defineTool({
      name: "send_voice_message",
      label: "Send Voice Message",
      description: "Send a text-to-speech voice message to a Mutiro user.",
      parameters: Type.Object({
        username: Type.String({ description: "Target username (kept for Mutiro tool compatibility)." }),
        speech: Type.String({ description: "Speakable plain text to synthesize and send." }),
        language: Type.Optional(Type.String({ description: "Optional BCP-47 language code to retarget the default voice." })),
        reply_to_message_id: Type.Optional(Type.String({ description: "Optional thread target. Defaults to the current user message." })),
      }),
      execute: async (_toolCallId, args) => {
        requireBridgeTurnActive();
        const normalizedSpeech = normalizeOutputText(args.speech);
        if (!normalizedSpeech) {
          return toolTextResult("NOOP acknowledged. No voice message sent.");
        }
        const defaultVoice = "en-US-Chirp3-HD-Orus";
        const voiceName = args.language ? applyVoiceLanguage(defaultVoice, args.language) : defaultVoice;
        const res = await deps.requestHost("message.send_voice", {
          "@type": TYPE_URLS.bridgeSendVoiceMessageCommand,
          to_username: String(args.username).replace(/^@/, ""),
          speech: normalizedSpeech,
          voice_name: voiceName,
          reply_to_message_id: replyTarget(args.reply_to_message_id),
        });
        return toolTextResult(`Voice message sent successfully: ${JSON.stringify(res, null, 2)}`);
      },
    }),
    defineTool({
      name: "send_card",
      label: "Send Card",
      description: "Send an interactive card to a Mutiro user.",
      parameters: Type.Object({
        username: Type.String({ description: "Target username (kept for Mutiro tool compatibility)." }),
        conversation_id: Type.String({ description: "Conversation ID (must match the current conversation)." }),
        components: Type.Array(Type.Any(), { description: "Array of A2UI component definitions." }),
        data: Type.Optional(Type.Any({ description: "Optional data model object for card bindings." })),
        card_id: Type.Optional(Type.String({ description: "Optional stable card id." })),
        reply_to_message_id: Type.Optional(Type.String({ description: "Optional thread target. Defaults to the current user message." })),
      }),
      execute: async (_toolCallId, args) => {
        requireBridgeTurnActive();
        const res = await deps.requestHost("message.send", {
          "@type": TYPE_URLS.bridgeSendMessageCommand,
          conversation_id: getConversationId(),
          reply_to_message_id: replyTarget(args.reply_to_message_id),
          parts: {
            parts: [
              {
                card: buildCardJson(args.components, args.data, args.card_id),
              },
            ],
          },
        });
        return toolTextResult(`Card sent successfully: ${JSON.stringify(res, null, 2)}`);
      },
    }),
    defineTool({
      name: "react_to_message",
      label: "React To Message",
      description: "Add an emoji reaction to an existing Mutiro message.",
      parameters: Type.Object({
        message_id: Type.String({ description: "Exact message ID to react to." }),
        emoji: Type.String({ description: "Emoji character (for example 👍)." }),
      }),
      execute: async (_toolCallId, args) => {
        requireBridgeTurnActive();
        try {
          const res = await deps.requestHost("message.react", {
            "@type": TYPE_URLS.addReactionRequest,
            message_id: args.message_id,
            emoji: args.emoji,
          }, { message_id: args.message_id });
          return toolTextResult(JSON.stringify(res, null, 2));
        } catch (err: any) {
          logBridge("[Bridge] react_to_message failed:", err);
          throw new Error(`Failed to react: ${JSON.stringify(err)}`);
        }
      },
    }),
    defineTool({
      name: "send_file_message",
      label: "Send File Message",
      description: "Upload and send a file to a Mutiro user.",
      parameters: Type.Object({
        username: Type.String({ description: "Target username (kept for Mutiro tool compatibility)." }),
        conversation_id: Type.String({ description: "Conversation ID (must match the current conversation)." }),
        file_path: Type.String({ description: "Absolute path to the file on disk." }),
        caption: Type.Optional(Type.String({ description: "Optional caption for the file." })),
        reply_to_message_id: Type.Optional(Type.String({ description: "Optional thread target. Defaults to the current user message." })),
      }),
      execute: async (_toolCallId, args) => {
        requireBridgeTurnActive();
        const uploadRes = await deps.requestHost("media.upload", {
          "@type": TYPE_URLS.bridgeMediaUploadCommand,
          local_path: args.file_path,
          filename: path.basename(args.file_path),
          mime_type: "application/octet-stream",
        });

        if (!uploadRes?.media) {
          throw new Error(`Failed to upload media: ${JSON.stringify(uploadRes)}`);
        }

        const res = await deps.requestHost("message.send", {
          "@type": TYPE_URLS.bridgeSendMessageCommand,
          conversation_id: getConversationId(),
          reply_to_message_id: replyTarget(args.reply_to_message_id),
          parts: {
            parts: [{ file: uploadRes.media }],
          },
        });
        return toolTextResult(`File uploaded and sent: ${JSON.stringify(res, null, 2)}`);
      },
    }),
    defineTool({
      name: "forward_message",
      label: "Forward Message",
      description: "Forward an existing message to another conversation or directly to a Mutiro user. Provide either `target_conversation_id` or `to_username` (not both).",
      parameters: Type.Object({
        message_id: Type.String({ description: "ID of the message to forward." }),
        target_conversation_id: Type.Optional(Type.String({ description: "ID of the destination conversation." })),
        to_username: Type.Optional(Type.String({ description: "Destination Mutiro username (direct message). Used when no target_conversation_id is given." })),
        comment: Type.Optional(Type.String({ description: "Optional comment to include with the forward." })),
      }),
      execute: async (_toolCallId, args) => {
        requireBridgeTurnActive();
        const targetConversationId = (args.target_conversation_id || "").trim();
        const toUsername = (args.to_username || "").trim().replace(/^@/, "");
        if (!targetConversationId && !toUsername) {
          return toolTextResult("forward_message requires either target_conversation_id or to_username.");
        }
        if (targetConversationId && toUsername) {
          return toolTextResult("forward_message accepts only one of target_conversation_id or to_username, not both.");
        }
        const res = await deps.requestHost("message.forward", {
          "@type": TYPE_URLS.forwardMessageRequest,
          message_id: args.message_id,
          ...(targetConversationId ? { conversation_id: targetConversationId } : { to_username: toUsername }),
          comment: args.comment || "",
        });
        return toolTextResult(JSON.stringify(res, null, 2));
      },
    }),
    defineTool({
      name: "recall",
      label: "Search Recall",
      description: "Semantically search the current conversation history.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query string." }),
        conversation_id: Type.Optional(Type.String({ description: "Optional conversation scope." })),
        max_results: Type.Optional(Type.Number({ description: "Optional maximum result count." })),
      }),
      execute: async (_toolCallId, args) => {
        requireBridgeTurnActive();
        const res = await deps.requestHost("recall.search", {
          "@type": TYPE_URLS.recallSearchRequest,
          query: args.query,
          conversation_id: args.conversation_id,
          limit: args.max_results,
        });
        return toolTextResult(JSON.stringify(res, null, 2));
      },
    }),
    defineTool({
      name: "recall_get",
      label: "Get Recall Item",
      description: "Open a recalled item from the current conversation history.",
      parameters: Type.Object({
        entry_id: Type.String({ description: "Recall entry id." }),
        conversation_id: Type.Optional(Type.String({ description: "Optional conversation scope." })),
      }),
      execute: async (_toolCallId, args) => {
        requireBridgeTurnActive();
        const res = await deps.requestHost("recall.get", {
          "@type": TYPE_URLS.recallGetRequest,
          entry_id: args.entry_id,
          conversation_id: args.conversation_id,
        });
        return toolTextResult(JSON.stringify(res, null, 2));
      },
    }),
  ];
};

const bindRuntimeSessionLogging = (deps: {
  activeConversationIdRef: { current: string };
  runtime: any;
  sendSignal: (conversationId: string, replyToMessageId: string, signalType: string, detailText?: string) => void;
  sessionStates: Map<string, SessionState>;
}) => {
  let unsubscribe: (() => void) | undefined;

  const bind = () => {
    unsubscribe?.();
    unsubscribe = deps.runtime.session.subscribe((event: any) => {
      const conversationId = deps.activeConversationIdRef.current;
      const state = conversationId ? deps.sessionStates.get(conversationId) : undefined;
      // Ignore local interactive Pi chatter here. We only want bridge-owned
      // turns to emit signals or accumulate outward reply text.
      if (!state?.bridgePromptActive) {
        return;
      }

      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        state.outputText += event.assistantMessageEvent.delta;
        return;
      }

      if (event.type === "tool_execution_start") {
        deps.sendSignal(conversationId, state.currentMessageId, "SIGNAL_TYPE_TOOL_RUNNING", event.toolName);
        return;
      }

      if (isToolExecutionEvent(event)) {
        logBridge("[Bridge] Pi tool event:", event);
        return;
      }

      if (event.type === "message_start") {
        deps.sendSignal(conversationId, state.currentMessageId, "SIGNAL_TYPE_TYPING", "Writing response...");
      }
    });
  };

  return {
    bind,
    dispose: () => unsubscribe?.(),
  };
};

const createSessionStore = async (deps: {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  requestHost: ReturnType<typeof createBridgeClient>["request"];
  sendSignal: (conversationId: string, replyToMessageId: string, signalType: string, detailText?: string) => void;
  targetDir: string;
}) => {
  const sessionStates = new Map<string, SessionState>();
  for (const [conversationId, persisted] of Object.entries(loadSessionMap(deps.targetDir))) {
    sessionStates.set(conversationId, {
      sessionPath: persisted.sessionPath,
      outputText: "",
      currentMessageId: "",
      recentMessages: [],
      currentSenderUsername: persisted.username,
      bridgePromptActive: false,
    });
  }

  const activeConversationIdRef = { current: "" };
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: getAgentDir(),
      authStorage: deps.authStorage,
      modelRegistry: deps.modelRegistry,
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      customTools: createMutiroTools({
        activeConversationIdRef,
        sessionStates,
        requestHost: deps.requestHost,
      }),
    });
    return {
      ...result,
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: deps.targetDir,
    agentDir: getAgentDir(),
    sessionManager: SessionManager.continueRecent(deps.targetDir),
  });

  const logging = bindRuntimeSessionLogging({
    activeConversationIdRef,
    runtime,
    sendSignal: deps.sendSignal,
    sessionStates,
  });

  const syncActiveConversationFromRuntime = () => {
    const sessionPath = runtime.session.sessionManager.getSessionFile();
    if (!sessionPath) {
      activeConversationIdRef.current = "";
      return;
    }

    const normalizedPath = path.resolve(sessionPath);
    const match = Array.from(sessionStates.entries()).find(([, state]) =>
      state.sessionPath && path.resolve(state.sessionPath) === normalizedPath);
    activeConversationIdRef.current = match?.[0] || "";
  };

  const syncRuntimeSession = () => {
    syncActiveConversationFromRuntime();
    logging.bind();
  };

  const wrapRuntimeMethod = (methodName: "switchSession" | "newSession" | "fork" | "importFromJsonl") => {
    const runtimeAny = runtime as any;
    const original = runtimeAny[methodName].bind(runtimeAny);
    runtimeAny[methodName] = async (...args: any[]) => {
      const result = await original(...args);
      syncRuntimeSession();
      return result;
    };
  };

  wrapRuntimeMethod("switchSession");
  wrapRuntimeMethod("newSession");
  wrapRuntimeMethod("fork");
  wrapRuntimeMethod("importFromJsonl");
  syncRuntimeSession();

  const ensureState = (conversationId: string) => {
    const existing = sessionStates.get(conversationId);
    if (existing) {
      return existing;
    }

    const created: SessionState = {
      outputText: "",
      currentMessageId: "",
      recentMessages: [],
      bridgePromptActive: false,
    };
    sessionStates.set(conversationId, created);
    return created;
  };

  const refreshInteractive = async (interactive: any) => {
    // Pi does not expose a public rebinding hook for external runtime switches yet.
    await interactive?.handleRuntimeSessionChange?.();
    interactive?.renderCurrentSessionState?.();
  };

  const getCurrentSessionPath = () => {
    const currentPath = runtime.session.sessionManager.getSessionFile();
    return currentPath ? path.resolve(currentPath) : "";
  };

  const getOrCreateSession = async (conversationId: string, username?: string, interactive?: any) => {
    // One Mutiro conversation owns one persistent Pi session file. The bridge
    // switches the shared runtime between those sessions as different
    // conversations become active.
    const state = ensureState(conversationId);
    let metadataChanged = false;
    if (username) {
      const normalizedUsername = username.replace(/^@/, "");
      if (state.currentSenderUsername !== normalizedUsername) {
        state.currentSenderUsername = normalizedUsername;
        metadataChanged = true;
      }
    }

    if (state.sessionPath && !fs.existsSync(state.sessionPath)) {
      state.sessionPath = undefined;
      saveSessionMap(deps.targetDir, sessionStates);
    }

    if (!state.sessionPath) {
      logBridge(`[Bridge] Initializing Pi session for conversation: ${conversationId}`);
      await runtime.newSession();
      const nextPath = runtime.session.sessionManager.getSessionFile();
      if (!nextPath) {
        throw new Error(`Pi runtime did not provide a session file for conversation ${conversationId}`);
      }
      state.sessionPath = path.resolve(nextPath);
      runtime.session.setSessionName(buildSessionName(conversationId, state.currentSenderUsername));
      saveSessionMap(deps.targetDir, sessionStates);
      activeConversationIdRef.current = conversationId;
      await refreshInteractive(interactive);
      return state;
    }

    const normalizedTargetPath = path.resolve(state.sessionPath);
    if (getCurrentSessionPath() !== normalizedTargetPath) {
      await runtime.switchSession(normalizedTargetPath);
      activeConversationIdRef.current = conversationId;
      if (metadataChanged) {
        runtime.session.setSessionName(buildSessionName(conversationId, state.currentSenderUsername));
      }
      await refreshInteractive(interactive);
    } else {
      activeConversationIdRef.current = conversationId;
      if (metadataChanged) {
        runtime.session.setSessionName(buildSessionName(conversationId, state.currentSenderUsername));
      }
    }

    if (metadataChanged) {
      saveSessionMap(deps.targetDir, sessionStates);
    }

    return state;
  };

  return {
    activeConversationIdRef,
    dispose: () => logging.dispose(),
    getOrCreateSession,
    getSession: (conversationId: string) => sessionStates.get(conversationId),
    runtime,
    sessionStates,
  };
};

const buildObservedTurn = (envelope: any): ObservedTurn | null => {
  const conversationId = envelope.conversation_id || envelope.payload?.message?.conversation_id;
  const messageId = envelope.message_id || envelope.payload?.message?.id;
  let text = extractBridgeMessageText(envelope.payload?.message, envelope.payload?.reply_to_message_preview);
  const attachmentContext = (envelope.payload?.attachment_context || "").trim();
  if (attachmentContext) {
    text = text ? `${text}${attachmentContext}` : attachmentContext;
  }

  if (!conversationId || !messageId || !text) {
    return null;
  }

  return {
    conversationId,
    messageId,
    replyToMessageId:
      envelope.reply_to_message_id ||
      envelope.payload?.reply_to_message_id ||
      envelope.payload?.message?.reply_to_message_id,
    senderUsername: envelope.payload?.message?.from?.username || "unknown",
    text,
  };
};

const isSelfEventMessage = (envelope: any, agentUsername: string) => {
  const senderUsername = envelope.payload?.message?.from?.username;
  const selfUsername = (agentUsername || "").trim();
  return !senderUsername || (!!selfUsername && senderUsername === selfUsername);
};

async function main() {
  const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  const logFilePath = path.join(targetDir, ".mutiro-pi-interactive-bridge.log");
  writeBridgeLog = (line: string) => {
    fs.appendFileSync(logFilePath, line, "utf8");
  };
  writeBridgeLog(`\n[${new Date().toISOString()}] ---- bridge start ----\n`);
  logBridge(`[Bridge] Starting Mutiro <-> Pi Interactive Bridge in: ${targetDir}`);

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const hostProcess = createHostProcess(targetDir);
  const bridge = createBridgeClient(hostProcess);
  const bridgeState = {
    agentUsername: "",
  };
  let cleanupStarted = false;

  const cleanup = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    try {
      rl.close();
    } catch {}
    try {
      sessionStore.dispose();
    } catch {}
    try {
      await sessionStore.runtime.dispose();
    } catch (err) {
      logBridge("[Bridge] runtime cleanup failed:", err);
    }
    try {
      if (!hostProcess.killed && hostProcess.exitCode === null) {
        hostProcess.kill("SIGTERM");
      }
    } catch (err) {
      logBridge("[Bridge] host cleanup failed:", err);
    }
  };

  const handleTerminationSignal = (signal: NodeJS.Signals) => {
    logBridge(`[Bridge] received ${signal}, shutting down`);
    cleanup()
      .finally(() => process.exit(0));
  };

  process.once("SIGINT", handleTerminationSignal);
  process.once("SIGTERM", handleTerminationSignal);
  process.once("SIGHUP", handleTerminationSignal);

  const sendSignal = (conversationId: string, replyToMessageId: string, signalType: string, detailText = "") => {
    if (!conversationId) return;
    bridge.send("signal.emit", {
      "@type": TYPE_URLS.sendSignalRequest,
      conversation_id: conversationId,
      signal_type: signalType,
      detail_text: detailText,
      in_reply_to: replyToMessageId,
    }, {
      conversation_id: conversationId,
      reply_to_message_id: replyToMessageId,
    });
  };

  const sendReply = (conversationId: string, replyToMessageId: string, text: string, state?: SessionState) => {
    const normalizedText = normalizeOutputText(text);
    if (!normalizedText) return;
    appendRecentMessage(state, buildSyntheticBridgeMessage({
      conversationId,
      replyToMessageId,
      senderUsername: bridgeState.agentUsername || "assistant",
      text: normalizedText,
    }));
    bridge.send("message.send", {
      "@type": TYPE_URLS.bridgeSendMessageCommand,
      conversation_id: conversationId,
      reply_to_message_id: replyToMessageId,
      text: { text: normalizedText },
    }, {
      conversation_id: conversationId,
      reply_to_message_id: replyToMessageId,
    });
  };

  const endTurn = (conversationId: string, replyToMessageId: string) => {
    bridge.send("turn.end", {
      "@type": TYPE_URLS.bridgeTurnEndCommand,
      status: "completed",
    }, {
      conversation_id: conversationId,
      reply_to_message_id: replyToMessageId,
    });
  };

  const sessionStore = await createSessionStore({
    authStorage,
    modelRegistry,
    requestHost: bridge.request,
    sendSignal,
    targetDir,
  });
  const interactive = new InteractiveMode(sessionStore.runtime);

  const initializeBridge = async () => {
    // External bridge mode now sits on the same host pipeline as
    // --transport=stdio, so the handshake is the standard documented bridge
    // handshake rather than a special path.
    logBridge("[Bridge] Host ready, sending initialization...");
    await bridge.request("session.initialize", {
      "@type": TYPE_URLS.bridgeInitializeCommand,
      role: "brain",
      client_name: "pi-mutiro-interactive-bridge",
      client_version: "1.0.0",
      requested_optional_capabilities: OPTIONAL_CAPABILITIES,
    });

    logBridge("[Bridge] Subscribing to event stream...");
    await bridge.request("subscription.set", {
      "@type": TYPE_URLS.bridgeSubscriptionSetCommand,
      all: true,
      conversation_ids: [],
    });
    logBridge("[Bridge] Handshake complete. Listening for messages...");
  };

  const handleObservedMessage = async (envelope: any) => {
    if (envelope.type === "event.message" && isSelfEventMessage(envelope, bridgeState.agentUsername)) {
      return;
    }

    if (envelope.type === "message.observed") {
      // Ack host delivery first. The actual chat reply, if any, is a separate
      // message.send request later in the turn.
      bridge.ack(envelope.request_id, TYPE_URLS.bridgeMessageObservedResult);
    }

    const turn = buildObservedTurn(envelope);
    if (!turn) {
      if (envelope.conversation_id && envelope.message_id) {
        endTurn(envelope.conversation_id, envelope.message_id);
      }
      return;
    }

    const sessionState = await sessionStore.getOrCreateSession(turn.conversationId, turn.senderUsername, interactive as any);
    sessionState.outputText = "";
    sessionState.currentMessageId = turn.messageId;
    // While this flag is true, Pi can use bridge tools. As soon as the Mutiro
    // turn finishes, the same shared Pi session goes back to being local-only.
    sessionState.bridgePromptActive = true;
    appendRecentMessage(sessionState, envelope.payload?.message);
    const snapshot = captureBridgeRunSnapshot(sessionStore.runtime.session);

    try {
      sendSignal(turn.conversationId, turn.messageId, "SIGNAL_TYPE_THINKING", "Processing...");
      await sessionStore.runtime.session.prompt(buildChatTurnPrompt(turn), { streamingBehavior: "followUp" });
    } finally {
      sessionState.bridgePromptActive = false;
    }

    rewriteBridgeUserPrompt(sessionStore.runtime.session, snapshot, turn.text);
    // The bridge prompt contains technical wrapper text that is useful during
    // execution but noisy in the long-lived TUI transcript, so rewrite it back
    // to the clean user text and prune the bridge-only tail.
    pruneBridgeRunArtifacts(sessionStore.runtime.session, snapshot, 1);
    await (interactive as any)?.renderCurrentSessionState?.();

    const replyText = normalizeOutputText(sessionState.outputText);
    if (replyText) {
      sendReply(turn.conversationId, turn.messageId, replyText, sessionState);
    }

    // turn.end is the host-side lifecycle signal. It is separate from whether
    // we happened to send a visible reply.
    endTurn(turn.conversationId, turn.messageId);
  };

  const handleTaskRequest = async (envelope: any) => {
    const conversationId = envelope.conversation_id || "task-queue";
    const sessionState = await sessionStore.getOrCreateSession(conversationId, undefined, interactive as any);
    sessionState.outputText = "";
    sessionState.currentMessageId = envelope.request_id;
    sessionState.bridgePromptActive = true;
    const snapshot = captureBridgeRunSnapshot(sessionStore.runtime.session);

    const taskText = envelope.payload?.prompt || envelope.payload?.text || envelope.payload?.description || "Execute pending tasks";

    try {
      sendSignal(conversationId, sessionState.currentMessageId, "SIGNAL_TYPE_THINKING", "Processing task...");
      await sessionStore.runtime.session.prompt(buildBridgeTaskPrompt(taskText), { streamingBehavior: "followUp" });
    } finally {
      sessionState.bridgePromptActive = false;
    }
    pruneBridgeRunArtifacts(sessionStore.runtime.session, snapshot, 0);
    await (interactive as any)?.renderCurrentSessionState?.();
    // task.request returns delegated text directly instead of using
    // message.send, because it is a host→brain function call, not a chat send.
    bridge.send("command_result", {
      "@type": TYPE_URLS.bridgeCommandResult,
      ok: true,
      response: {
        "@type": TYPE_URLS.bridgeTaskResult,
        text: normalizeOutputText(sessionState.outputText),
      },
    }, {
      request_id: envelope.request_id,
      conversation_id: conversationId,
    });
  };

  const handleSessionSnapshot = (envelope: any) => {
    const conversationId = envelope.payload?.conversation_id || envelope.conversation_id;
    if (!conversationId) {
      bridge.sendError(envelope.request_id, "invalid_request", "session.snapshot conversation_id is required");
      return;
    }

    const sessionState = sessionStore.getSession(conversationId);
    bridge.send("command_result", {
      "@type": TYPE_URLS.bridgeCommandResult,
      ok: true,
      response: {
        "@type": TYPE_URLS.bridgeSessionSnapshotResult,
        recent_messages: sessionState?.recentMessages || [],
        metadata: {
          conversation_id: conversationId,
        },
      },
    }, {
      request_id: envelope.request_id,
      conversation_id: conversationId,
    });
  };

  const handleSessionObserved = async (envelope: any) => {
    const conversationId = envelope.payload?.conversation_id || envelope.conversation_id;
    if (!conversationId) {
      bridge.sendError(envelope.request_id, "invalid_request", "session.observed conversation_id is required");
      return;
    }

    const sessionState = await sessionStore.getOrCreateSession(conversationId, undefined, interactive as any);
    const observedText = (envelope.payload?.text || "").trim();
    if (observedText) {
      appendRecentMessage(sessionState, buildSyntheticBridgeMessage({
        conversationId,
        senderUsername: "system",
        text: observedText,
        metadata: {
          source: (envelope.payload?.source || "").trim(),
        },
      }));
    }

    bridge.ack(envelope.request_id, TYPE_URLS.bridgeSessionObservedResult);
  };

  const rl = readline.createInterface({ input: hostProcess.stdout, terminal: false });

  rl.on("line", async (line) => {
    if (!line.trim()) return;

    try {
      const envelope = JSON.parse(line);

      switch (envelope.type) {
        case "ready":
          bridgeState.agentUsername = envelope.payload?.agent_username || bridgeState.agentUsername;
          try {
            await initializeBridge();
          } catch (err) {
            logBridge("[Bridge] Handshake failed:", err);
          }
          break;

        case "command_result":
          bridge.resolveResponse(envelope.request_id, envelope.payload);
          break;

        case "error":
          if (!bridge.rejectResponse(envelope.request_id, envelope.error)) {
            logBridge("[Bridge] Host error:", envelope.error);
          }
          break;

        case "message.observed":
        case "event.message":
          await handleObservedMessage(envelope);
          break;

        case "task.request":
          await handleTaskRequest(envelope);
          break;

        case "session.snapshot":
          handleSessionSnapshot(envelope);
          break;

        case "session.observed":
          await handleSessionObserved(envelope);
          break;

        default:
          if (envelope.request_id) {
            bridge.sendError(envelope.request_id, "unsupported_envelope", `unsupported envelope type ${JSON.stringify(envelope.type)}`, {
              conversation_id: envelope.conversation_id,
              message_id: envelope.message_id,
              reply_to_message_id: envelope.reply_to_message_id,
            });
          }
          break;
      }
    } catch (err) {
      logBridge("[Bridge] Error processing line:", err);
    }
  });

  try {
    await interactive.run();
  } finally {
    process.removeListener("SIGINT", handleTerminationSignal);
    process.removeListener("SIGTERM", handleTerminationSignal);
    process.removeListener("SIGHUP", handleTerminationSignal);
    await cleanup();
  }
}

main().catch((err) => {
  logBridge("Fatal error:", err);
  process.exit(1);
});
