---
'@adcp/sdk': patch
---

Answer a routed storyboard's `controller` requirement from the route that owns the state it exercises, instead of the cross-tenant tool union.

`runStoryboard` builds a union of every tenant's advertised tools so a `required_tools` ANY-OF family gate passes when any tenant in the map serves any member — disjunctive by design. The `controller` gate read that same union, which is the opposite question: a peer tenant's `comply_test_controller` cannot seed another tenant's state. A seller advertising no controller, mapped alongside an unrelated signals peer that advertises one, therefore cleared `requires: [controller]`, executed its steps against unseeded state and graded green — while a non-routed run of the same seller correctly reported `missing_test_controller`. The runner already asserts this invariant one screen away, where routed fixture resolution refuses to let "a union member authorize a selected agent's operation".

The gate is now unmet only when **no route serving a state-exercising step advertises its own** `comply_test_controller`. That is deliberately narrower than requiring one per callable route: a route that is only read from — a signals peer serving static marketplace data — is no fixture target and needs no controller, and a storyboard mixing a seeded seller with such a peer still runs. A single control plane genuinely fronting two tenants has to be declared rather than inferred from a union; per-tenant seed dispatch is the follow-up already tracked where routed plus `prerequisites.controller_seeding: true` fail-fasts.

The verdict is established per route during the routing preflight and handed to the ordered `requires` gate, so it answers at its **declared position** — an earlier unmet requirement still wins, and routing failures still outrank it. Declared-order parity between routed and non-routed runs is unchanged.

Scope is routed runs only. Non-routed runs already read the agent's own tool list and are untouched in both directions. The disjunctive `required_any_of_tools` union keeps its existing behaviour. Controller seeding's own missing-controller applicability check now takes the same selected-route provenance; that path is defence in depth rather than a live fix, because a routed run cannot reach it today.

Pinned by executed regressions over live MCP agents: the reported topology now reports `missing_test_controller` with `skip.requirement: controller` and **no step reaches the wire**; the controller on the route under test still runs; a read-only peer without one does not skip the storyboard; routed and non-routed agree about the same seller in both directions; the ANY-OF union still passes with the tool on one tenant only; routed plus `controller_seeding: true` still fail-fasts; and non-routed seeding still grades from the agent's own tools. The union behaviour predates this release and reproduces on `main`.
