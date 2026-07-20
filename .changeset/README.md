# Changesets

利用者に影響する変更は`pnpm changeset`でrelease noteを追加します。公開APIのbreaking changeでは、
影響する各packageを`major`にし、本文から`docs/migrations/*.md`の実在するguideへlinkしてください。

8つの公開packageは1つのTenantScript platformとしてfixed versionでreleaseします。private workspaceは
release対象ではありません。
