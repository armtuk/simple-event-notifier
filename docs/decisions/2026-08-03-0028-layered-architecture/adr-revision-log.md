## 2026-08-03T07:28:00Z — Initial decision recorded — Alex Turner

First draft, authored during the replanning of features F1–F5. Records the layered model adopted
from `.agents/guidance/api-servers.md`: the canonical `Event` as Application Model, a Repository
boundary in front of every external system (S3 and 3P APIs alike), Transformers as the only code
permitted to know a foreign shape, Business Logic Services transiting Application Model values
only, Controllers restricted to protocol concerns, and one functional area per 3P integration.

Also records what is deliberately **not** adopted — the optional Aggregate Service and
DataService/DataStrategy layers and projection machinery — and fixes the system's CQRS position at
maturity Level 2–3 with `PushEvent` named as a command and the S3 object as a pulled published fact.

Supersedes no earlier ADR. It does, however, replace the never-written ADR that
**AWE-153 — Reusable integration template (`integration-core`)** carried in its plan, which was
scoped to "integration template + dual-path design"; the dual-path (webhook + poller) design was
dropped when **AWE-157 — GitHub activity poller (Events + Notifications)** was abandoned, so that
ADR's scope no longer describes the system.
