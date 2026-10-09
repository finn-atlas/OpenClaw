import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { GoogleChatApiError } from "./api.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";
import "./monitor.js";
import type { GoogleChatEvent } from "./types.js";

const apiMocks = vi.hoisted(() => ({
  deleteGoogleChatMessage: vi.fn(),
  downloadGoogleChatMedia: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
  updateGoogleChatMessage: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  applyGoogleChatInboundAccessPolicy: vi.fn(),
}));

const routingMocks = vi.hoisted(() => ({
  processEvent: undefined as
    | ((event: GoogleChatEvent, target: Record<string, unknown>) => Promise<void>)
    | undefined,
}));

const inboundMocks = vi.hoisted(() => ({
  resolveAgentRoute: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  createChannelInboundEnvelopeBuilderAsync:
    async () =>
    ({ body }: { body: string }) =>
      body,
}));

vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/routing")>()),
  resolveAgentRoute: inboundMocks.resolveAgentRoute,
}));

vi.mock("./api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api.js")>()),
  deleteGoogleChatMessage: apiMocks.deleteGoogleChatMessage,
  downloadGoogleChatMedia: apiMocks.downloadGoogleChatMedia,
  sendGoogleChatMessage: apiMocks.sendGoogleChatMessage,
  updateGoogleChatMessage: apiMocks.updateGoogleChatMessage,
}));

vi.mock("./monitor-access.js", () => ({
  applyGoogleChatInboundAccessPolicy: accessMocks.applyGoogleChatInboundAccessPolicy,
}));

vi.mock("./monitor-routing.js", () => ({
  registerGoogleChatWebhookTarget: vi.fn(),
  setGoogleChatWebhookEventProcessor: vi.fn(
    (
      eventProcessor: (event: GoogleChatEvent, target: Record<string, unknown>) => Promise<void>,
    ) => {
      routingMocks.processEvent = eventProcessor;
    },
  ),
}));

type GoogleChatTestReplyPayload = { text: string; replyToId?: string; isStatusNotice?: boolean };
type GoogleChatTestDelivery = {
  durable: (payload: GoogleChatTestReplyPayload, info: { kind: string }) => unknown;
  deliver: (payload: GoogleChatTestReplyPayload) => Promise<void>;
  onDelivered: (
    payload: GoogleChatTestReplyPayload,
    info: { kind: string },
    result: { visibleReplySent: boolean },
  ) => void | Promise<void>;
};

beforeEach(() => {
  apiMocks.deleteGoogleChatMessage.mockReset();
  apiMocks.downloadGoogleChatMedia.mockReset();
  apiMocks.sendGoogleChatMessage.mockReset().mockResolvedValue(null);
  apiMocks.updateGoogleChatMessage.mockReset().mockResolvedValue({});
  accessMocks.applyGoogleChatInboundAccessPolicy.mockReset().mockResolvedValue({
    ok: true,
    commandAuthorized: undefined,
    effectiveWasMentioned: undefined,
    groupBotLoopProtection: undefined,
    groupSystemPrompt: undefined,
  });
  inboundMocks.resolveAgentRoute.mockReset().mockReturnValue({
    agentId: "agent-1",
    accountId: "work",
    sessionKey: "session-1",
  });
});

function createCore(params: {
  run: (delivery: GoogleChatTestDelivery) => Promise<void>;
  chunks?: string[];
}) {
  return {
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: {
        buildContext: vi.fn((payload: unknown) => payload),
        run: vi.fn(
          async (turn: {
            adapter: { resolveTurn: () => { delivery: GoogleChatTestDelivery } };
          }) => {
            await params.run(turn.adapter.resolveTurn().delivery);
          },
        ),
      },
      text: {
        resolveChunkMode: vi.fn(() => "markdown"),
        chunkMarkdownTextWithMode: vi.fn((text: string) => params.chunks ?? [text]),
      },
    },
  } as unknown as GoogleChatCoreRuntime;
}

function createEvent(params?: {
  messageName?: string | null;
  spaceType?: string;
}): GoogleChatEvent {
  return {
    type: "MESSAGE",
    space: { name: "spaces/CLASSIFY", spaceType: params?.spaceType ?? "SPACE" },
    message: {
      name:
        params?.messageName === null
          ? undefined
          : (params?.messageName ?? "spaces/CLASSIFY/messages/1"),
      text: "hello",
      thread: { name: "spaces/CLASSIFY/threads/requested" },
      sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
    },
  } satisfies GoogleChatEvent;
}

function createAccount(config: ResolvedGoogleChatAccount["config"]): ResolvedGoogleChatAccount {
  return {
    accountId: "work",
    config,
    credentialSource: "inline",
  } as ResolvedGoogleChatAccount;
}

async function processEvent(params: {
  account: ResolvedGoogleChatAccount;
  core: GoogleChatCoreRuntime;
  event?: GoogleChatEvent;
  runtime?: GoogleChatRuntimeEnv;
  config?: Record<string, unknown>;
}) {
  if (!routingMocks.processEvent) {
    throw new Error("Expected Google Chat webhook event processor registration");
  }
  await routingMocks.processEvent(params.event ?? createEvent(), {
    account: params.account,
    config: params.config ?? {},
    runtime: params.runtime ?? { error: vi.fn(), log: vi.fn() },
    core: params.core,
    mediaMaxMb: 10,
    path: "/googlechat",
  });
}

const SPACE = "spaces/CLASSIFY";
const SOURCE = `${SPACE}/messages/1`;
const THREAD = `${SPACE}/threads/requested`;
const TYPING = `${SPACE}/messages/typing`;

describe("Google Chat automatic reply target reconciliation", () => {
  it("honors an explicit reply target with thread sessions enabled", async () => {
    const otherThread = `${SPACE}/threads/other`;
    const account = createAccount({
      replyToMode: "all",
      typingIndicator: "none",
      sessionThread: true,
    });
    const core = createCore({
      run: async (delivery) => {
        const payload = Object.freeze({ text: "retargeted", replyToId: otherThread });
        expect(delivery.durable(payload, { kind: "final" })).toEqual({
          to: SPACE,
          replyToId: otherThread,
          threadId: otherThread,
        });
        await delivery.deliver(payload);
      },
    });
    await processEvent({ account, core });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: SPACE,
      text: "retargeted",
      thread: otherThread,
    });
  });

  it.each([
    {
      label: "definitive rejected edit",
      error: new GoogleChatApiError(403, "edit forbidden"),
      deletes: true,
    },
    { label: "lost edit response", error: new Error("response lost"), deletes: false },
    {
      label: "timed-out edit response",
      error: new GoogleChatApiError(408, "request timeout"),
      deletes: false,
    },
  ])("keeps placeholder custody correct after a $label", async ({ error, deletes }) => {
    const account = createAccount({ replyToMode: "all" });
    const core = createCore({
      run: async (delivery) => {
        await expect(delivery.deliver({ text: "answer" })).rejects.toBe(error);
      },
    });
    apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: TYPING,
      threadName: THREAD,
    });
    apiMocks.updateGoogleChatMessage.mockRejectedValueOnce(error);

    await processEvent({ account, core });

    if (deletes) {
      expect(apiMocks.deleteGoogleChatMessage).toHaveBeenCalledExactlyOnceWith({
        account,
        messageName: TYPING,
      });
    } else {
      expect(apiMocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
    }
  });

  it("threads batched replies without threading other batched-mode output", async () => {
    const account = createAccount({ replyToMode: "batched", typingIndicator: "none" });
    const core = createCore({
      run: async (delivery) => {
        const toolReply = { text: "tool output" };
        expect(delivery.durable(toolReply, { kind: "final" })).toEqual({
          to: SPACE,
          replyToId: null,
        });
        await delivery.deliver(toolReply);
        const batchedReply = { text: "batched answer", replyToId: SOURCE };
        expect(delivery.durable(batchedReply, { kind: "final" })).toEqual({
          to: SPACE,
          replyToId: THREAD,
          threadId: THREAD,
        });
        await delivery.deliver(batchedReply);
      },
    });
    await processEvent({ account, core });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(1, {
      account,
      space: SPACE,
      text: "tool output",
      thread: undefined,
    });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(2, {
      account,
      space: SPACE,
      text: "batched answer",
      thread: THREAD,
    });
  });

  it("shows queued status in the typing message and removes it after a silent turn", async () => {
    const account = createAccount({ replyToMode: "all" });
    const core = createCore({ run: async () => {} });
    apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: TYPING,
      threadName: THREAD,
    });

    await processEvent({
      account,
      core,
      config: { messages: { statusReactions: { enabled: true } } },
    });

    expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: TYPING,
      text: "👀 Received",
    });
    expect(apiMocks.deleteGoogleChatMessage).toHaveBeenCalledExactlyOnceWith({
      account,
      messageName: TYPING,
    });
  });

  it("removes an unused typing placeholder when the turn ends without a reply", async () => {
    const account = createAccount({ replyToMode: "all" });
    const core = createCore({ run: async () => {} });
    apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: TYPING,
      threadName: THREAD,
    });

    await processEvent({ account, core });

    expect(apiMocks.deleteGoogleChatMessage).toHaveBeenCalledExactlyOnceWith({
      account,
      messageName: TYPING,
    });
  });

  it("threads only the first visible answer in first mode", async () => {
    const account = createAccount({ replyToMode: "first", typingIndicator: "none" });
    const core = createCore({
      run: async (delivery) => {
        const status = { text: "Working", isStatusNotice: true };
        await delivery.onDelivered(status, { kind: "status" }, { visibleReplySent: true });
        const first = { text: "first" };
        expect(delivery.durable(first, { kind: "final" })).toEqual({
          to: SPACE,
          replyToId: THREAD,
          threadId: THREAD,
        });
        await delivery.deliver(first);
        await delivery.onDelivered(first, { kind: "final" }, { visibleReplySent: true });
        const second = { text: "second" };
        expect(delivery.durable(second, { kind: "final" })).toEqual({
          to: SPACE,
          replyToId: null,
        });
        await delivery.deliver(second);
      },
    });
    await processEvent({ account, core });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(1, {
      account,
      space: SPACE,
      text: "first",
      thread: THREAD,
    });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(2, {
      account,
      space: SPACE,
      text: "second",
      thread: undefined,
    });
  });

  it("keeps automatic replies top-level with reply mode off", async () => {
    const account = createAccount({ replyToMode: "off" });
    const payload = Object.freeze({ text: "top-level reply", replyToId: SOURCE });
    const core = createCore({
      run: async (delivery) => {
        await delivery.deliver(payload);
        expect(delivery.durable(payload, { kind: "final" })).toEqual({
          to: SPACE,
          replyToId: null,
        });
      },
    });
    apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: TYPING,
      threadName: `${SPACE}/threads/typing`,
    });
    await processEvent({ account, core });
    expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: TYPING,
      text: payload.text,
    });
    expect(apiMocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledOnce();
  });

  it("keeps the typing thread when automatic delivery supplies the source message name", async () => {
    const deliveredThread = `${SPACE}/threads/fallback`;
    const account = createAccount({ replyToMode: "all" });
    const core = createCore({
      chunks: ["first chunk", "second chunk"],
      run: async (delivery) => {
        await delivery.deliver(Object.freeze({ text: "two chunks", replyToId: SOURCE }));
      },
    });
    vi.mocked(core.channel.text.resolveChunkMode).mockReturnValue("newline");
    apiMocks.sendGoogleChatMessage
      .mockResolvedValueOnce({ messageName: TYPING, threadName: deliveredThread })
      .mockResolvedValueOnce({
        messageName: `${SPACE}/messages/second`,
        threadName: deliveredThread,
      });
    await processEvent({ account, core });
    expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: TYPING,
      text: "first chunk",
    });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(1, {
      account,
      space: SPACE,
      text: "_OpenClaw is typing..._",
      thread: THREAD,
    });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(2, {
      account,
      space: SPACE,
      text: "second chunk",
      thread: deliveredThread,
    });
  });

  it.each<{
    label: string;
    event?: GoogleChatEvent;
    thread?: string;
    failTyping?: boolean;
  }>([
    { label: "threaded after typing fails", thread: THREAD, failTyping: true },
    { label: "unknown source message", event: createEvent({ messageName: null }), thread: SOURCE },
    { label: "direct message", event: createEvent({ spaceType: "DIRECT_MESSAGE" }) },
  ])("reconciles delivery and durable metadata: $label", async ({ event, thread, failTyping }) => {
    const account = createAccount({
      replyToMode: "all",
      typingIndicator: failTyping ? "message" : "none",
    });
    const core = createCore({
      run: async (delivery) => {
        const payload = Object.freeze({ text: "reply", replyToId: SOURCE });
        expect(delivery.durable(payload, { kind: "final" })).toEqual(
          thread
            ? { to: SPACE, replyToId: thread, threadId: thread }
            : { to: SPACE, replyToId: null },
        );
        await delivery.deliver(payload);
      },
    });
    const runtime = { error: vi.fn(), log: vi.fn() };
    if (failTyping) {
      apiMocks.sendGoogleChatMessage.mockRejectedValueOnce(new Error("typing unavailable"));
    }
    apiMocks.sendGoogleChatMessage.mockResolvedValue({
      messageName: `${SPACE}/messages/reply`,
      threadName: thread,
    });
    await processEvent({ account, core, event, runtime });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledTimes(failTyping ? 2 : 1);
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenLastCalledWith({
      account,
      space: SPACE,
      text: "reply",
      thread,
    });
    expect(apiMocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
    if (failTyping) {
      expect(runtime.error).toHaveBeenCalledWith(
        "Failed sending typing message: Error: typing unavailable",
      );
    }
  });
});
