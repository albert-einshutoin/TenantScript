# Migration guides

公開APIのbreaking changeごとに、利用者が旧APIから移行できる具体的なguideをこのdirectoryへ追加します。
guideには影響package、before/after、移行手順、互換期間、rollback方法を含めます。

対応するChangeset本文から相対linkし、影響packageを`major`として宣言してください。snapshot更新だけ、
外部URLだけ、存在しないguide、`docs/migrations/`外へのlinkはTier 1で拒否されます。
