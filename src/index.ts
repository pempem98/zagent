import { createHubFromEnv } from "./channels/hub.js";
import type { IncomingMessage } from "./channels/types.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on the real environment.
}

const hub = createHubFromEnv();

/** Placeholder brain: swap this for the Gemini + knowledge-base agent. */
async function answer(message: IncomingMessage): Promise<string> {
  return `[${message.channel}] Bạn vừa nói: ${message.text}`;
}

await hub.start(async (message) => {
  if (!message.addressed || message.kind !== "text" || !message.text.trim()) return;
  console.log(`[${message.channel}] ${message.senderName || message.senderId}: ${message.text}`);
  await hub.typing(message);
  await hub.reply(message, await answer(message));
});

console.log(`Zalo hub running on: ${hub.ids.join(", ")}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void hub.stop().then(() => process.exit(0)));
}
