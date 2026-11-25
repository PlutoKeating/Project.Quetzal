# 领域包签名与校验工具

本示例二进制把 `packages/domains/*/pack.json` 中的安全信封重新计算并签名为可校验状态。

```bash
# 前缀工具链 PATH 以避免 rustup 代理异常
cargo run -p quetzalcoatl-domains --example sign_domain_packs
```

它做四件事，全部基于 crate 内的唯一实现（与运行期校验共用同一段代码，杜绝“签名脚本与校验器各写一套”）：

1. 剥离 `safetyEnvelope`，对正文做 RFC 8785 规范化 JSON + 域分离 BLAKE3，得到 `packBlake3Hex`；
2. 把监护人公钥与标签写入信封载荷，保证 `guardianKeyId == guardianPubkeyHex`；
3. 对载荷再算一次规范化摘要，得到 `digestHex`；
4. 用监护人 Ed25519 种子签名该摘要，写入 `sigHex`。

> **安全声明**：仓库内置签名使用的是由领域包 ID 经 BLAKE3 派生的**合成演示钥匙**（非机密）。
> 真实部署必须由监护人自持的离线 Ed25519 密钥重签，并通过
> `DomainPackRegistry::trust_guardian` 登记其公钥；未登记密钥签署的领域包会被 `PermissionDenied` 拒绝。
