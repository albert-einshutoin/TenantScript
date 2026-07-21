# Control Plane HTTP error catalog

Control Plane failures use a stable JSON envelope:

```json
{ "error": { "code": "installation_not_found", "message": "installation not found" } }
```

Clients must branch on `error.code`, not `error.message`. Messages are safe human context, may change
without notice, and never contain a provider response, storage exception, token, configuration, or
tenant payload. HTTP status remains useful for generic policy, while the code identifies the action.

## Security boundary

A missing resource and a cross-tenant or cross-app resource return the same `404` code for that
resource type. Clients must not probe alternate scopes or interpret timing as existence evidence.
Provider and storage details are never reflected; `internal_error` and unavailable-service codes are
deliberately redacted. Log the stable code, route, status, and local operation ID—not request bodies,
bearer tokens, raw messages from dependencies, or customer data.

## Catalog

**Retryability** describes automated client behavior. “After recovery” means retry only after the
operator or dependency has recovered; use bounded exponential backoff and preserve an idempotency
key for the same mutation intent. **Client action** is the safe next step.

| Code                                        | HTTP | Meaning                                                                     | Retryability   | Client action                                                                               |
| ------------------------------------------- | ---: | --------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `admin_configuration_unavailable`           |  503 | Worker configuration is malformed or unsafe.                                | After recovery | Ask the operator to validate bindings without exposing their values.                        |
| `admin_mutation_rate_limit_unavailable`     |  503 | The mutation limiter is missing or unavailable.                             | After recovery | Preserve intent and retry after the limiter recovers.                                       |
| `admin_mutation_rate_limited`               |  429 | The scoped mutation window is exhausted.                                    | Yes            | Wait for `Retry-After`; do not fan out retries.                                             |
| `admin_scope_forbidden`                     |  403 | The identity is not a valid tenant-scoped admin or cannot read its session. | No             | Use a correctly scoped identity.                                                            |
| `app_database_unavailable`                  |  503 | The authenticated app has no usable D1 route.                               | After recovery | Provision/bind the app database; never fall back to another DB.                             |
| `approval_already_decided`                  |  409 | The approval left the pending state.                                        | Conditional    | Refresh the approval and accept its current state.                                          |
| `approval_decision_forbidden`               |  403 | The role cannot submit approval decisions.                                  | No             | Use an authorized admin workflow.                                                           |
| `approval_expired`                          |  409 | The approval expired before the decision.                                   | No             | Create a new request rather than replaying the decision.                                    |
| `approval_not_found`                        |  404 | No approval is visible in the authenticated scope.                          | No             | Treat it as absent without probing another scope.                                           |
| `approval_role_forbidden`                   |  403 | The actor role does not satisfy the stored approval threshold.              | No             | Escalate through the documented approval path.                                              |
| `approval_store_unavailable`                |  503 | Approval persistence is not configured.                                     | After recovery | Retry only after operator recovery.                                                         |
| `capability_confirmation_mismatch`          |  400 | Confirmed capabilities differ from the reviewed manifest.                   | No             | Refresh the preview and confirm the exact capability set.                                   |
| `cursor_service_unavailable`                |  503 | Signed cursor support is not configured.                                    | After recovery | Ask the operator to configure the cursor secret.                                            |
| `dashboard_forbidden`                       |  403 | The identity cannot read the dashboard.                                     | No             | Request a role with dashboard read access.                                                  |
| `dashboard_store_unavailable`               |  503 | Dashboard persistence is unavailable.                                       | After recovery | Retry after storage/operator recovery.                                                      |
| `execution_not_found`                       |  404 | No execution is visible in the authenticated scope.                         | No             | Treat it as absent without scope probing.                                                   |
| `execution_read_forbidden`                  |  403 | The identity cannot read execution evidence.                                | No             | Request the required read scope.                                                            |
| `execution_store_unavailable`               |  503 | Execution detail storage is unavailable.                                    | After recovery | Retry after storage/operator recovery.                                                      |
| `idempotency_key_reused`                    |  409 | One key was reused for a different mutation intent.                         | No             | Generate a new key only for the new intent.                                                 |
| `identity_resolver_unavailable`             |  503 | No identity resolver is configured or reachable.                            | After recovery | Retry after authentication service recovery.                                                |
| `install_flow_store_unavailable`            |  503 | Install preview/create persistence is unavailable.                          | After recovery | Retry after operator recovery.                                                              |
| `install_request_store_unavailable`         |  503 | Installation request persistence is unavailable.                            | After recovery | Retry with the same key after recovery.                                                     |
| `installation_command_forbidden`            |  403 | The identity cannot change an installation.                                 | No             | Use an authorized role.                                                                     |
| `installation_command_store_unavailable`    |  503 | Installation command persistence is unavailable.                            | After recovery | Retry with the same intent after recovery.                                                  |
| `installation_install_forbidden`            |  403 | The identity cannot install a plugin version.                               | No             | Use the approval or authorized install path.                                                |
| `installation_not_found`                    |  404 | No installation is visible in the authenticated scope.                      | No             | Treat missing and cross-scope targets identically.                                          |
| `installation_read_forbidden`               |  403 | The identity cannot inspect installations.                                  | No             | Request installation read access.                                                           |
| `installation_request_forbidden`            |  403 | The identity cannot request an installation.                                | No             | Use an authorized requester role.                                                           |
| `installation_revision_conflict`            |  409 | The expected revision is stale.                                             | Conditional    | Refresh state, review changes, then submit a new intent.                                    |
| `installation_store_unavailable`            |  503 | Installation detail persistence is unavailable.                             | After recovery | Retry after operator recovery.                                                              |
| `internal_error`                            |  500 | An unexpected failure was safely redacted.                                  | Conditional    | Retry idempotent reads with backoff; preserve mutation keys and escalate repeated failures. |
| `invalid_approval_decision`                 |  400 | The approval body or decision is invalid.                                   | No             | Correct the request using the public schema.                                                |
| `invalid_command`                           |  400 | The installation command is malformed.                                      | No             | Correct the body and required fields.                                                       |
| `invalid_config`                            |  400 | Plugin configuration or resolved grants fail validation.                    | No             | Refresh schema/manifest and correct configuration.                                          |
| `invalid_cursor`                            |  400 | The cursor is malformed, expired, or belongs to another scope/section.      | No             | Restart pagination without the cursor.                                                      |
| `invalid_execution_filter`                  |  400 | An execution filter value is unsupported.                                   | No             | Use documented filter values.                                                               |
| `invalid_execution_id`                      |  400 | The execution ID is missing.                                                | No             | Supply a non-empty ID.                                                                      |
| `invalid_idempotency_key`                   |  400 | The mutation key is missing or invalid.                                     | No             | Supply a valid unique key for the intent.                                                   |
| `invalid_install_request`                   |  400 | The installation request body is invalid.                                   | No             | Correct the body using the public schema.                                                   |
| `invalid_limit`                             |  400 | A pagination limit is not a positive integer.                               | No             | Supply a supported positive limit.                                                          |
| `invalid_rollback`                          |  400 | The rollback command is malformed.                                          | No             | Correct target, revision, actor, and reason fields.                                         |
| `invalid_service_token`                     |  400 | Service-token issue input is unsafe or invalid.                             | No             | Reduce role/scope/lifetime and correct the request.                                         |
| `invalid_usage_query`                       |  400 | The UTC usage date range is invalid.                                        | No             | Correct dates and range.                                                                    |
| `invalid_version`                           |  400 | A required plugin version ID is missing.                                    | No             | Supply the reviewed version ID.                                                             |
| `method_not_allowed`                        |  405 | The route does not support the HTTP method.                                 | No             | Use the `Allow` header.                                                                     |
| `origin_forbidden`                          |  403 | Browser Origin is not allowlisted.                                          | No             | Use an exact configured origin; never bypass CORS.                                          |
| `origin_required`                           |  403 | A preflight request omitted Origin.                                         | No             | Send a standards-compliant browser preflight.                                               |
| `plugin_version_not_found`                  |  404 | No plugin version is visible in the authenticated app.                      | No             | Refresh the catalog without probing another app.                                            |
| `provider_connections_forbidden`            |  403 | The identity cannot inspect provider connection metadata.                   | No             | Request dashboard read access.                                                              |
| `provider_connection_store_unavailable`     |  503 | Provider connection inventory storage is unavailable.                       | After recovery | Retry after storage/operator recovery.                                                      |
| `request_too_large`                         |  413 | The buffered request exceeds the endpoint limit.                            | No             | Reduce the body; do not split one atomic command.                                           |
| `rollback_forbidden`                        |  403 | The identity cannot execute rollback.                                       | No             | Use an authorized operator workflow.                                                        |
| `rollback_store_unavailable`                |  503 | Rollback persistence is unavailable.                                        | After recovery | Retry with the same key after recovery.                                                     |
| `rollback_target_is_current`                |  409 | The requested target is already current.                                    | No             | Refresh and treat the desired state as reached.                                             |
| `rollback_target_not_found`                 |  404 | The rollback target is absent or outside scope.                             | No             | Select a visible reviewed version.                                                          |
| `route_not_found`                           |  404 | The API route is not registered.                                            | No             | Correct the path/version.                                                                   |
| `service_token_issue_forbidden`             |  403 | The identity cannot issue service tokens.                                   | No             | Use an owner/admin path with least privilege.                                               |
| `service_token_not_found`                   |  404 | The token record is absent or outside scope.                                | No             | Treat it as absent without probing.                                                         |
| `service_token_revoke_forbidden`            |  403 | The identity cannot revoke the token.                                       | No             | Use an authorized owner/admin identity.                                                     |
| `service_token_role_escalation`             |  403 | The requested token role exceeds the issuer's role.                         | No             | Choose an equal or less privileged role.                                                    |
| `service_token_scope_forbidden`             |  403 | The requested token scope is not delegated to the issuer.                   | No             | Request only scopes already held by the issuer.                                             |
| `service_token_service_unavailable`         |  503 | Service-token persistence is unavailable.                                   | After recovery | Retry only after operator recovery.                                                         |
| `slack_oauth_install_start_forbidden`       |  403 | The identity cannot start a Slack provider connection.                      | No             | Use a privileged role with the explicit provider connection operation.                      |
| `slack_oauth_install_start_invalid_request` |  400 | The install-start request contains query or body input.                     | No             | Send an authenticated POST without query or body.                                           |
| `slack_oauth_install_start_unavailable`     |  503 | Slack install-start configuration or state issuance is unavailable.         | After recovery | Validate bindings and fixed provider configuration without exposing their values.           |
| `unauthorized`                              |  401 | A valid bearer credential was not supplied.                                 | No             | Acquire/replace the credential; do not replay a rejected token.                             |
| `unsupported_media_type`                    |  415 | A JSON mutation lacks the required content type.                            | No             | Send `Content-Type: application/json`.                                                      |
| `usage_forbidden`                           |  403 | The identity cannot read usage.                                             | No             | Request usage read access.                                                                  |
| `usage_meter_unavailable`                   |  503 | Usage aggregation is unavailable.                                           | After recovery | Retry after operator/storage recovery.                                                      |

## TypeScript client branching

Parse the closed envelope, then branch on the code. Do not display dependency details or use the
message as a machine contract.

```ts
type ControlPlaneError = { error: { code: string; message: string } };

const body = (await response.json()) as ControlPlaneError;
switch (body.error.code) {
  case "admin_mutation_rate_limited":
    scheduleAfter(response.headers.get("Retry-After"));
    break;
  case "installation_revision_conflict":
    await refreshInstallation();
    break;
  case "installation_not_found":
    showUnavailableResource();
    break;
  default:
    showSafeFailure(body.error.code);
}
```

The example functions are application callbacks, not TenantScript exports. Validate the HTTP body
before using it in production and bound every automated retry.

## Contributor update rule

Any new public code must be added here with its status, meaning, retryability, and client action in
the same pull request. `scripts/control-plane-error-catalog.test.mjs` extracts source literals,
rejects duplicate/stale rows, and verifies literal `errorResponse` status values.
