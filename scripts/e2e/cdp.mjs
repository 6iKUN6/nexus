// Tiny CDP helper shared by the e2e scripts.
import { writeFileSync } from 'node:fs';
export async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const errors = [];
  let since = Date.now();
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result ?? m);
      pending.delete(m.id);
    } else if (
      (m.method === 'Runtime.exceptionThrown' ||
        (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')) &&
      (m.params.timestamp ?? 0) >= since
    )
      errors.push(JSON.stringify(m.params).slice(0, 400));
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Runtime.enable');
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', {
      expression: x,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (expr, label, timeout = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await ev(expr)) return true;
      await sleep(150);
    }
    throw new Error(`timeout waiting for: ${label}`);
  };
  const shot = async (file) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(s.data, 'base64'));
  };
  const click = (selectorOrText) =>
    ev(
      `(() => { const t = ${JSON.stringify(selectorOrText)}; const el = t.startsWith('text=') ? [...document.querySelectorAll('button, [role=tab], label')].find(b => b.innerText.trim() === t.slice(5)) : document.querySelector(t); if (!el) throw new Error('not found ' + t); el.click(); return true; })()`,
    );
  const type = (selector, value) =>
    ev(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
    );
  const key = async (k, code, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp'])
      await send('Input.dispatchKeyEvent', {
        type,
        key: k,
        code,
        modifiers,
        windowsVirtualKeyCode: k === 'Enter' ? 13 : k.toUpperCase().charCodeAt(0),
      });
  };
  const text = () => ev('document.body.innerText');
  return {
    ws,
    send,
    ev,
    sleep,
    until,
    shot,
    click,
    type,
    key,
    text,
    errors,
    resetErrors: () => {
      errors.length = 0;
      since = Date.now();
    },
  };
}
export const check = (label, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) process.exitCode = 1;
};
