import { check, connect } from './cdp.mjs';

const c = await connect(process.argv[2]);
const { ev, until, click, type, key, sleep, shot } = c;

await until(`document.body.innerText.includes('A workspace for connected agents.')`, 'welcome');
check('首次启动显示欢迎页', true);

// Create a conversation with the fake harness
await click('text=新会话 ⌘T');
await until(`!!document.querySelector('.arco-modal')`, 'modal');
// The harness list arrives over RPC after core spawns; wait for it, don't assume.
await until(`document.querySelectorAll('.arco-modal .arco-radio').length >= 4`, 'harness list');
const radios = await ev(
  `[...document.querySelectorAll('.arco-modal .arco-radio')].map(r => r.innerText.replace(/\\s+/g,' ').trim() + (r.classList.contains('arco-radio-disabled') ? ' [disabled]' : ''))`,
);
check(
  '新会话对话框列出 harness（无适配器的禁用）',
  radios.some((r) => r.includes('Fake')) &&
    radios.some((r) => r.includes('Codex') && r.includes('[disabled]')),
  JSON.stringify(radios),
);
await ev(
  `[...document.querySelectorAll('.arco-modal .arco-radio')].find(r => r.innerText.includes('Fake')).click()`,
);
await type('.arco-modal input.font-mono', `${process.env.NEXUS_E2E_DIR}/project`);
// The project dir is a git repo: the worktree option appears and auto-selects.
await until(
  `[...document.querySelectorAll('.arco-modal .arco-radio')].some(r => r.innerText.includes('独立 worktree') && r.classList.contains('arco-radio-checked'))`,
  'worktree auto-selected',
);
check('git 仓库默认选中 worktree 隔离', true);
await ev(
  `[...document.querySelectorAll('.arco-modal button')].find(b => b.innerText.trim() === '创建').click()`,
);
await until(
  `!document.querySelector('.arco-modal-wrapper:not([style*="display: none"]) .arco-modal') || document.body.innerText.includes('和 Fake 开始对话')`,
  'created',
);
await until(`document.body.innerText.includes('和 Fake 开始对话')`, 'empty conversation');
check('创建会话后打开空会话', true);
await until(`document.body.innerText.includes('在独立 worktree 中运行')`, 'worktree detail');
check('详情面板标注 worktree 隔离', true);

// Send a message (Enter), watch streaming → tool → permission
await type('textarea', '整理 notes');
await ev(`document.querySelector('textarea').focus()`);
await key('Enter', 'Enter');
await until(`document.body.innerText.includes('整理 notes')`, 'user bubble');
await until(`!!document.querySelector('.nx-pulse')`, 'streaming indicator', 5000)
  .then(() => check('流式输出中显示光标与“运行中”', true))
  .catch(() => check('流式输出中显示光标与“运行中”', false));
await until(`document.body.innerText.includes('Fake 请求权限')`, 'permission card');
check(
  '工具卡片与权限卡片出现',
  await ev(
    `document.body.innerText.includes('Grep') && document.body.innerText.includes('写入 notes.md')`,
  ),
);
const mode = await ev(
  `[...document.querySelectorAll('aside .arco-radio-checked')].map(r=>r.innerText).join(',')`,
);
check(
  '侧栏“待我处理”出现等待授权',
  await ev(`document.body.innerText.includes('等待授权 · 整理 notes')`),
  `sidebar mode=${mode}`,
);
await shot(`${process.env.NEXUS_E2E_DIR}/permission.png`);

// Queue a second message while waiting
await type('textarea', '第二条');
await click('text=排队发送');
await until(`document.body.innerText.includes('排队中')`, 'queued label');
check('运行中发送的消息显示“排队中”', true);

// Approve
await click('text=允许');
await until(`document.body.innerText.includes('已完成：整理 notes')`, 'first reply');
check(
  '允许后继续执行并完成第一条',
  await ev(`document.body.innerText.includes('你选择了「允许」')`),
);
await until(`document.body.innerText.includes('Fake 请求权限')`, 'second run permission', 8000);
check('排队的第二条自动开始运行', !(await ev(`document.body.innerText.includes('排队中 ·')`)));

// Stop the second run while it waits for permission
await click('text=停止运行');
await until(`document.body.innerText.includes('你停止了这次运行')`, 'stopped');
check(
  '停止运行 → “你停止了这次运行”，权限请求失效',
  await ev(`document.body.innerText.includes('权限请求已失效')`),
);
check(
  '详情面板显示运行记录',
  await ev(
    `document.body.innerText.includes('运行记录 · 2') && document.body.innerText.includes('已停止')`,
  ),
);

// Draft persists
await type('textarea', '未发送的草稿');
await sleep(600);
await shot(`${process.env.NEXUS_E2E_DIR}/after-run.png`);
console.log(
  'errors (excluding known Arco ref warning):',
  c.errors.filter((e) => !e.includes('element.ref')).length,
);
process.exit();
