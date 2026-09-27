# dsh-plugin-toolkit

> Diagnose and repair DSH plugin loading.

[简体中文](README.zh-CN.md) | **English**

Three standalone scripts for the failure modes that make DSH plugins **install but never run**. No dependencies, no build step — plain Node.

They exist because these failures are silent: the exit code is often 0, nothing is logged, and the plugin simply does nothing.

---

## The three failures

| Failure | Symptom | Tool |
|---|---|---|
| **Half-installed state** — the package entity is in `node_modules` but the dependency declaration or bundle registration is missing | "it installed but the plugin doesn't work" | `install-selfcontained` |
| **Three-way disagreement** — `package.json`, `pnpm-lock.yaml` and `node_modules` contradict each other | an install that half-succeeded, or a `--frozen-lockfile` failure later | `diagnose-install` |
| **Silent death** — installed, declared, present on disk, **but the name is not in `dsh.profile.bundles`** | nothing at all. No error, no log | `lint-profile` |
| **Won't start at all** — the profile manifest or the profile's own `cordis.patch.yml` is malformed | DSH dies during startup; you cannot reach the UI to fix it | `lint-profile` |

The third is the most dangerous and was found in the wild on this machine: **two plugins had been dead for months**. They were installed, their manifests declared `dsh.bundle.patch`, they were real directories — and they had never once run.

The reason is in `dsh-app-boot`'s own module documentation:

> the tree is composed by applying each bundle's patch lists in `dsh.profile.bundles` order **over an empty entry list**

The tree starts empty and is built only from `bundles`. A package not named there is never even looked at.

---

## Tools

### `lint-profile.mjs` — find plugins that never run

```powershell
node scripts/lint-profile.mjs                  # profile defaults to web
node scripts/lint-profile.mjs --profile tui
node scripts/lint-profile.mjs --all            # every local plugin
node scripts/lint-profile.mjs --json
```

Reconciles every dependency against four facts and prints one table:

```
插件                              实体    bundles  版本          状态
dsh-sovereign                   实体    是        0.4.0       OK
dsh-essence                     实体    否        0.1.0       !! 装了但未注册 — 不会生效
```

Exit code 0 when clean, 1 when anything is wrong — usable from CI.

It also checks the two failure modes that stop DSH from starting at all — the profile manifest and the profile's own `cordis.patch.yml`. Those two are reported separately as **fatal items**, because the tolerance differs sharply between layers:

| Where it breaks | What happens |
|---|---|
| A **bundle** (a plugin's own patch, missing file, no `dsh.bundle`) | caught and skipped — `skipping profile bundle`, **startup continues** (measured: exit 0) |
| The **profile manifest** or the **profile's `cordis.patch.yml`** | a bare `throw` with no catch — **the process dies** (measured) |

That asymmetry is why "pasting files into the profile directory breaks DSH" almost always means the paste overwrote or damaged the profile's own `cordis.patch.yml`. This check exists so you find out *before* starting the server — once startup fails, you cannot reach the UI to repair it.

The tool itself is hardened against a corrupt manifest: an earlier version parsed the manifest unguarded and died on exactly the input it was meant to report.

### `diagnose-install.mjs` — reconcile three sources

```powershell
node scripts/diagnose-install.mjs                    # the package in cwd
node scripts/diagnose-install.mjs --plugin <name>
node scripts/diagnose-install.mjs --all
```

Compares the dependency declaration, the lockfile entry, and what is actually on disk — including **whether the installed copy is a real directory or a symlink**. Client artefacts are located through the manifest's declared `exports["./client"]`, not a guessed path, so plugins that put their bundle in `./client.js` or `./client/client.js` are handled correctly.

### `install-selfcontained.mjs` — install without invoking pnpm

```powershell
node scripts/install-selfcontained.mjs --profile web
node scripts/install-selfcontained.mjs --profile web --dry-run
node scripts/install-selfcontained.mjs --profile web --uninstall
```

Does exactly three things, and nothing else:

1. copies the entity into `profile/node_modules/<name>/`
2. writes `dependencies[name] = "file:./node_modules/<name>"` — a **relative** spec
3. adds `<name>` to `dsh.profile.bundles`

Relative spec plus a real directory means **the whole profile can be moved anywhere** and the dependency still resolves. Absolute `file:` paths and `link:` specs both break on relocation.

**Known trade-off, reported rather than hidden:** because this bypasses pnpm, `pnpm-lock.yaml` is not updated. The script detects that and prints the exact command to reconcile it. Skipping it silently leaves a profile where `pnpm install --frozen-lockfile` fails later.

---

## Install of the tools themselves

Nothing to install — run the scripts directly from a checkout:

```powershell
git clone https://github.com/MYCF711/dsh-plugin-toolkit
cd dsh-plugin-toolkit
node scripts/lint-profile.mjs
```

---

## Verified behavior

```powershell
npm run verify      # 28 checks
```

All run in isolated temporary directories. **No real profile is touched.**

Coverage includes: detecting a plugin that is installed but unregistered; a declared-but-absent dependency; a registered-but-absent entity; a healthy profile reporting clean; `install-selfcontained` writing a relative spec and registering the bundle; and `--dry-run` making no changes at all.

---

## Context and token cost: zero

None of these are DSH plugins. They are command-line scripts you run yourself. Nothing is registered with the runtime, nothing touches the prompt, nothing runs automatically.

The one DSH-side companion worth having is [dsh-plugin-doctor](https://github.com/MYCF711/dsh-plugin-doctor), which pins a working pnpm version at startup — also zero prompt cost.

---

## Why these exist

Every failure above was hit on a real machine, diagnosed from the DSH source rather than guessed at. The notes in each script's header record what was measured and what was tried and rejected, so the reasoning survives.

---

## License

[MIT](LICENSE) © 2026 MYCF711
