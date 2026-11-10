import { check, connect } from './cdp.mjs';

const c = await connect(process.argv[2]);
const { ev, until, click, sleep } = c;
await until(`document.body.innerText.includes('整理 notes')`, 'restored conversation', 8000);
check('重启后会话列表恢复', true);
// Tabs are restored once the conversation list arrives; poll instead of
// checking a single instant (the sidebar can show the title earlier).
const tabRestored = await until(
  `[...document.querySelectorAll('[role=tab]')].some(t => t.getAttribute('aria-selected') === 'true' && t.title === '整理 notes')`,
  'restored tab',
  8000,
)
  .then(() => true)
  .catch(() => false);
check('重启后 Tab 恢复并打开同一会话', tabRestored);
await until(`document.body.innerText.includes('已完成：整理 notes')`, 'history', 8000);
check(
  '重启后历史消息完整',
  await ev(
    `document.body.innerText.includes('你停止了这次运行') && document.body.innerText.includes('你选择了「允许」')`,
  ),
);
check(
  '重启后未发送的草稿还在',
  (await ev(`document.querySelector('textarea').value`)) === '未发送的草稿',
  await ev(
    `JSON.stringify({ value: document.querySelector('textarea')?.value ?? null, saved: localStorage.getItem('nexus.ui.v1') })`,
  ),
);

// Start a run, wait for the permission prompt, then hard-kill (simulated crash).
await ev(
  `(() => { const el = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '崩溃测试'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`,
);
await click('text=发送');
await until(`document.body.innerText.includes('Fake 请求权限')`, 'permission before crash', 8000);
check('崩溃前：运行停在等待授权', true);
await sleep(300);
process.exit();
