# AI delivery acceptance plan

**Goal:** Continue optimization until the existing delivery gate is actually satisfied; do not weaken the gate.

**Requirements:** Kaggle CPU for parameter training and large-scale evaluation; acting seat's public observation only; authoritative legality and 108-card conservation; wildcard declaration preservation; 256 inference candidates; reproducible source/model/configuration hashes; complete paired records; functioning provider and user-facing deliverables without credentials.

**Gate:** At least 200 independent deal pairs, team head rate >=55%, two-sided 95% Hoeffding lower bound >50%. Upgrades must be reported, and regressions relative to the frozen model must not be hidden.

**Architecture:** Existing v017 model proposes actions, public-memory Monte Carlo compares candidates through full-match rollouts. v020 stays frozen as a validation reference. Three advanced configurations are fixed before examining new results: rules-ensemble (24 samples,6 candidates,48 total,12 own), rules-wide and model-wide (24,6,64,16). Same utility and override criterion as v020; two neural proposals; rules/model baseline respectively. No local training.

- [x] Inspect current authoritative code and v020 result: 54.58%, gate false.
- [x] Add failing regression tests, implement offered neural proposals and fixed variants.
- [x] Pass strict TypeScript, existing search/model/engine regression and integration checks.
- [ ] Private cloud tournament: all four variants on 160 pairs at offset7500000. Select by head wins, then upgrade, then earlier variant on exact ties.
- [ ] If selected validation head rate >=55%, evaluate once on frozen independent 2000 pairs at offset8000000. Otherwise preserve acceptance set and continue improving.
- [ ] Independently verify hashes, all seeds/parity swaps, aggregates, uncertainty, legality, and frozen gate. Failed acceptance remains failed; any later model requires fresh acceptance seeds.
- [ ] Package selected model and provider, source, configuration, complete reports and runnable instructions. Verify serving behavior matches the accepted configuration.
- [ ] Completion audit across every requirement, then mark the active goal complete only if all are proven.

Epoch0 v017 and previously rejected v019 remain preserved. Larger acceptance sample was fixed before any new validation/acceptance results, rather than expanded after looking at significance.

## Serving audit finding

The browser gateway originally had a 1200ms default deadline, shorter than the observed v020 max 1560ms. Loopback providers now advertise a 10000ms deadline; offline stays1200ms and explicit caller deadlines win. Regression verifies short provider timeout fallback, a valid 1300ms response, explicit overrides and local decisions. Frozen Kaggle policy evaluation is unchanged: transport waiting affects browser serving only. Final package must include the rebuilt browser and a serving-versus-frozen decision consistency check.

## Release preparation audit

Frozen-policy consistency passed: 15 compiled rules/policy/evaluation files are byte-identical; only gateway transport deadlines differ, and all its decision/candidate/visibility statements are unchanged. Four policies agree on sampled fixtures; three public-view providers match direct frozen benchmark actions.

release-policy.mjs rejects unpassed gates, insufficient pairs, inconsistent counters/bounds, illegal decisions, unexpected variants and model/policy hash mismatches. release-provider.mjs fixes the verified variant and search configuration. Tests passed. work/package-accepted-v021.py is prepared but must refuse packaging until full cloud records pass the independent verifier. Actual accepted-package HTTP/browser checks and final completion audit remain pending.

## Live selection evidence and remaining browser audit

Official Kaggle client live log streaming shows validation completed: v020180/320 (56.25%), rules-ensemble192/320 (60%), rules-wide203/320 (63.4375%), model-wide194/320 (60.625%). Selected rules-wide; validation upgrade +172. Independent2000-pair acceptance now running. Full records and final gate audit remain pending; no validation result counts as acceptance.

Actual browser attempt via available Codex in-app browser failed to attach, both visible and background. Browser pass is not claimed. Experimental HTTP server was stopped after the test attempt; no unrelated services were touched. Revalidate browser availability for the actual accepted package before completion.
