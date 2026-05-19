# 7-Layer Guardrail · OpenAgentPay 风控架构

> **概览**：OpenAgentPay 借鉴 AWS Bedrock AgentCore Payments 的 7 层 Guardrail 设计，把每一层做成**可插拔的开源组件**。Layer 3/5/7 由 [`@openagentpay/governance`](../packages/governance/) 提供，开发者按需替换具体实现（DynamoDB / Splunk / Chainalysis ...）即可。

<p align="center">
  <img src="https://img.aws.xin/uPic/guardrail-7-layers.png" alt="OpenAgentPay 7-Layer Guardrail" width="600"/>
</p>

---

## 为什么需要 7 层？

AI Agent 自主花钱听起来很酷，但企业财务/法务/合规第一反应一定是：

> "Agent 会不会花爆预算？"
> "怎么满足 SOX / MRM / 反洗钱审计？"
> "Prompt injection 把 Agent 骗去打钱怎么办？"
> "OFAC sanctions 制裁名单怎么过滤？"
> "私钥被盗怎么办？"

**单点防护永远不够**，必须把不同性质的检查分散到不同的层，每一层都"硬"，**Agent 无法绕过**。AgentCore Payments 团队总结了 7 层；OpenAgentPay 继承这个设计并开源化。

**关键原则：任一层失败即止**（first-deny-wins）。所有决策无论通过还是拒绝，都进入 Layer 7 audit log，永久不可篡改。

---

## 7 层逐一详解

### 🔐 Layer 1 · Authorization

> End user 显式授权 Agent 使用 wallet。

| | |
|---|---|
| **解决什么问题** | Agent 不能 open-ended 自主绑定钱包；必须 end user 确认 |
| **OpenAgentPay 实现** | **Out of scope**——交给上游 auth 系统 |
| **典型方案** | AWS Cognito · OIDC · SAML · 企业 SSO |
| **AgentCore 对照** | 同 — AgentCore 也要求 end user explicit consent |

为什么 out-of-scope？因为这一层强烈依赖你的 IdP 选型，没有"开源"统一方案。OpenAgentPay 假设这一层**已经在系统外完成**，从 Agent 拿到的 `userId` 已经是经过 auth 的可信标识。

---

### 📋 Layer 2 · Session

> 每笔/每段时间的预算上限 + 过期时间。

| | |
|---|---|
| **解决什么问题** | "Agent 会不会花爆预算？" |
| **OpenAgentPay 实现** | [`@openagentpay/core`](../packages/core/) `SessionManager` |
| **API 形态** | `createPaymentSession({ budgetUsd, expiryMinutes })` |
| **强制点** | `processPayment()` 内部 atomic check-and-reserve 后再签名 |
| **AgentCore 对照** | `PaymentSession` 完全对齐 — `maxSpendAmount` + `expiryTime` |

代码位置：[`packages/core/src/session/manager.ts`](../packages/core/src/session/manager.ts)

```typescript
// Agent 代码层
const session = await pm.createPaymentSession({
  userId,
  budgetUsd: 5,            // hard cap
  expiresMinutes: 30,      // session TTL
});
// ...
await pm.processPayment({ sessionId: session.id, ... });
// 超出预算 → 抛 SessionError(code: "exhausted")
// 过期 → 抛 SessionError(code: "expired")
```

---

### 📐 Layer 3 · Policy ⭐ NEW v0.4.0

> Velocity / amount / merchant / time-of-day 等可配置规则。

| | |
|---|---|
| **解决什么问题** | "光有 budget cap 不够——还需要每小时限速、单笔阈值、白/黑名单..." |
| **OpenAgentPay 实现** | [`@openagentpay/governance`](../packages/governance/) `PolicyEngine` |
| **内置规则** | 6 种（见下表） |
| **扩展点** | `Policy` 是纯函数 `(ctx) => PolicyDecision` — 自己写一个就能用 |
| **AgentCore 对照** | "Finance/Compliance team can define per-agent / per-session policies" |

#### 内置 Policy 规则

| 函数 | 用途 | 例子 |
|---|---|---|
| `velocityLimit({windowMs, maxCount, maxAmountAtomic})` | 滑窗速率限制 | "每分钟最多 20 笔" / "每小时最多 \$100" |
| `amountThreshold({maxAtomic})` | 单笔金额上限 | "单笔不能超过 \$50" |
| `merchantWhitelist(addresses)` | 收款方白名单 | "只能向已 KYC 过的商户付款" |
| `merchantBlacklist(addresses)` | 收款方黑名单 | "屏蔽已知诈骗地址" |
| `walletProviderWhitelist(providers)` | 钱包白名单 | "agent A 只能用 Coinbase CDP，不能用其他" |
| `timeOfDay({startHourUtc, endHourUtc})` | 时段限制 | "只在工作时间允许付款" |

#### 工作流

1. 调用 `policyEngine.evaluate(ctx)`，按 use 顺序串行检查
2. **第一个 deny 即返回**，不再检查后续 policies
3. 所有评估结果（含通过的）一并写入 audit log

#### 例子（demo-api 默认配置）

```typescript
policyEngine.use(amountThreshold({ maxAtomic: "50000000" })); // $50
policyEngine.use(velocityLimit({ windowMs: 60_000, maxCount: 20 })); // 20/min
policyEngine.use(velocityLimit({
  windowMs: 60 * 60 * 1000,
  maxAmountAtomic: "100000000", // $100
}));
```

---

### ⛓️ Layer 4 · On-chain

> 每笔交易在公链上有 immutable record（不可抵赖、不可篡改）。

| | |
|---|---|
| **解决什么问题** | "事后审计、纠纷解决——证据从哪来？" |
| **OpenAgentPay 实现** | Wallet connectors 通过 EIP-3009 `transferWithAuthorization` 上链 |
| **证据点** | block number + tx hash + timestamp + 签名 v/r/s |
| **AgentCore 对照** | 完全相同——AgentCore 也用 EIP-3009 |

支持的链（v0.4.0）：

- HashKey Chain Testnet（[`wallet-hashkey`](../packages/wallet-hashkey/)）
- Base Sepolia（[`wallet-coinbase-cdp`](../packages/wallet-coinbase-cdp/)）

每笔成功支付都返回：

```typescript
{
  txHash: "0xb6e6674f...",
  blockNumber: "41691332",
  gasUsed: "100308",
  explorerUrl: "https://sepolia.basescan.org/tx/0xb6e6674f..."
}
```

CEX 路径（OAP-CEX，例如 Binance Pay）虽然不真上链，但有 CEX 提供的不可抵赖 transactionId — 同样属于 Layer 4 范畴。

---

### 🛡️ Layer 5 · Compliance ⭐ NEW v0.4.0

> Sanctions / OFAC / illicit finance 检查。

| | |
|---|---|
| **解决什么问题** | "怎么避免给被制裁地址打钱？反洗钱怎么办？" |
| **OpenAgentPay 实现** | [`@openagentpay/governance`](../packages/governance/) `ComplianceChecker` |
| **内置实现** | `StaticSanctionsChecker`（demo 用）·`CompositeComplianceChecker`（聚合多个）|
| **生产扩展点** | Chainalysis KYT API · TRM Labs · Elliptic · OFAC SDN list parser |
| **AgentCore 对照** | "Coinbase CDP Facilitator 内置 sanctions 检查" — OpenAgentPay 把它做成可插拔 |

#### Demo 配置

```typescript
import { StaticSanctionsChecker, DEMO_SANCTIONS_LIST } from "@openagentpay/governance";

const checker = new StaticSanctionsChecker([DEMO_SANCTIONS_LIST]);
// DEMO_SANCTIONS_LIST 包含 Tornado Cash 路由 + Lazarus Group 等示意地址
```

#### 生产扩展示例（伪代码）

```typescript
class ChainalysisChecker implements ComplianceChecker {
  readonly name = "ChainalysisKYT";
  async check(recipient: string): Promise<ComplianceCheckResult> {
    const r = await fetch(`https://api.chainalysis.com/api/kyt/v1/users/.../address/${recipient}`, {
      headers: { Token: process.env.CHAINALYSIS_API_KEY! },
    });
    const json = await r.json();
    return { cleared: json.risk === "Low", checkerName: this.name, matches: json.matches };
  }
}

const composite = new CompositeComplianceChecker([
  new ChainalysisChecker(),
  new StaticSanctionsChecker([OFAC_SDN_LIST]),
]);
// fail-closed: 任一 fail 即拒绝
```

---

### 🔑 Layer 6 · Identity

> 私钥 / 凭证管理 — Agent 永远拿不到原始 secret。

| | |
|---|---|
| **解决什么问题** | "Agent 容器被入侵 → 私钥被盗 → 完蛋" |
| **OpenAgentPay 实现** | AWS Secrets Manager + KMS（HashKey path）· Coinbase CDP TEE（CDP path） |
| **加密** | KMS-encrypted at rest · TLS in transit · 仅 Lambda IAM 角色可读 |
| **强制点** | Lambda 启动时拉取，仅在内存中存在；Agent 容器零接触 |
| **AgentCore 对照** | 完全相同——AgentCore Identity = 我们的 Secrets Manager |

#### CDK 配置示例

```typescript
const pkSecret = new secretsmanager.Secret(this, "HashkeyAgentPrivateKey", {
  secretStringValue: cdk.SecretValue.unsafePlainText(props.hashkeyAgentPrivateKey),
});
pkSecret.grantRead(apiFn); // 只有 Lambda 能读
apiFn.addEnvironment("HASHKEY_TESTNET_AGENT_PRIVATE_KEY_SECRET_ARN", pkSecret.secretArn);
```

Coinbase CDP 路径更进一步——私钥**永远不离开 Coinbase TEE**（trusted execution environment）；我们的代码只能调 `account.signTypedData()` 拿签名结果，看不到底层私钥。

---

### 📜 Layer 7 · Audit ⭐ NEW v0.4.0

> 所有决策 + 推理链 + 结果统一进入不可篡改日志。

| | |
|---|---|
| **解决什么问题** | "审计报告怎么写？SOX / MRM 怎么过？" |
| **OpenAgentPay 实现** | [`@openagentpay/governance`](../packages/governance/) `AuditLogger` + `AuditSink` |
| **内置 Sink** | `InMemoryAuditSink`（demo）· `ConsoleAuditSink`（local dev） |
| **生产扩展点** | S3 (immutable bucket) · CloudWatch Logs · OpenSearch · Splunk · Datadog |
| **AgentCore 对照** | "Every payment decision + reasoning + tx hash unified log" |

#### 事件结构

```typescript
interface AuditEvent {
  eventId: string;          // timestamp-ordered: "audit-{hex_ts}-{rand}"
  timestamp: string;        // ISO 8601
  kind: AuditEventKind;     // policy_check / compliance_check / payment_success / ...
  actor: string;            // userId
  walletProvider?: string;
  sessionId?: string;
  recipient?: string;
  amountAtomic?: string;
  currency?: string;
  chain?: string;
  txHash?: string;
  result: "allowed" | "denied" | "succeeded" | "failed";
  reason?: string;
  policyEvaluations?: PolicyDecision[];  // every rule's outcome
  complianceCheck?: ComplianceCheckResult;
  metadata?: Record<string, unknown>;    // free-form
}
```

#### 一笔成功付款产生的事件序列

```
13:38:17  policy_check       allowed   (3 policies passed)
13:38:17  compliance_check   allowed   (no sanctions match)
13:38:18  payment_success    succeeded (tx 0xb6e6674f..., block 41691332)
```

#### 一笔被 deny 的付款

```
13:38:19  policy_check       denied    "amount 100000000 exceeds maxAtomic 50000000"
                                       (compliance_check 不会被触发，first-deny-wins)
```

---

## 端到端示例：从请求到 audit

```typescript
// 1. Agent 收到 HTTP 402, 构造 PaymentRequest
const request: PaymentRequest = {
  protocol: "x402-v1",
  recipient: "0x...",
  amount: { amountAtomic: "10000000", decimals: 6, currency: "USDC" }, // $10
  validBefore: now + 600,
  nonce: connector.generateNonce(),
};

// 2. Layer 2: Session 检查
const session = await sessionManager.getSession(sessionId);
// 已 budget reserved (atomic) — 失败抛 SessionError

// 3. Layer 3 + 5 + 7 一站式
const decision = await governance.preCheck({ userId, walletProvider, request, session });
if (!decision.allowed) {
  return reject(decision.reason); // L3/L5 deny，audit 已记录
}

// 4. Layer 6: 从 Secrets Manager 加载私钥（启动时已 cached）
// 5. 签名（私钥不离开 Lambda 内存）
const signed = await connector.signAuthorization({ instrumentId, request, session });

// 6. Layer 4: 上链
const settlement = await connector.settle(signed);

// 7. Layer 7: 记录最终结果
if (settlement.success) {
  await governance.recordSuccess({ ...settlement, txHash: settlement.transactionRef });
} else {
  await governance.recordFailure({ ..., errorCode: settlement.errorCode });
}
```

---

## 试一试 (Live Demo)

打开 [https://d1p7yxa99nxaye.cloudfront.net](https://d1p7yxa99nxaye.cloudfront.net) → 切换到 **Guardrail** tab：

- 顶部看到 7 层完整可视化
- "Try It" 区有两个按钮，一键触发 Policy deny 和 Sanctions match
- 下方 audit log 实时刷新（每 3 秒），看每笔决策的完整 trail

或者直接 curl：

```bash
# 列出所有 active policies + sanctions checker
curl https://d1p7yxa99nxaye.cloudfront.net/api/governance | jq

# 模拟 policy deny: $100 > $50 cap
curl -X POST https://d1p7yxa99nxaye.cloudfront.net/api/pay \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<...>","amountUsdc":100,"walletProvider":"coinbase-cdp"}'
# 返回 success:false errorCode:"policy_denied"

# 模拟 sanctions deny
curl -X POST https://d1p7yxa99nxaye.cloudfront.net/api/pay \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<...>","amountUsdc":0.001,
       "recipient":"0x8589427373d6d84e98730d7795d8f6f8731fda16",
       "walletProvider":"coinbase-cdp"}'
```

---

## 与 AgentCore Payments 对照表

| 维度 | AgentCore Payments | OpenAgentPay |
|---|---|---|
| Layer 1 Authorization | End user UI consent | 同——交给上游 |
| Layer 2 Session | `PaymentSession` (managed) | `@openagentpay/core` (open-source) |
| Layer 3 Policy | "Finance/Compliance team policies"（产品里）| `@openagentpay/governance` PolicyEngine（OSS，可自托管） |
| Layer 4 On-chain | x402 + EIP-3009 | 同（plus HashKey 异链支持） |
| Layer 5 Compliance | Coinbase CDP 内置 sanctions | `ComplianceChecker` 接口（pluggable，可换 Chainalysis 等） |
| Layer 6 Identity | AgentCore Identity | AWS Secrets Manager + KMS（直接复用 AWS）+ Coinbase CDP TEE |
| Layer 7 Audit | 统一日志（managed） | `AuditLogger` + `AuditSink`（pluggable，跨 SIEM 可移植） |

**核心差异**：AgentCore Payments 是 AWS 完全 managed 的 SaaS，OpenAgentPay 是开源、可自托管、跨钱包/链/协议。两者**不互斥**——OpenAgentPay 明确把自己定位为 AgentCore Payments 的**扩展层**，而非替代品。

---

## 路线图

| 项目 | 状态 | 备注 |
|---|---|---|
| 6 内置 policies | ✅ v0.4.0 | velocityLimit, amountThreshold, merchantWhite/Black, walletProviderWhitelist, timeOfDay |
| 23 governance unit tests | ✅ v0.4.0 | 100% pass |
| Live audit log UI | ✅ v0.4.0 | demo-web Guardrail tab |
| Static sanctions checker | ✅ v0.4.0 | demo only |
| **DynamoDB AuditSink** | ⏳ planned | 持久化 audit log |
| **Chainalysis KYT integration** | ⏳ planned | production-grade compliance |
| **OFAC SDN list auto-sync** | ⏳ planned | 每日同步官方 list |
| **Per-agent policy bundles** | ⏳ planned | 不同 agent 应用不同 policy 集 |
| **Two-person approval for high-value** | ⏳ planned | tx > $X 需要二人审批 |
| **Anomaly detection (ML-based)** | ⏳ research | spend pattern 异常检测 |

---

## 参考阅读

- [`@openagentpay/governance` 源代码](../packages/governance/)
- [`packages/governance/tests/governance.test.ts`](../packages/governance/tests/governance.test.ts) — 23 unit tests
- [AWS Bedrock AgentCore Payments Preview](https://aws.amazon.com/bedrock/agentcore/) — 我们 inspire 的对象
- [研究报告](https://github.com/neosun100/fsidnb-agentcore-payment) — AgentCore Payments 完整深度分析（含 7 层 Guardrail 的官方插图）
- [`docs/STRATEGY.md`](./STRATEGY.md) — OpenAgentPay 整体战略

---

*Last updated: 2026-05-19 · v0.4.0 · 维护者：[Neo Sun](https://github.com/neosun100)*
