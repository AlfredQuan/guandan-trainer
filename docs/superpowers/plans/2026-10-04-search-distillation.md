# Search distillation implementation plan

> For agentic workers: use superpowers:executing-plans in this session.

**Goal:** Improve the existing action model using the independently evaluated public-memory search teacher.

**Architecture:** Freeze v017 as warm start and reference. Generate search labels from public observations, fit a weighted imitation objective with a reference KL anchor on Kaggle CPU, and select by validation duels before touching a fresh held-out split.

**Tech stack:** Existing TypeScript rules engine, Node runtime, PyTorch CPU, private Kaggle script.

**Spec / constraints:** User requests continued AI improvement and cloud CPU training only. No local training. Preserve default policy pending the existing deployment gate (200 pairs, >=55%, Hoeffding lower bound >50%). Four seats, level ranks 2..A, inference action budget 256. No seeds or hidden ownership in feature rows. Credentials stay outside source and output.

**Review focus:** Invalid or omitted action labels; train/validation/heldout seed overlap; wildcard declaration loss; model export parity; validation selection bias.

- [x] Add a failing regression test for canonical labels, invalid labels, four-seat recording and completed legal games.
- [x] Implement `distillRow` and `generateDistillDeal`, retain inference candidate budget and account for omitted targets.
- [x] Package frozen model and cloud-only trainer. Warm-start v017, weight changed decisions, KL regularize ordinary positions; six epochs with checkpoints at 2/4/6.
- [x] Select on 80 fresh validation pairs (offset 7200000), including epoch0. Generate 800 training deals (7000000) and 160 validation deals (7100000).
- [x] Evaluate selected student and frozen reference once on the same 240 heldout pairs (7300000); report paired gain, legality, export checks and deployment gate.
- [x] Package model, reports, source and documented reproduction commands. Keep default unchanged unless its frozen gate passes.

No Git metadata exists in this downloaded checkout; source archive is the reviewable handoff.

## Result and follow-up

v019 cloud training completed in 592 seconds, selected epoch4. Fresh test 251/480 versus reference250/480, upgrade balance -3 versus +52: no demonstrated improvement, default unchanged. A separate v020 experiment now keeps frozen v017 weights and evaluates public-information full-match search on fresh offset7400000. See docs/MODEL_MATCH_SEARCH.md.
