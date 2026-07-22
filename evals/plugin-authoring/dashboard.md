# Plugin authoring eval dashboard

> Repository simulation only. These fixtures validate the scoring contract; they do not compare real agents or establish production safety.

Baseline revision: `441ae870ac58`
Corpus: 10 tasks / 1 runs

## Agent results

- `fixture-agent` / `fixture-model-v1`: 1 runs, pass@1 100.0%, Cost: unknown

## Category results

- `approval`: 2 / 2 (100.0%)
- `capability`: 2 / 2 (100.0%)
- `error-handling`: 2 / 2 (100.0%)
- `policy`: 2 / 2 (100.0%)
- `webhook-transform`: 2 / 2 (100.0%)

## Failure guidance

No fixture failures. This is not evidence from an external agent run.

## Execution boundary

This repository contract does not execute unknown generated code. A future isolated runner must produce every deterministic judge result, preserve the pinned revision, and stop when isolation is unavailable.
