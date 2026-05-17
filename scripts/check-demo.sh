#!/usr/bin/env bash
# scripts/check-demo.sh
# =====================================================================
# 演讲台 health check：验证 demo 全链路 OK
# =====================================================================
#
# 架构（2026-05-17 23:25 后）：
#   Browser → CloudFront → API Gateway HTTP API → Lambda → HashKey Chain
#
#   Lambda Function URL 已彻底删除（避免被 Amazon Palisade flag 为
#   world-accessible）。API Gateway 是 AWS 标准 public-facing service，
#   不会触发 Palisade 的 lambda_function_world_accessible detector。
#
# 用法：
#   bash scripts/check-demo.sh
# =====================================================================

set -uo pipefail

DEMO_URL=https://d1p7yxa99nxaye.cloudfront.net
API_GATEWAY=https://awutdc0iaa.execute-api.us-east-1.amazonaws.com

echo "=== OpenAgentPay Demo Health Check ==="
echo ""

# 1. CloudFront /api/health
echo "[1/4] CloudFront → /api/health"
HTTP=$(curl -s -o /tmp/h.json -w "%{http_code}" "${DEMO_URL}/api/health?_=$(date +%s)")
if [ "${HTTP}" = "200" ]; then
  echo "      ✅ HTTP 200: $(cat /tmp/h.json)"
else
  echo "      ❌ HTTP ${HTTP}: $(cat /tmp/h.json)"
fi
echo ""

# 2. CloudFront /api/wallet
echo "[2/4] CloudFront → /api/wallet (live HashKey balance)"
HTTP=$(curl -s -o /tmp/w.json -w "%{http_code}" "${DEMO_URL}/api/wallet?_=$(date +%s)")
if [ "${HTTP}" = "200" ]; then
  BAL=$(python3 -c "import json; print(json.load(open('/tmp/w.json'))['balance'])" 2>/dev/null)
  echo "      ✅ HTTP 200, balance: ${BAL} USDC"
else
  echo "      ❌ HTTP ${HTTP}"
fi
echo ""

# 3. POST /api/session
echo "[3/4] POST /api/session"
SID=$(curl -s -X POST "${DEMO_URL}/api/session?_=$(date +%s)" \
  -H "Content-Type: application/json" \
  -d '{"budgetUsd":0.1,"expiryMinutes":15}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('sessionId',''))" 2>/dev/null)
if [ -n "${SID}" ]; then
  echo "      ✅ session: ${SID}"
else
  echo "      ❌ no session"
fi
echo ""

# 4. POST /api/pay (real on-chain)
echo "[4/4] POST /api/pay (real on-chain settlement)"
if [ -n "${SID}" ]; then
  curl -s -X POST "${DEMO_URL}/api/pay?_=$(date +%s)" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${SID}\",\"amountUsdc\":0.001}" \
    | python3 -c "
import json, sys
d = json.load(sys.stdin)
if d.get('success'):
    print(f'      ✅ tx: {d[\"txHash\"]}')
    print(f'         block: {d[\"settleResult\"][\"blockNumber\"]}')
    print(f'         explorer: {d[\"explorerUrl\"]}')
else:
    print(f'      ❌ {json.dumps(d, indent=2)[:300]}')
"
fi
echo ""
echo "=== Done ==="
echo ""
echo "Demo URL:        ${DEMO_URL}"
echo "API Gateway:     ${API_GATEWAY}"
echo "GitHub:          https://github.com/neosun100/openAgentPay"
echo ""
echo "如果以上 4 步都 ✅，demo 就 ready for the talk."
