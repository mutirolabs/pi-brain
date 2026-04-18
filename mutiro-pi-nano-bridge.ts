import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import { spawn } from "child_process";
import * as path from "path";
import * as readline from "readline";

const V = "mutiro.agent.bridge.v1";
const T = {
  init: "type.googleapis.com/mutiro.chatbridge.ChatBridgeInitializeCommand",
  sub: "type.googleapis.com/mutiro.chatbridge.ChatBridgeSubscriptionSetCommand",
  result: "type.googleapis.com/mutiro.chatbridge.ChatBridgeCommandResult",
  observedAck: "type.googleapis.com/mutiro.chatbridge.ChatBridgeMessageObservedResult",
  task: "type.googleapis.com/mutiro.chatbridge.ChatBridgeTaskResult",
  send: "type.googleapis.com/mutiro.chatbridge.ChatBridgeSendMessageCommand",
  turnEnd: "type.googleapis.com/mutiro.chatbridge.ChatBridgeTurnEndCommand",
  signal: "type.googleapis.com/mutiro.signal.SendSignalRequest",
} as const;

const id = () => Math.random().toString(36).slice(2);
const dir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const host = spawn("mutiro", ["agent", "host", "--mode=bridge"], { cwd: dir, env: process.env });
const rl = readline.createInterface({ input: host.stdout, terminal: false });
// request_id correlation is all this tiny adapter needs for direct request /
// response bridge calls.
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
// One Pi session per conversation gives us continuity without rebuilding the
// whole conversation transcript every turn.
const sessions = new Map<string, { session: any; text: string }>();
let agentUsername = "";

// Parse slog JSON lines from the host and render compactly; fall back to the
// raw line if it does not look like slog JSON.
const stderrReader = readline.createInterface({ input: host.stderr, terminal: false });
stderrReader.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  if (t.startsWith("{") && t.endsWith("}")) {
    try {
      const p = JSON.parse(t);
      if (p && typeof p.msg === "string") {
        const drop = new Set(["time", "level", "msg", "component", "agent_username"]);
        const attrs = Object.entries(p)
          .filter(([k]) => !drop.has(k))
          .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join(" ");
        const level = (typeof p.level === "string" ? p.level : "info").toLowerCase();
        const out = `host: ${p.msg}${attrs ? ` ${attrs}` : ""}`;
        if (level === "error") console.error(out);
        else if (level === "warn" || level === "warning") console.warn(out);
        else console.log(out);
        return;
      }
    } catch {}
  }
  console.log(`host: ${t}`);
});
host.on("exit", (code) => {
  stderrReader.close();
  process.exit(code || 0);
});

const send = (type: string, payload: any, extra: Record<string, string> = {}) =>
  host.stdin.write(`${JSON.stringify({ protocol_version: V, type, request_id: extra.request_id || id(), payload, ...extra })}\n`);

const request = (type: string, payload: any, extra: Record<string, string> = {}) =>
  new Promise<any>((resolve, reject) => {
    const request_id = id();
    pending.set(request_id, { resolve, reject });
    send(type, payload, { ...extra, request_id });
  });

const ack = (request_id: string, type: string) =>
  // Ack the host request itself. This is distinct from sending a reply back to
  // the user with message.send.
  send("command_result", { "@type": T.result, ok: true, response: { "@type": type } }, { request_id });

const signal = (conversation_id: string, reply_to_message_id: string, signal_type: string, detail_text = "") =>
  send("signal.emit", {
    "@type": T.signal,
    conversation_id,
    signal_type,
    detail_text,
    in_reply_to: reply_to_message_id,
  }, { conversation_id, reply_to_message_id });

const shortMessageId = (value?: string) => {
  const id = (value || "").trim();
  return id.length <= 8 ? id : id.slice(-8);
};

const extractBridgeMessageText = (message?: any) => {
  if (!message) return "";

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
        const target = shortMessageId(message.reply_to_message_id);
        if ((part.reaction_operation || "").trim().toLowerCase() === "removed") {
          push(target ? `[removed reaction ${emoji} from #${target}]` : `[removed reaction ${emoji}]`);
        } else {
          push(target ? `[reacted ${emoji} to #${target}]` : `[reacted ${emoji}]`);
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

const normalizeOutputText = (value: string) => {
  const trimmed = (value || "").trim();
  const lowered = trimmed.toLowerCase();
  if (!trimmed) return "";
  if (lowered === "noop" || lowered === "noop.") return "";
  return trimmed;
};

const getSession = async (conversationId: string) => {
  const existing = sessions.get(conversationId);
  if (existing) return existing;
  const state = { session: null as any, text: "" };
  const { session } = await createAgentSession({ cwd: dir, tools: [], sessionManager: SessionManager.inMemory() });
  state.session = session;
  session.subscribe((e: any) => {
    if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
      state.text += e.assistantMessageEvent.delta;
    }
  });
  sessions.set(conversationId, state);
  return state;
};

const prompt = async (conversation_id: string, message_id: string, text: string, sender = "unknown", reply_to_message_id = "") => {
  // This prompt format is intentionally simple. The nano example exists to
  // show the minimum viable bridge loop, not a polished prompt architecture.
  const s = await getSession(conversation_id);
  s.text = "";
  signal(conversation_id, message_id, "SIGNAL_TYPE_THINKING", "Processing...");
  await s.session.prompt(
    `[message_context]\n- sender: ${sender}\n- sender_role: user\n- message_id: ${message_id}\n- conversation_id: ${conversation_id}${reply_to_message_id ? `\n- reply_to_message_id: ${reply_to_message_id}` : ""}\n\n${text}`,
    { streamingBehavior: "followUp" },
  );
  const replyText = normalizeOutputText(s.text);
  if (replyText) {
    signal(conversation_id, message_id, "SIGNAL_TYPE_TYPING", "Writing response...");
    await request("message.send", {
      "@type": T.send,
      conversation_id,
      reply_to_message_id: message_id,
      text: { text: replyText },
    }, { conversation_id, reply_to_message_id: message_id });
  }
  // turn.end closes the host-owned turn lifecycle even when the visible reply
  // path above was a no-op.
  send("turn.end", { "@type": T.turnEnd, status: "completed" }, { conversation_id, reply_to_message_id: message_id });
};

rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const e = JSON.parse(line);
    if (e.type === "ready") {
      agentUsername = e.payload?.agent_username || "";
      // Standard bridge handshake for standalone mode.
      await request("session.initialize", { "@type": T.init, role: "brain", client_name: "pi-mutiro-nano-bridge", client_version: "1.0.0" });
      await request("subscription.set", { "@type": T.sub, all: true, conversation_ids: [] });
      return;
    }
    if (e.type === "command_result") {
      pending.get(e.request_id)?.resolve(e.payload?.response || e.payload);
      pending.delete(e.request_id);
      return;
    }
    if (e.type === "error") {
      if (!pending.has(e.request_id)) console.error("[NanoBridge] Host error:", e.error);
      pending.get(e.request_id)?.reject(e.error);
      pending.delete(e.request_id);
      return;
    }
    if (e.type === "message.observed") {
      ack(e.request_id, T.observedAck);
      const m = e.payload?.message;
      const text = (() => {
        const content = extractBridgeMessageText(m);
        const attachmentContext = (e.payload?.attachment_context || "").trim();
        return attachmentContext ? (content ? `${content}${attachmentContext}` : attachmentContext) : content;
      })();
      if (m?.conversation_id && m?.id && text) await prompt(m.conversation_id, m.id, text, m?.from?.username, m?.reply_to_message_id);
      return;
    }
    if (e.type === "event.message") {
      const m = e.payload?.message;
      if (m?.from?.username && m.from.username === agentUsername) return;
      const text = extractBridgeMessageText(m);
      if (m?.conversation_id && m?.id && text) await prompt(m.conversation_id, m.id, text, m?.from?.username, m?.reply_to_message_id);
      return;
    }
    if (e.type === "task.request") {
      const conversation_id = e.conversation_id || "task-queue";
      const message_id = e.request_id;
      const text = e.payload?.prompt || "Execute pending tasks";
      const s = await getSession(conversation_id);
      s.text = "";
      signal(conversation_id, message_id, "SIGNAL_TYPE_THINKING", "Processing task...");
      await s.session.prompt(text, { streamingBehavior: "followUp" });
      // task.request returns plain text in the response payload instead of
      // sending a visible chat message.
      send("command_result", {
        "@type": T.result,
        ok: true,
        response: { "@type": T.task, text: normalizeOutputText(s.text) },
      }, { request_id: e.request_id });
    }
  } catch (err) {
    console.error("[NanoBridge] Error:", err);
  }
});
