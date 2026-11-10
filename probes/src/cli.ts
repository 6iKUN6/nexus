import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findHarness, HARNESSES } from './harnesses.ts';
import { runScenario } from './runner.ts';
import { findScenario, SCENARIOS } from './scenarios.ts';
import type { HarnessProbe, Scenario } from './types.ts';

const OUTPUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'output');

const USAGE = `用法:
  pnpm probe [harness...] [--scenario <id>]... [--yes]

  harness   ${HARNESSES.filter((h) => !h.hidden)
    .map((h) => h.id)
    .join(' | ')} | all   (默认 all；selftest 用于验证探针本身)
  scenario  ${SCENARIOS.map((s) => s.id).join(' | ')} | all   (默认 help，免费)
  --yes     确认运行会调用模型、消耗额度的场景

示例:
  pnpm probe                                   # 所有 harness 的 --help / --version
  pnpm probe claude-code --scenario basic --yes
  pnpm probe codex pi --scenario all --yes
结果写入 probes/output/<harness>/<scenario>/<时间戳>/，汇总: pnpm probe:report`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    scenario: { type: 'string', multiple: true, short: 's' },
    yes: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.info(USAGE);
  process.exit(0);
}

const harnessIds =
  positionals.length === 0 || positionals.includes('all')
    ? HARNESSES.filter((h) => !h.hidden).map((h) => h.id)
    : positionals;
const harnesses: HarnessProbe[] = harnessIds.map(
  (id) => findHarness(id) ?? fail(`未知 harness: ${id}`),
);

const scenarioIds = values.scenario ?? ['help'];
const scenarios: Scenario[] = scenarioIds.includes('all')
  ? SCENARIOS
  : scenarioIds.map((id) => findScenario(id) ?? fail(`未知场景: ${id}`));

const paid = scenarios.filter((s) => s.costsQuota);
if (paid.length > 0 && !values.yes) {
  fail(`场景 ${paid.map((s) => s.id).join(', ')} 会调用模型并消耗额度，请加 --yes 确认。`);
}

for (const harness of harnesses) {
  for (const scenario of scenarios) {
    process.stdout.write(`▶ ${harness.id} · ${scenario.id} … `);
    const record = await runScenario(harness, scenario, OUTPUT_ROOT);
    const turns = record.turns
      .map((t) =>
        t.spawnError
          ? `spawn 失败: ${t.spawnError}`
          : `exit=${t.exitCode ?? t.signal} ${t.durationMs}ms json=${t.jsonLines}/${t.stdoutLines}` +
            (t.sessionId ? ' session✓' : '') +
            (t.expectMatched === null ? '' : t.expectMatched ? ' expect✓' : ' expect✗') +
            (t.cancel
              ? ` cancel@${t.cancel.sentAtMs}ms${t.cancel.escalatedTo ? `→${t.cancel.escalatedTo}` : ''}`
              : '') +
            (t.orphans.length ? ` 残留进程=${t.orphans.length}` : '') +
            (t.timedOut ? ' 超时' : ''),
      )
      .join(' | ');
    console.info(`${record.harnessVersion ?? '未安装/无版本'}${turns ? ` · ${turns}` : ''}`);
  }
}
