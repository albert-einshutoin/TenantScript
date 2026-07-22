# Plugin authoring eval contract

TenantScriptのcoding-agent向けplugin authoringを、成功例の印象ではなく固定corpusと決定論的judgeで
比較するrepository contractです。現在の公開dashboardは`repository-simulation`だけであり、実agentの
性能比較、生成物の本番安全性、外部providerやCloudflareでのlive実行を証明しません。

## Repository verified scope

- `evals/plugin-authoring/corpus.json`は固定commitと10件の代表要件を持ちます。
- webhook transform、approval、policy、capability利用、error handlingを各2件含みます。
- 全taskはmanifest、build、unit test、security test、`ext audit`、least privilegeの6 judgeを必須にします。
- `corpusDigest`と`repositoryRevision`が要件またはbaselineのdriftを検出します。
- task/judgeの欠落、重複、unknown field、矛盾したpass/failure、負のduration/costをfail closedで拒否します。
- machine reportとMarkdown dashboardは入力順に依存せず、同じ入力から同じbytesを生成します。
- costが証跡にない場合は推測せず`Cost: unknown`と表示します。
- `repository-simulation`はevidence bundleがないことを`null`で明示し、`isolated-agent-run`は64桁の`evidenceBundleDigest`を必須にします。

corpus/resultの公開構造は`corpus.schema.json`と`result.schema.json`です。JSON Schemaだけを実行時の
semantic validatorとは扱わず、repository checkerがtask完全性、judge対応、digest、時系列まで検証します。

## Commands

```sh
# cwd: repository root
# expected-exit: 0
pnpm test:agent-evals
pnpm lint:agent-evals
```

corpusまたはreview済みresultを変更した場合は、生成物を更新して差分をreviewします。

```sh
# cwd: repository root
# expected-exit: 0
pnpm agent-eval:write
pnpm lint:agent-evals
```

`report.json`はautomation向け、`dashboard.md`は人間向けです。fixtureのpass@1が100%でも、採点器の
known-good repository simulationが通ったという意味だけです。実agentの比較では、agent/model/run ID、
cost、開始・終了時刻をresultへ記録し、失敗resultも削除せず同じcorpusに対して集計します。

## Failure and recovery contract

| Failure code             | 改善先                                        |
| ------------------------ | --------------------------------------------- |
| `manifest-invalid`       | manifest説明またはscaffold manifest           |
| `build-failed`           | build手順または生成dependency制約             |
| `unit-test-failed`       | TDD recipeとbehavior test                     |
| `security-test-failed`   | security recipeとadversarial test             |
| `audit-failed`           | `ext audit`説明または検出されたsource pattern |
| `least-privilege-failed` | capability宣言または最小権限説明              |

errorは入力prompt、credential、machine-local pathを反射しません。未知のresult file、symlink、1 MiBを超える
入力、unsafeな生成先も拒否します。

## Execution boundary

このcontractはunknownなagent生成codeを実行しません。実行結果を`isolated-agent-run`として追加する前に、
後続のisolated runnerがfresh worktreeまたは同等の隔離、network deny、resource/time limit、process-tree
cleanupを保証し、全6 judgeを実際に完走する必要があります。隔離を確立できない場合は停止し、
repository simulationを実agent成功として流用しません。LLM-as-judgeだけでpassにすることもありません。
In short, the repository scorer does not execute unknown generated code.
