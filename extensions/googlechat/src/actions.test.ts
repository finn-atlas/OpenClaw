import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const inspectGoogleChatAccount = vi.hoisted(() => vi.fn());
const listGoogleChatAccountIds = vi.hoisted(() => vi.fn());
const resolveGoogleChatAccount = vi.hoisted(() => vi.fn());
const sendGoogleChatMessage = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpace = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  inspectGoogleChatAccount,
  listGoogleChatAccountIds,
  resolveGoogleChatAccount,
}));

vi.mock("./api.js", () => ({
  sendGoogleChatMessage,
}));

vi.mock("./targets.js", () => ({
  resolveGoogleChatOutboundSpace,
}));

let googlechatMessageActions: typeof import("./message-tool-api.js").googlechatMessageActions;

describe("googlechat message actions", () => {
  beforeAll(async () => {
    ({ googlechatMessageActions } = await import("./message-tool-api.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./api.js");
    vi.doUnmock("./targets.js");
    vi.resetModules();
  });

  function buildAccount() {
    return {
      accountId: "default",
      enabled: true,
      credentialSource: "service-account",
      config: { groupPolicy: "open", dmPolicy: "open" },
    };
  }

  function expectJsonResult(result: unknown, details: Record<string, unknown>) {
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(details, null, 2),
        },
      ],
      details,
    });
  }

  it("describes only send actions when enabled accounts exist", () => {
    listGoogleChatAccountIds.mockReturnValueOnce([]);
    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toBeNull();

    listGoogleChatAccountIds.mockReturnValueOnce(["default"]);
    inspectGoogleChatAccount.mockReturnValueOnce({
      enabled: true,
      credentialSource: "inline",
      tokenStatus: "available",
      config: {},
    });

    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toEqual({
      actions: ["send"],
    });
    expect(googlechatMessageActions.supportsAction?.({ action: "send" })).toBe(true);
    expect(googlechatMessageActions.supportsAction?.({ action: "upload-file" })).toBe(false);
  });

  it("keeps account-scoped discovery send-only", () => {
    inspectGoogleChatAccount.mockImplementation(
      ({ accountId: _accountId }: { accountId?: string | null }) => ({
        enabled: true,
        credentialSource: "inline",
        tokenStatus: "available",
        config: {},
      }),
    );

    for (const accountId of ["default", "work"]) {
      expect(
        googlechatMessageActions.describeMessageTool?.({ cfg: {} as never, accountId }),
      ).toEqual({
        actions: ["send"],
      });
    }
  });

  it("sends text through the resolved space", async () => {
    const account = buildAccount();
    resolveGoogleChatAccount.mockReturnValue(account);
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
    sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
      threadName: "spaces/AAA/threads/thread-1",
    });

    const result = await googlechatMessageActions.handleAction({
      action: "send",
      params: {
        to: "spaces/AAA",
        message: "caption",
        threadId: "thread-1",
      },
      cfg: {},
      accountId: "default",
    } as never);

    expect(resolveGoogleChatOutboundSpace).toHaveBeenCalledWith({
      account,
      target: "spaces/AAA",
    });
    expect(sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "caption",
      thread: "thread-1",
    });
    expectJsonResult(result, {
      ok: true,
      to: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      threadName: "spaces/AAA/threads/thread-1",
    });
  });

  it("renders message-tool Markdown for Google Chat before sending", async () => {
    const account = buildAccount();
    resolveGoogleChatAccount.mockReturnValue(account);
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
    sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/msg-1" });

    await googlechatMessageActions.handleAction({
      action: "send",
      params: {
        to: "spaces/AAA",
        message: "**Completed ✅**\n\nThe [GitHub UAM item](https://example.com/uam) is updated.",
        threadId: "spaces/AAA/threads/source",
      },
      cfg: {},
      accountId: "default",
    } as never);

    expect(sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "*Completed ✅*\n\nThe <https://example.com/uam|GitHub UAM item> is updated.",
      thread: "spaces/AAA/threads/source",
    });
  });

  it("keeps long message-tool sends in the first Google Chat thread", async () => {
    resolveGoogleChatAccount.mockReturnValue(buildAccount());
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
    sendGoogleChatMessage
      .mockResolvedValueOnce({
        messageName: "spaces/AAA/messages/msg-1",
        threadName: "spaces/AAA/threads/new-thread",
      })
      .mockResolvedValueOnce({
        messageName: "spaces/AAA/messages/msg-2",
        threadName: "spaces/AAA/threads/new-thread",
      });

    await googlechatMessageActions.handleAction({
      action: "send",
      params: { to: "spaces/AAA", message: "x".repeat(33_000) },
      cfg: {},
      accountId: "default",
    } as never);

    expect(sendGoogleChatMessage).toHaveBeenCalledTimes(2);
    expect(sendGoogleChatMessage.mock.calls[0]?.[0].thread).toBeUndefined();
    expect(sendGoogleChatMessage.mock.calls[1]?.[0].thread).toBe("spaces/AAA/threads/new-thread");
  });

  it("reports the accepted prefix when a later message chunk fails", async () => {
    resolveGoogleChatAccount.mockReturnValue(buildAccount());
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
    sendGoogleChatMessage
      .mockResolvedValueOnce({
        messageName: "spaces/AAA/messages/msg-1",
        threadName: "spaces/AAA/threads/new-thread",
      })
      .mockRejectedValueOnce(new Error("second chunk failed"));

    const error = await googlechatMessageActions
      .handleAction({
        action: "send",
        params: { to: "spaces/AAA", message: "x".repeat(33_000) },
        cfg: {},
        accountId: "default",
      } as never)
      .catch((failure: unknown) => failure);

    expect(isChannelPartialDeliveryError(error)).toBe(true);
    if (!isChannelPartialDeliveryError(error)) {
      throw new Error("expected partial delivery error");
    }
    expect(error.deliveryResult).toEqual({
      messageIds: ["spaces/AAA/messages/msg-1"],
      content: sendGoogleChatMessage.mock.calls[0]?.[0].text,
      visibleReplySent: true,
    });
    expect(sendGoogleChatMessage).toHaveBeenCalledTimes(2);
  });

  it.each([
    { action: "send", params: { to: "spaces/AAA", message: "caption", media: "remote.png" } },
    {
      action: "send",
      params: { to: "spaces/AAA", message: "caption", mediaUrls: ["remote.png"] },
    },
    {
      action: "send",
      params: {
        to: "spaces/AAA",
        message: "caption",
        attachments: [{ url: "remote.png" }],
      },
    },
  ])(
    "rejects outbound attachment action $action before provider access",
    async ({ action, params }) => {
      await expect(
        googlechatMessageActions.handleAction({
          action,
          params,
          cfg: {},
          accountId: "default",
        } as never),
      ).rejects.toThrow(
        "Google Chat outbound attachments require user OAuth and are not supported by this service-account channel.",
      );

      expect(resolveGoogleChatAccount).not.toHaveBeenCalled();
      expect(resolveGoogleChatOutboundSpace).not.toHaveBeenCalled();
      expect(sendGoogleChatMessage).not.toHaveBeenCalled();
    },
  );

  it("rejects unsupported actions without provider access", async () => {
    const action = "react";
    resolveGoogleChatAccount.mockReturnValue(buildAccount());

    await expect(
      googlechatMessageActions.handleAction({
        action,
        params: { messageId: "spaces/AAA/messages/msg-1", emoji: "👍" },
        cfg: {},
        accountId: "default",
      } as never),
    ).rejects.toThrow(`Action ${action} is not supported for provider googlechat.`);

    expect(sendGoogleChatMessage).not.toHaveBeenCalled();
  });
});
