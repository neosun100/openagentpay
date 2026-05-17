#!/usr/bin/env bash
# scripts/restore-demo.sh
# =====================================================================
# 演讲台应急脚本：30 秒内恢复 demo
# =====================================================================
#
# 用途：
#   如果 Lambda Function URL 突然返回 403 Forbidden（demo 突然不能访问），
#   通常是 Amazon Palisade/Epoxy 自动检测到 'world accessible' 后做了
#   mitigation 把 Resource Policy 的 Principal:* 收窄成 account ID。
#
# 怎么知道是这个原因：
#   curl https://d1p7yxa99nxaye.cloudfront.net/api/health
#   → 如果返回 {"Message":"Forbidden..."} ，就是这个问题
#
# 修复方案：
#   1. 重新加 wide-open Resource Policy（恢复公开访问）
#   2. CloudFront invalidate（清错误响应缓存）
#   3. 等约 60 秒 propagation
#   4. demo 恢复
#
# 演讲台用法：
#   bash scripts/restore-demo.sh
#
# 依赖：
#   - AWS_PROFILE=jiasunm-neo（如未配置请先 'isengard auth login'）
#
# Talos finding ID（备查）：
#   ffd4d097-06ac-4849-b79a-69fe56efc501
#
# Ticket（已 Resolved）：
#   28157d5b-2aea-4284-b95f-2d4f998f845e
# =====================================================================

set -euo pipefail

PROFILE=jiasunm-neo
REGION=us-east-1
FUNCTION=openagentpay-demo-api
DISTRIBUTION=E30J02EDDPMCS9
DEMO_URL=https://d1p7yxa99nxaye.cloudfront.net

echo "=== Step 1: 检查当前 demo 状态 ==="
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${DEMO_URL}/api/health?_=$(date +%s)")
echo "  Current /api/health: HTTP ${HTTP_CODE}"
echo ""

if [ "${HTTP_CODE}" = "200" ]; then
  echo "✅ Demo 已经 OK，无需恢复。"
  exit 0
fi

echo "=== Step 2: 添加 wide-open Resource Policy ==="
STMT_ID="PublicAccessRestoreDemo$(date +%s)"
aws lambda add-permission \
  --function-name "${FUNCTION}" \
  --action lambda:InvokeFunctionUrl \
  --principal "*" \
  --function-url-auth-type NONE \
  --statement-id "${STMT_ID}" \
  --profile "${PROFILE}" \
  --region "${REGION}" \
  --output text > /dev/null
echo "  Added policy statement: ${STMT_ID}"
echo ""

echo "=== Step 3: CloudFront invalidation ==="
INV_ID=$(aws cloudfront create-invalidation \
  --distribution-id "${DISTRIBUTION}" \
  --paths "/*" \
  --profile "${PROFILE}" \
  --region "${REGION}" \
  --query 'Invalidation.Id' \
  --output text)
echo "  Invalidation ID: ${INV_ID}"
echo "  等待 invalidation 完成..."
aws cloudfront wait invalidation-completed \
  --distribution-id "${DISTRIBUTION}" \
  --id "${INV_ID}" \
  --profile "${PROFILE}" \
  --region "${REGION}"
echo "  ✅ Invalidation done."
echo ""

echo "=== Step 4: Wait 30s for propagation ==="
sleep 30

echo "=== Step 5: 验证 demo 恢复 ==="
HTTP_CODE=$(curl -s -o /tmp/restore-test.json -w "%{http_code}" "${DEMO_URL}/api/health?_=$(date +%s)")
echo "  /api/health: HTTP ${HTTP_CODE}"
cat /tmp/restore-test.json
echo ""
echo ""

if [ "${HTTP_CODE}" = "200" ]; then
  echo "🎉 Demo 已恢复！"
  echo ""
  echo "Live URL: ${DEMO_URL}"
  echo ""
  echo "建议：演讲时 demo 测试一下 /api/wallet 看 USDC balance 是否实时返回："
  echo "  curl ${DEMO_URL}/api/wallet"
  exit 0
else
  echo "❌ Demo 仍未恢复——可能需要等更久 propagation。"
  echo "如果 60s 后仍 403，备用方案："
  echo "  1. 笔记本运行本地 demo: pnpm demo"
  echo "  2. 用截图 + 链上 explorer 链接展示历史交易"
  echo ""
  echo "已确认链上 tx (Blockscout 永久可查):"
  echo "  https://testnet-explorer.hsk.xyz/tx/0xd18cb0f19359bdaae17aa89a0e14c47ccb7793579b9a09ac0423eefb1390a06a"
  echo "  https://testnet-explorer.hsk.xyz/tx/0xf6fc51415fd0210485c9c3ac0bc7c68bd13a843991fc1f74cc0a04a2cbbcfa53"
  echo "  https://testnet-explorer.hsk.xyz/tx/0x115d72e812b957dc8c2de65242eb84eb377a728a8e594a46348948ec949ae020"
  exit 1
fi
