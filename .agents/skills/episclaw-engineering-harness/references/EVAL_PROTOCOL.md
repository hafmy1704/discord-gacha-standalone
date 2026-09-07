# Harness Evaluation Protocol

Use this protocol when changing the harness itself. Structural validation alone does not prove behavioral usefulness.

## Evaluation layers

### 1. Static validation

- validate frontmatter and folder naming;
- verify every local Markdown link;
- reject orphan runtime references unless explicitly exempted;
- parse every Python helper;
- confirm examples use `<skill-root>` rather than assuming project-relative helper paths.

Run:

```text
python "<skill-root>/scripts/harness_validate.py" "<skill-root>"
python "<skill-root>/scripts/eval_cases.py" validate "<skill-root>/evals/cases.json"
```

### 2. Script tests

Run the bundled unit/integration tests on every supported host available:

```text
python -m unittest discover -s "<skill-root>/tests" -v
```

Minimum behaviors:

- Git snapshot detects upstream/default branch without assuming `master`;
- scope guard includes committed, staged, unstaged, and untracked paths;
- dot-prefixed paths remain distinct;
- an unconfigured scope policy cannot report PASS;
- common evidence-secret shapes are redacted, and hash-chain verification detects unrecomputed edits or accidental corruption without claiming authenticated tamper resistance;
- mission graph rejects invalid transitions and records valid loops;
- schema-v1 missions migrate on first write;
- concurrent expected-revision transitions cannot lose history;
- checkpoint/resume rehydrates the capsule and detects repository drift.

### 3. Trigger evaluation

Maintain realistic prompts in `evals/cases.json` with expected activation:

- production concurrency incident → activate HIGH;
- ordinary bug fix → activate STANDARD;
- typo/docs-only edit → activate LIGHT or do not activate automatically;
- generic design discussion → do not force implementation gates;
- non-EpisClaw provider project → do not load EpisClaw invariants;
- review-only request → do not mutate.
- post-compaction resume → verify capsule/repository before mutation;
- stale checkpoint → return to PREFLIGHT;
- concurrent mission writers → use revision fencing.

Measure false positives and false negatives separately.

Validate packaged cases strictly with `scripts/eval_cases.py`. Store externally produced trial outcomes as JSONL with exactly `case_id`, `model`, `host`, `timestamp`, actual `activation`, `tier`, `mode`, and an `observable_results` object containing every case observable exactly once with a boolean result. Repeated case IDs are expected for stochastic trials; the tuple `(case_id, model, host, timestamp)` must remain unique. Summarize without claiming the script judged natural-language behavior:

```text
python "<skill-root>/scripts/eval_cases.py" summarize "<skill-root>/evals/cases.json" <results.jsonl>
```

### 4. Behavior evaluation

For each high-value rule, compare:

1. baseline agent without the harness;
2. agent with the harness;
3. pressure variants involving urgency, sunk cost, incomplete evidence, and owner encouragement.

Score observable decisions rather than exact wording:

- identified descriptive/normative conflict;
- selected proportional tier;
- reproduced or recorded a valid exception;
- patched the responsible seam;
- did not overclaim runtime/deployment/external success;
- respected mutation authority;
- dispositioned reviewer findings;
- avoided importing EpisClaw constraints into unrelated repositories.

### 5. Variance and regression

Run multiple trials when model behavior is stochastic. Record model, host, date, prompt, tool availability, outcome, and failure mode. A harness change is ready when it improves target decisions without materially increasing false activation or blocking low-risk work.

Do not claim cross-agent portability until the same cases pass on each named agent family.

The bundled evaluator validates case/result structure and computes supplied outcomes. It does not run an agent, judge an observable, or prove portability by itself. Independent forward-testing remains required for generalized behavioral claims.
