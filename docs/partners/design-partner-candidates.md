# Design Partner Candidate List

Date: 2026-06-14

This list supports the Phase 0 gate review and P1-T42 partner onboarding. It is a working shortlist
of candidate profiles, not a commitment that any named company has agreed to participate.

## Selection Criteria

- B2B SaaS with recurring customer-specific automation or integration work.
- Clear pain from one-off customer code, webhook transformations, custom approvals, or policy
  checks.
- Willing to run a self-hosted OSS control plane or a production-equivalent environment.
- Can define a baseline for SE implementation lead time before starting the pilot.
- Can run at least one plugin through proxy mode or host SDK integration during the first week.
- Has a manager or admin persona who can evaluate approval, rollback, and audit logs.

## Candidate Profiles

| ID            | Segment                  | Best-fit trigger                                                              | First plugin                                                                | Success signal                                                      | Owner action                                                     |
| ------------- | ------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| DP-FINOPS-01  | FinOps / cloud cost SaaS | Customer-specific budget policy and notification routing                      | `invoice.created` or `budget.threshold.crossed` -> Slack + manager approval | Custom alert/policy setup time reduced by 50% for one customer      | Identify 3 FinOps teams with heavy customer-specific policy work |
| DP-AIAGENT-01 | AI agent SaaS            | Customer-specific tool permissions, approval gates, or workflow continuations | `agent.action.requested` -> approval + continuation                         | Risky tool/action flow can be installed without bespoke tenant code | Identify 3 agent platforms selling into regulated teams          |
| DP-DEVSaaS-01 | Developer-facing SaaS    | Webhook transformation and per-customer integration glue                      | inbound webhook proxy -> transform -> destination SaaS                      | Proxy mode delivers value without host app code changes             | Identify 3 API/webhook-heavy devtools teams                      |

## Pilot Shape

1. Start with proxy mode unless the partner already has a clean host SDK integration point.
2. Install one low-risk plugin first: Slack notification, webhook payload transform, or manager
   approval.
3. Record baseline implementation lead time before TenantScript is introduced.
4. Run weekly feedback for four weeks after the first production-equivalent plugin is active.
5. Capture rollback drill evidence before counting the pilot toward the Phase 1 gate.

## Disqualifiers

- Needs managed SaaS hosting from TenantScript rather than self-hosted OSS.
- Cannot expose test webhook traffic or realistic event samples.
- Cannot name an owner for approval and rollback evaluation.
- Requires Phase 2 RBAC, audit retention, or email/http capability before a first pilot can start.

## Evidence To Record During Outreach

- Candidate contact and owner.
- Segment and primary use case.
- Baseline implementation lead time measurement method.
- Chosen first plugin.
- Production or production-equivalent start date.
- Weekly review cadence.
- Rollback drill date and MTTR.
