/* Model Probe - remaining plan tasks 4-11, executed serially with deterministic gates.
 * Subagents do the writing; world.run does the gating. Fix loops carry gate feedback.
 * Repo: Y:\Development\ZCode, branch feat/model-probe. */

interface TaskOutcome {
  /** The implementer's report text (status + what changed). */
  summary: string;
  /** True when the implementer reported DONE and all gates passed. */
  ok: boolean;
}

interface ReportFinding {
  where: string;
  what: string;
  evidence: string;
  status: "verified" | "unconfirmed";
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  conclusion: string;
  findings: ReportFinding[];
  verified: string[];
  notCovered: string[];
}

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(-max) : text;
}

// world.run can only spawn real executables; on Windows npx/pnpm are .cmd shims that
// spawn rejects (ENOENT). Route everything through node.exe with the tool's JS entry point.
// The analyzer needs the literal command inline - do not extract "node" into a const.
const TSX_CLI = "node_modules/tsx/dist/cli.mjs";
const PNPM_CLI = "C:/Users/Andrei/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs";

async function runGate(
  name: string,
  cmd: string,
  argsArr: string[],
  timeoutMs?: number,
): Promise<{ ok: boolean; detail: string }> {
  const opts = timeoutMs === undefined ? {} : { timeoutMs };
  let res;
  if (cmd === "tsx") res = await world.run("node", [TSX_CLI, ...argsArr], opts);
  else if (cmd === "pnpm") res = await world.run("node", [PNPM_CLI, ...argsArr], opts);
  else if (cmd === "node") res = await world.run("node", argsArr, opts);
  else throw new Error(`unsupported gate command: ${cmd}`);
  const ok = res.exitCode === 0;
  const detail = `${name} exit=${res.exitCode}${ok ? "" : `\n${tail(res.stdout + "\n" + res.stderr, 3000)}`}`;
  return { ok, detail };
}

async function executeTask(
  name: string,
  planLineStart: number,
  planLineEnd: number,
  gates: Array<{ name: string; cmd: string; args: string[]; timeoutMs?: number }>,
): Promise<TaskOutcome> {
  const implementer = agent(name);
  const implementPrompt = [
    `You are implementing a task from the approved Model Probe plan in the ZCode repo (Windows, Git Bash, pnpm monorepo).`,
    `Repo root: Y:\\Development\\ZCode. Branch: feat/model-probe (already checked out - do NOT create branches).`,
    ``,
    `Read the FULL task text from the plan file: docs/superpowers/plans/2026-09-29-model-probe.md lines ${planLineStart}-${planLineEnd} (use Read with offset/limit). That section is the entire task spec: files to create/modify, test code, implementation reference, and the exact commit message.`,
    ``,
    `Rules:`,
    `- Follow the task's TDD order where given (test first, verify fail, implement, verify pass).`,
    `- Chinese comments for constraint comments, matching repo style. NO attribution trailers / Co-Authored-By in commits.`,
    `- Existing built artifacts available: packages/shared model-probe types (Task 1) and zcode-protocol schemas/methods (Task 2), bootstrap ledger-store + engine conventions (Tasks 3). If the task references "testModelConnectivity" wiring, mirror its shape exactly.`,
    `- Tests run with npx tsx --test <file>. There is no package test script; do not add one.`,
    `- If the task references payload shapes or event types, read the authoritative source in apps/zcode-cli/packages/contracts/src/events/session.events.ts and implement against it.`,
    `- The script runs these gates after you finish; do not run them yourself: ${gates.map((g) => g.name).join(", ")}.`,
    `- If you hit something genuinely blocking (ambiguity that changes behavior, missing authority), escalate with a question instead of guessing.`,
    ``,
    `Implement the task completely, commit it, then reply with a short report: what you changed, commit SHA, any concerns.`,
  ].join("\n");

  let outcome = await implementer.ask<string>(implementPrompt);

  // Gate + fix loop.
  let round = 0;
  const maxRounds = 3;
  while (round < maxRounds) {
    let failures: string[] = [];
    for (const gate of gates) {
      const g = await runGate(gate.name, gate.cmd, gate.args, gate.timeoutMs);
      if (!g.ok) failures.push(g.detail);
    }
    if (failures.length === 0) {
      return { summary: String(outcome), ok: true };
    }
    round += 1;
    outcome = await implementer.ask<string>(
      [
        `The deterministic gates failed after your change:`,
        failures.join("\n---\n"),
        ``,
        `Fix the failures and amend or re-commit as needed (keep branch feat/model-probe). Reply with what you changed and the new commit SHA.`,
      ].join("\n"),
    );
  }
  return {
    summary: `${String(outcome)}\n[gates still failing after ${maxRounds} fix rounds]`,
    ok: false,
  };
}

// ---- Task definitions: [name, plan line range, gates] ----
interface TaskDef {
  name: string;
  start: number;
  end: number;
  gates: Array<{ name: string; cmd: string; args: string[]; timeoutMs?: number }>;
}

const TSX_TEST = (f: string) => ({
  name: `test ${f}`,
  cmd: "tsx",
  args: ["--test", f],
  timeoutMs: 300000,
});
const TYPECHECK = {
  name: "root typecheck",
  cmd: "pnpm",
  args: ["typecheck"],
  timeoutMs: 600000,
};
const LINT = { name: "root lint", cmd: "pnpm", args: ["lint"], timeoutMs: 300000 };

const tasks: TaskDef[] = [
  {
    name: "Task 4: probe engine",
    start: 603,
    end: 1006,
    gates: [
      TSX_TEST(
        "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/model-probe-engine.test.ts",
      ),
    ],
  },
  {
    name: "Task 5: executor + protocol server wiring",
    start: 1007,
    end: 1199,
    gates: [TYPECHECK],
  },
  {
    name: "Task 6: services facade",
    start: 1200,
    end: 1367,
    gates: [TYPECHECK],
  },
  {
    name: "Task 7: UI hooks",
    start: 1368,
    end: 1531,
    gates: [TYPECHECK, LINT],
  },
  {
    name: "Task 8: picker presentation + ModelConfigSelect",
    start: 1532,
    end: 1672,
    gates: [TSX_TEST("packages/ui/test/modelProbePresentation.test.ts"), TYPECHECK, LINT],
  },
  {
    name: "Task 9: settings section registration",
    start: 1673,
    end: 1711,
    gates: [TYPECHECK],
  },
  {
    name: "Task 10: ModelProbeSection UI + i18n",
    start: 1712,
    end: 1934,
    gates: [TYPECHECK, LINT],
  },
];

const findings: ReportFinding[] = [];
const verified: string[] = [];
const outcomes: Array<{ task: string; ok: boolean; summary: string }> = [];

// Dashboard: one card per task, moved by status as it lands.
artifact.board("task-board", {
  title: "Model Probe tasks",
  key: "where",
  status: "status",
  columns: ["verified", "unconfirmed"],
  cardTitle: "where",
  detail: [
    { field: "what", label: "result" },
    { field: "severity", label: "severity" },
  ],
});

for (const t of tasks) {
  // Phase names must be compile-time literals; one name per block. Since the loop is one
  // construct, we use one shared phase name that covers the whole serial execution.
  phase("Implement the remaining tasks and fix what the checks find");
  log(`Starting ${t.name} (plan lines ${t.start}-${t.end})`);
  const outcome = await executeTask(t.name, t.start, t.end, t.gates);
  outcomes.push({ task: t.name, ok: outcome.ok, summary: outcome.summary });
  report(
    {
      where: t.name,
      what: outcome.ok ? `${t.name} done, gates green.` : `${t.name} has unresolved gate failures.`,
      evidence: tail(outcome.summary, 600),
      status: outcome.ok ? "verified" : "unconfirmed",
      severity: outcome.ok ? "low" : "high",
    },
    "task-board",
  );
  if (!outcome.ok) {
    log(`${t.name} failed its gates; continuing to next task.`);
  }
}

// ---- Final verification (Task 11) ----
phase("Run the full repo gates");
const gatesFinal = [
  {
    name: "freshness",
    cmd: "node",
    args: ["scripts/check-workspace-freshness.mjs"],
    timeoutMs: 120000,
  },
  { name: "root typecheck", cmd: "pnpm", args: ["typecheck"], timeoutMs: 600000 },
  { name: "root lint", cmd: "pnpm", args: ["lint"], timeoutMs: 300000 },
  {
    name: "architecture check",
    cmd: "pnpm",
    args: ["architecture:check", "--changed"],
    timeoutMs: 300000,
  },
];
const gateResults: string[] = [];
for (const g of gatesFinal) {
  const r = await runGate(g.name, g.cmd, g.args, g.timeoutMs);
  gateResults.push(`${g.name}: ${r.ok ? "ok" : "FAIL"}`);
  verified.push(`${g.name} (${g.cmd} ${g.args.join(" ")})`);
  if (!r.ok) {
    findings.push({
      where: "final gates",
      what: `${g.name} failed`,
      evidence: tail(r.detail, 1200),
      status: "verified",
      severity: "high",
    });
  }
}

const doneCount = outcomes.filter((o) => o.ok).length;
const conclusion = `Model Probe implementation finished: ${doneCount}/${tasks.length} tasks green on their gates. Final repo gates: ${gateResults.join(", ")}.`;

phase("Publish the implementation report");
const reportMd = [
  `# Model Probe - implementation report`,
  ``,
  conclusion,
  ``,
  `## Task outcomes`,
  ...outcomes.map((o) => `- ${o.ok ? "✅" : "❌"} ${o.task}`),
  ``,
  `## Verified by`,
  ...verified.map((v) => `- ${v}`),
  ``,
  `## Gate failures (if any)`,
  ...(findings.length
    ? findings.map((f) => `- ${f.what}\n  ${f.evidence.split("\n").slice(0, 4).join("\n  ")}`)
    : ["- none"]),
].join("\n");
await artifact.markdown("impl-report", reportMd, {
  title: "Model Probe implementation report",
  description: conclusion,
  primary: true,
});

const result: WorkflowReport = {
  conclusion,
  findings,
  verified,
  notCovered: [
    "apps/zcode-cli package-internal tsc (baseline has pre-existing module-resolution errors; root typecheck is the gate used)",
    "Runtime smoke of the desktop app UI (requires interactive desktop run)",
  ],
};
return result;
