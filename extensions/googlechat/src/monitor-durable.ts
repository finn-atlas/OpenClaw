import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";

export function resolveGoogleChatDurableReplyOptions(params: {
  payload: ReplyPayload;
  infoKind: string;
  spaceId: string;
}) {
  if (params.infoKind !== "final") {
    return false;
  }
  const threadId = params.payload.replyToId?.trim() || undefined;
  if (!threadId) {
    return { to: params.spaceId, replyToId: null };
  }
  return {
    to: params.spaceId,
    replyToId: threadId,
    threadId,
  };
}
