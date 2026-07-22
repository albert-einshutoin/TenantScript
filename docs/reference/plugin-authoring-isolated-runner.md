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
閉じます。このrepository module自体はまだreview済みimageの
`/opt/tenantscript/bin/plugin-authoring-judge`へinstallされていません。

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

`unit-test` judgeにはjudge-owned behavior matrixを使うbounded adapterがあります。
`behavior-cases.json`は固定10 taskごとに正常系、境界、malformed payload、provider failureをclosed dataとして保持し、
candidateのtest scriptやfixtureを読みません。各caseは新しい固定Node childで`bundle.cjs`をproduction loaderの
`runScopedPluginDispatch`へ渡し、250ms、128 MiB、case固有subrequest上限で実行します。childはsanitized environmentを使い、
stdoutのclosed observationをrunごとの32-byte keyでHMAC認証します。親adapterはbuild receipt、result、capability call、
runtime log、未完了capabilityをすべて照合し、1 caseが失敗しても残りのcaseを実行します。

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

security-test、auditの2 execution adapterは未実装です。entrypoint interfaceではmissing、false、例外、
boolean以外の結果を各judgeのfailureへfail closedにし、後続judgeとtaskをskipしません。build / unit-test adapterの成功やtest
doubleの全成功はimageやreal-agent qualityの証拠ではなく、残る2 execution adapterがreview済みimageへ接続されるまで
実runの全judge成功を主張しません。

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

## Verification and current limitation

```sh
# cwd: repository root
# expected-exit: 0
pnpm test:agent-evals
pnpm test:security
```

Tier 1はfake Docker backendでrequest、workspace、固定invocation、cleanup、evidence/resultのorchestrationを
決定論的に検証し、unknown codeを実行しません。これはrunner contractの証拠であり、reviewed judge imageの
内容や外部agentの品質証拠ではありません。このrunner contract does not publish real-agent metrics、pass@3、
provider cost、monthly regression resultを公開しません。それらはimage reviewと複数trialの後続作業です。
