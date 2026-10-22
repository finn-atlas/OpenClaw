// Googlechat tests cover automatic reply target reconciliation at the monitor boundary.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatIngressLifecycle } from "./monitor-ingress.js";
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
    | ((
        event: GoogleChatEvent,
        target: Record<string, unknown>,
        lifecycle?: GoogleChatIngressLifecycle,
      ) => Promise<void>)
    | undefined,
}));

const inboundMocks = vi.hoisted(() => ({
  resolveChannelInboundRouteEnvelope: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  resolveChannelInboundRouteEnvelope: inboundMocks.resolveChannelInboundRouteEnvelope,
}));

vi.mock("./api.js", () => ({
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
      eventProcessor: (
        event: GoogleChatEvent,
        target: Record<string, unknown>,
        lifecycle?: GoogleChatIngressLifecycle,
      ) => Promise<void>,
    ) => {
      routingMocks.processEvent = eventProcessor;
    },
  ),
}));

type GoogleChatTestReplyPayload = {
  text: string;
  replyToId?: string;
  isStatusNotice?: boolean;
  isCommentary?: boolean;
  isCompactionNotice?: boolean;
  isFallbackNotice?: boolean;
};
type GoogleChatTestDelivery = {
  durable: (payload: GoogleChatTestReplyPayload, info: { kind: string }) => unknown;
  deliver: (payload: GoogleChatTestReplyPayload, info?: { kind: string }) => Promise<void>;
  onDelivered: (
    payload: GoogleChatTestReplyPayload,
    info: { kind: string },
    result?: { visibleReplySent?: boolean },
  ) => Promise<void>;
};
type GoogleChatTestTurn = {
  delivery: GoogleChatTestDelivery;
  dispatcherOptions?: { onReplyStart?: () => Promise<void> };
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
  inboundMocks.resolveChannelInboundRouteEnvelope.mockReset().mockReturnValue({
    route: {
      agentId: "agent-1",
      accountId: "work",
      sessionKey: "session-1",
    },
    buildEnvelope: ({ body }: { body: string }) => body,
  });
});

function createCore(params: {
  run: (delivery: GoogleChatTestDelivery, turn: GoogleChatTestTurn) => Promise<void>;
  chunks?: string[];
  result?: unknown;
}) {
  return {
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: {
        buildContext: vi.fn((payload: unknown) => payload),
        run: vi.fn(async (turn: { adapter: { resolveTurn: () => GoogleChatTestTurn } }) => {
          const resolved = turn.adapter.resolveTurn();
          await params.run(resolved.delivery, resolved);
          return params.result;
        }),
      },
      text: {
        resolveChunkMode: vi.fn(() => "markdown"),
        chunkMarkdownTextWithMode: vi.fn((text: string) => params.chunks ?? [text]),
      },
    },
  } as unknown as GoogleChatCoreRuntime;
}

function createEvent(params?: {
  messageName?: string;
  // `null` omits the inbound thread entirely (unthreaded group message); `undefined` uses the default.
  threadName?: string | null;
  spaceType?: string;
}): GoogleChatEvent {
  const threadName =
    params?.threadName === undefined ? "spaces/CLASSIFY/threads/requested" : params.threadName;
  return {
    type: "MESSAGE",
    space: { name: "spaces/CLASSIFY", spaceType: params?.spaceType ?? "SPACE" },
    message: {
      name: params?.messageName ?? "spaces/CLASSIFY/messages/1",
      text: "hello",
      ...(threadName ? { thread: { name: threadName } } : {}),
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
  lifecycle?: GoogleChatIngressLifecycle;
}) {
  if (!routingMocks.processEvent) {
    throw new Error("Expected Google Chat webhook event processor registration");
  }
  await routingMocks.processEvent(
    params.event ?? createEvent(),
    {
      account: params.account,
      config: params.config ?? {},
      runtime: params.runtime ?? { error: vi.fn(), log: vi.fn() },
      core: params.core,
      mediaMaxMb: 10,
      path: "/googlechat",
    },
    params.lifecycle,
  );
}

describe("Google Chat automatic reply target reconciliation", () => {
  it.each([undefined, "off"] as const)(
    "keeps automatic replies top-level with reply mode %s",
    async (replyToMode) => {
      const account = createAccount({ replyToMode });
      const payload = { text: "top-level reply", replyToId: "spaces/CLASSIFY/messages/1" };
      const core = createCore({
        run: async (delivery) => {
          await delivery.deliver(payload);
          expect(delivery.durable(payload, { kind: "final" })).toEqual({
            to: "spaces/CLASSIFY",
            replyToId: null,
          });
        },
      });
      apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
        messageName: "spaces/CLASSIFY/messages/typing",
        threadName: "spaces/CLASSIFY/threads/typing",
      });

      await processEvent({ account, core });

      expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith({
        account,
        messageName: "spaces/CLASSIFY/messages/typing",
        text: "top-level reply",
      });
      expect(apiMocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
      expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, "off"] as const)(
    "keeps automatic replies top-level without typing with reply mode %s",
    async (replyToMode) => {
      const account = createAccount({ replyToMode, typingIndicator: "none" });
      const core = createCore({
        run: async (delivery) => {
          const payload = { text: "top-level reply", replyToId: "spaces/CLASSIFY/messages/1" };
          expect(delivery.durable(payload, { kind: "final" })).toEqual({
            to: "spaces/CLASSIFY",
            replyToId: null,
          });
          await delivery.deliver(payload);
        },
      });

      await processEvent({ account, core });

      expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledWith({
        account,
        space: "spaces/CLASSIFY",
        text: "top-level reply",
        thread: undefined,
      });
    },
  );

  it("keeps the typing thread when automatic delivery supplies the source message name", async () => {
    const sourceMessageName = "spaces/CLASSIFY/messages/1";
    const requestedThread = "spaces/CLASSIFY/threads/requested";
    const deliveredThread = "spaces/CLASSIFY/threads/fallback";
    const account = createAccount({ replyToMode: "all" });
    const core = createCore({
      chunks: ["first chunk", "second chunk"],
      run: async (delivery) => {
        await delivery.deliver({ text: "two chunks", replyToId: sourceMessageName });
      },
    });
    apiMocks.sendGoogleChatMessage
      .mockResolvedValueOnce({
        messageName: "spaces/CLASSIFY/messages/typing",
        threadName: deliveredThread,
      })
      .mockResolvedValueOnce({
        messageName: "spaces/CLASSIFY/messages/second",
        threadName: deliveredThread,
      });

    await processEvent({ account, core });

    expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/CLASSIFY/messages/typing",
      text: "first chunk",
    });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(2, {
      account,
      space: "spaces/CLASSIFY",
      text: "second chunk",
      thread: deliveredThread,
    });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(1, {
      account,
      space: "spaces/CLASSIFY",
      text: "_OpenClaw is typing..._",
      thread: requestedThread,
    });
  });

  it("shows queued status in the typing message and removes it after a silent turn", async () => {
    const account = createAccount({ replyToMode: "all" });
    const core = createCore({ run: async () => {} });
    apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: "spaces/CLASSIFY/messages/typing",
      threadName: "spaces/CLASSIFY/threads/requested",
    });

    await processEvent({
      account,
      core,
      config: { messages: { statusReactions: { enabled: true } } },
    });

    expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/CLASSIFY/messages/typing",
      text: "👀 Received",
    });
    expect(apiMocks.deleteGoogleChatMessage).toHaveBeenCalledExactlyOnceWith({
      account,
      messageName: "spaces/CLASSIFY/messages/typing",
    });
  });

  it("moves a normal turn from received to thinking through dispatcher options", async () => {
    vi.useFakeTimers();
    const account = createAccount({ replyToMode: "all" });
    const core = createCore({
      run: async (_delivery, turn) => {
        expect(turn.dispatcherOptions?.onReplyStart).toBeTypeOf("function");
        await turn.dispatcherOptions?.onReplyStart?.();
        await vi.advanceTimersByTimeAsync(800);
      },
    });
    apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: "spaces/CLASSIFY/messages/typing",
      threadName: "spaces/CLASSIFY/threads/requested",
    });

    try {
      await processEvent({
        account,
        core,
        config: { messages: { statusReactions: { enabled: true } } },
      });

      expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith({
        account,
        messageName: "spaces/CLASSIFY/messages/typing",
        text: "🧠 Thinking…",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["isCompactionNotice", "isFallbackNotice"] as const)(
    "keeps the typing placeholder through an interim %s",
    async (noticeFlag) => {
      const account = createAccount({ replyToMode: "all" });
      const core = createCore({
        run: async (delivery) => {
          await delivery.deliver({
            text: "Interim notice",
            replyToId: "spaces/CLASSIFY/messages/1",
            [noticeFlag]: true,
          });
          await delivery.deliver({
            text: "Final answer",
            replyToId: "spaces/CLASSIFY/messages/1",
          });
        },
      });
      apiMocks.sendGoogleChatMessage
        .mockResolvedValueOnce({
          messageName: "spaces/CLASSIFY/messages/typing",
          threadName: "spaces/CLASSIFY/threads/requested",
        })
        .mockResolvedValueOnce({
          messageName: "spaces/CLASSIFY/messages/notice",
          threadName: "spaces/CLASSIFY/threads/requested",
        });

      await processEvent({ account, core });

      expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledTimes(2);
      expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith({
        account,
        messageName: "spaces/CLASSIFY/messages/typing",
        text: "Final answer",
      });
      expect(apiMocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
    },
  );

  it("removes an unused typing placeholder when the turn ends without a reply", async () => {
    const account = createAccount({ replyToMode: "all" });
    const core = createCore({ run: async () => {} });
    apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: "spaces/CLASSIFY/messages/typing",
      threadName: "spaces/CLASSIFY/threads/requested",
    });

    await processEvent({ account, core });

    expect(apiMocks.deleteGoogleChatMessage).toHaveBeenCalledExactlyOnceWith({
      account,
      messageName: "spaces/CLASSIFY/messages/typing",
    });
  });

  it("keeps a queued turn's typing message until its later reply claims it", async () => {
    const account = createAccount({ replyToMode: "all" });
    const lifecycle = {
      admission: "exclusive",
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
      onSettled: vi.fn(),
    } satisfies GoogleChatIngressLifecycle & { onSettled: () => void };
    let deferredDelivery: GoogleChatTestDelivery | undefined;
    const core = createCore({
      run: async (delivery) => {
        deferredDelivery = delivery;
        lifecycle.onDeferred?.();
      },
      result: { dispatched: true, dispatchResult: { deferredToActiveRun: "followup" } },
    });
    apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: "spaces/CLASSIFY/messages/typing",
      threadName: "spaces/CLASSIFY/threads/requested",
    });

    await processEvent({ account, core, lifecycle });

    expect(apiMocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
    if (!deferredDelivery) {
      throw new Error("Queued Google Chat delivery was not captured");
    }
    await deferredDelivery.deliver({
      text: "queued reply",
      replyToId: "spaces/CLASSIFY/messages/1",
    });
    lifecycle.onSettled?.();

    expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/CLASSIFY/messages/typing",
      text: "queued reply",
    });
    expect(apiMocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
  });

  it("removes a steering placeholder when its lifecycle settles before dispatch returns", async () => {
    const account = createAccount({ replyToMode: "all" });
    const lifecycle = {
      admission: "exclusive",
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
      onSettled: vi.fn(),
    } satisfies GoogleChatIngressLifecycle & { onSettled: () => void };
    const core = createCore({
      run: async () => {
        lifecycle.onSettled();
      },
      result: { dispatched: true, dispatchResult: { deferredToActiveRun: "steer" } },
    });
    apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: "spaces/CLASSIFY/messages/typing",
      threadName: "spaces/CLASSIFY/threads/requested",
    });

    await processEvent({ account, core, lifecycle });

    expect(apiMocks.deleteGoogleChatMessage).toHaveBeenCalledExactlyOnceWith({
      account,
      messageName: "spaces/CLASSIFY/messages/typing",
    });
  });

  it("keeps a requested diagnostic notice after the turn sends a separate answer", async () => {
    const account = createAccount({ replyToMode: "all" });
    const core = createCore({
      run: async (delivery) => {
        await delivery.deliver(
          {
            text: "Diagnostics",
            replyToId: "spaces/CLASSIFY/messages/1",
            isStatusNotice: true,
          },
          { kind: "final" },
        );
      },
      result: { dispatched: true, dispatchResult: { observedReplyDelivery: true } },
    });
    apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: "spaces/CLASSIFY/messages/typing",
      threadName: "spaces/CLASSIFY/threads/requested",
    });

    await processEvent({ account, core });

    expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/CLASSIFY/messages/typing",
      text: "Diagnostics",
    });
    expect(apiMocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
  });

  it("cleans queued tool progress when a later block-streamed answer settles", async () => {
    const account = createAccount({ replyToMode: "all" });
    const lifecycle = {
      admission: "exclusive",
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
      onSettled: vi.fn(),
    } satisfies GoogleChatIngressLifecycle & { onSettled: () => void };
    let deferredDelivery: GoogleChatTestDelivery | undefined;
    const core = createCore({
      run: async (delivery) => {
        deferredDelivery = delivery;
        lifecycle.onDeferred();
      },
      result: { dispatched: true, dispatchResult: { deferredToActiveRun: "followup" } },
    });
    apiMocks.sendGoogleChatMessage
      .mockResolvedValueOnce({
        messageName: "spaces/CLASSIFY/messages/typing",
        threadName: "spaces/CLASSIFY/threads/requested",
      })
      .mockResolvedValueOnce({
        messageName: "spaces/CLASSIFY/messages/answer",
        threadName: "spaces/CLASSIFY/threads/requested",
      });

    await processEvent({ account, core, lifecycle });
    if (!deferredDelivery) {
      throw new Error("Queued Google Chat delivery was not captured");
    }
    const progress = { text: "Working", replyToId: "spaces/CLASSIFY/messages/1" };
    await deferredDelivery.deliver(progress, { kind: "tool" });
    await deferredDelivery.onDelivered(progress, { kind: "tool" });
    const answer = { text: "Done", replyToId: "spaces/CLASSIFY/messages/1" };
    await deferredDelivery.deliver(answer, { kind: "block" });
    await deferredDelivery.onDelivered(answer, { kind: "block" });
    lifecycle.onSettled();

    await vi.waitFor(() =>
      expect(apiMocks.deleteGoogleChatMessage).toHaveBeenCalledExactlyOnceWith({
        account,
        messageName: "spaces/CLASSIFY/messages/typing",
      }),
    );
  });

  it("reconciles delivery and durable metadata without a typing message", async () => {
    const sourceMessageName = "spaces/CLASSIFY/messages/1";
    const replyThreadName = "spaces/CLASSIFY/threads/requested";
    let durableResult: unknown;
    const account = createAccount({ replyToMode: "all", typingIndicator: "none" });
    const core = createCore({
      run: async (delivery) => {
        const payload = { text: "threaded reply", replyToId: sourceMessageName };
        durableResult = delivery.durable(payload, { kind: "final" });
        await delivery.deliver(payload);
      },
    });
    apiMocks.sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/CLASSIFY/messages/reply",
      threadName: replyThreadName,
    });

    await processEvent({ account, core });

    expect(durableResult).toEqual({
      to: "spaces/CLASSIFY",
      replyToId: replyThreadName,
      threadId: replyThreadName,
    });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledOnce();
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/CLASSIFY",
      text: "threaded reply",
      thread: replyThreadName,
    });
  });

  it("reconciles delivery after the typing message fails", async () => {
    const sourceMessageName = "spaces/CLASSIFY/messages/1";
    const replyThreadName = "spaces/CLASSIFY/threads/requested";
    const account = createAccount({ replyToMode: "all" });
    const core = createCore({
      run: async (delivery) => {
        await delivery.deliver({ text: "threaded reply", replyToId: sourceMessageName });
      },
    });
    const runtime = { error: vi.fn(), log: vi.fn() };
    apiMocks.sendGoogleChatMessage
      .mockRejectedValueOnce(new Error("typing unavailable"))
      .mockResolvedValueOnce({
        messageName: "spaces/CLASSIFY/messages/reply",
        threadName: replyThreadName,
      });

    await processEvent({ account, core, runtime });

    expect(runtime.error).toHaveBeenCalledWith(
      "Failed sending typing message: Error: typing unavailable",
    );
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(2, {
      account,
      space: "spaces/CLASSIFY",
      text: "threaded reply",
      thread: replyThreadName,
    });
  });

  it.each([
    ["different message", "spaces/CLASSIFY/messages/other"],
    ["whitespace-decorated message", " spaces/CLASSIFY/messages/1 "],
  ])("does not reinterpret a %s target", async (_name, targetMessageName) => {
    let durableResult: unknown;
    const account = createAccount({ replyToMode: "all", typingIndicator: "none" });
    const core = createCore({
      run: async (delivery) => {
        const payload = { text: "explicit reply", replyToId: targetMessageName };
        durableResult = delivery.durable(payload, { kind: "final" });
        await delivery.deliver(payload);
      },
    });

    await processEvent({ account, core });

    expect(durableResult).toEqual({
      to: "spaces/CLASSIFY",
      replyToId: targetMessageName.trim(),
      threadId: targetMessageName.trim(),
    });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/CLASSIFY",
      text: "explicit reply",
      thread: targetMessageName.trim(),
    });
  });

  it("delivers top-level in a direct message when automatic delivery supplies the source message name", async () => {
    // Regression guard: DMs have no inbound thread, so `replyThreadName` is undefined. The
    // source-message target must collapse to top-level rather than being sent as a message
    // resource (which Google Chat rejects as a thread), and the placeholder must not be deleted.
    const sourceMessageName = "spaces/CLASSIFY/messages/1";
    let durableResult: unknown;
    const account = createAccount({ replyToMode: "all", typingIndicator: "none" });
    const core = createCore({
      run: async (delivery) => {
        const payload = { text: "dm reply", replyToId: sourceMessageName };
        durableResult = delivery.durable(payload, { kind: "final" });
        await delivery.deliver(payload);
      },
    });
    apiMocks.sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/CLASSIFY/messages/reply",
      threadName: undefined,
    });

    await processEvent({ account, core, event: createEvent({ spaceType: "DIRECT_MESSAGE" }) });

    expect(durableResult).toEqual({ to: "spaces/CLASSIFY", replyToId: null });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledOnce();
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/CLASSIFY",
      text: "dm reply",
      thread: undefined,
    });
    expect(apiMocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
  });

  it("delivers top-level in a group space that carries no inbound thread", async () => {
    // Regression guard: a group message can arrive without a thread resource, so
    // `replyThreadName` is undefined here too. The source-message target must still collapse
    // to top-level instead of echoing the message resource back as the thread.
    const sourceMessageName = "spaces/CLASSIFY/messages/1";
    let durableResult: unknown;
    const account = createAccount({ replyToMode: "all", typingIndicator: "none" });
    const core = createCore({
      run: async (delivery) => {
        const payload = { text: "group reply", replyToId: sourceMessageName };
        durableResult = delivery.durable(payload, { kind: "final" });
        await delivery.deliver(payload);
      },
    });
    apiMocks.sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/CLASSIFY/messages/reply",
      threadName: undefined,
    });

    await processEvent({
      account,
      core,
      event: createEvent({ spaceType: "SPACE", threadName: null }),
    });

    expect(durableResult).toEqual({ to: "spaces/CLASSIFY", replyToId: null });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledOnce();
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/CLASSIFY",
      text: "group reply",
      thread: undefined,
    });
    expect(apiMocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
  });
});
