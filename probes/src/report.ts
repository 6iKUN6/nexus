import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESSES as ALL_HARNESSES } from './harnesses.ts';
import { SCENARIOS } from './scenarios.ts';
import type { ScenarioRecord, TurnRecord } from './types.ts';

/**
 * Prints a markdown matrix from the latest run of every harness × scenario.
 * Cells are automatic observations only; the final 支持/降级/不支持 verdict
 * is written by a human into probes/MATRIX.md after reading the raw output.
 */

const HARNESSES = ALL_HARNESSES.filter((h) => !h.hidden);
const OUTPUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'output');

async function latest(harness: string, scenario: string): Promise<ScenarioRecord | null> {
  const dir = join(OUTPUT_ROOT, harness, scenario);
  try {
    const runs = (await readdir(dir)).sort();
    const last = runs.at(-1);
    if (!last) return null;
    return JSON.parse(await readFile(join(dir, last, 'summary.json'), 'utf8')) as ScenarioRecord;
  } catch {
    return null;
  }
}

function cell(turns: TurnRecord[]): string {
  if (turns.length === 0) return '—';
  const last = turns.at(-1);
  if (!last) return '—';
  if (last.spawnError) return `✗ ${last.spawnError.slice(0, 40)}`;
  const parts = [`exit ${last.exitCode ?? last.signal}`];
  if (last.expectMatched !== null) parts.push(last.expectMatched ? '结果✓' : '结果✗');
  if (turns.length > 1) parts.push(turns.every((t) => t.sessionId) ? 'session✓' : 'session✗');
  if (last.cancel)
    parts.push(last.cancel.escalatedTo ? `取消需${last.cancel.escalatedTo}` : '取消✓');
  if (turns.some((t) => t.orphans.length > 0)) parts.push('有残留进程');
  if (last.timedOut) parts.push('超时');
  return parts.join(' · ');
}

const header = ['场景', ...HARNESSES.map((h) => h.id)];
const rows: string[][] = [];
const versions: string[] = [];

for (const scenario of SCENARIOS) {
  const row = [scenario.id];
  for (const harness of HARNESSES) {
    const record = await latest(harness.id, scenario.id);
    if (scenario.id === 'help') {
      row.push(record ? (record.harnessVersion ?? '未安装') : '未运行');
      if (record) versions.push(`${harness.id}=${record.harnessVersion ?? '未安装'}`);
    } else {
      row.push(record ? cell(record.turns) : '未运行');
    }
  }
  rows.push(row);
}

const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
console.info(`版本: ${versions.join(', ') || '未知'}\n`);
console.info([line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n'));

console.info('\n事件类型（最近一次 basic / tool 运行）:');
for (const harness of HARNESSES) {
  for (const scenario of ['basic', 'tool']) {
    const record = await latest(harness.id, scenario);
    const types = record?.turns.flatMap((t) => Object.keys(t.eventTypes)) ?? [];
    if (types.length)
      console.info(`- ${harness.id}/${scenario}: ${[...new Set(types)].join(', ')}`);
  }
}
