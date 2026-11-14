import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { probeProcessIdentity } from "../../runtime/process-tree.js";
import {
  collectDatabase,
  pairedCalls,
  runLane,
  textContent,
  type LaneContext,
  type Reply,
  type SettledContext,
} from "./swarm-bounded-harness.js";

export const LIFECYCLE_MODES = [
  "nesting-builtin",
  "nesting-custom",
  "timeout-http",
  "timeout-tool",
  "cancel-read",
  "cancel-write",
  "single-timeout-read",
  "single-timeout-write",
  "single-cancel-read",
  "single-cancel-write",
] as const;

export type LifecycleMode = typeof LIFECYCLE_MODES[number];

interface TailEntry {
  time: number;
  pid: number;
  event: string;
}

interface ProcessSnapshot {
  time: number;
  activeResponseCount: number;
  tailEntries: TailEntry[];
  processes: Array<{ pid: number; probe: Awaited<ReturnType<typeof probeProcessIdentity>> }>;
}

interface LifecycleSettlement {
  settledAt: number;
  before: ProcessSnapshot;
  after: ProcessSnapshot;
}

function swarmReply(id: string, items: string[], profile = "coder"): Reply {
  return {
    tool: {
      name: "AgentSwarm",
      id,
      args: {
        description: id,
        subagent_type: profile,
        prompt_template: "WORKER_KEY: {{item}}. Execute the scripted lifecycle control.",
        items,
      },
    },
  };
}

/**
 * Each case runs in an owned subprocess. SIGTERM targets that subprocess after
 * its real runSwarm request has reached the provider, so the command's normal
 * cancellation handler is installed. No test provider is closed until the
 * process and socket observations below have completed.
 */
export async function runLifecycleCase(mode: LifecycleMode): Promise<void> {
  const nested = mode.startsWith("nesting-");
  const single = mode.startsWith("single-");
  const cancel = mode.includes("cancel-");
  const toolTail = mode === "timeout-tool";
  const write = mode.endsWith("-write") || toolTail;
  const timeout = mode.includes("timeout-");
  const cap = single ? 1 : 2;
  const budgetSeconds = timeout ? 14 : 45;
  let rootCalls = 0;
  let signalSent = false;
  let signalTimer: ReturnType<typeof setTimeout> | undefined;
  let tailTimer: ReturnType<typeof setInterval> | undefined;
  let tailPolling = false;
  let laneContext: LaneContext | undefined;
  let settlement: LifecycleSettlement | undefined;
  const readyWorkers = new Set<string>();
  const tailEntries = new Map<string, TailEntry>();
  const observations: Record<string, unknown>[] = [];

  const record = (entry: Record<string, unknown>): void => {
    const event = { time: Date.now(), ...entry };
    observations.push(event);
    assert(laneContext, "the isolated lane exists before a model request");
    appendFileSync(path.join(laneContext.root, "lifecycle-events.jsonl"), `${JSON.stringify(event)}\n`);
  };

  const captureTail = async (): Promise<void> => {
    if (!toolTail || !laneContext) return;
    const database = await collectDatabase(laneContext.data);
    for (const row of database.recovery) {
      const tree = row.payload.workspaceRoot;
      if (!tree) continue;
      const text = await readFile(path.join(tree, "tail-events.jsonl"), "utf8").catch(() => "");
      for (const line of text.split("\n").filter(Boolean)) {
        const entry = JSON.parse(line) as TailEntry;
        tailEntries.set(`${entry.time}:${entry.pid}:${entry.event}`, entry);
      }
    }
  };

  const scheduleSignal = (): void => {
    if (signalTimer || signalSent) return;
    signalTimer = setTimeout(() => {
      signalSent = true;
      record({ event: "owned-sigterm", pid: process.pid });
      process.kill(process.pid, "SIGTERM");
    }, 500);
  };

  const snapshot = async (ctx: SettledContext): Promise<ProcessSnapshot> => {
    await captureTail();
    const database = await collectDatabase(ctx.data);
    const pids = new Set<number>(ctx.observedProcessIdentities.map((identity) => identity.pid));
    for (const job of database.jobs) if (job.kimi_pid) pids.add(job.kimi_pid);
    for (const row of database.recovery) {
      for (const launch of row.payload.launches) {
        for (const identity of launch.identities) pids.add(identity.pid);
      }
    }
    for (const entry of tailEntries.values()) pids.add(entry.pid);
    return {
      time: Date.now(),
      activeResponseCount: ctx.activeResponseCount(),
      tailEntries: [...tailEntries.values()],
      processes: await Promise.all([...pids].map(async (pid) => ({ pid, probe: await probeProcessIdentity(pid) }))),
    };
  };

  let output: Awaited<ReturnType<typeof runLane>>;
  try {
    output = await runLane({
      name: `lifecycle-${mode}`,
      cap,
      tasks: cap,
      retry: false,
      write,
      budgetSeconds,
      // A deliberately conflicting ambient value must lose to the production
      // spawn overlay. The test never supplies the protective long timeout.
      env: { KIMI_CODE_SWARM_TIMEOUT_MS: "3000" },
      postSetup: async (ctx) => {
        laneContext = ctx;
        if (timeout) {
          const config = path.join(ctx.home, "config.toml");
          await writeFile(config, `${await readFile(config, "utf8")}\n[swarm]\ntimeout_ms = 3000\n`, { mode: 0o600 });
        }
        if (mode === "nesting-custom") {
          const agents = path.join(ctx.home, "agents");
          await mkdir(agents, { recursive: true });
          await writeFile(path.join(agents, "agent.md"), [
            "---", "name: agent", "description: Scripted root profile", "override: true",
            "tools: [AgentSwarm, Read, Write]", 'subagents: ["*"]', "---", "Execute the scripted control.", "",
          ].join("\n"));
          await writeFile(path.join(agents, "nesting-control.md"), [
            "---", "name: nesting-control", "description: Child explicitly exposing AgentSwarm",
            "tools: [AgentSwarm, Read, Write]", "subagents: [coder]", "---", "Execute the scripted control.", "",
          ].join("\n"));
        }
      },
      beforeRun: async (ctx) => {
        if (!toolTail) return;
        await writeFile(path.join(ctx.workspace, "tail.test.ts"), [
          "import { test } from 'bun:test';",
          "import { appendFileSync } from 'node:fs';",
          "const log = (event: string) => appendFileSync('tail-events.jsonl', JSON.stringify({ time: Date.now(), pid: process.pid, event }) + '\\n');",
          "process.on('SIGTERM', () => log('SIGTERM-ignored'));",
          "test('bounded teardown control', async () => { log('test-start'); await new Promise(resolve => setTimeout(resolve, 15000)); log('test-end'); }, 20000);",
          "",
        ].join("\n"));
        execFileSync("git", ["add", "tail.test.ts"], { cwd: ctx.workspace, env: ctx.env });
        execFileSync("git", ["commit", "-qm", "add isolated teardown control"], { cwd: ctx.workspace, env: ctx.env });
        tailTimer = setInterval(() => {
          if (tailPolling) return;
          tailPolling = true;
          void captureTail().catch(() => {}).finally(() => { tailPolling = false; });
        }, 100);
      },
      afterSettle: async (ctx) => {
        const before = await snapshot(ctx);
        record({ event: "pre-provider-cleanup-snapshot", snapshot: before });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const after = await snapshot(ctx);
        record({ event: "pre-provider-cleanup-delayed-snapshot", snapshot: after });
        settlement = { settledAt: ctx.settledAt, before, after };
        return settlement;
      },
      handler: async (info) => {
        record({
          event: "request", worker: info.worker, index: info.index, workerAttempt: info.workerAttempt,
          lastRole: info.last?.role,
          lastContent: info.last?.role === "tool" ? textContent(info.last.content) : undefined,
          tools: info.body.tools?.map((tool: { function?: { name?: string } }) => tool.function?.name),
        });
        if (!info.worker) {
          rootCalls++;
          if (single) {
            if (write && rootCalls === 1) {
              return { tool: { name: "Write", id: "call_single_write", args: { path: "single.txt", content: "SINGLE_LIFECYCLE_WRITE\n" } } };
            }
            if (cancel) scheduleSignal();
            return { text: "Unexpected late single-worker completion", delayMs: 40000 };
          }
          if (rootCalls === 1) {
            return swarmReply("call_wave_one", ["worker-1", "worker-2"], mode === "nesting-custom" ? "nesting-control" : "coder");
          }
          if (timeout && rootCalls === 2) return swarmReply("call_wave_two", ["worker-3", "worker-4"]);
          return { text: "LIFECYCLE_CONTROL_COMPLETE" };
        }
        if (nested) {
          if (info.last?.role === "tool") return { text: `${info.worker} nested result: ${textContent(info.last.content)}` };
          return swarmReply(`call_nested_${info.worker}`, ["worker-101", "worker-102"]);
        }
        if (cancel) {
          if (write && info.last?.role !== "tool") {
            return { tool: { name: "Write", id: `call_write_${info.worker}`, args: { path: `${info.worker}.txt`, content: `CANCEL_CONTROL_${info.worker}\n` } } };
          }
          readyWorkers.add(info.worker);
          if (readyWorkers.size === 2) scheduleSignal();
          return { text: `${info.worker} unexpected late completion`, delayMs: 40000 };
        }
        if (info.worker === "worker-1" || info.worker === "worker-2") {
          if (toolTail && info.worker === "worker-2") return { text: "Companion completed", delayMs: 1500 };
          if (info.workerAttempt === 1) {
            return { status: 429, headers: { "retry-after": "1" }, text: JSON.stringify({ error: { type: "rate_limit_error", message: "scripted lifecycle retry" } }), delayMs: 100 };
          }
          if (toolTail) return { tool: { name: "Bash", id: `call_tail_${info.worker}`, args: { command: "bun test tail.test.ts", description: "Run bounded teardown control" } } };
          return { text: `${info.worker} unexpected late first-wave completion`, delayMs: 40000 };
        }
        return { text: `${info.worker} unexpected second-wave completion` };
      },
    });
  } finally {
    if (signalTimer) clearTimeout(signalTimer);
    if (tailTimer) clearInterval(tailTimer);
  }

  assert(laneContext && settlement, "a lane must settle before lifecycle assertions");
  for (const state of [settlement.before, settlement.after]) {
    assert.equal(state.activeResponseCount, 0, "provider remains available until all requests have closed");
    assert(state.processes.length > 0, "quiescence requires a positively observed owned process");
    for (const process of state.processes) {
      assert(process.probe.complete, `PID ${process.pid} was completely probed`);
      assert.equal(process.probe.identity, undefined, `PID ${process.pid} is gone before provider cleanup`);
    }
  }
  assert(settlement.after.time - settlement.before.time >= 1000);
  assert.equal(output.userStatus, "");
  assert.equal(output.database.jobs.length, 1);
  const job = output.database.jobs[0];
  assert.equal(job.operation_kind, write ? "swarm-write" : "swarm");
  assert.equal(job.intended_engine, "native-v2");
  assert.equal(job.kimi_version, "2.6.2");
  const children = output.rawJournals.filter((journal) => journal.agent !== "main");
  const patch = output.patches.map((entry) => entry.text).join("\n");
  if (nested) {
    assert.equal(job.status, "completed");
    assert.equal(rootCalls, 2);
    assert.equal(children.length, 2, "the child requests must create no grandchildren");
    const attempts = pairedCalls(children, "AgentSwarm");
    assert.equal(attempts.length, 2);
    for (const attempt of attempts) {
      assert.equal(attempt.result.result.isError, true);
      assert.match(attempt.result.result.output, /^Swarm mode is off, so AgentSwarm did not run and no subagents were started\./);
    }
    const firstRequests = observations.filter((event) => event.event === "request" && event.worker && event.workerAttempt === 1);
    assert.equal(firstRequests.length, 2);
    for (const request of firstRequests) {
      assert.equal((request.tools as string[]).includes("AgentSwarm"), mode === "nesting-custom");
    }
  } else {
    assert.equal(children.length, single ? 0 : 2);
    assert.equal(rootCalls, single && write ? 2 : 1, "terminal abort must not return control to another wave");
    assert.equal(job.status, cancel ? "cancelled" : "failed");
    const error = JSON.parse(job.error ?? "null") as { code?: string } | null;
    assert(error);
    if (cancel) {
      assert.equal(error.code, "SWARM_CANCELLED");
      assert(signalSent);
    } else {
      assert.match(error.code ?? "", /^(?:REVIEW|RESCUE)_KIMI_RESPONSE_TIMEOUT$/);
      const config = await readFile(path.join(laneContext.home, "config.toml"), "utf8");
      assert.match(config, /\[swarm\]\ntimeout_ms = 3000/);
    }
    if (write && !toolTail) {
      const writes = pairedCalls(single ? output.rawJournals : children, "Write");
      assert.equal(writes.length, single ? 1 : 2);
      assert(writes.every((entry) => !entry.result.result.isError));
      for (const sentinel of single ? ["SINGLE_LIFECYCLE_WRITE"] : ["CANCEL_CONTROL_worker-1", "CANCEL_CONTROL_worker-2"]) {
        assert(patch.includes(sentinel), `partial patch retains ${sentinel}`);
      }
    }
    if (toolTail) {
      assert.equal(output.attempts["worker-1"], 2, "a real retry must reach the teardown test");
      // The outer process kill can leave the interrupted Bash call without a
      // result. Its call plus the test's observed live PID is execution proof;
      // requiring a result would reject the intended cancellation path.
      const bashCalls = children.flatMap((journal) => journal.events.map((entry) => entry.event ?? entry))
        .filter((entry) => entry.type === "tool.call" && entry.name === "Bash");
      assert(bashCalls.some((entry) => entry.args.command === "bun test tail.test.ts"));
      const starts = settlement.before.tailEntries.filter((entry) => entry.event === "test-start");
      assert.equal(starts.length, 1);
      assert(settlement.settledAt - starts[0]!.time > 3000, "native short timeout must not stop the test before the job budget");
      assert(settlement.before.tailEntries.some((entry) => entry.event === "SIGTERM-ignored"));
      assert(!settlement.before.tailEntries.some((entry) => entry.event === "test-end"), "job teardown kills the deliberately held test");
      assert(settlement.before.processes.some((entry) => entry.pid === starts[0]!.pid));
    }
    if (single) {
      assert.equal(output.database.recovery.length, 1, "single-worker mode records its owned print process");
      const recovery = output.database.recovery[0]!.payload;
      assert.equal(recovery.session, null);
      assert.equal(recovery.sessionDirty, false);
      assert.equal(recovery.launches.length, 1);
      assert.equal(recovery.launches[0].kind, "print", "single-worker mode must not launch the web activation lifecycle");
    }
  }
  await writeFile(path.join(laneContext.root, "lifecycle-evidence.json"), `${JSON.stringify({
    mode, cap, budgetSeconds, rootCalls, signalSent, observations, settlement,
    status: job.status, children: children.length, patchBytes: Buffer.byteLength(patch),
  }, null, 2)}\n`);
}
