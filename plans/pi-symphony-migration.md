# Migration plan: incorporate `pi-symphony` into `pi-skills-extensions`

## Goal

Bring [pi-symphony](https://github.com/NicoPowers/pi-symphony) into this repository so operators install **one** Pi package (`pi-skills-extensions`) instead of maintaining two decoupled GitHub repos for engineering skills and the Symphony scheduler.

This package remains **Linear-first** for issue tracking; planning feedback should go through **Plannotator** when creating or revising migration steps or operational runbooks (not GitHub Issues).

## Current inventory

### `pi-skills-extensions` (this repo)

| Area | Contents |
| --- | --- |
| `skills/engineering/` | Matt Pocock–style engineering skills |
| `prompts/`, `themes/` | Prompt templates and themes |
| `extensions/` | Empty slot today |
| `package.json` | `pi-package` with `./extensions`, `./skills`, `./prompts`, `./themes` |

### `pi-symphony` (source repo)

| Area | Contents |
| --- | --- |
| `extensions/symphony.ts` | Pi extension entry (`main` in upstream `package.json`) |
| `skills/symphony/` | Skill content for Symphony operators |
| `src/` | Scheduler/orchestrator (`config.ts`, `linear.ts`, `orchestrator.ts`) |
| `tests/` | Vitest suite |
| `workflow-templates/` | Four `*.WORKFLOW.md` Linear templates |
| `docs/` | Spec conformance and operational docs |
| `CONTEXT.md`, `WORKFLOW.md` | Repo-local docs |

Upstream declares runtime deps `liquidjs`, `yaml`; build/test via `tsc` + `vitest`; peers on Pi coding agent stack.

## Target end state

1. **Single install surface**: `pi install https://github.com/NicoPowers/pi-skills-extensions` ships Symphony plus engineering skills, prompts, and themes.
2. **Clear ownership**: Symphony code lives under predictable paths (see below); workflow templates and docs ship beside it.
3. **Dependencies merged safely**: Root `package.json` gains Symphony’s `dependencies`, `scripts`, and `peerDependencies`.

### Proposed tree (after merge)

```
extensions/
  symphony.ts              ← from pi-symphony
skills/
  engineering/               ← existing
  symphony/                  ← from pi-symphony
src/                         ← from pi-symphony (scheduler)
tests/                       ← from pi-symphony
workflow-templates/          ← from pi-symphony
docs/symphony/               ← all Symphony markdown from upstream `docs/` plus ported README material
```

Namespace Symphony docs under `docs/symphony/` so future extensions can own sibling folders (for example `docs/<extension>/`) without collisions.

Consolidate upstream Symphony `README.md` content into the **root** `README.md` with a full Symphony section (install, Linear, Sandbox, `pi --symphony`, templates). This repo is optimized for your multi-machine operator setup; anyone who wants skills alone can copy skill folders out of the repo.

## Phased migration

### Phase 1 — Mechanical vendoring (no behavior change)

1. Copy into this repo: `extensions/symphony.ts`, `skills/symphony/`, `src/`, `tests/`, `workflow-templates/`, upstream `docs/` → **`docs/symphony/`**, and upstream `tsconfig.json` if required by `tsc`.
2. Merge `package.json`:
   - Union `dependencies` / `peerDependencies` / `devDependencies`.
   - Add `"main"` if Pi or tooling expects the extension entry (mirror upstream `main`: `extensions/symphony.ts`).
   - Merge `scripts`: `build`, `test` from pi-symphony; ensure `pi.extensions` still globs TS under `extensions/` (align with Pi’s discovery rules — today `./extensions`; confirm Symphony’s nested layout matches).
3. Run `npm install`, `npm run build`, `npm test` locally; fix path or TS resolution issues.

### Phase 2 — Documentation, CI, and operator UX

1. Update root `README.md` with a **complete** Symphony section: prerequisites (`LINEAR_API_KEY`, `/linear-tools-config`), Docker Sandbox (`sbx`), `pi --symphony`, pointers to `workflow-templates/` and `docs/symphony/`.
2. Cross-link spec material from `docs/symphony/` (for example `docs/symphony/SPEC_CONFORMANCE.md`).
3. Replace any generic “issue tracker” wording with **Linear** where Symphony is described; avoid GitHub Issues as the workflow source of truth.
4. Note **Plannotator**: structural planning for this migration and future Symphony changes should be reviewed through Plannotator’s UI.
5. **CI (GitHub Actions)**: add `.github/workflows/ci.yml` (or equivalent) running on `push` and `pull_request` to `main` (adjust branches if needed):
   - `npm ci`
   - `npm run build`
   - `npm test`
   Use the active LTS Node version (pin with `actions/setup-node` and a `.nvmrc` or `node-version` file if helpful). Fail the job if any step fails.

### Phase 3 — Deprecation of standalone repo

1. After the first tagged release that includes Symphony, bump **`package.json` major version** (treat Symphony-in-package as a materially expanded Pi surface), then mark `pi-symphony` README as **deprecated** with redirect to `pi-skills-extensions` and migration commands.
2. Optionally archive `pi-symphony` or keep it read-only for historical hashes.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Experimental upstream surface area (Docker Sandbox, scheduler) | Keep upstream warnings in docs; gate Symphony sections in README behind clear prerequisites. |
| Duplicate or conflicting Pi extension names | Ensure only one `symphony` extension path; run Pi locally with `pi list` after merge. |
| No automated verification before merge | Land CI in Phase 2 so every PR runs `npm ci`, `npm run build`, `npm test`. |

## Verification checklist

- [ ] `pi install` from this repo exposes Symphony extension and skills.
- [ ] `npm run build` and `npm test` pass locally and in CI.
- [ ] GitHub Actions CI runs on push/PR and executes `npm ci`, `npm run build`, `npm test`.
- [ ] `workflow-templates/` paths in docs resolve in-repo.
- [ ] Symphony docs live under `docs/symphony/` with correct internal links.
- [ ] Linear-only narrative in user-facing docs; Plannotator called out for plan review.

## Resolved decisions (from Plannotator)

1. **Docs layout**: use `docs/symphony/` for all Symphony documentation so additional extensions can add sibling folders later.
2. **README depth**: root `README.md` should include full Symphony documentation; skills-only consumption is out of scope (skills can be copied manually).
3. **Versioning**: ship Symphony with a **major** version bump.
4. **CI**: add GitHub Actions running `npm ci`, `npm run build`, `npm test` on push/PR.

---

*Re-submitted for Plannotator review after incorporating feedback.*
