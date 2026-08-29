# Hook and failure contract v1

`event`、`transform`、`policy`の3種類を公開hook typeとする。failure policyの既定値と許可される組み合わせは次のとおり。

| hook type   | default       | allowed policies              | result                                        |
| ----------- | ------------- | ----------------------------- | --------------------------------------------- |
| `event`     | `record-only` | `record-only`                 | `{ status: "accepted" }`                      |
| `transform` | `fail-closed` | `fail-closed`, `use-original` | `{ status: "transformed", output }`           |
| `policy`    | `fail-closed` | `fail-closed`                 | `{ decision: "allow" or "deny", reasonCode }` |

`webhook.outbound`は`transform`かつ`fail-closed`でなければならない。失敗時に元payloadを転送してはならない。
`use-original`はhostが安全性を明示したtransformだけで許可し、redactionやpolicy用途には使わない。

すべてのadapterは次の閉じたerror codeだけを外部へ返す。provider例外、plugin本文、payload、URLなどの診断値はcodeへ反映しない。

`input_invalid`、`snapshot_unavailable`、`snapshot_integrity_failed`、`plugin_artifact_invalid`、
`plugin_timeout`、`plugin_memory_exceeded`、`plugin_subrequest_exceeded`、`plugin_result_invalid`、
`capability_denied`、`capability_failed`、`egress_denied`、`destination_unavailable`、
`evidence_unavailable`、`runtime_unavailable`。

event failureはoriginating operationを変更せず記録だけ行う。transform/policy failureはfail-closedし、
policyのmalformed result・timeout・unknown reason codeはdenyとして扱う。
