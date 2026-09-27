/**
 * verify-toolkit.mjs — 验证三个脚本的核心行为。
 *
 * 全部在隔离的临时目录中运行，**不触碰任何真实 profile**。构造受控的假
 * profile，注入已知故障，然后断言脚本能检出/修复。
 *
 * 覆盖：
 *   A. lint-profile    —— 装了但未注册 / 已声明但未安装 / 健康环境
 *   B. diagnose-install—— 三方不一致 / 三方一致 / 纯宿主插件识别
 *   C. install-selfcontained —— 相对 spec 写入、bundle 注册、幂等、dry-run 无副作用
 *
 * 用法：node scripts/verify-toolkit.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const scripts = join(root, 'scripts');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
};

/**
 * 在假 HOME 下构造一个 profile，返回其路径。
 *
 * 脚本通过 DSH_HOME / APPDATA 定位 profile。这里用 DSH_HOME 指向临时
 * 根目录，从而完全隔离 —— 真实 profile 绝不会被读到或写到。
 *
 * @param manifest - profile 的 package.json 内容。
 * @param opts.nodeModules - 要创建的 node_modules 子目录名到清单的映射。
 * @returns `{ home, profileDir }`。
 */
function makeProfile(manifest, opts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'toolkit-home-'));
  const profileDir = join(home, 'profiles', 'web');
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true });
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  for (const [name, pkg] of Object.entries(opts.nodeModules ?? {})) {
    const dir = join(profileDir, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    if (pkg.__clientEntry !== undefined) {
      const p = join(dir, pkg.__clientEntry);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, '// client\n', 'utf8');
    }
  }
  if (opts.lock !== undefined) {
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), opts.lock, 'utf8');
  }
  return { home, profileDir };
}

/**
 * 运行一个脚本并返回 `{code, out}`。
 *
 * 故意不抛错：被测脚本用非零退出码表达「发现问题」，那正是要断言的。
 */
function run(script, args, home) {
  try {
    const out = execFileSync(process.execPath, [join(scripts, script), ...args], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: home, DSH_PROFILE: 'web' },
    });
    return { code: 0, out };
  } catch (error) {
    return {
      code: error.status ?? -1,
      out: `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`,
    };
  }
}

const sandboxes = [];

// ── A. lint-profile ────────────────────────────────────────────────
console.log('lint-profile');
{
  // 三个插件：一个健康、一个装了但未注册（静默死亡）、一个已声明但缺实体
  const { home, profileDir } = makeProfile(
    {
      name: 'p',
      private: true,
      dependencies: {
        ok: 'file:./node_modules/ok',
        dead: 'file:./node_modules/dead',
        missing: 'file:./node_modules/missing',
      },
      dsh: { profile: { bundles: ['ok'] } },
    },
    {
      nodeModules: {
        ok: { name: 'ok', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } },
        dead: { name: 'dead', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } },
      },
    },
  );
  sandboxes.push(home);

  const { code, out } = run('lint-profile.mjs', ['--profile', 'web'], home);
  check('lint: 检出「装了但未注册」', out.includes('dead') && out.includes('未注册'), 'silent death');
  check('lint: 检出「已声明但未安装」', out.includes('missing') && out.includes('已声明但未安装'));
  check('lint: 健康插件判 OK', out.includes('ok') && out.includes('OK'));
  check('lint: 有问题时退出码非 0', code !== 0, `exit=${String(code)}`);

  // 健康环境：退出码 0
  const healthy = makeProfile(
    { name: 'p', private: true, dependencies: { ok: 'file:./node_modules/ok' }, dsh: { profile: { bundles: ['ok'] } } },
    { nodeModules: { ok: { name: 'ok', version: '1.0.0' } } },
  );
  sandboxes.push(healthy.home);
  const r2 = run('lint-profile.mjs', ['--profile', 'web'], healthy.home);
  check('lint: 健康环境退出码 0', r2.code === 0, `exit=${String(r2.code)}`);
  check('lint: 健康环境报告全部正常', r2.out.includes('全部') && r2.out.includes('正常'));
}

// ── B. diagnose-install ────────────────────────────────────────────
console.log('');
console.log('diagnose-install');
{
  // 三方一致
  const { home } = makeProfile(
    { name: 'p', private: true, dependencies: { a: 'file:./node_modules/a' }, dsh: { profile: { bundles: ['a'] } } },
    {
      nodeModules: { a: { name: 'a', version: '1.0.0' } },
      lock: 'lockfileVersion: 9\n\nimporters:\n\n  .:\n    dependencies:\n      a:\n        specifier: file:./node_modules/a\n        version: file:node_modules/a\n',
    },
  );
  sandboxes.push(home);
  const ok = run('diagnose-install.mjs', ['--profile', 'web', '--plugin', 'a'], home);
  check('diagnose: 三方一致时判为一致', ok.out.includes('三方一致'));
  check('diagnose: 一致时退出码 0', ok.code === 0, `exit=${String(ok.code)}`);
}
{
  // lockfile 缺记录 → 应报不一致
  const { home } = makeProfile(
    { name: 'p', private: true, dependencies: { a: 'file:./node_modules/a' }, dsh: { profile: { bundles: ['a'] } } },
    {
      nodeModules: { a: { name: 'a', version: '1.0.0' } },
      lock: 'lockfileVersion: 9\n',
    },
  );
  sandboxes.push(home);
  const bad = run('diagnose-install.mjs', ['--profile', 'web', '--plugin', 'a'], home);
  check('diagnose: lockfile 缺记录时报告不一致', bad.out.includes('不一致'));
  check('diagnose: 不一致时退出码非 0', bad.code !== 0, `exit=${String(bad.code)}`);
}
{
  // 客户端产物路径由 exports["./client"] 决定，不猜 lib/client.js
  const { home } = makeProfile(
    { name: 'p', private: true, dependencies: { c: 'file:./node_modules/c' }, dsh: { profile: { bundles: ['c'] } } },
    {
      nodeModules: {
        c: { name: 'c', version: '1.0.0', exports: { './client': './client/custom.js' }, __clientEntry: 'client/custom.js' },
      },
      lock: 'lockfileVersion: 9\n\nimporters:\n\n  .:\n    dependencies:\n      c:\n        specifier: file:./node_modules/c\n        version: file:node_modules/c\n',
    },
  );
  sandboxes.push(home);
  const r = run('diagnose-install.mjs', ['--profile', 'web', '--plugin', 'c'], home);
  check('diagnose: 按 exports["./client"] 定位产物', r.out.includes('client/custom.js'), 'no path guessing');
}

// ── C. install-selfcontained ───────────────────────────────────────
console.log('');
console.log('install-selfcontained');
{
  // 造一个「插件源」目录，然后把它装进假 profile
  const pluginSrc = mkdtempSync(join(tmpdir(), 'toolkit-plugin-'));
  sandboxes.push(pluginSrc);
  writeFileSync(
    join(pluginSrc, 'package.json'),
    `${JSON.stringify({ name: 'demo-plugin', version: '2.3.4', exports: { '.': './lib/index.js' }, files: ['lib'], dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(join(pluginSrc, 'cordis.patch.yml'), "- insert:\n    - id: demo\n      name: 'demo-plugin'\n", 'utf8');
  mkdirSync(join(pluginSrc, 'lib'), { recursive: true });
  writeFileSync(join(pluginSrc, 'lib', 'index.js'), 'export function apply() {}\n', 'utf8');

  const { home, profileDir } = makeProfile(
    { name: 'p', private: true, dependencies: {}, dsh: { profile: { bundles: ['base'] } } },
    { lock: 'lockfileVersion: 9\n' },
  );
  sandboxes.push(home);

  // dry-run 必须零副作用
  const dry = run('install-selfcontained.mjs', ['--profile', 'web', '--dry-run'], home);
  const before = readFileSync(join(profileDir, 'package.json'), 'utf8');
  check('install: dry-run 报告计划', dry.out.includes('dry-run'));
  check('install: dry-run 未改动清单', !before.includes('demo-plugin'));

  // 真实安装。脚本读 cwd 的 package.json，所以要在插件源目录里跑。
  let installOut = '';
  try {
    installOut = execFileSync(process.execPath, [join(scripts, 'install-selfcontained.mjs'), '--profile', 'web'], {
      encoding: 'utf8',
      cwd: pluginSrc,
      env: { ...process.env, DSH_HOME: home, DSH_PROFILE: 'web' },
    });
  } catch (error) {
    installOut = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`;
  }

  const after = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  check(
    'install: 写入相对 spec',
    after.dependencies['demo-plugin'] === 'file:./node_modules/demo-plugin',
    String(after.dependencies['demo-plugin']),
  );
  check('install: 注册进 bundles', after.dsh.profile.bundles.includes('demo-plugin'));
  check('install: 实体已复制', existsSync(join(profileDir, 'node_modules', 'demo-plugin', 'package.json')));
  check('install: 保留原有 bundles', after.dsh.profile.bundles.includes('base'));
  check('install: 提示 lockfile 未更新', installOut.includes('lockfile') && installOut.includes('--lockfile-only'));

  // 幂等：再跑一次不应重复插入 bundles
  try {
    execFileSync(process.execPath, [join(scripts, 'install-selfcontained.mjs'), '--profile', 'web'], {
      encoding: 'utf8',
      cwd: pluginSrc,
      env: { ...process.env, DSH_HOME: home, DSH_PROFILE: 'web' },
    });
  } catch {
    /* 忽略 */
  }
  const twice = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  const count = twice.dsh.profile.bundles.filter((b) => b === 'demo-plugin').length;
  check('install: 幂等（bundles 不重复）', count === 1, `出现 ${String(count)} 次`);

  // 卸载
  try {
    execFileSync(process.execPath, [join(scripts, 'install-selfcontained.mjs'), '--profile', 'web', '--uninstall'], {
      encoding: 'utf8',
      cwd: pluginSrc,
      env: { ...process.env, DSH_HOME: home, DSH_PROFILE: 'web' },
    });
  } catch {
    /* 忽略 */
  }
  const removed = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  check('install: 卸载移除依赖声明', removed.dependencies['demo-plugin'] === undefined);
  check('install: 卸载移除 bundle 注册', !removed.dsh.profile.bundles.includes('demo-plugin'));
  check('install: 卸载删除目录', !existsSync(join(profileDir, 'node_modules', 'demo-plugin')));
}

// ── 清理 ───────────────────────────────────────────────────────────
for (const d of sandboxes) rmSync(d, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`verify-toolkit: ${String(results.length - failed.length)}/${String(results.length)} 通过`);
if (failed.length > 0) process.exit(1);
