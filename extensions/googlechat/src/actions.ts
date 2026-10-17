import {
  jsonResult,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGoogleChatAccount } from "./accounts.js";
import { sendGoogleChatMessage } from "./api.js";
import { formatGoogleChatTextChunks } from "./format.js";
import { resolveGoogleChatOutboundSpace } from "./targets.js";

const OUTBOUND_MEDIA_KEYS = ["media", "mediaUrl", "path", "filePath", "fileUrl"] as const;
const STRUCTURED_ATTACHMENT_MEDIA_KEYS = [...OUTBOUND_MEDIA_KEYS, "url"] as const;

function hasGoogleChatOutboundAttachment(params: Record<string, unknown>): boolean {
  if (OUTBOUND_MEDIA_KEYS.some((key) => readStringParam(params, key) !== undefined)) {
    return true;
  }
  if (readStringArrayParam(params, "mediaUrls") !== undefined) {
    return true;
  }
  if (!Array.isArray(params.attachments)) {
    return false;
  }
  return params.attachments.some(
    (attachment) =>
      isRecord(attachment) &&
      STRUCTURED_ATTACHMENT_MEDIA_KEYS.some(
        (key) => readStringParam(attachment, key) !== undefined,
      ),
  );
}

export async function handleGoogleChatAction({
  action,
  params,
  cfg,
  accountId,
  assertDirectAdapterHandoff,
  onPlatformSendDispatch,
}: ChannelMessageActionContext) {
  if (action === "upload-file" || (action === "send" && hasGoogleChatOutboundAttachment(params))) {
    throw new Error(
      "Google Chat outbound attachments require user OAuth and are not supported by this service-account channel.",
    );
  }

  const account = resolveGoogleChatAccount({
    cfg,
    accountId,
  });
  if (account.credentialSource === "none" || account.tokenStatus === "configured_unavailable") {
    throw new Error("Google Chat credentials are missing.");
  }

  if (action === "send") {
    const to = readStringParam(params, "to", { required: true });
    const content = readStringParam(params, "message", {
      required: true,
      allowEmpty: true,
    });
    const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
    const space = await resolveGoogleChatOutboundSpace({
      account,
      target: to,
      assertDirectAdapterHandoff,
    });

    const chunks = formatGoogleChatTextChunks(content);
    let thread = threadId ?? undefined;
    let sent: Awaited<ReturnType<typeof sendGoogleChatMessage>> = null;
    const acceptedText: Array<{ id?: string; text: string }> = [];
    for (const text of chunks.length > 0 ? chunks : [""]) {
      try {
        sent = await sendGoogleChatMessage({
          account,
          space,
          text,
          thread,
          assertDirectAdapterHandoff,
          onPlatformSendDispatch,
        });
      } catch (error) {
        if (acceptedText.length === 0) {
          throw error;
        }
        throw createChannelPartialDeliveryError(error, {
          messageIds: acceptedText.flatMap(({ id }) => (id ? [id] : [])),
          content: acceptedText.map(({ text: delivered }) => delivered).join("\n"),
          visibleReplySent: true,
        });
      }
      acceptedText.push({ id: sent?.messageName, text });
      thread = sent?.threadName ?? thread;
    }
    return jsonResult({ ok: true, to: space, ...sent });
  }

  throw new Error(`Action ${action} is not supported for provider googlechat.`);
}
