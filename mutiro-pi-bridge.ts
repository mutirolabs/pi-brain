import {
  AuthStorage,
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as path from "path";
import * as readline from "readline";
import { inspect } from "util";

/**
 * mutiro-pi-bridge.ts
 *
 * A minimal Mutiro Chatbridge <-> Pi adapter.
 *
 * It:
 * - spawns `mutiro agent host --mode=bridge`
 * - speaks NDJSON with the host over stdio
 * - keeps one Pi session per Mutiro conversation
 * - exposes a small Mutiro-specific tool surface inside Pi
 *
 * Usage:
 *   npx tsx mutiro-pi-bridge.ts [path/to/agent/directory]
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
  // One Mutiro conversation maps to one Pi session. That keeps continuity
  // inside Pi without rebuilding full history on every observed turn.
  session: any;
  outputText: string;
  currentMessageId: string;
  recentMessages: any[];
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

const toolTextResult = (text: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

const shortMessageId = (value?: string) => {
  const id = (value || "").trim();
  return id.length <= 8 ? id : id.slice(-8);
};

/**
 * Converts a normalized bridge message into plain text for the LLM.
 *
 * The host delivers messages as `envelope.payload.message` with the following shape:
 *
 *   { text?: string, parts?: ChatBridgeMessagePart[], reply_to_message_id?: string, ... }
 *
 * `parts` is an array of flat objects, each carrying a `type` string discriminator.
 * The host digests the raw wire format into this clean shape before delivery, so
 * brain implementations only need to care about the fields documented below.
 *
 * ## Part types and when they arrive
 *
 * | type          | when it arrives                                          | what we extract                                            |
 * |---------------|----------------------------------------------------------|------------------------------------------------------------|
 * | `text`        | User sends a normal typed message                        | `part.text` verbatim                                       |
 * | `audio`       | User sends a voice message (host transcribes upstream)   | `part.transcript` — the transcribed text                   |
 * | `image`       | User shares a photo or screenshot                        | `[Image attachment: <caption>]` placeholder                |
 * | `file`        | User shares a document (PDF, etc.)                       | `[File attachment: <filename> — <caption>]` placeholder    |
 * | `card`        | An agent sends an interactive A2UI card into the chat    | `[Interactive card: <card_id>]` placeholder                |
 * | `card_action` | A user clicks/submits on an interactive card             | `[Card interaction: card=… action=… data=…]`               |
 * | `contact`     | User shares another member's contact                     | `[Shared contact: Name (@username, role)]`                 |
 * | `reaction`    | User adds or removes an emoji reaction on a message      | `[reacted 👍 to #<msgId>]` or `[removed reaction …]`      |
 * | `live_call`   | A voice call ends — system posts a summary to the thread | Full summary with action items and follow-ups              |
 *
 * Note: for `image` and `file` parts, the host downloads the actual files into
 * `{agent_workspace}/Downloads/` before delivering the message. The download paths are
 * communicated separately via `envelope.payload.attachment_context` (see `buildObservedTurn`),
 * not through this function. This function only produces the inline text placeholders.
 *
 * @see `buildObservedTurn` — assembles the final text by combining this function's output
 *   with `attachment_context` (the host's download notification listing local file paths).
 * @see https://docs.mutiro.com/chatbridge-protocol — canonical protocol reference.
 */
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
        if (actionItems.length > 0) lines.push(`Action items:\n${actionItems.map((item) => `- ${item}`).join("\n")}`);
        if (followUps.length > 0) lines.push(`Follow-ups:\n${followUps.map((item) => `- ${item}`).join("\n")}`);
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

const buildChatTurnPrompt = (turn: ObservedTurn) =>
  [buildMessageContextHeader(turn), "", turn.text].join("\n");

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

// In bridge mode the Mutiro host writes slog JSON records to stderr. Parse
// each line and render a compact `host: <msg> key=val ...` form so the bridge
// log stream reads naturally instead of leaking raw Go-side records.
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
    if (level === "error") console.error(text);
    else if (level === "warn") console.warn(text);
    else console.log(text);
  });

  hostProcess.on("exit", (code) => {
    stderrReader.close();
    console.log(`[Bridge] Mutiro host exited with code ${code}`);
    process.exit(code || 0);
  });

  return hostProcess;
};

const createBridgeClient = (hostProcess: ChildProcessWithoutNullStreams) => {
  // Bridge requests are ordinary NDJSON envelopes with request/response
  // correlation on request_id. Visible chat replies are *not* the response to
  // message.observed; they are separate outbound bridge requests.
  const pendingRequests = new Map<string, PendingRequest>();

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
    // Acknowledge host-owned request delivery. This is separate from sending a
    // user-visible message back into Mutiro.
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
  conversationId: string;
  requestHost: ReturnType<typeof createBridgeClient>["request"];
  state: SessionState;
}) => {
  // Pi tools are only thin adapters here. They translate Pi-side tool calls
  // into portable chatbridge operations instead of talking to backend SDKs.
  const replyTarget = (explicitReplyTo?: string) => explicitReplyTo || deps.state.currentMessageId;

  return [
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
        const normalizedMessage = normalizeOutputText(args.message);
        if (!normalizedMessage) {
          return toolTextResult("NOOP acknowledged. No message sent.");
        }
        const res = await deps.requestHost("message.send", {
          "@type": TYPE_URLS.bridgeSendMessageCommand,
          conversation_id: deps.conversationId,
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
        const res = await deps.requestHost("message.send", {
          "@type": TYPE_URLS.bridgeSendMessageCommand,
          conversation_id: deps.conversationId,
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
        try {
          const res = await deps.requestHost("message.react", {
            "@type": TYPE_URLS.addReactionRequest,
            message_id: args.message_id,
            emoji: args.emoji,
          }, { message_id: args.message_id });
          return toolTextResult(JSON.stringify(res, null, 2));
        } catch (err: any) {
          console.error("[Bridge] react_to_message failed:", inspect(err, { depth: null, colors: false }));
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
          conversation_id: deps.conversationId,
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

const attachSessionLogging = (deps: {
  conversationId: string;
  sendSignal: (conversationId: string, replyToMessageId: string, signalType: string, detailText?: string) => void;
  state: SessionState;
}) => {
  deps.state.session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      deps.state.outputText += event.assistantMessageEvent.delta;
      process.stdout.write(event.assistantMessageEvent.delta);
      return;
    }

    if (event.type === "tool_execution_start") {
      deps.sendSignal(deps.conversationId, deps.state.currentMessageId, "SIGNAL_TYPE_TOOL_RUNNING", event.toolName);
      return;
    }

    if (isToolExecutionEvent(event)) {
      console.error("[Bridge] Pi tool event:", inspect(event, { depth: null, colors: false }));
      return;
    }

    if (event.type === "message_start") {
      deps.sendSignal(deps.conversationId, deps.state.currentMessageId, "SIGNAL_TYPE_TYPING", "Writing response...");
    }
  });
};

const createSessionStore = (deps: {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  requestHost: ReturnType<typeof createBridgeClient>["request"];
  resourceLoader: DefaultResourceLoader;
  sendSignal: (conversationId: string, replyToMessageId: string, signalType: string, detailText?: string) => void;
}) => {
  const activeSessions = new Map<string, SessionState>();

  const getOrCreateSession = async (conversationId: string) => {
    // Reuse the same Pi session for later turns in the same Mutiro
    // conversation. This is the core "swap the brain, keep the host lane"
    // idea in the simplest possible form.
    if (activeSessions.has(conversationId)) {
      return activeSessions.get(conversationId)!;
    }

    console.log(`[Bridge] Initializing Pi session for conversation: ${conversationId}`);

    const state: SessionState = {
      session: null,
      outputText: "",
      currentMessageId: "",
      recentMessages: [],
    };

    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      authStorage: deps.authStorage,
      modelRegistry: deps.modelRegistry,
      resourceLoader: deps.resourceLoader,
      customTools: createMutiroTools({
        conversationId,
        requestHost: deps.requestHost,
        state,
      }),
    });

    state.session = session;
    attachSessionLogging({
      conversationId,
      sendSignal: deps.sendSignal,
      state,
    });

    activeSessions.set(conversationId, state);
    return state;
  };

  const getSession = (conversationId: string) => activeSessions.get(conversationId);

  return { getOrCreateSession, getSession };
};

/**
 * Assembles a promptable {@link ObservedTurn} from an inbound host envelope.
 *
 * The text is built in two layers:
 *
 * 1. `extractBridgeMessageText(envelope.payload.message)` — converts each message part
 *    (text, audio transcript, card placeholder, etc.) into inline plain text.
 *
 * 2. `envelope.payload.attachment_context` — a host-generated system notification listing
 *    files the host downloaded into `{agent_workspace}/Downloads/` before delivering this
 *    envelope. For image and file parts, the host fetches the actual bytes from storage and
 *    saves them locally so the brain can read/analyze them. The notification looks like:
 *
 *      [SYSTEM: Downloaded 2 attachment(s) to your workspace:
 *      • photo.jpg → /workspace/Downloads/photo.jpg
 *        Image: 1920x1080 pixels, JPG, 2.1 MB
 *      • report.pdf → /workspace/Downloads/report.pdf
 *        File type: PDF, 450.3 KB
 *      These files are now available in your workspace. ...]
 *
 *    This is appended directly to the text so the LLM sees both the part-level description
 *    (e.g. "[Image attachment: sunset photo]") and the concrete local path it can reference.
 *
 * Returns null if any required field (conversationId, messageId, or text) is missing.
 */
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
  console.log(`[Bridge] Starting Mutiro <-> Pi Bridge in: ${targetDir}`);

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
  });
  await resourceLoader.reload();

  const hostProcess = createHostProcess(targetDir);
  const bridge = createBridgeClient(hostProcess);
  const bridgeState = {
    agentUsername: "",
  };

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

  const sessionStore = createSessionStore({
    authStorage,
    modelRegistry,
    requestHost: bridge.request,
    resourceLoader,
    sendSignal,
  });

  const initializeBridge = async () => {
    // Standalone bridge mode mirrors the documented handshake:
    // ready -> session.initialize -> subscription.set -> message.observed.
    console.log("[Bridge] Host ready, sending initialization...");
    await bridge.request("session.initialize", {
      "@type": TYPE_URLS.bridgeInitializeCommand,
      role: "brain",
      client_name: "pi-mutiro-bridge",
      client_version: "1.0.0",
      requested_optional_capabilities: OPTIONAL_CAPABILITIES,
    });

    console.log("[Bridge] Subscribing to event stream...");
    await bridge.request("subscription.set", {
      "@type": TYPE_URLS.bridgeSubscriptionSetCommand,
      all: true,
      conversation_ids: [],
    });
    console.log("[Bridge] Handshake complete. Listening for messages...");
  };

  const handleObservedMessage = async (envelope: any) => {
    if (envelope.type === "event.message" && isSelfEventMessage(envelope, bridgeState.agentUsername)) {
      return;
    }

    if (envelope.type === "message.observed") {
      // Ack delivery immediately so the host knows we accepted the turn, even
      // though the actual visible reply will happen later via message.send.
      bridge.ack(envelope.request_id, TYPE_URLS.bridgeMessageObservedResult);
    }

    const turn = buildObservedTurn(envelope);
    if (!turn) {
      if (envelope.conversation_id && envelope.message_id) {
        endTurn(envelope.conversation_id, envelope.message_id);
      }
      return;
    }

    const sessionState = await sessionStore.getOrCreateSession(turn.conversationId);
    sessionState.outputText = "";
    sessionState.currentMessageId = turn.messageId;
    appendRecentMessage(sessionState, envelope.payload?.message);

    sendSignal(turn.conversationId, turn.messageId, "SIGNAL_TYPE_THINKING", "Processing...");
    await sessionState.session.prompt(buildChatTurnPrompt(turn), { streamingBehavior: "followUp" });

    const replyText = normalizeOutputText(sessionState.outputText);
    if (replyText) {
      sendReply(turn.conversationId, turn.messageId, replyText, sessionState);
    }

    // turn.end closes the host-owned turn lifecycle even if we already emitted
    // one or more user-visible replies.
    endTurn(turn.conversationId, turn.messageId);
  };

  const handleTaskRequest = async (envelope: any) => {
    const conversationId = envelope.conversation_id || "task-queue";
    const sessionState = await sessionStore.getOrCreateSession(conversationId);
    sessionState.outputText = "";
    sessionState.currentMessageId = envelope.request_id;

    const taskText = envelope.payload?.prompt || envelope.payload?.text || envelope.payload?.description || "Execute pending tasks";

    sendSignal(conversationId, sessionState.currentMessageId, "SIGNAL_TYPE_THINKING", "Processing task...");
    await sessionState.session.prompt(taskText, { streamingBehavior: "followUp" });
    // task.request returns plain text directly in the response payload instead
    // of using message.send, because this is delegated work rather than a
    // visible chat reply.
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

    const sessionState = await sessionStore.getOrCreateSession(conversationId);
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
            console.error("[Bridge] Handshake failed:", err);
          }
          break;

        case "command_result":
          bridge.resolveResponse(envelope.request_id, envelope.payload);
          break;

        case "error":
          if (!bridge.rejectResponse(envelope.request_id, envelope.error)) {
            console.error("[Bridge] Host error:", envelope.error);
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
      console.error("[Bridge] Error processing line:", err);
    }
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
