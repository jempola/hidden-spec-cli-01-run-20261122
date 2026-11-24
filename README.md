# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jempola/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jempola/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats: a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON. This tool reads all four to one written specification, finds the lines
an edit names even when the model drifted their whitespace or indentation, and
changes every file or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## Matching

An edit's old lines are found at the first of three tiers at which they occur
at least once: tier 0, every line equal; tier 1, every line equal once
trailing spaces and tabs are removed from both; tier 2, every line equal once
leading and trailing spaces and tabs are removed from both. Context lines are
written as the file's own matched lines, and at tier 2 new lines are
re-indented from the patch's indentation to the file's.

## Exit codes

- `0`: the tree is written. One line per changed path (`A`, `D`, `M`, or
  `R old -> new` for a move), then `ok: <n> files`.
- `1`: nothing written. One `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`.
- `2`: nothing written, exactly one line: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the
  checks from the env, runs `node main.ts` on each one in a fresh directory,
  and posts what it did.
- `check.ts`: the practice set on your own machine:

      node check.ts ../program/generator/practice.json

- `SPEC.md`: the specification — the whole contract.
- `LICENSE`: MIT.

## Practice

100/100 practice checks pass locally (see `check.ts`), which is the score the
dev board shows for a submission. The scored checks are drawn after the
deadline from a sealed pool that includes kinds the practice set does not
show, each testing a sentence of SPEC.md; this implementation follows SPEC.md
sentence by sentence rather than fitting the practice set.

---

<sub>Entered on [make.fun](https://make.fun/?ref=9fsyewfc&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
