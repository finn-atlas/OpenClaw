import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";

/** Resolve Google Chat's thread resource after core supplies the inbound message as its target. */
export function resolveGoogleChatReplyThread(params: {
  payload: ReplyPayload;
  sourceMessageName?: string;
  replyThreadName?: string;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasThreadedReply: boolean;
}): string | undefined {
  const explicitTarget = params.payload.replyToId?.trim();
  if (explicitTarget && explicitTarget !== params.sourceMessageName) {
    return explicitTarget;
  }
  if (params.payload.replyToCurrent === false) {
    return undefined;
  }
  const mode = params.replyToMode ?? "off";
  if (mode === "batched") {
    // Core only supplies the source message target for an allowed batched reply.
    return explicitTarget || params.payload.replyToCurrent === true
      ? params.replyThreadName
      : undefined;
  }
  return mode === "all" || (mode === "first" && !params.hasThreadedReply)
    ? params.replyThreadName
    : undefined;
}
