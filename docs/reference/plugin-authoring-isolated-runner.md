# Isolated plugin authoring judge runner

TenantScriptのisolated runnerは、coding agentが生成した10 task分のcandidate bundleをmaintainer checkoutや
host processで直接実行せず、固定baselineとdigest固定container imageへ渡すjudge orchestration contractです。
runner自体のrepository testはsandbox引数・証跡・cleanupを検証しますが、reviewed judge imageの公開や
real-agent metricsを意味しません。現時点のdashboardは引き続きrepository simulationだけです。

## Responsibility boundary

agent generation and provider communicationはrunnerの外側です。provider APIへ接続するagent processと、
未知の生成codeをbuild/testするjudge processを同じnetwork authorityで動かしません。runnerが担当するのは、
生成が完了して停止した後のcandidate bundleだけです。

runnerは次をrepositoryで検証します。

- requestのrepository revisionがcorpus baselineと一致する
- corpus digestが現在の固定10 taskと一致する
- judge imageが`repository@sha256:<64 hex>`形式で、local daemon上の同じRepoDigestを持つ
- candidate root直下がcorpusの10 task IDと完全一致する
- candidateがregular fileだけで、symlink、hard link、hidden control file、path escapeを含まない
- 1 file 256 KiB、全体16 MiB、2,000 files、深さ8、path 240 bytes以内
- baselineをdetached worktreeから一時copyし、`.git`、`.devloop`、`.tmp`をcontainerへ渡さない
- Docker invocationが`--pull=never`、`--network=none`、`--read-only`、capability drop、
  no-new-privileges、PID/memory/CPU/tmpfs/time limitを強制する
- candidate入力をread-only mountし、build/testの書き込み先を容量制限付き`/work` tmpfsに限定する
- `/work` tmpfsを最低32 MiBとし、最大16 MiBのcandidate snapshotに対してfilesystem metadataとadapter state用の
  raw headroomを最低16 MiB確保する。より大きなbuild stateが必要なrunは上限内で明示的に増やす
- judge imageのentrypointを`/opt/tenantscript/bin/plugin-authoring-judge`へ固定する
- success、judge failure、timeout、malformed outputの全経路で名前付きcontainerを明示削除する
- stdoutを1 MiB以下のclosed JSONとして検証し、stderrやcandidate内容を公開errorへ反射しない

Git worktreeは再現性を作るだけでsecurity sandboxではありません。unknown codeを実行する境界は、
network/resource/process isolationを持つcontainerです。Docker socket、maintainer credential、ambient
environment、checkoutの`node_modules`はmountしません。

## Trusted judge image contract

runnerはjudge imageをbuildまたはpullしません。operatorが事前にsource reviewし、immutable digestでlocal
daemonへ配置してください。tag、`latest`、local image ID、digestのないreferenceは拒否されます。

imageは固定entrypointで、`/baseline`のread-only baselineと`/candidate`のread-only bundleを読み、
`/work`のbounded tmpfsへ必要なfileだけをcopyして、
manifest、build、unit-test、security-test、audit、least-privilegeの6 judgeを実行します。stdoutには
`judge-output.schema.json`に適合するJSONを1つだけ出力し、それ以外のdiagnosticはstderrへ送ります。
runnerはstderrを保持も反射もしません。

repositoryには、固定corpusを10 task x 6 judgeの順序で評価し、adapterのfalse、例外、不正な戻り値を
judge固有のfailure codeへ閉じるorchestration coreがあります。このcoreはcandidate codeを実行せず、
review済みimage、production execution adapter、sandboxの証拠ではありません。

`scripts/plugin-authoring-judge-entrypoint.mjs`はrunnerと共有する固定entrypoint/argv contractを持ち、request、
digest固定corpus、空workspace、candidate bundleをcontainer内でも再検証してからcoreを呼びます。host側で検証済みでも
candidate全体を再度inspectするのは、direct image invocationやmount driftから後続adapterへsymlink、hard link、hidden
control、oversized treeを渡さないためです。検証時に保持したbytesからtaskごとのread-only
`/work/<task-id>/source` snapshotをmaterializeし、後からlive candidate mountが変化してもadapterへ渡しません。adapterの
writable stateは`/work/<task-id>`へ分離します。stdoutはclosed judge JSON 1行、entrypoint failureは固定stderrだけに
閉じます。repositoryには`/opt/tenantscript/bin/plugin-authoring-judge`へinstallするlocal image sourceがありますが、
GHCRへ未publish・未attestであり、review済みdigestとしてrunner requestへ設定できる段階ではありません。

`build` judgeにはbounded offline compile-check adapterがあります。adapterはcandidateの`package.json` scripts、
`tsconfig.json`、lockfile、install hookを実行・継承せず、judge codeと同じ固定Node executableから固定workerを
shellなしで起動します。workerは`src`内の通常`.ts` fileだけを対象にし、相対importと
`@tenantscript/manifest` / `@tenantscript/plugin-sdk`の公開root importだけを許可します。TypeScript compiler
APIはsanitized environment、10秒timeout、stdout/stderr各32 KiB、合計64 KiB、container全体のPID/memory/network
制限内で実行され、成功時は固定JSONだけを返します。candidate diagnostic、source、absolute pathはjudge outputへ
反射しません。candidateの型定義やcompiler pluginを読み込まないため、このbuild判定はreview済みの最小authoring
contractに対するcompile-checkであり、candidate独自dependencyや任意build pipelineの成功を証明しません。
成功時には、materialize済みsource全体のSHA-256と生成した`bundle.cjs`のSHA-256・byte数を結ぶ
judge-owned build receiptを`/work/<task-id>/build`へ保存します。後続adapterはsourceまたはbundleが変化したreceiptを
拒否し、candidateが用意したprebuilt artifactを実行しません。
bundle entrypointは静的抽出済みのreviewed manifestを`definePlugin`由来のhandlerへ再bindingするため、candidateが
別のhook、capability、egressを持つmanifestを渡して実行時だけ権限契約を差し替えることもできません。

`unit-test` judgeにはjudge-owned behavior matrixを使うbounded adapterがあります。
`behavior-cases.json`は固定10 taskごとに正常系、境界、malformed payload、provider failureをclosed dataとして保持し、
candidateのtest scriptやfixtureを読みません。matrixはbaseline mountではなくdigest固定judge image内のreview済みsourceから
読み、古いbaselineやdirect image invocationによる欠落・差し替えを許しません。各caseは新しい固定Node childで`bundle.cjs`をproduction loaderの
`runScopedPluginDispatch`へ渡し、250ms、128 MiB、case固有subrequest上限で実行します。childはsanitized environmentを使い、
stdoutのclosed observationをrunごとの32-byte keyでHMAC認証します。親adapterはbuild receipt、result、capability call、
runtime log、未完了capabilityをすべて照合し、1 caseが失敗しても残りのcaseを実行します。

`security-test` judgeには二層のjudge-owned adversarial adapterがあります。最初の層はcandidateと独立した固定probe
bundleをproduction loaderへ渡し、Node global / ambient secret / constructor recoveryの隔離、raw fetchの
`egress_denied`記録、capability subrequest budget、infinite loop timeoutを毎caseで確認します。次の層は
`security-cases.json`のtask別prototype-shaped payloadをcandidate bundleへ渡し、runごとのambient canaryが結果や
capability evidenceへ反射されないこと、corpus allowlist外のcapability、raw egress log、未完了call、task-scoped
escape marker、timeout、出力超過がないことを検証します。case matrixはbaseline mountではなくdigest固定judge sourceから
読み、build receiptで再検証したbundleだけをfresh childで実行します。candidateのtest script、fixture、config、prebuilt
artifactは使用しません。

抽出済みmanifest valueに対しては、canonical manifest parserの成功と、task固有の単一hook、capability keyの
exact set、egress denyを判定するpure policyがあります。parserの例外や不正な戻り値はdiagnosticを反射せず
`manifest`と`least-privilege`のfailureへ閉じます。

`src/manifest.ts`はimportやtype strippingで実行せず、TypeScript ASTからclosed data literalだけを静的抽出します。
top-levelはscaffoldが生成するtype-only `TenantScriptManifest` importと
`export const manifest = <literal> satisfies TenantScriptManifest`だけを許可します。literalは通常の非computed propertyを
持つobject、array、string、finite number、boolean、nullに限定し、call、identifier参照、spread、getter、computed key、
duplicate/prototype-sensitive keyを拒否します。source byte、AST node、nesting depthにも上限があります。抽出失敗や
parser diagnosticはcandidate内容を反射せず両judgeのfailureへ閉じます。この静的adapterはunknown sourceの非実行境界を
提供しますが、build/test/audit sandboxやreview済みimageの完成を証明しません。

`audit` judgeはbuild receiptでsourceと`bundle.cjs`を再検証し、`src/manifest.ts`を実行せず静的抽出し、
32 KiB以下・深さ8以下・512 node以下の`package.json`だけをbounded metadataとして読みます。candidateのpackage script、
config、prebuilt artifactは実行・読込しません。judge-owned SDK versionとCLI公開APIのcanonical `auditPluginPackage`を使い、
closed finding taxonomy、severity、certainty、path、message、決定論的順序を再検証します。公開CLIではwarningがreport成功に
なり得ますが、isolated judgeではheuristic uncertaintyを安全性の証拠にしないzero-finding policyを採用し、warningを含む
全findingをfail closedにします。この静的監査は既知の危険patternを検出するreview gateであり、安全性の認証ではありません。

entrypoint interfaceはmissing、false、例外、boolean以外の結果を各judgeのfailureへfail closedにし、後続judgeとtaskを
skipしません。全execution adapterのrepository test成功やtest doubleの全成功は、review済みimageやreal-agent qualityの
証拠ではありません。

security-test成功は固定probeと入力で観測した実行境界だけを証明します。未実行の隠し分岐、危険APIの静的存在、dependency
provenance、未知のsandbox脆弱性、container image supply chainは保証しません。前二者は後続audit、image自体は
SBOM・digest・review recordのgateで扱います。

reviewed judge imageがない場合のstop conditionは明確です。runnerは
`isolated judge sandbox is unavailable`で停止し、host実行やrepository simulationへfallbackしません。

## Request and candidate layout

公開schemaは次の3つです。

- `evals/plugin-authoring/runner-request.schema.json`
- `evals/plugin-authoring/judge-output.schema.json`
- `evals/plugin-authoring/isolated-evidence.schema.json`

requestはrun identity、現在のbaseline/corpus digest、review済みimage digest、上限制約だけを持ちます。
candidate directoryやoutput directoryのmachine-local pathはCLI引数で渡し、evidenceへ保存しません。

candidate rootは次のように、corpus task IDごとに1 directoryを持ちます。全10 directoryが必要です。

```text
candidate/
├── approval-invoice-threshold/
│   ├── package.json
│   ├── src/
│   │   ├── manifest.ts
│   │   └── index.ts
│   └── test/
├── approval-refund-review/
└── ... eight remaining corpus task IDs ...
```

`src/manifest.ts`は`ext init`が生成するauthoring sourceの正本です。candidateへ派生`manifest.json`や
prebuilt bundleを要求せず、review済みjudge adapterがread-only sourceから`/work`内へ抽出・buildします。

## Run

事前にreview済みimageがlocal daemonへdigest固定で配置され、requestとcandidateがschemaを満たしている必要があります。

```sh
# cwd: repository root
# expected-exit: 0
mkdir -p .tmp/plugin-authoring-isolated
pnpm isolated-agent-eval:run -- request.json candidate .tmp/plugin-authoring-isolated/output
```

operatorが管理する親directoryは先に作成します。runnerはoutput directory自体が存在しないか空であることを要求し、
symlinkや既存artifactを上書きしません。
成功時はstdoutへ次のbounded observationを返します。

```json
{
  "status": "success",
  "summary": "10 of 10 plugin authoring tasks passed all deterministic judges",
  "nextActions": [],
  "artifacts": ["evidence.json", "result.json"]
}
```

- `evidence.json`はcandidate digest、baseline、corpus digest、image digest、limits、cleanup、全judge結果を持つ
- `result.json`は既存`isolated-agent-run` contractへ接続し、evidence SHA-256を必須にする
- judge failureは`warning`とfailure code別の次アクションを返す
- sandbox、execution、output、cleanup failureはnon-reflective errorで停止する

## Local judge image contract

`deploy/plugin-authoring-judge/Dockerfile`はlinux/amd64のNode baseをplatform manifest digestで固定し、
multi-stage buildでlockfileから依存を`--ignore-scripts` installします。build contextは
`plugin-authoring-judge-image-context.mjs`のallowlistで作り、`.git`、`.devloop`、`.tmp`、candidate、test source、
local build artifactをdaemonへ渡しません。final imageへはprivate image workspaceのproduction dependency closureだけを
deployし、root所有artifactをnon-rootの`node` userで読み、固定entrypointだけを起動します。

actual image contract testは`--network=none`、read-only root、全capability drop、no-new-privileges、PID/memory/CPU上限、
read-only input mount、UID/GID 65532だけが書けるbounded `/tmp`・`/work` tmpfsを使い、production runnerと同じargvで
known-good 10 task x 6 judgeと固定failureを実行します。さらにjudge-ownedな6つのknown-bad mutationを互いに異なるtaskへ
配置した1 container matrixを実行し、target failureを含む次のclosed failure vectorだけが返ることを検証します。

| Target failure           | Judge-owned mutation        | Closed failure vector                          |
| ------------------------ | --------------------------- | ---------------------------------------------- |
| `manifest-invalid`       | invalid manifest version    | `manifest`, `audit`, `least-privilege`         |
| `build-failed`           | compile-time type error     | `build`, `unit-test`, `security-test`, `audit` |
| `unit-test-failed`       | wrong behavior result       | `unit-test`                                    |
| `security-test-failed`   | raw egress attempt          | `unit-test`, `security-test`, `audit`          |
| `audit-failed`           | missing package test script | `audit`                                        |
| `least-privilege-failed` | unused capability grant     | `audit`, `least-privilege`                     |

相関failureはbuild receipt、runtime loader、static audit、manifest/least-privilege評価のfail-closed依存を表します。
fixture sourceとscenario contractはimage build contextへ含めず、test時のread-only candidate mountだけで渡します。
production entrypointへfailure injection hookは追加しません。

```sh
# cwd: repository root
# expected-exit: 0
pnpm test:judge-image
```

### Local SBOM candidate evidence

`pnpm test:judge-image`は実imageをarchive化し、Syft 1.49.0のlinux/amd64 manifest digestを固定したscannerへ
read-only mountしてCycloneDX 1.7 JSONを生成します。scanner containerはnetworkなし、read-only root、non-root、
capabilityなしで動き、Docker socketやregistry credentialを受け取りません。validatorはcomponent/dependency上限、
unique `bom-ref`、dependency参照、Node/TypeScript/esbuild/TenantScript runtime、base OS、development package非混入、
secret-shaped valueとhost path非反射をfail-closedで確認します。

```sh
# cwd: repository root
# expected-exit: 0
pnpm judge-image:evidence
```

生成物は`.tmp/plugin-authoring-judge-image-evidence/`の`judge-image.cdx.json`と
`judge-image-evidence.json`です。candidate evidenceはsource revision、Dockerfile/lockfile/allowlist context digest、
local image ID、scan対象archive digest、SBOM digest、scanner digestを結びます。Tier 1は
`plugin-authoring-judge-image-evidence-<commit SHA>`として14日保持します。raw SBOMのtimestamp、UUID、digestは
対象scan artifactのidentityです。archiveは512 MiBをhard capにしますが、`docker save`のbyte表現とサイズはengine-localであり、
別engine・別buildとのbyte-for-byte reproducibilityを主張しません。

これはlocal source/build/runtimeとSBOM inventoryのrepository evidenceです。imageは未publish・未attestで、
local image IDはGHCR registry digestではありません。candidate statusには`registry-digest`、`attestation`、
`independent-review` blockerが残るため、review済みproduction image、provenance、脆弱性不存在、real-agent品質の
証拠として扱いません。linux/amd64以外も検証済みとは主張しません。

PR head、`pull_request` workflowの一時merge SHA、成功run、GitHub artifact digest、上記candidate evidence、
SBOM digest、Codex review判断は
[`TS-JUDGE-IMAGE-REVIEW-2026-001`](../security/judge-image-reviews/TS-JUDGE-IMAGE-REVIEW-2026-001.json)
で別々のidentityとして固定し、repository gateでcurrent image inputとのdriftを検証します。artifactの期限切れは
download可用性だけに影響し、candidateをapprovedへ昇格しません。record formatと3つの残存blockerは
[`judge-image-reviews`](../security/judge-image-reviews/README.md)を参照してください。

## Verification and current limitation

```sh
# cwd: repository root
# expected-exit: 0
pnpm test:agent-evals
pnpm test:judge-image
pnpm test:security
```

Tier 1はfake Docker backendでrequest、workspace、固定invocation、cleanup、evidence/resultのorchestrationを
決定論的に検証し、unknown codeを実行しません。これはrunner contractの証拠であり、reviewed judge imageの
内容や外部agentの品質証拠ではありません。このrunner contract does not publish real-agent metrics、pass@3、
provider cost、monthly regression resultを公開しません。それらはimage reviewと複数trialの後続作業です。
