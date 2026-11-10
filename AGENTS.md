# Nexus — Agent Guide

Rules for every contributor, human or AI. `CLAUDE.md` is a symlink to this file, so Claude Code and Codex read the same instructions.

Nexus is a **local-only** desktop app (macOS first) for managing local agent CLIs ("harnesses": Claude Code, Codex, pi; DeepSeek Harness is deferred) through an IM-style chat UI with tabs. It has no server, no accounts and no cloud sync. The full plan is `docs/initiation/开发落地计划.md` (internal, not distributed), and the decisions are in `docs/decisions/`. **Read the relevant ADR before changing a module it covers.**

## Commands

```bash
pnpm install          # pnpm 11, Node >= 22.12 (24 recommended)
pnpm dev              # run the desktop app with hot reload
                      #   NEXUS_FAKE_HARNESS=1   adds the scripted "Fake" harness (no quota)
                      #   NEXUS_USER_DATA_DIR=…  isolated data dir (SQLite + localStorage)
                      #   NEXUS_VIBRANCY=0       solid sidebar (needed for CDP screenshots)
pnpm check            # lint + typecheck + boundary rules + tests (CI runs exactly this)
pnpm e2e:smoke        # drive the real app via CDP with the Fake harness (no quota, ~40s, macOS)
pnpm test:contract    # tests against REAL harness CLIs — spends quota, ask first
pnpm lint:fix         # Biome autofix + format
pnpm test:watch       # Vitest watch mode
pnpm build            # build desktop bundles into packages/desktop/out
pnpm pack:mac         # unsigned .app in packages/desktop/release (signing comes in M5)
pnpm brand            # regenerate app icon (.icns/.png) + favicon from assets/logos (commit the output)
pnpm probe            # M0 capability probes; the default `help` scenario is free (see probes/README.md)
```

**Run `pnpm check` before every commit.** A change is not done until it passes.

## Architecture

```
packages/
  protocol/        zod schemas, event types, adapter contract, typed JSON-RPC. Shared by everything.
  core/            all product logic: harness detection, conversations (serial queue per
                   conversation, permissions, cancel, restart recovery), SQLite event log
                   (Drizzle ORM on better-sqlite3, ADR 0009).
                   Plain Node; never imports electron. Runs in an Electron utilityProcess.
  core/src/handoff/ M4 simplified handoff: stop → frozen context package → CAS owner swap (ADR 0011).
  proc/            process-group helpers shared by adapters and core: verified stop
                   (SIGTERM → poll → SIGKILL → confirm), ADR 0010.
  adapters/<name>/ one package per harness, implementing AgentAdapter from protocol.
                   fake/ (scripted, tests + dev), claude/ (Claude Agent SDK, M1),
                   codex/ (app-server stdio JSON-RPC, M2), pi/ (--mode rpc JSONL, M2).
  ui/              React + Arco UI. Browser-only (it must also work as a future WebUI).
  desktop/         Electron shell: main (windows/OS), preload (port hand-off), core-host, renderer entry.
probes/            M0 throwaway scripts that record real harness behaviour. Not shipped.
```

Runtime: `renderer ──MessagePort (JSON-RPC)──▶ core (utilityProcess) ──spawn──▶ harness CLIs`. Main creates the channel and is not involved after that. Main only handles windows and the directory picker; a tray and notifications are not implemented yet.

Data flow (ADR 0005): core appends every event to a per-conversation log (monotonic `seq`) and pushes it as a notification. The UI's `CoreStore` mirrors it, dedupes by seq and refills gaps, and `buildTimeline(events)` derives everything on screen. **Never put derived UI state into core events, and never mutate history.** Append a new event instead.

### Boundaries (enforced by `pnpm deps:check`; violations fail CI)

| Package | May import | Must not import |
|---|---|---|
| protocol | `zod` | any other internal package, Node builtins |
| core | protocol, adapters, proc, Node | electron, ui, desktop |
| proc | Node | any internal package, electron |
| adapters/* | protocol, proc, Node, the harness SDK | core, ui, desktop, other adapters |
| ui | protocol, React, Arco | core, adapters, desktop, electron, Node builtins |
| desktop/renderer | ui, protocol | core, adapters, electron, Node builtins |
| desktop/main, preload, core-host | anything | — |

Need something across a boundary? Add an RPC method to `protocol/src/rpc.ts` (schema first). Never weaken a rule in `.dependency-cruiser.cjs` just to make code pass.

## Code conventions

- TypeScript `strict` with `noUncheckedIndexedAccess`. **No `any`.** No non-null assertions (`!`). Use `type`, not `interface`.
- Any data that crosses a process or package boundary is defined as a zod schema in `protocol`, and the TS type is derived from it (`z.infer`). Validate on receipt.
- Pass dependencies in as parameters (see `createCore({ detectHarnesses })` and `DetectDeps`) so logic can be tested without real processes or a real filesystem.
- File names: `PascalCase.tsx` for components, `camelCase.ts` for everything else, and tests sit next to the code as `*.test.ts(x)`.
- Comments explain *why*, in English. UI copy is in Chinese and hardcoded for v0.1. i18n is a later decision, so don't add an i18n library yet.
- Formatting is owned by Biome (single quotes, semicolons, trailing commas, 100 columns). Don't hand-format.

## UI (Arco + Tailwind, Apple theme — ADR 0003/0004)

- Use **Arco components** (`@arco-design/web-react`) for interactive elements: no raw `<button>` / `<input>` / `<select>`. Icons come from `@arco-design/web-react/icon`. The one documented exception is when Arco can't produce the pattern, e.g. the Safari-style `TabStrip`. Then write a custom element with full ARIA roles and keyboard support.
- Tailwind is for layout and spacing. **Colors come only from tokens**: `bg-surface-{1,2,3}`, `bg-elevated`, `bg-sidebar`, `bg-titlebar`, `bg-bubble-{in,out}`, `text-fg-{1..4}`, `border-line-{1,2,3}`, `bg-tint-{1,2,3}`, `text-brand`, `text-ok/warn/bad` (each also has a `*-soft` background), `bg-sys-{orange,purple,teal,indigo,gray}`, `text-on-accent`, `shadow-mac`. **No hex colors and no Tailwind palette colors.**
- The Apple theme is defined in `packages/ui/src/theme/` and works by overriding Arco's CSS variables. To change a color, edit the theme files, not individual components.
- Tailwind preflight is off. Layer order (`theme, arco, components, utilities`) means utilities already beat Arco, so **never use the `!` important modifier**.
- Appearance is `system | light | dark`, handled by `useThemePreference`. The `arco-theme` attribute on `<body>` controls dark mode, and native chrome follows through `Platform.setNativeTheme`.
- Arco popups (Tooltip, Dropdown, Popover) need a DOM element or an Arco component as their direct child, because React 19 has no `findDOMNode`. Wrap custom components in a `<span>`.
- Status needs text as well as color. Keep "installed / authenticated / process running / answering" as separate indicators, and keep running state separate from unread counts.
- Enter must not send while an IME composition is active (`event.nativeEvent.isComposing`).
- Entry setup lives in `@nexus/ui/setup` (Arco React 19 adapter, global CSS, early theme application) and must be imported before rendering.
- **Brand**: the logo source of truth is `assets/logos/` (designer-owned; don't edit or reformat it, and Biome ignores it). The in-app mark is `<NexusMark>` / `<NexusAppIcon>` in `packages/ui/src/brand/`. Its paths are copied from `nexus-mark.svg`, and it uses `currentColor` with the `text-brand-mark` token (ink #172924 in light mode, paper #F4F5EF in dark). Use `bg-brand-mint` / `text-brand-ink` for brand surfaces. The UI accent stays Apple systemBlue (`brand`); don't confuse the two.
- View models live in `packages/ui/src/model/` (`types.ts`, `buildTimeline.ts`, `coreStore.ts`). Components receive view models and callbacks; only `Workspace` talks to `CoreStore`.
- Delegation is live (M3, ADR 0008): `DelegateDialog` → `task.delegate`, progress folded into a `DelegationCard`.
- Handoff is live (M4, ADR 0011): `HandoffDialog` → `handoff.prepare` (stops and **verifies** the source, freezes a context package) → `handoff.commit` (CAS on `ownerVersion`). Prompts typed during the review queue and run under the receiver. Never commit a handoff whose source stop was not confirmed.

## Harness adapters & processes

- Spawn with an executable path and an **argv array**. Never build a shell command string from user input.
- Run each Run in its own **process group**. Cancel = SIGINT to the group → SIGTERM → SIGKILL, then verify that no group members are left with `@nexus/proc`'s `terminateProcessGroup` (ADR 0010). `dispose()` returns `{ confirmed, problem }`; never claim a stop you did not verify. (The probe self-test showed that tool subprocesses can survive SIGINT.)
- **Never infer success from terminal text.** If a harness doesn't emit an event, that state is *unknown*, not "done". (A tool still running when its run ends is shown as "结果未知"; a stream that ends without a terminal event becomes `run.failed(no_terminal_event)`.)
- **Never re-run after a restart.** Interrupted runs are closed as `run.failed(interrupted)`; only the user can retry. Shutdown drops adapter terminal events so an interrupted run is never mislabelled `cancelled`.
- **Global run cap**: at most `maxConcurrentRuns` (default 3) harness runs at once; extra prompts wait in a cross-conversation FIFO and are shown as 排队中 (plan §7).
- Adapters get `executablePath` and `env` from core (`CreateSessionOptions`). They never search PATH themselves.
- Gate features on `probe()` capabilities and show unsupported features as disabled with a reason. Never fake them.
- An external session id is only meaningful inside the adapter that created it.
- **Worktree isolation (ADR 0006)**: conversations run in a detached-HEAD worktree under `<userData>/worktrees/<id>` by default when the cwd is a git repo; `direct` mode is opt-in and one directory allows only one direct conversation. `Conversation.cwd` is always the actual run directory — adapters never need to know about isolation.
- GUI apps don't get the shell PATH. Always resolve CLIs through `resolveLoginShellPath()`.
- Record behaviour against real CLI versions in `probes/` first, then copy representative outputs into adapter test fixtures.

## Security

- The renderer is sandboxed (`contextIsolation`, `sandbox`, no `nodeIntegration`). The preload hands over the core port and exposes `platform` and `setTheme` (ADR 0004). Add nothing else without an ADR. Main validates every IPC sender with `isAppUrl` and whitelists the arguments.
- The window may only navigate to the app itself (reloads and HMR are allowed). Everything else is blocked, and external https links open in the browser.
- Core does not listen on any network port. Future local IPC sockets (the collaboration helper) live in the user's directory with mode 0600 and require a per-session token.
- Never log, persist or export secrets (`.env`, API keys, tokens). Diagnostic exports exclude them by default.

## Testing

- Changes to protocol, core logic, state machines, queues, storage or adapters **must include tests**. Pure styling doesn't need them.
- Default to the fake adapter (`@nexus/adapter-fake`). Tests that run real CLIs are named `*.contract.test.ts`, pin a harness version, are excluded from `pnpm test`, and run only through `pnpm test:contract`.
- Adapter mapping tests replay sanitized real recordings (`packages/adapters/<name>/fixtures/*.jsonl`). When adding a fixture, strip host paths, account data and the `system init` message.
- UI changes that affect flows should keep `pnpm e2e:smoke` passing (`scripts/e2e/`).
- Test behaviour through public interfaces. Don't write tests that mirror the implementation.

## Workflow

- One concern per change. Keep diffs small enough to review.
- **Changing `packages/protocol` needs agreement from both developers.** It is the contract between every layer.
- Write significant decisions as an ADR: `docs/decisions/NNNN-title.md` (context, decision, consequences, all short).
- Commit messages use Conventional Commits: `feat(core): …`, `fix(ui): …`, `docs: …`, `chore: …`, `test: …`, `refactor: …`.
- Probes: `help` is free. **Every other scenario spends the developer's model quota, so ask before running them.**
- Don't add dependencies casually. Check maintenance status and size, put internal packages in `devDependencies` of `desktop` (they get bundled), and keep native modules in `dependencies`.
