# Jai Work Google Chat overlay

This deployment branch starts at upstream OpenClaw `05c947cc5d` (`2026.9.7`). It keeps two independent Google Chat backports for the Mac Mini `jai-work` gateway. It does not include the separate VOC threading, message-tool formatting, or per-thread session layers documented on `maintain/googlechat-patch-stack-2026-10-17`.

| Layer | Source                                                                                 | Behavior                                                                                                                                                                                                                                                                                          |
| ----- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Adapted from `6d8c40f48e`                                                              | Edit the Google Chat typing placeholder with queued and tool activity, suppress routine commentary delivery, replace the placeholder with the first normal answer, and remove an unused placeholder after the turn settles. Deferred followups retain the placeholder until their own settlement. |
| 2     | Upstream `d593d284e5` ([PR #141752](https://github.com/openclaw/openclaw/pull/141752)) | Render normal conversational replies through the Google Chat formatter before sending or editing the placeholder. This converts CommonMark bold and links to Chat's native syntax and rejects a rendered-empty reply before dispatch.                                                             |

The status layer activates when `channels.googlechat.typingIndicator` is `message` and `messages.statusReactions.enabled` is `true`. Both layers change no configuration or session schema. An explicit `message(action=send)` is still a separate visible message; only ordinary automatic replies claim the placeholder.

To roll back the gateway, restore the previous `~/openclaw` symlink target and restart it after active turns finish. Keep `~/.openclaw` and agent session stores in place. Before deployment, validate this pinned branch with the Google Chat monitor and reply-delivery tests, extension type checks, and a runtime build. After deployment, verify a real inbound Google Chat turn.

## Standard runtime deployment

Use the checkout's pinned package manager and lockfile as the runtime user. From the candidate checkout, run `pnpm install --frozen-lockfile` for the entire workspace, then the normal build. Do not copy `node_modules` or construct extension dependency links manually. The workspace includes `extensions/*`, so pnpm owns Codex and every other extension's dependency graph.

Before switching the stable `~/openclaw` symlink, require the install and build to succeed and run `extensions/codex/node_modules/@openai/codex/bin/codex.js --version` from the candidate. Keep the same stable launcher path and the repository-pinned stock `@openai/codex` version; no global Codex installation or custom Codex fork is needed.

After switching, require a successful isolated `gateway call agent --expect-final` turn using the configured harness, with external delivery disabled, then verify the next natural Chat reply. Gateway readiness and channel probes alone do not establish model readiness. Retain the previous checkout until validation passes.
