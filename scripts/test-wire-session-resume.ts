import { randomUUID } from "node:crypto";

import { ApprovalDispatcher, rejectAllApprovals } from "../runtime/wire/approval-dispatcher.js";
import { WireClient } from "../runtime/wire/client.js";
import { KIMI_WIRE_PROTOCOL_VERSION } from "../runtime/wire/types.js";

const sessionId = `test-resume-${randomUUID()}`;

async function runTurn(label: string, prompt: string): Promise<string> {
  console.log(`\n=== ${label} (session=${sessionId}) ===`);

  const client = new WireClient({
    cwd: process.cwd(),
    args: ["--wire", "--session", sessionId],
    approvalDispatcher: new ApprovalDispatcher(
      rejectAllApprovals("resume test rejects all approvals"),
    ),
  });

  try {
    await client.start();

    await client.initialize({
      protocol_version: KIMI_WIRE_PROTOCOL_VERSION,
      client: { name: "wire-resume-test", version: "0.0.1" },
      capabilities: { supports_question: false, supports_plan_mode: false },
    });

    const result = await client.prompt(prompt, "ask");
    console.log(`Reply: ${JSON.stringify(result.finalText)}`);
    return result.finalText;
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  await runTurn(
    "Turn 1: plant a memorable fact",
    "Remember this exact phrase: 'the secret word is lavender'. Reply with just the word 'acknowledged'. Do not use tools.",
  );

  await runTurn(
    "Turn 2: probe prior context",
    "What secret word did I tell you to remember in our previous turn? Reply with just the word, no explanation. Do not use tools.",
  );
}

main().catch((error) => {
  console.error("Test failed:", error);
  process.exitCode = 1;
});
