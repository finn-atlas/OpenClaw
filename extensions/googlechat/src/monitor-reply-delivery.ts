import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { sendGoogleChatMessage } from "./api.js";
import { formatGoogleChatTextChunks } from "./format.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";

export type GoogleChatTypingMessage = ReturnType<typeof createGoogleChatTypingMessage>;

export function createGoogleChatTypingMessage(params: {
  messageName: string;
  requestedThreadName?: string;
  deliveredThreadName?: string;
}) {
  const name = params.messageName.trim();
  const requestedThreadName = params.requestedThreadName?.trim();
  if (!requestedThreadName) {
    return { placement: "top-level" as const, name };
  }
  return {
    placement: "thread" as const,
    name,
    requestedThreadName,
    deliveredThreadName: params.deliveredThreadName?.trim() || requestedThreadName,
  };
}

export async function deliverGoogleChatReply(params: {
  payload: ReplyPayload;
  account: ResolvedGoogleChatAccount;
  spaceId: string;
  runtime: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  config: OpenClawConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  typingMessage?: GoogleChatTypingMessage;
  onTextDelivered?: (messageName: string) => void;
}): Promise<void> {
  const { payload, account, spaceId, runtime, core, config, statusSink } = params;
  const typingMessage = params.typingMessage;
  const replyThreadName = payload.replyToId?.trim() || undefined;
  const reply = resolveSendableOutboundReplyParts(payload);
  let deliveryThreadName = replyThreadName;
  const acceptedText: Array<{ id?: string; text: string }> = [];
  const runTextOperation = async <T>(operation: Promise<T>): Promise<T> =>
    await operation.catch((error: unknown) => {
      if (acceptedText.length === 0) {
        throw error;
      }
      throw createChannelPartialDeliveryError(error, {
        messageIds: acceptedText.flatMap(({ id }) => (id ? [id] : [])),
        content: acceptedText.map(({ text }) => text).join("\n"),
        visibleReplySent: true,
      });
    });

  const typingMatchesReply =
    typingMessage?.placement === "thread"
      ? typingMessage.requestedThreadName === replyThreadName
      : typingMessage?.placement === "top-level"
        ? replyThreadName === undefined
        : false;
  if (typingMatchesReply && typingMessage?.placement === "thread") {
    deliveryThreadName = typingMessage.deliveredThreadName;
  }

  if (reply.hasMedia) {
    runtime.error?.(
      "Google Chat outbound attachments require user OAuth and are not supported by this service-account channel; sending text fallback only.",
    );
  }

  const chunkLimit = account.config.textChunkLimit ?? 4000;
  const chunkMode = core.channel.text.resolveChunkMode(config, "googlechat", account.accountId);
  const chunks = formatGoogleChatTextChunks(reply.text, chunkLimit).flatMap((chunk) =>
    core.channel.text.chunkMarkdownTextWithMode(chunk, chunkLimit, chunkMode),
  );
  const rejection =
    reply.hasMedia && !reply.hasText
      ? "Google Chat outbound attachments require user OAuth and no text fallback is available."
      : reply.hasText && !chunks.some((chunk) => chunk)
        ? "Google Chat reply has no visible text after formatting."
        : undefined;
  if (rejection) {
    // Permanent policy rejection before any recipient-visible send; the typed
    // contract keeps delivery custody from recording a false ambiguous attempt.
    throw new PlatformMessageNotDispatchedError(rejection, { cause: undefined, retryable: false });
  }

  const recordOutboundStatus = () => {
    try {
      statusSink?.({ lastOutboundAt: Date.now() });
    } catch (err) {
      runtime.error?.(`Google Chat outbound status update failed: ${String(err)}`);
    }
  };
  const sendTextMessage = async (chunk: string) => {
    const sent = await runTextOperation(
      sendGoogleChatMessage({
        account,
        space: spaceId,
        text: chunk,
        thread: deliveryThreadName,
      }),
    );
    if (sent) {
      const id = sent.messageName?.trim() || undefined;
      acceptedText.push({ id, text: chunk });
      if (id) {
        params.onTextDelivered?.(id);
      }
    }
    if (replyThreadName) {
      deliveryThreadName = sent?.threadName?.trim() || deliveryThreadName;
    }
  };
  for (const chunk of chunks) {
    if (!chunk) {
      continue;
    }
    await sendTextMessage(chunk);
    recordOutboundStatus();
  }
}
