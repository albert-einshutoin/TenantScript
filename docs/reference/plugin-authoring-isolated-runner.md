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
review済みimage、production judge adapter、sandboxの証拠ではありません。manifest抽出やbuildを行うadapterは
後続のimage実装でcontainer内だけに接続し、scaffold正本の`src/manifest.ts`を扱います。

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
