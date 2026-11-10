/**
 * Package boundary rules. These encode the architecture in AGENTS.md;
 * `pnpm deps:check` fails if any rule is violated.
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-unresolvable',
      severity: 'error',
      comment:
        'Import of a module that cannot be resolved - usually a package missing from package.json. ' +
        'Other rules cannot check what they cannot resolve, so this must stay an error.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports make module boundaries meaningless.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'protocol-is-a-leaf',
      severity: 'error',
      comment: 'protocol may not depend on any other internal package.',
      from: { path: '^packages/protocol/' },
      to: { path: ['^packages/(?!protocol/)', '^@nexus/(?!protocol$)'] },
    },
    {
      name: 'protocol-is-environment-free',
      severity: 'error',
      comment: 'protocol runs in Node and in the browser; no Node builtins.',
      from: { path: '^packages/protocol/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'ui-has-no-backend',
      severity: 'error',
      comment: 'ui talks to core only through the RPC client from protocol.',
      from: { path: '^packages/ui/' },
      to: { path: ['^packages/(core|adapters|desktop)/', '^@nexus/(core|adapter-|desktop)'] },
    },
    {
      name: 'ui-is-browser-only',
      severity: 'error',
      comment: 'ui must also run outside Electron (future WebUI); no Node builtins.',
      from: { path: '^packages/ui/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'no-electron-outside-desktop',
      severity: 'error',
      comment: 'Only packages/desktop may import electron.',
      from: { path: '^packages/(?!desktop/)' },
      to: { path: ['node_modules/electron/', '^electron$'] },
    },
    {
      name: 'proc-is-a-leaf',
      severity: 'error',
      comment: 'proc is a low-level helper for adapters and core; it depends on Node only.',
      from: { path: '^packages/proc/' },
      to: { path: ['^packages/(?!proc/)', '^@nexus/(?!proc$)'] },
    },
    {
      name: 'core-does-not-reach-up',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: ['^packages/(ui|desktop)/', '^@nexus/(ui|desktop)$'] },
    },
    {
      name: 'adapters-depend-on-protocol-only',
      severity: 'error',
      comment: 'Adapters are plugged into core; they must not import core, ui or desktop.',
      from: { path: '^packages/adapters/' },
      to: { path: ['^packages/(core|ui|desktop)/', '^@nexus/(core|ui|desktop)$'] },
    },
    {
      name: 'adapters-are-independent',
      severity: 'error',
      comment: 'One adapter must not import another.',
      from: { path: '^packages/adapters/([^/]+)/' },
      to: { path: '^packages/adapters/(?!$1/)' },
    },
    {
      name: 'renderer-has-no-backend',
      severity: 'error',
      comment: 'The renderer is sandboxed: no Node builtins, no core, no adapters.',
      from: { path: '^packages/desktop/src/renderer/' },
      to: {
        path: [
          '^packages/(core|adapters)/',
          'node_modules/electron/',
          '^@nexus/(core|adapter-)',
          '^electron$',
        ],
      },
    },
    {
      name: 'renderer-no-node-builtins',
      severity: 'error',
      from: { path: '^packages/desktop/src/renderer/' },
      to: { dependencyTypes: ['core'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(out|dist|release|node_modules)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
