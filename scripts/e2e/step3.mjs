import { check, connect } from './cdp.mjs';

const c = await connect(process.argv[2]);
const { ev, until, sleep, shot } = c;
await until(`document.body.innerText.includes('运行被中断')`, 'interrupted card', 8000).catch(
  () => {},
);
check(
  '崩溃重启后：那次运行标记为“运行被中断”',
  await ev(
    `document.body.innerText.includes('运行被中断') && document.body.innerText.includes('没有自动重试')`,
  ),
);
check(
  '崩溃重启后：权限请求显示为已失效',
  await ev(`document.body.innerText.includes('权限请求已失效')`),
);
await sleep(2500);
check(
  '崩溃重启后：没有自动重跑（无新的权限请求）',
  !(await ev(`document.body.innerText.includes('Fake 请求权限')`)),
);
check(
  '提供“重试”按钮',
  await ev(`[...document.querySelectorAll('button')].some(b => b.innerText.trim() === '重试')`),
);
check(
  '侧栏“待我处理”显示运行失败',
  await ev(`document.body.innerText.includes('运行失败 · 整理 notes')`),
);
await shot(`${process.env.NEXUS_E2E_DIR}/recovered.png`);
console.log(
  'errors (excluding known Arco ref warning):',
  c.errors.filter((e) => !e.includes('element.ref')).length,
);
process.exit();
