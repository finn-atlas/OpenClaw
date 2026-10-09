// Googlechat tests cover monitor.reply delivery plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { GoogleChatApiError } from "./api.js";
import { createGoogleChatTypingMessage, deliverGoogleChatReply } from "./monitor-reply-delivery.js";
import type { GoogleChatCoreRuntime } from "./monitor-types.js";

const mocks = vi.hoisted(() => ({
  deleteGoogleChatMessage: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
  updateGoogleChatMessage: vi.fn(),
}));

vi.mock("./api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api.js")>()),
  deleteGoogleChatMessage: mocks.deleteGoogleChatMessage,
  sendGoogleChatMessage: mocks.sendGoogleChatMessage,
  updateGoogleChatMessage: mocks.updateGoogleChatMessage,
}));

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  config: {},
} as ResolvedGoogleChatAccount;

const config = {} as OpenClawConfig;

function createCore(params?: { chunks?: readonly string[] }) {
  return {
    channel: {
      text: {
        resolveChunkMode: vi.fn(() => (params?.chunks ? "newline" : "length")),
        chunkMarkdownTextWithMode: vi.fn((text: string) => params?.chunks ?? [text]),
      },
      media: {
        readRemoteMediaBuffer: vi.fn(async () => ({ buffer: Buffer.from("image") })),
      },
    },
  } as unknown as GoogleChatCoreRuntime;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendGoogleChatMessage.mockResolvedValue(null);
  mocks.updateGoogleChatMessage.mockResolvedValue({});
});

afterAll(() => {
  vi.doUnmock("./api.js");
  vi.resetModules();
});

describe("Google Chat reply delivery", () => {
  it.each(["send", "typing update", "missing typing fallback"])(
    "renders Markdown in the Google Chat dialect for %s",
    async (delivery) => {
      if (delivery === "missing typing fallback") {
        mocks.updateGoogleChatMessage.mockRejectedValueOnce(
          new GoogleChatApiError(404, "Google Chat API 404: message not found"),
        );
      }
      const thread = "spaces/AAA/threads/root";
      await deliverGoogleChatReply({
        payload: {
          text: "**Status:** [Launch plan](https://example.com/plan)\n\n- **Ready:** `GB`\n- *Pending*",
          replyToId: thread,
        },
        account,
        spaceId: "spaces/AAA",
        runtime: createRuntimeSpies(),
        core: createCore(),
        config,
        typingMessage:
          delivery === "send"
            ? undefined
            : createGoogleChatTypingMessage({
                messageName: "spaces/AAA/messages/typing",
                requestedThreadName: thread,
              }),
      });

      const text =
        "*Status:* <https://example.com/plan|Launch plan>\n\n* *Ready:* `GB`\n* _Pending_";
      if (delivery !== "send") {
        expect(mocks.updateGoogleChatMessage).toHaveBeenCalledWith({
          account,
          messageName: "spaces/AAA/messages/typing",
          text,
        });
      }
      if (delivery !== "typing update") {
        expect(mocks.sendGoogleChatMessage).toHaveBeenCalledExactlyOnceWith({
          account,
          space: "spaces/AAA",
          thread,
          text,
        });
      } else {
        expect(mocks.sendGoogleChatMessage).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["界", "a"])(
    "keeps long %s bold spans formatted within the byte limit",
    async (letter) => {
      await deliverGoogleChatReply({
        payload: { text: `**${letter.repeat(140)}**`, replyToId: "spaces/AAA/threads/root" },
        account: { ...account, config: { textChunkLimit: 64 } },
        spaceId: "spaces/AAA",
        runtime: createRuntimeSpies(),
        core: createCore(),
        config,
      });

      const chunks = mocks.sendGoogleChatMessage.mock.calls.map(
        ([params]) => params.text as string,
      );
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 64)).toBe(true);
      expect(chunks.every((chunk) => /^\*[界a]+\*$/u.test(chunk))).toBe(true);
      expect(chunks.map((chunk) => chunk.slice(1, -1)).join("")).toBe(letter.repeat(140));
    },
  );

  it("formats newline chunks once and preserves code literals", async () => {
    const core = createCore({ chunks: ["**ready**", "`**literal**`"] });
    await deliverGoogleChatReply({
      payload: { text: "**ready**\n\n`**literal**`", replyToId: "spaces/AAA/threads/root" },
      account,
      spaceId: "spaces/AAA",
      runtime: createRuntimeSpies(),
      core,
      config,
    });

    expect(core.channel.text.chunkMarkdownTextWithMode).toHaveBeenCalledWith(
      "**ready**\n\n`**literal**`",
      4000,
      "newline",
    );
    expect(mocks.sendGoogleChatMessage.mock.calls.map(([params]) => params.text)).toEqual([
      "*ready*",
      "`**literal**`",
    ]);
  });

  it("does not resend the first chunk when the typing update result is ambiguous", async () => {
    const core = createCore({ chunks: ["first chunk", "second chunk"] });
    const runtime = createRuntimeSpies();
    const statusSink = vi.fn();
    const updateError = new Error("response lost");
    mocks.updateGoogleChatMessage.mockRejectedValueOnce(updateError);

    await expect(
      deliverGoogleChatReply({
        payload: { text: "first chunk\n\nsecond chunk", replyToId: "spaces/AAA/threads/root" },
        account,
        spaceId: "spaces/AAA",
        runtime,
        core,
        config,
        statusSink,
        typingMessage: {
          placement: "thread",
          name: "spaces/AAA/messages/typing",
          requestedThreadName: "spaces/AAA/threads/root",
          deliveredThreadName: "spaces/AAA/threads/root",
        },
      }),
    ).rejects.toBe(updateError);

    expect(mocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/typing",
      text: "first chunk",
    });
    expect(mocks.sendGoogleChatMessage).not.toHaveBeenCalled();
    expect(statusSink).not.toHaveBeenCalled();
  });

  it.each([
    ["provider fallback", "spaces/AAA/threads/fallback", "spaces/AAA/threads/fallback"],
    ["requested when metadata is omitted", undefined, "spaces/AAA/threads/requested"],
  ])("continues later chunks in the %s thread", async (_name, threadName, expectedThread) => {
    const core = createCore({ chunks: ["first chunk", "second chunk"] });
    const runtime = createRuntimeSpies();
    mocks.sendGoogleChatMessage
      .mockResolvedValueOnce({
        messageName: "spaces/AAA/messages/first",
        threadName,
      })
      .mockResolvedValueOnce({
        messageName: "spaces/AAA/messages/second",
        threadName,
      });

    await deliverGoogleChatReply({
      payload: { text: "two chunks", replyToId: "spaces/AAA/threads/requested" },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
    });

    expect(mocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(1, {
      account,
      space: "spaces/AAA",
      text: "first chunk",
      thread: "spaces/AAA/threads/requested",
    });
    expect(mocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(2, {
      account,
      space: "spaces/AAA",
      text: "second chunk",
      thread: expectedThread,
    });
  });

  it("replaces the typing message for a valid explicit thread target", async () => {
    const core = createCore();
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/reply" });

    await deliverGoogleChatReply({
      payload: {
        text: "retargeted reply",
        replyToId: "spaces/AAA/threads/other",
      },
      account,
      spaceId: "spaces/AAA",
      runtime: createRuntimeSpies(),
      core,
      config,
      typingMessage: createGoogleChatTypingMessage({
        messageName: "spaces/AAA/messages/typing",
        requestedThreadName: "spaces/AAA/threads/root",
        deliveredThreadName: "spaces/AAA/threads/root",
      }),
    });

    expect(mocks.deleteGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/typing",
    });
    expect(mocks.updateGoogleChatMessage).not.toHaveBeenCalled();
    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "retargeted reply",
      thread: "spaces/AAA/threads/other",
    });
  });

  it("cleans up typing and rejects media-only replies without provider upload access", async () => {
    const core = createCore();
    const runtime = createRuntimeSpies();

    await expect(
      deliverGoogleChatReply({
        payload: {
          mediaUrl: "https://example.invalid/reply.png",
          replyToId: "spaces/AAA/threads/root",
        },
        account,
        spaceId: "spaces/AAA",
        runtime,
        core,
        config,
        typingMessage: {
          placement: "thread",
          name: "spaces/AAA/messages/typing",
          requestedThreadName: "spaces/AAA/threads/root",
          deliveredThreadName: "spaces/AAA/threads/root",
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PlatformMessageNotDispatchedError &&
        !error.retryable &&
        error.message ===
          "Google Chat outbound attachments require user OAuth and no text fallback is available.",
    );

    expect(mocks.deleteGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/typing",
    });
    expect(core.channel.media.readRemoteMediaBuffer).not.toHaveBeenCalled();
    expect(mocks.updateGoogleChatMessage).not.toHaveBeenCalled();
    expect(mocks.sendGoogleChatMessage).not.toHaveBeenCalled();
  });
});
