// Performance budgets (plan §13, D21), measured against a seeded fixture
// (perf-seed.mjs: 10 conversations × ~1,155 events):
//   - Tab switch to interactive:            p95 < 150ms
//   - Local enqueue feedback after send:    p95 < 200ms
//   - Typing and scrolling stay smooth with 3 active runs + the full history
//     (no long tasks > 50ms during the interaction window).
// Measured over CDP in the dev build; numbers include ~2-5ms of CDP
// round-trip per poll, so treat them as an upper bound. Reported per sample.
import { connect } from './cdp.mjs';

const c = await connect(process.argv[2]);
const { ev, until, type, key, sleep } = c;

const TAGS = Array.from({ length: 10 }, (_, i) => `会话-${String(i + 1).padStart(2, '0')}`);
const marker = (tag, round = 164) => `${tag} 第${round}轮 回答`;
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1];
const results = [];
const report = (name, samples, budget) => {
  const v = p95(samples);
  results.push({ name, p95: v, budget, pass: v < budget });
  console.log(`${name}: p95=${v}ms (budget <${budget}ms) ${v < budget ? '✓' : '✗'}`);
  console.log(`  samples: ${samples.join(', ')}`);
};

await until(
  `[...document.querySelectorAll('nav button')].filter(b => b.innerText.includes('压测会话-')).length >= 10`,
  'seeded conversation list',
  30000,
);

// --- Open all 10 conversations as tabs (cold render of each heavy timeline) ---
const coldOpen = [];
for (const tag of TAGS) {
  const t0 = Date.now();
  await ev(
    `[...document.querySelectorAll('nav button')].find(b => b.innerText.includes('压测${tag}')).click()`,
  );
  await until(
    `document.querySelector('[role=log]')?.innerText.includes('${marker(tag)}')`,
    `open ${tag}`,
    30000,
  );
  coldOpen.push(Date.now() - t0);
}
console.log(`cold open (mount heavy timeline): ${coldOpen.join(', ')}`);

// --- Tab switch p95: alternate between the two heaviest tabs ---
const switchSamples = [];
for (let i = 0; i < 20; i++) {
  const target = TAGS[i % 2 === 0 ? 8 : 9];
  const t0 = Date.now();
  await ev(`document.querySelector('[role=tab][title="压测${target}"]').click()`);
  for (;;) {
    const done = await ev(
      `document.querySelector('[role=tab][aria-selected="true"]').title === '压测${target}' && document.querySelector('[role=log]')?.innerText.includes('${marker(target)}')`,
    );
    if (done) break;
    if (Date.now() - t0 > 10000) throw new Error(`tab switch to ${target} timed out`);
    await sleep(4);
  }
  switchSamples.push(Date.now() - t0);
}
report('tab switch to interactive', switchSamples, 150);

// --- Enqueue feedback p95: send in the active conversation, user bubble shows ---
const enqueueSamples = [];
for (let i = 0; i < 10; i++) {
  const text = `enqueue-${i}-${Date.now()}`;
  await type('textarea', text);
  await ev(`document.querySelector('textarea').focus()`);
  const t0 = Date.now();
  await key('Enter', 'Enter');
  for (;;) {
    const done = await ev(`document.querySelector('[role=log]')?.innerText.includes('${text}')`);
    if (done) break;
    if (Date.now() - t0 > 10000) throw new Error('enqueue feedback timed out');
    await sleep(4);
  }
  enqueueSamples.push(Date.now() - t0);
  // Let the fake run reach its permission prompt so runs accumulate below.
  await until(
    `document.querySelector('[role=log]')?.innerText.includes('Fake 请求权限')`,
    'fake waiting',
    15000,
  ).catch(() => {});
}
report('enqueue feedback after send', enqueueSamples, 200);

// --- Smoothness under load: park a run at its permission prompt in two more
// conversations, so 3 runs are active at once (the global cap), then measure
// typing and scrolling in the heavy conversation. ---
for (const [tag, text] of [
  [TAGS[0], '负载运行一'],
  [TAGS[1], '负载运行二'],
]) {
  await ev(`document.querySelector('[role=tab][title="压测${tag}"]').click()`);
  await type('textarea', text);
  await ev(`document.querySelector('textarea').focus()`);
  await key('Enter', 'Enter');
  await until(
    `document.querySelector('[role=log]')?.innerText.includes('Fake 请求权限')`,
    `load run in ${tag}`,
    15000,
  );
}
await ev(`document.querySelector('[role=tab][title="压测${TAGS[9]}"]').click()`);
await until(
  `document.querySelector('[role=tab][aria-selected="true"]').title === '压测${TAGS[9]}'`,
  'back to heavy tab',
);

await ev(
  `window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); true`,
);

// Typing: 40 keystrokes into the composer.
await ev(`document.querySelector('textarea').focus()`);
for (let i = 0; i < 40; i++) {
  await ev(
    `(() => { const el = document.querySelector('textarea'); el.value += '字'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  );
}
await sleep(400);
const typingLongTasks = await ev(`window.__lt.splice(0)`);
console.log(`long tasks during typing: [${typingLongTasks.join(', ')}]`);
const typingPass = typingLongTasks.filter((d) => d > 50).length === 0;
results.push({
  name: 'typing smoothness',
  p95: typingLongTasks.length,
  budget: 0,
  pass: typingPass,
});
console.log(`typing smoothness: ${typingPass ? '✓ no long tasks' : '✗'}`);

// Scrolling: sweep the heavy timeline bottom → top.
await ev(
  `(async () => { const el = document.querySelector('[role=log]'); for (let y = el.scrollHeight; y > 0; y -= 300) { el.scrollTop = y; await new Promise((r) => requestAnimationFrame(r)); } return true; })()`,
);
await sleep(400);
const scrollLongTasks = await ev(`window.__lt.splice(0)`);
console.log(`long tasks during scroll: [${scrollLongTasks.join(', ')}]`);
const scrollPass = scrollLongTasks.filter((d) => d > 50).length === 0;
results.push({
  name: 'scroll smoothness',
  p95: scrollLongTasks.length,
  budget: 0,
  pass: scrollPass,
});
console.log(`scroll smoothness: ${scrollPass ? '✓ no long tasks' : '✗'}`);

const failed = results.filter((r) => !r.pass);
console.log(
  failed.length === 0 ? 'PERF PASS' : `PERF FAIL: ${failed.map((f) => f.name).join(', ')}`,
);
process.exit(failed.length === 0 ? 0 : 1);
