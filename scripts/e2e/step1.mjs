import { check, connect } from './cdp.mjs';

const c = await connect(process.argv[2]);
const { ev, until, click, type, key, sleep, shot } = c;

await until(`document.body.innerText.includes('A workspace for connected agents.')`, 'welcome');
check('首次启动显示欢迎页', true);

// Create a conversation with the fake harness
await click('text=新会话 ⌘T');
await until(`!!document.querySelector('.arco-modal')`, 'modal');
// The harness list arrives over RPC after core spawns; wait for it, don't assume.
// Detection resolves the login-shell PATH and probes every CLI; a cold start
// can take longer than the default 10s.
await until(
  `document.querySelectorAll('.arco-modal .arco-radio').length >= 4`,
  'harness list',
  30000,
);
const radios = await ev(
  `[...document.querySelectorAll('.arco-modal .arco-radio')].map(r => r.innerText.replace(/\\s+/g,' ').trim() + (r.classList.contains('arco-radio-disabled') ? ' [disabled]' : ''))`,
);
// Whether a real CLI is installed depends on the machine (CI has none), so
// assert the rule instead of the inventory: Fake is always usable, and a
// disabled harness always says why it cannot be picked.
check(
  '新会话对话框列出 harness：Fake 可选，未安装的显示原因并禁用',
  radios.some((r) => r.includes('Fake') && !r.includes('[disabled]')) &&
    radios.every((r) => !r.includes('[disabled]') || r.includes('未安装')),
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

// Harness management view (D13): capabilities and auth from the adapter probe
await click('text=Agents');
check(
  'Agents 视图显示能力与认证状态',
  await ev(
    `document.body.innerText.includes('权限卡片') && document.body.innerText.includes('已认证')`,
  ),
);
// D23: MCP server management lives in the Agents view
await ev(`document.querySelector('[aria-label="添加 MCP server"]').click()`);
const mcpDlg = `.arco-modal-wrapper:not([style*="display: none"]) .arco-modal`;
await until(`!!document.querySelector('${mcpDlg} input[aria-label="server 名称"]')`, 'mcp dialog');
await type(`${mcpDlg} input[aria-label="server 名称"]`, '测试 server');
await type(`${mcpDlg} input[aria-label="server 命令"]`, 'npx');
await type(
  `${mcpDlg} textarea[aria-label="server 参数"]`,
  '-y\n@modelcontextprotocol/server-everything',
);
await type(
  `${mcpDlg} textarea[aria-label="server 环境变量"]`,
  'API_KEY=$' + '{NEXUS_TEST_MISSING}',
);
await ev(
  `[...document.querySelectorAll('${mcpDlg} button')].find(b => b.innerText.trim() === '保存').click()`,
);
await until(`document.body.innerText.includes('测试 server')`, 'server listed');
check('MCP server 添加后出现在列表', true);
check('未解析的占位符有标注', await ev(`document.body.innerText.includes('缺环境变量')`));
check(
  '持久化到 core（重新拉取仍在）',
  await ev(`document.body.innerText.includes('@modelcontextprotocol/server-everything')`),
);
// Delete again so the restart steps do not carry extra state.
await ev(`document.querySelector('[aria-label="删除 测试 server"]').click()`);
await until(
  `[...document.querySelectorAll('.arco-popconfirm button, .arco-popover button')].some(b => b.innerText.trim() === '删除')`,
  'delete confirm',
);
await ev(
  `[...document.querySelectorAll('.arco-popconfirm button, .arco-popover button')].find(b => b.innerText.trim() === '删除').click()`,
);
await until(`!document.body.innerText.includes('测试 server')`, 'server removed');
check('MCP server 可删除', true);
await click('text=会话');

// --- M3 delegation: delegate to Fake, child asks permission, review, accept ---
await click('text=委派');
// Arco keeps closed modals mounted (hidden); scope everything to the visible one.
const dlg = `.arco-modal-wrapper:not([style*="display: none"]) .arco-modal`;
await until(
  `[...document.querySelectorAll('${dlg}')].some(m => m.innerText.includes('委派子任务'))`,
  'delegate dialog',
);
await type(`${dlg} input`, '调查路由守卫的空指针');
// The executor defaults to a different harness; switch it to Fake (no quota).
await ev(`document.querySelector('${dlg} .arco-select').click()`);
await until(
  `[...document.querySelectorAll('.arco-select-option')].some(o => o.innerText.includes('Fake'))`,
  'executor options',
);
await ev(
  `[...document.querySelectorAll('.arco-select-option')].find(o => o.innerText.includes('Fake')).click()`,
);
await ev(
  `[...document.querySelectorAll('${dlg} button')].find(b => b.innerText.trim() === '创建子任务').click()`,
);
await until(`!!document.querySelector('[aria-label^="委派的子任务"]')`, 'delegation card');
check(
  '委派后时间线出现子任务卡片（进行中）',
  await ev(`document.body.innerText.includes('进行中')`),
);
await until(`document.body.innerText.includes('等待授权 · 调查路由守卫')`, 'child waiting', 15000);
check('子会话在独立 worktree 中运行并停在权限请求', true);

// Open the child, approve its permission, watch the result flow back.
await ev(
  `[...document.querySelectorAll('button')].find(b => b.innerText.trim() === '打开子会话').click()`,
);
await until(`document.body.innerText.includes('委派的子任务 · 点击查看委派会话')`, 'child banner');
check('子会话显示指向委派方的横幅', true);
await click('text=允许');
await until(`document.body.innerText.includes('子任务待验收 · 整理 notes')`, 'task inbox', 15000);
check('子任务完成后侧栏出现“子任务待验收”', true);
await shot(`${process.env.NEXUS_E2E_DIR}/delegation-review.png`);

// Back in the parent: the card shows the result; accept it.
await ev(
  `[...document.querySelectorAll('[role=tab]')].find(t => t.title === '整理 notes').click()`,
);
await until(`document.body.innerText.includes('子任务结果')`, 'card review');
check('委派卡片进入待验收并展示子任务结果', true);
await ev(
  `[...document.querySelectorAll('button')].find(b => b.innerText.trim() === '查看改动').click()`,
);
await until(`document.body.innerText.includes('工作区没有改动')`, 'task evidence', 15000);
check('委派卡片可展开证据（子任务改动列表）', true);
await ev(
  `[...document.querySelectorAll('button')].find(b => b.innerText.trim() === '验收通过').click()`,
);
await until(`document.body.innerText.includes('已通过')`, 'accepted');
check(
  '验收通过 → 卡片标记已通过，待办消失',
  !(await ev(`document.body.innerText.includes('子任务待验收')`)),
);

// --- M4 handoff: prepare (stops the source) → review package → cancel ---
await click('text=交接');
const drawer = '.arco-drawer';
await until(`!!document.querySelector('${drawer} input[aria-label="交接目标"]')`, 'handoff drawer');
// D22: the dialog comes prefilled from the log (goal chain + derived next
// action); the user still edits and confirms.
await until(
  `document.querySelector('${drawer} input[aria-label="交接目标"]').value === '整理 notes' && document.querySelector('${drawer} textarea[aria-label="接手方先做什么"]').value.includes('最近的用户要求')`,
  'prefilled handoff draft',
);
check('交接对话框从日志预填目标与下一步', true);
// A second chat-capable harness is needed to hand off to. CI installs none of
// the real CLIs, so there the dialog can only show that fact — assert that and
// move on instead of failing on an environment property.
const hasTarget = await ev(`!!document.querySelector('${drawer} .arco-select')`);
if (!hasTarget) {
  check(
    '没有第二个可用的 Agent 时，交接对话框说明原因并禁用准备按钮',
    await ev(
      `document.body.innerText.includes('没有可用的其他 Agent') &&
       [...document.querySelectorAll('${drawer} button')].some(b => b.innerText.includes('准备交接') && b.disabled)`,
    ),
  );
  await ev(
    `[...document.querySelectorAll('${drawer} button')].find(b => b.innerText.trim() === '取消').click()`,
  );
  await until(
    `!document.querySelector('.arco-drawer-wrapper:not(.arco-drawer-wrapper-hide)')`,
    'handoff drawer closed',
  );
} else {
  await type(`${drawer} input[aria-label="交接目标"]`, '修好登录后的跳转');
  await type(`${drawer} textarea[aria-label="接手方先做什么"]`, '先复现问题，再改代码');
  await type(`${drawer} textarea[aria-label="已确认的事实"]`, '问题出在回调里');
  await type(`${drawer} textarea[aria-label="尚未验证的假设"]`, '其他守卫可能同样有问题');
  await ev(
    `[...document.querySelectorAll('${drawer} button')].find(b => b.innerText.trim() === '停止原 Agent 并准备交接').click()`,
  );
  await until(`document.body.innerText.includes('确认交接')`, 'package review');
  check(
    '准备交接后展示冻结的上下文包（要求/事实/假设分开）',
    await ev(
      `document.body.innerText.includes('问题出在回调里') && document.body.innerText.includes('其他守卫可能同样有问题') && document.body.innerText.includes('整理 notes')`,
    ),
  );
  await shot(`${process.env.NEXUS_E2E_DIR}/handoff-review.png`);
  // Cancel: back out of the review (discards the frozen package), then close.
  await ev(
    `[...document.querySelectorAll('${drawer} button')].find(b => b.innerText.trim() === '返回修改').click()`,
  );
  await until(`!!document.querySelector('${drawer} input[aria-label="交接目标"]')`, 'back to form');
  await ev(
    `[...document.querySelectorAll('${drawer} button')].find(b => b.innerText.trim() === '取消').click()`,
  );
  await until(`document.body.innerText.includes('未完成')`, 'handoff aborted');
  check(
    '取消交接 → 卡片标注“未完成”，负责人不变',
    await ev(
      `document.body.innerText.includes('未完成') && document.body.innerText.includes('用户取消了交接') && document.body.innerText.includes('发给')`,
    ),
  );
  // The hold is released: the composer accepts a prompt again.
  await until(
    `!document.querySelector('.arco-modal-wrapper:not([style*="display: none"])')`,
    'drawer gone',
  );
  await type('textarea[aria-label="消息"]', '交接取消后继续');
  await click('text=发送');
  // The demo script asks for permission before finishing, like any real run.
  await until(
    `document.body.innerText.includes('Fake 请求权限')`,
    'released run permission',
    15000,
  );
  await click('text=允许');
  await until(`document.body.innerText.includes('已完成：交接取消后继续')`, 'released', 15000);
  check('取消交接后消息可以继续发送', true);
}

// Preview pane (ADR 0014): open it, load a local dev server URL, reject remote ones.
await ev(
  `[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '预览面板').click()`,
);
await until(`!!document.querySelector('input[aria-label="预览地址"]')`, 'preview pane open');
await type('input[aria-label="预览地址"]', 'localhost:5173');
await until(
  `document.querySelector('webview')?.getAttribute('src') === 'http://localhost:5173/'`,
  'webview loads the local URL',
);
check('预览面板加载本机 dev server 地址（补 http 前缀）', true);
await type('input[aria-label="预览地址"]', 'https://example.com');
await until(`document.body.innerText.includes('内置预览仅支持本机地址')`, 'remote URL rejected');
check('预览面板不加载非本机地址', await ev(`!document.querySelector('webview')`));
check(
  '非本机地址提供「在默认浏览器打开」入口',
  await ev(
    `[...document.querySelectorAll('button')].some(b => b.innerText.includes('在默认浏览器打开'))`,
  ),
);
await shot(`${process.env.NEXUS_E2E_DIR}/preview-pane.png`);
// Restore a valid URL so the persisted state exercises the reload path in step 2.
await type('input[aria-label="预览地址"]', 'localhost:5173');
await until(
  `document.querySelector('webview')?.getAttribute('src') === 'http://localhost:5173/'`,
  'webview restored',
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
