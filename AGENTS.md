# AGENTS.md

<!-- ai-rulebook:start -->
<!-- Managed by the AI Rulebook extension. Text between the ai-rulebook markers is regenerated on install; toggle rules from the AI Rulebook sidebar instead of editing here. -->

<!-- ai-rulebook:rule code enabled -->

## Code

- Before adding a helper, search for an existing one. Reuse or extend rather than adding a near-duplicate.
- Place new code with the feature it belongs to. Use established module boundaries and public entry points where they exist.
- Prefer the standard library or an already-present dependency over adding a new one; flag any new dependency in your report.
- Before adding a dependency, check maintenance status, runtime compatibility, and known security issues. Do not add prerelease, archived, or deprecated dependencies, dependencies with known unmitigated vulnerabilities, or ones requiring an EOL runtime. Treat release age as a reason to investigate, not proof of abandonment. Flag existing dependency issues encountered in the task; don't migrate them unasked.
- Validate input that crosses a trust boundary (user input, network, files, environment). Never log or commit secrets. Add actionable context when propagating errors across boundaries; preserve the original cause. Do not silently discard failures.

<!-- ai-rulebook:end-rule code -->

<!-- ai-rulebook:rule docs enabled -->

## Docs

- Update existing documentation when the change makes it inaccurate, including usage, configuration, requirements, architecture, and development commands.
- Follow the project's documentation layout and conventions. If none exist, keep platform-read files at the root and other documentation under `docs/`, linked from `README.md`.
- Add user-facing release notes for release-worthy changes. Follow the existing changelog format; describe visible behavior and skip internal refactors.
- Create new documentation only when requested or necessary to explain the changed behavior. Do not introduce a new documentation framework without being asked.

<!-- ai-rulebook:end-rule docs -->

<!-- ai-rulebook:rule git enabled -->

## Git

- Inspect the working tree before editing. Preserve changes you did not make.
- Don't commit, push, or create branches unless asked.
- When asked to commit, stage only your task's changes, using selective hunks
  where files contain unrelated edits — never a blind `git add -A`. Inspect
  the staged diff before committing. Write an imperative subject line with
  a body that says why.
- Never force-push, rebase, amend, or reset away pushed history unless the
  user explicitly names that operation.

<!-- ai-rulebook:end-rule git -->

<!-- ai-rulebook:rule markdown enabled -->

## Markdown

When editing `.md` files:

- One H1; never skip heading levels.
- `-` for bullets; language tag on every fence.
- Inline code for paths, commands, and filenames.
- Relative links for in-repo targets.

<!-- ai-rulebook:end-rule markdown -->

<!-- ai-rulebook:rule scope enabled -->

## Scope

- Before editing, inspect the relevant implementation, tests, and project commands. Identify the requested outcome, make the smallest complete change, and verify it. Continue until complete or blocked by a concrete dependency.
- Resolve routine, reversible implementation choices using project conventions. Ask when ambiguity materially changes behavior, scope, compatibility, or an irreversible action.
- Change only what the task requires. No drive-by refactors, renames, reformatting, or version bumps.
- Tests and documentation for the change itself are part of the task, never drive-by work.
- Follow local naming, formatting, and structural conventions. Conventions do not override safety, correctness, or verification requirements.
- If a rule implies work outside the task, state it and move on — don't act on it.
- An unrelated bug or dead code you notice gets reported, not fixed.

<!-- ai-rulebook:end-rule scope -->

<!-- ai-rulebook:rule tests enabled -->

## Tests

- For behavior changes, add or update a test at the level that exercises the requirement. For bug fixes, first reproduce the failure with a regression test when feasible. Test observable behavior rather than implementation details.
- Match the project's existing test file location and naming convention. If none exists, colocate tests with the source using the ecosystem's standard suffix (e.g. `foo.test.ts`, `foo_test.go`).
- After behavior changes, run the project's test command.
- Run the project's existing lint and type checks before reporting done; fix what you introduced. If no linter is configured, recommend one suited to the project and explain its benefit. Add or configure it only when requested or approved. Never disable lint checks merely to obtain a pass.
- Do not weaken checks merely to obtain a pass. When a requirement intentionally changes, update obsolete expectations and explain the change. Preserve coverage of behavior that remains required.
- Before reporting completion, inspect the final diff for unintended changes, debug code, secrets, and missing generated artifacts.
- State what changed, which checks ran and their results, and any remaining blockers. Report every failing test and every relevant check not run. Distinguish observed results from assumptions; never describe an unrun test as passing.

<!-- ai-rulebook:end-rule tests -->
<!-- ai-rulebook:end -->
