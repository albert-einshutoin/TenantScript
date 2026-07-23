# Judge image review records

This directory binds a judge image candidate to the immutable source, CI, artifact, SBOM, and review
observations that actually produced it. The JSON records are checked by
`scripts/check-judge-image-review-records.mjs`; unknown fields, identity drift, incomplete checks, and
approval claims fail closed.

The pull-request head and the workflow merge revision are intentionally separate. GitHub reviews the
head revision, while a `pull_request` workflow builds the temporary merge revision exposed as
`github.sha`. The evidence file stored beside each record is the bounded summary downloaded from the
named Actions artifact. Its digest is checked before any fields are trusted. The adjacent
`.artifact.json` file is a bounded projection of the GitHub Artifact API observation; it independently
binds artifact ID, name, digest, size, retention timestamps, workflow run, and PR head to the record.

Every current record remains `candidate`. A successful Tier 1 run and a Codex review are repository
evidence, not an independent security review or a production approval. `attestation`,
`independent-review`, and `registry-digest` must remain blockers until separately verified evidence
exists. Artifact expiry affects download availability; it does not change the recorded digest or turn
the candidate into an approved image.
