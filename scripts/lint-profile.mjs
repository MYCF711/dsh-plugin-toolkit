/**
 * lint-profile.mjs — 校验整个 profile 的插件装载状态，找出「装了但没生效」的插件。
 *
 * ── 为什么需要它（不是规范，是判据） ────────────────────────────────
 *
 * `dsh-app-boot` 的 profile 模块注释写明插件树的构成方式：
 *
 *   > the tree is composed by applying each bundle's patch lists in
 *   > `dsh.profile.bundles` order over an empty entry list
 *
 * 即：**树从空列表开始，只按 `dsh.profile.bundles` 逐条叠加。**
 *
 * 推论很硬：一个包即使装在 `node_modules`、即使清单里声明了
 * `dsh.bundle.patch`，只要名字不在 `bundles` 里，宿主**根本不会看它** ——
 * 不是加载失败，是压根没进入加载流程。依赖声明、lockfile、实体目录
 * 三者全都正常，插件却是死的。退出码不会报，日志不会响，人眼看不出。
 *
 * 本机实测到的实例：dsh-essence、dsh-wb-fusion 装了数月，从未运行过一次，
 * 在 `dsh --dump-config` 的合成树里出现 0 次（正常插件 2–3 次）。
 *
 * 所以这个脚本不做「建议」，只做对账：把每个依赖项的四种状态摆出来，
 * 让静默失效变成一条显式告警。谁跑都一样，不依赖任何人记得什么。
 *
 * 用法：
 *   node scripts/lint-profile.mjs                 # 默认 web
 *   node scripts/lint-profile.mjs --profile tui
 *   node scripts/lint-profile.mjs --json          # 机器可读
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const profileName = flag('profile', 'web');
const asJson = has('json');

// ── 定位 profile ───────────────────────────────────────────────────
/** 从 DSH_HOME 或默认 launcher 布局定位 profile 目录。 */
function findProfileDir(name) {
  const candidates = [];
  if (process.env.DSH_HOME !== undefined) {
    candidates.push(join(process.env.DSH_HOME, 'profiles', name));
  }
  if (process.env.APPDATA !== undefined) {
    const homes = join(process.env.APPDATA, 'in.dsh-plug.dsh-launcher', 'homes');
    if (existsSync(homes)) {
      for (const ver of readdirSafe(homes)) candidates.push(join(homes, ver, 'profiles', name));
    }
  }
  return candidates.find((c) => existsSync(c));
}

/** readdirSync 的安全包装，目录不可读时返回空数组。 */
function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const profileDir = findProfileDir(profileName);
if (profileDir === undefined) {
  console.error(`找不到 profile "${profileName}"`);
  process.exit(1);
}

// 清单必须无防护地解析**会自毁** —— 清单坏掉正是本工具要报告的情形之一。
// 旧版在这里裸跑 JSON.parse，于是损坏的 profile 会让 lint 自己崩掉，
// 报不出任何有用信息。改为先做致命项检查、再尽力解析供后续表格使用。
const manifestPathEarly = join(profileDir, 'package.json');
let manifest = null;
let manifestFatal = null;
try {
  const raw = readFileSync(manifestPathEarly, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    manifestFatal = 'profile 清单不是 JSON 对象';
  } else {
    manifest = parsed;
  }
} catch (error) {
  manifestFatal = `profile 清单无法解析：${String(error)}`;
}

if (manifest === null) {
  // 清单不可用：插件表格无从谈起，只报这一条致命项并退出。
  const fatalEntry = { what: manifestFatal, path: manifestPathEarly };
  if (asJson) {
    console.log(JSON.stringify({ profileDir, fatal: [fatalEntry] }, null, 2));
    process.exit(1);
  }
  console.log(`profile : ${profileDir}`);
  console.log('');
  console.log('发现 1 个致命项 —— 这会让 DSH 直接打不开：');
  console.log('');
  console.log(`· ${String(manifestFatal)}`);
  console.log(`  文件：${manifestPathEarly}`);
  console.log('');
  console.log('修复：用备份覆盖回去，例如同目录下的 package.json.bak-* 。');
  process.exit(1);
}

const deps = manifest.dependencies ?? {};
const bundles = manifest.dsh?.profile?.bundles ?? [];

// ── 逐项对账 ───────────────────────────────────────────────────────
/**
 * 一个依赖项的完整装载状态。
 *
 * 判定「装载」只看两件事，二者缺一即为静默失效：
 *   · 名字在 dsh.profile.bundles 里（唯一决定加载的依据）
 *   · node_modules 里有实体
 */
function inspect(name) {
  const spec = String(deps[name]);
  const dir = join(profileDir, 'node_modules', name);
  const present = existsSync(dir);

  let isLink = false;
  let version;
  let declaresBundle = false;
  let clientEntry;
  let clientPresent;
  if (present) {
    isLink = (lstatSync(dir).mode & 0o170000) === 0o120000;
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      const p = JSON.parse(readFileSync(pj, 'utf8'));
      version = p.version;
      declaresBundle = p.dsh?.bundle?.patch !== undefined;
      clientEntry = p.exports?.['./client'];
      // 产物路径以清单声明为准，不猜目录结构。
      if (typeof clientEntry === 'string') clientPresent = existsSync(join(dir, clientEntry));
    }
  }

  const inBundles = bundles.includes(name);
  const isLocal = spec.startsWith('file:') || spec.startsWith('link:');
  const isRemote = !isLocal;

  // 远程依赖由 pnpm 负责，不在本脚本职责内（bundles 里通常也没有）。
  // 只对本地插件做严格判定：本地插件必须显式登记。
  const silentDeath = isLocal && present && !inBundles;
  const declaredButMissing = isLocal && !present;
  const bundleMissing = inBundles && !present;

  return {
    name,
    spec,
    isLocal,
    isRemote,
    present,
    isLink,
    version,
    declaresBundle,
    inBundles,
    clientEntry,
    clientPresent,
    silentDeath,
    declaredButMissing,
    bundleMissing,
  };
}

const all = Object.keys(deps).map(inspect);
const locals = all.filter((r) => r.isLocal);
const problems = locals.filter((r) => r.silentDeath || r.declaredButMissing || r.bundleMissing);

// ── profile 自身的致命项 ───────────────────────────────────────────
//
// bundle 层与用户 patch 层的容错**完全不同**，这是实机验证出来的：
//
//   · bundle 解析失败（读不到、无 dsh.bundle、自带 patch 有语法错）
//     → 被 dsh-app-boot 的 try/catch 吞掉，只打印 `skipping profile bundle`
//     → **不影响启动**（实测 exit 0）
//
//   · profile 的 package.json 非法 / 读不到
//   · profile 的 cordis.patch.yml 非法 / 读不到
//     → 源码里是裸 throw，没有任何 catch
//     → **进程直接死，DSH 打不开**（实测抛错、无输出）
//
// 所以「往 profile 目录里粘贴东西导致 DSH 打不开」，真实机制几乎总是
// 后者：粘贴覆盖或破坏了 profile 根目录的 cordis.patch.yml。这些检查
// 正是为了在启动之前拦住它 —— 一旦启动失败，人已经进不去界面了。
const fatal = [];

{
  const patchPath = join(profileDir, 'cordis.patch.yml');
  if (existsSync(patchPath)) {
    let text = null;
    try {
      text = readFileSync(patchPath, 'utf8');
    } catch (error) {
      fatal.push({ what: `profile patch 层读不到：${String(error)}`, path: patchPath });
    }
    if (text !== null) {
      // 只做「顶层必须是 YAML 数组」这一条结构检查 —— 不引 yaml 依赖，
      // 因为这一条正是 dsh 抛错的两个条件之一（另一条是 YAML 语法错误）。
      // 语法层无法在此完全复刻，但顶层形状错误（例如整份文件被覆盖成
      // 一个映射）是最常见的粘贴事故，能被这条抓到。
      const stripped = text
        .split('\n')
        .filter((line) => !/^\s*#/.test(line) && line.trim() !== '')
        .join('\n');
      if (stripped !== '' && !/^\s*-/.test(stripped)) {
        fatal.push({
          what:
            'profile patch 层顶层不是 YAML 数组（dsh 要求 top-level YAML array）。' +
            '这会让启动直接抛错 —— 常见于该文件被粘贴内容覆盖。',
          path: patchPath,
        });
      }
    }
  }
}

if (asJson) {
  console.log(
    JSON.stringify({ profileDir, bundles: bundles.length, plugins: all, problems, fatal }, null, 2),
  );
  process.exit(problems.length > 0 || fatal.length > 0 ? 1 : 0);
}

// ── 报告 ───────────────────────────────────────────────────────────
console.log(`profile : ${profileDir}`);
console.log(`依赖项  : ${String(all.length)}（本地 ${String(locals.length)}，远程 ${String(all.length - locals.length)}）`);
console.log(`bundles : ${String(bundles.length)} 项`);
console.log('');

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('插件', 32)}${pad('实体', 6)}${pad('bundles', 9)}${pad('版本', 12)}状态`);
console.log('-'.repeat(80));
for (const r of all) {
  let state = 'OK';
  if (r.silentDeath) state = '!! 装了但未注册 — 不会生效';
  else if (r.declaredButMissing) state = '!! 已声明但未安装';
  else if (r.bundleMissing) state = '!! 已注册但缺实体';
  else if (r.isRemote && !r.inBundles) state = '（远程依赖，由 pnpm 管理）';

  console.log(
    `${pad(r.name, 32)}${pad(r.present ? (r.isLink ? '链接' : '实体') : '-', 6)}` +
      `${pad(r.inBundles ? '是' : '否', 9)}${pad(r.version ?? '-', 12)}${state}`,
  );
}

console.log('');
if (fatal.length > 0) {
  console.log(`发现 ${String(fatal.length)} 个致命项 —— 这些会让 DSH 直接打不开：`);
  console.log('');
  for (const f of fatal) {
    console.log(`· ${f.what}`);
    console.log(`  文件：${f.path}`);
  }
  console.log('');
  console.log('这一层与 bundle 层不同：bundle 解析失败只会被跳过，而 profile 清单');
  console.log('与用户 patch 层出错是裸抛异常，会直接终止启动。');
  console.log('修复：用备份覆盖回去，例如同目录下的 cordis.patch.yml.bak-* 。');
  console.log('');
}

if (problems.length === 0) {
  console.log(
    fatal.length === 0
      ? `全部 ${String(locals.length)} 个本地插件装载正常。`
      : `插件装载无异常，但有 ${String(fatal.length)} 个致命项（见上）。`,
  );
  process.exit(fatal.length > 0 ? 1 : 0);
}

console.log(`发现 ${String(problems.length)} 个问题插件：`);
console.log('');
for (const r of problems) {
  console.log(`· ${r.name}`);
  if (r.silentDeath) {
    console.log('  状态：实体已安装、依赖已声明，但名字不在 dsh.profile.bundles 中。');
    console.log('  后果：宿主从空列表构树，不会加载它。没有报错，没有日志，看起来一切正常。');
    console.log('  修复：node scripts/install-selfcontained.mjs --profile ' + profileName);
  }
  if (r.declaredButMissing) {
    console.log('  状态：dependencies 里有声明，node_modules 里没有实体。');
    console.log('  修复：node scripts/install-selfcontained.mjs --profile ' + profileName);
  }
  if (r.bundleMissing) {
    console.log('  状态：dsh.profile.bundles 里有名字，但 node_modules 里没有实体。');
    console.log('  后果：启动时解析不到该 bundle，可能直接失败。');
  }
  console.log('');
}
console.log('注意：以上修复只改 profile 的 package.json 与 node_modules，不经过 pnpm。');
process.exit(1);
