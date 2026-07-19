# Security suite v2 threat map

TenantScriptのTier 1 security suiteは、Cloudflare accountやrepository secretを使わず、fork Pull Requestでも主要な信頼境界を検証する。これはPhase 3で予定する完全なthreat modelの前段となる、Phase 1攻撃面のsource of truthである。

## Trust boundaries

1. **Plugin isolate → loader/capability broker**: plugin codeはraw secret、未許可egress、未許可capabilityへ到達できない。
2. **Client → Control Plane**: app、tenant、actor、roleは認証identityから導出し、request bodyの自己申告を信頼しない。
3. **Control Plane → D1/Durable Object**: tenant scope、revision、budget、audit、idempotencyをstorage境界でも検証する。
4. **Control Plane → Admin UI**: UIはbearer tokenを明示送信し、cookie authorityに依存せず、server-controlled textをHTMLとして解釈しない。
5. **Workspace package → package**: production dependencyはレビュー済みの方向だけを許可し、sandboxとControl Planeの責務を混在させない。

## Attack-to-test map

| Attack                                   | Required rejection or containment                                  | Permanent test                                               |
| ---------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| raw secret/global/fetch extraction       | plugin contextへ公開しない                                         | `packages/loader/test/security-suite.test.ts`                |
| capability/grant escalation              | 未許可名、scope、role、resumeHookを拒否                            | `packages/capabilities/test/security-suite.test.ts`          |
| capability journal tampering             | 同じexecution/call indexの異なる入力をreplayせずproviderも呼ばない | `packages/capabilities/test/security-suite.test.ts`          |
| approval role/tenant/resumeHook spoofing | token roleと保存済みapprovalだけを使用                             | `packages/control-plane/test/security-suite.test.ts`         |
| budget race or negative usage            | Durable Objectで直列化し、counter減算を拒否                        | `packages/control-plane/test/security-suite.test.ts`         |
| tenant/app boundary bypass               | D1 queryとmutationの両方でidentity scopeを固定                     | `packages/control-plane/test/security-suite.workers.test.ts` |
| proxy SSRF/allowlist bypass              | private、loopback、link-local、non-HTTP、未許可originを拒否        | `packages/proxy/test/security-suite.test.ts`                 |
| Admin UI XSS                             | server-controlled labelをtext nodeとして描画                       | `apps/admin-ui/src/security-suite.test.tsx`                  |
| Admin UI CSRF                            | mutationはexplicit bearerを使い、fetch credentialsを`omit`         | `apps/admin-ui/src/security-suite.test.tsx`                  |
| package dependency reversal              | 未承認workspace edgeと未知の内部packageをCIで拒否                  | `scripts/check-package-boundaries.test.mjs`                  |

## Running the gate

```sh
pnpm test:security
pnpm lint:boundaries
```

`.github/workflows/tier1.yml`は両方をaccountless quality gateとして実行する。攻撃面を追加した場合は、機能テストだけでなくこの対応表と該当security suiteも同じPull Requestで更新する。

## Current architecture exception

`@tenantscript/loader`から`@tenantscript/control-plane`への依存はapproval continuation contractが現在Control Plane packageにあるため許可している。checkerはこの1本を明示allowlistに固定し、他packageが同じ上向き依存を増やすことは許可しない。contractを下位の共有packageへ抽出した時点でこの例外を削除する。
