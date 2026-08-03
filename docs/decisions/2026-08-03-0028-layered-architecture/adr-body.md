---
id: 2026-08-03-0028-layered-architecture
title: Layered architecture — Application Model, Repository boundary, and per-integration functional areas
status: Accepted
created: 2026-08-03
updated: 2026-08-03
supersedes: none
superseded-by: none
---

# Layered architecture — Application Model, Repository boundary, and per-integration functional areas

## Decision

This system adopts the layered model in `.agents/guidance/api-servers.md`. Six rules are binding:

1. **The canonical `Event` is the Application Model.** It lives in `@personal-events/event-model`
   and is the only shape business logic accepts or returns. It is fully validated at every
   boundary crossing, so code above the Repository may treat its correctness as guaranteed.
2. **Every external system sits behind a Repository** — the S3 event bucket, the GitHub API, the
   Claude Code hook contract. A Repository accepts and returns Application Model values.
3. **A Transformer at each Repository boundary** converts between the Application Model and the
   store's own shape (an S3 object entity, a 3P API payload). **Transformers are the only code in
   the system permitted to know a foreign shape.**
4. **Business Logic Services transit Application Model values only.** They are pure wherever
   possible and perform no I/O; data arrives pre-gathered per the Gather/Compute/Persist rule in
   `.agents/general.md`.
5. **Controllers/Handlers own protocol concerns only** — HTTP status codes, process exit codes,
   argv parsing. They deserialize the foreign shape, delegate to a Service, and serialize the
   result. No business logic.
6. **Each 3P integration is its own functional area** with its own package holding that
   integration's 3P models, transformer, service, repository, and handler.

### Direction rules

**Inbound — a 3P event arrives:**

```
GitHub webhook ──3p-model──▶ Handler/Controller
                             └─▶ Service
                                 └─▶ Transformer ──3p-model → application-model──▶
                                     └─▶ Business logic (classify, priority)
                                         └─▶ EventRepository ──application-model──▶ Entity(key+JSON) ──▶ S3
```

**Outbound — core calls a 3P:**

```
Core ──app-model──▶ Service ──app-model──▶ Repository ──app-model──▶ Transformer ──3p-model──▶ 3P API
```

**Read side — the sync client:**

```
S3 ──▶ EventRepository ──▶ Transformer (Entity → Event) ──▶ Validator ──▶ Service ──▶ stdout / notifier
```

Per `api-servers.md` §"Data-model flow by boundary": inbound validates the Application Model then
transforms to the Entity Model; outbound transforms from the Entity Model then validates the
resulting Application Model.

### Layer inventory

| Layer | Present? | Realization here |
| :--- | :--- | :--- |
| 1. Resolver / Controller | **Always** | Webhook Lambda handler; push-CLI argv entry; sync poll loop |
| 2. Business Logic Service | **Always** | Classification (alert vs notification, priority), triage rules |
| 3. Aggregate Service | **Omitted** | An `Event` is a flat value, not an aggregate |
| 4. DataService / DataStrategy | **Omitted** | No projection/source split to arbitrate |
| 5. Repository | **Always** | `EventRepository` over S3; one repository per 3P API |
| Transformers | **Always** | At every Repository boundary |

Layers 3 and 4 are marked optional by `api-servers.md`; omitting them is conformance, not
shortcutting.

### CQRS positioning

Per `.agents/guidance/cqrs.md`, this system sits at **maturity Level 2–3** (command-oriented /
logical CQRS) and should stay there. S3 **is** the source of record, so the projection-versus-cache
machinery has nothing to arbitrate — there is no second store to keep consistent.

The command/event vocabulary is adopted deliberately, per `cqrs.md` §"Events vs commands":

- **Writing is a `PushEvent` command** — a directed request to a known recipient.
- **What lands in S3 is a published fact** that consumers **pull** on their own schedule.

Naming these separately prevents the drift where "event" silently means both the message and the
write that produced it.

## Context

The system pairs one internal model with a growing set of third-party integrations — GitHub and
Claude Code first, with email, calendar, incident paging, Jira and Confluence on the roadmap. Any
system of that shape must state where foreign data stops being foreign, or it decays in a
predictable way: provider payload shapes leak upward until the application is expressed in the
vocabulary of whichever integration was built first.

`api-servers.md` §"The Transformers are responsible for" names this failure directly: *"A lack of
mapping between the data-store and the application layer forces the application to be expressed in
terms of the data-store rather than in terms of the business logic or the actual data domain."*

Two concrete forces made the decision necessary now:

- **`system.md` already declares the event model "the load-bearing contract"** that every producer
  and consumer couples to — but declaring it is not enforcing it. The Repository/Transformer
  boundary is the mechanism that makes the declaration true.
- **The prior plan structure put the shared integration template inside the `github-integration`
  feature.** That made Claude Code, Slack and every future source transitively depend on all of
  GitHub, and it entangled generic classification with GitHub's two API namespaces. The template
  was the right instinct filed in the wrong place.

## Blast radius

- **Monorepo layout** — the package set and its dependency direction.
- **`@personal-events/event-model`** — becomes the formally-named Application Model; must export
  its field schemas (`Priority`, `NoDotString`, `IsoInstant`) so no consumer re-declares those
  bounds and forks the contract.
- **Every integration package** — each must present the model/transformer/service/repository shape.
- **Applications** — push CLI, sync client, webhook Lambda become Controllers with no business logic.
- **Plan artifacts** — features F1–F5 and, specifically, the scope and location of
  **AWE-153 — Reusable integration template (`integration-core`)**, which is re-scoped to the layer
  contracts and moved out of `github-integration` into the foundation feature.
- **The S3 object format** — it is the Entity Model of the `EventRepository`, and it is consumed by
  anything reading the bucket, including a naive `aws s3 sync` client.

## Alternatives & trade-offs

**Direct-to-SDK in each producer, no Repository layer.** *Rejected.* Every producer re-implements
the object-key codec and the S3 write. That forks the one contract `system.md` names as
load-bearing, and it is precisely what the push CLI, the Claude hook CLI and the webhook handler
would each have done independently.

**A shared config-driven framework package with adapter interfaces** — the original
**AWE-153 — Reusable integration template (`integration-core`)** as specified. *Rejected as
specified, retained in part.* Its `SourceAdapter` and `SecondaryProcessor` interfaces had zero
implementations and an explicitly deferred execution model, and its `channel` discriminant plus
compile-to-`ReadonlyMap` step existed largely to reconcile GitHub's webhook `event`+`action`
namespace with the Notifications API's `reason` values — a problem that disappeared when
**AWE-157 — GitHub activity poller (Events + Notifications)** was dropped. What is retained: the
mapping config with a **required default** so nothing is silently dropped, typed `Either` failures,
and the normalizer/classifier split.

**The full `api-servers.md` stack including Aggregate Service, DataService and projections.**
*Rejected.* An `Event` is a flat value with no constituent entities, and S3 is the source of record
rather than one store among several. `cqrs.md` marks these layers optional and warns against
climbing maturity levels without a forcing reason.

**Per-integration free-form structure.** *Rejected.* `.agents/code-file-organization.md` requires
feature-first layout, and without a uniform per-integration shape each new source invents its own
boundary — which is the drift this ADR exists to prevent.

## Reversibility

**Two-way door early, hardening quickly.** With two integrations, re-layering one is mechanical.
The cost scales with the number of integrations and, more sharply, with the number of consumers
that have learned to accept a foreign shape — each one is a separate correction.

The Application Model itself is closer to a **one-way door**: the `Event` JSON and its object-key
scheme are a published contract, consumed by the S3 bucket's entire history, by any naive
`aws s3 sync` client, and by an npm-published hook CLI. Changing it is a versioning exercise, not
an edit. Treat it as a versioned interface from the first commit.

## References

- `.agents/guidance/api-servers.md` — the canonical layer model this ADR adopts
- `.agents/guidance/cqrs.md` — command/query segregation, maturity levels, events-vs-commands
- `.agents/object-types.md` — object taxonomy and Service/Repository/Transformer naming
- `.agents/code-file-organization.md` — feature-first source layout
- `.agents/guidance/api-integrations.md` — 3P response validation, SDK preference, rate limits
- `.agents/plans/system.md` — system vision and functional-area catalogue
- No implementing PR yet; this records a decision taken during planning on 2026-08-03.
