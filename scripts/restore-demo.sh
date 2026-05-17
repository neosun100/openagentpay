#!/usr/bin/env bash
# scripts/restore-demo.sh — DEPRECATED
# =====================================================================
# 此脚本已不再需要！
#
# 之前的 demo 用 Lambda Function URL (AuthType=NONE)，被 Amazon
# Palisade flag 为 'world accessible'，每次 Epoxy mitigation 后
# 都需要这个脚本恢复。
#
# 现在的 demo 用 API Gateway HTTP API（标准合规架构），Palisade
# 不会再 flag。如果 demo 真的有问题，跑 check-demo.sh 诊断：
#
#   bash scripts/check-demo.sh
# =====================================================================

echo "⚠️  此脚本已 deprecated。架构已改为 API Gateway，不再需要恢复。"
echo "   跑 check-demo.sh 做健康检查即可："
echo ""
echo "       bash scripts/check-demo.sh"
echo ""
exit 0
