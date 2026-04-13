# Mutiro Pi Bridge Reference

Use this repo if you want to swap Mutiro's built-in brain and create your own brain over `chatbridge`, using Pi as the reference implementation.

## Quick Start

### 1. If you do not have a Mutiro agent yet, create one

The easiest path is to use the Mutiro guide and let Claude or ChatGPT walk you through it:

- Claude:
  `https://claude.ai/new?q=Read%20this%20page%20from%20the%20Mutiro%20docs%3A%20https%3A%2F%2Fmutiro.com%2Fdocs%2Fguides%2Fcreate-agent.md%20and%20help%20me%20create%20an%20agent%20step%20by%20step.`
- ChatGPT:
  `https://chatgpt.com/?q=Read%20this%20page%20from%20the%20Mutiro%20docs%3A%20https%3A%2F%2Fmutiro.com%2Fdocs%2Fguides%2Fcreate-agent.md%20and%20help%20me%20create%20an%20agent%20step%20by%20step.`

Or read the source guide directly:

- `https://mutiro.com/docs/guides/create-agent.md`

### 2. Run this bridge against your agent folder

Before you start this bridge, stop the normal Mutiro agent/host for that agent first. Do not run the built-in brain and the Pi bridge against the same agent at the same time.

Install dependencies:

```bash
npm install
```

Run the standard adapter:

```bash
npm run bridge -- /path/to/agent-directory
```

You can also use:

```bash
./run-brain.sh /path/to/agent-directory
```

That is the shortest path: create a Mutiro agent, then point this bridge at that agent directory.

## What This Repo Is

This repo is a small reference package showing how to plug an external brain into Mutiro `chatbridge` using Pi.

Pi is a strong fit for this reference because it is interactive, sessionful, and expressive enough to show the bridge model clearly. The same overall shape can support other external brains too:

- `mutiro agent host --mode=bridge`
- NDJSON over stdio
- one long-lived brain process
- one runtime session per Mutiro conversation
- all outbound chat actions going back through the bridge

## What Is Here

- `mutiro-pi-bridge.ts`
  Standard reference adapter. One Pi session per Mutiro conversation, in memory only.
- `mutiro-pi-nano-bridge.ts`
  Minimal text-only example. No tools, just signals, text replies, and `turn.end`.
- `mutiro-pi-interactive-bridge.ts`
  Full interactive Pi TUI sharing the same underlying session/runtime that Mutiro turns use.
- `run-brain.sh`
  Tiny launcher for the standard adapter.

## Why This Exists

Use this folder as a reference if you want to integrate another runtime with Mutiro bridge.

It shows how to:

1. Spawn `mutiro agent host --mode=bridge`
2. Complete `ready -> session.initialize -> subscription.set`
3. Receive `message.observed`
4. Turn inbound Mutiro messages into runtime prompts
5. Execute outbound chat actions only through the bridge
6. Finish turns with `turn.end`

## Important Bridge Notes

- `message.send` is a bridge-local command, not a raw backend `SendToConversationRequest`
- the portable payload type is `mutiro.chatbridge.ChatBridgeSendMessageCommand`
- `message.send_voice` is also bridge-local and keeps TTS inside the host
- this reference usually replies by `conversation_id`
- the bridge also supports `to_username` for direct sends

## Adapter Model

The adapter process is the brain. It:

- spawns `mutiro agent host --mode=bridge`
- reads and writes bridge envelopes on stdio
- keeps one Pi session per `conversation_id`
- exposes a small Mutiro-oriented tool surface inside Pi

The brain does not talk to Mutiro SDKs directly.

## Supported Bridge Operations

The full adapter exercises:

- `message.send`
- `message.send_voice`
- `message.react`
- `message.forward`
- `media.upload`
- `signal.emit`
- `turn.end`
- `recall.search`
- `recall.get`

The nano adapter intentionally does much less.

## Session Model

- one Pi session per Mutiro `conversation_id`
- later turns in the same conversation reuse that Pi session
- `mutiro-pi-bridge.ts` keeps sessions in memory only
- `mutiro-pi-interactive-bridge.ts` persists the Pi session-path mapping in the agent workspace so the same conversation can reopen the same Pi session later

This reference does not rebuild full Mutiro history on every turn. It relies on the long-lived Pi session for continuity.

## Run
Run the nano adapter:

```bash
npm run nano -- /path/to/agent-directory
```

Run the interactive adapter:

```bash
npm run interactive -- /path/to/agent-directory
```

The agent directory should be a normal Mutiro agent workspace that `mutiro agent host` can run from.

## Handshake

Startup flow:

1. host sends `ready`
2. brain sends `session.initialize`
3. brain sends `subscription.set`
4. host starts delivering `message.observed`

Per turn:

1. brain acknowledges `message.observed`
2. brain runs the turn in Pi
3. brain sends zero or more outbound bridge operations
4. brain sends `turn.end`

## Interactive Variant

`mutiro-pi-interactive-bridge.ts` is the most interesting example.

It uses Pi's normal interactive UI while sharing the same runtime/session layer that Mutiro turns use. That means:

- Mutiro messages and local TUI usage can share one Pi cognitive session
- bridge tools stay gated to live Mutiro-owned turns
- local TUI prompts stay local

This is useful as a reference for “swap the brain, keep the host and session semantics” experiments.

## Debugging

Useful signals while integrating:

- `Handshake failed`
  Bridge startup or negotiation problem.
- `Host error`
  A bridge request failed outside a pending request path.
- `react_to_message failed`
  The adapter reached the bridge and got a real host-side error.

The interactive adapter also writes bridge diagnostics to:

```text
<agent-dir>/.mutiro-pi-interactive-bridge.log
```

## Type Checking

This folder now has its own `tsconfig.json`. Use:

```bash
npm run check
```

It runs with `skipLibCheck` because Pi's dependency tree currently includes noisy external type issues that are not specific to this reference code.

## What To Copy

If you are integrating another runtime, the most useful pieces to copy are:

- bridge handshake flow
- pending request correlation by `request_id`
- `message.observed` acknowledgement behavior
- per-conversation session cache
- outbound operation wrappers
- final `turn.end` behavior

Pi is the star of this reference, and the bridge structure it demonstrates is reusable for other runtimes too.
