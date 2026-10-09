import { createStatusReactionController } from "openclaw/plugin-sdk/channel-feedback";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { updateGoogleChatMessage } from "./api.js";

const LABELS: Record<string, string> = {
  "👀": "Received",
  "🧠": "Thinking…",
  "🛠️": "Running a tool…",
  "💻": "Working on code…",
  "🌐": "Accessing the web…",
  "🛫": "Deploying…",
  "🏗️": "Building…",
  "💁": "Using the browser…",
  "🗜️": "Organizing context…",
  "⏳": "Still working…",
  "🗺️": "Updating the plan…",
  "📖": "Reading a file…",
  "✍️": "Writing a file…",
  "📝": "Editing a file…",
  "🩹": "Applying code changes…",
  "🔎": "Searching…",
  "📄": "Fetching a web page…",
  "🧰": "Managing tools…",
  "⌨️": "Using the terminal…",
  "🖱️": "Using the computer…",
  "📱": "Using a device…",
  "🖥️": "Working with the screen…",
  "🖼️": "Working with images…",
  "📋": "Updating the dashboard…",
  "📎": "Attaching a file…",
  "⏰": "Managing scheduled tasks…",
  "🎯": "Updating the goal…",
  "❓": "Preparing a question…",
  "🔑": "Accessing credentials…",
  "✨": "Suggesting a task…",
  "🗑️": "Dismissing a task…",
  "🦀": "Managing OpenClaw…",
  "🔌": "Managing the gateway…",
  "🧩": "Using a tool…",
  "📊": "Checking session status…",
  "🔀": "Publishing to GitHub…",
  "🔐": "Checking GitHub access…",
  "🗂️": "Managing sessions…",
  "💬": "Checking conversations…",
  "📨": "Sending a message…",
  "↔️": "Working with another conversation…",
  "🧾": "Processing results…",
  "🎙️": "Working with transcripts…",
  "🧑‍🔧": "Delegating work…",
  "🤖": "Coordinating agents…",
  "🧭": "Finding agents…",
  "📓": "Reading memory…",
  "🧮": "Running code…",
  "✉️": "Working with messages…",
  "🎨": "Generating images…",
  "🎵": "Generating music…",
  "🎬": "Generating video…",
  "📑": "Reading a PDF…",
  "⏸️": "Waiting…",
  "🔊": "Generating speech…",
};

/** Updates an existing typing placeholder; final-answer delivery owns its lifetime. */
export async function createGoogleChatStatusMessage(params: {
  account: ResolvedGoogleChatAccount;
  messageName: string;
  onError: (error: unknown) => void;
}) {
  let closed = false;
  const controller = createStatusReactionController({
    enabled: true,
    initialEmoji: "👀",
    presentation: "activity",
    // Silence between lifecycle events does not mean the run has failed.
    emojis: { stallSoft: "⏳", stallHard: "⏳" },
    adapter: {
      setReaction: async (emoji) => {
        if (closed) {
          return;
        }
        await updateGoogleChatMessage({
          account: params.account,
          messageName: params.messageName,
          text: `${emoji} ${LABELS[emoji] ?? "Working…"}`,
        });
      },
    },
    onError: params.onError,
  });
  await controller.setQueued();
  return {
    controller,
    // clear() cancels timers and drains the controller's serialized writes.
    // Do not delete here: delivery can reuse this message for the final answer.
    stop: async () => {
      closed = true;
      await controller.clear();
    },
  };
}
