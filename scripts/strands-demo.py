"""
scripts/strands-demo.py — Live demo of openagentpay-strands against production API.

Demonstrates the Strands plugin in 3 scenarios against the live OpenAgentPay
demo-api at https://d1p7yxa99nxaye.cloudfront.net:

    1. Allowed payment via Coinbase CDP → real Base Sepolia tx
    2. Allowed payment via HashKey Chain → real HashKey tx
    3. Policy-denied payment ($100 > $50 cap) → returns errorCode

Run:
    .venv/bin/python scripts/strands-demo.py

Requires:
    - .venv with openagentpay-strands installed (pnpm install handles this via uv)
    - Production demo-api at the URL below

This script does NOT require a real LLM or the Strands SDK — it directly
invokes the tool function. Perfect for CI / end-to-end smoke verification.
"""
from __future__ import annotations

import asyncio
import json
import sys

from openagentpay_strands import create_payment_tool


API_URL = "https://d1p7yxa99nxaye.cloudfront.net"


def hr() -> None:
    print("─" * 80)


async def main() -> None:
    print()
    hr()
    print("🤖  OpenAgentPay × Strands Plugin — Live Demo")
    print(f"📍  Target: {API_URL}")
    hr()
    print()

    # We build TWO tools — one per default wallet — so each scenario uses the
    # right routing without overriding wallet_provider per call.
    cdp_tool = create_payment_tool(
        api_url=API_URL,
        default_wallet_provider="coinbase-cdp",
        default_session_budget_usd=1.0,
        default_session_expiry_minutes=10,
    )
    hk_tool = create_payment_tool(
        api_url=API_URL,
        default_wallet_provider="hashkey-chain",
        default_session_budget_usd=1.0,
        default_session_expiry_minutes=10,
    )

    # ---------------------------------------------------------------
    # Scenario 1: Allowed payment via Coinbase CDP
    # ---------------------------------------------------------------
    hr()
    print("Scenario 1 / 3  ·  Coinbase CDP ($0.001 USDC) — expect success + tx hash")
    hr()
    r1 = await cdp_tool(
        amount_usd=0.001,
        recipient="0x" + "a" * 40,  # throwaway recipient
        reason="Strands agent buying market analysis API access",
    )
    print(json.dumps(json.loads(r1), indent=2))
    print()

    # ---------------------------------------------------------------
    # Scenario 2: Allowed payment via HashKey Chain
    # ---------------------------------------------------------------
    hr()
    print("Scenario 2 / 3  ·  HashKey Chain ($0.001 USDC) — expect success + tx hash")
    hr()
    r2 = await hk_tool(
        amount_usd=0.001,
        recipient="0x" + "b" * 40,
        reason="Strands agent buying second resource for cross-chain demo",
    )
    print(json.dumps(json.loads(r2), indent=2))
    print()

    # ---------------------------------------------------------------
    # Scenario 3: Over-budget payment — policy deny
    # ---------------------------------------------------------------
    hr()
    print("Scenario 3 / 3  ·  Over-budget ($100) — expect amountThreshold deny")
    hr()
    r3 = await cdp_tool(
        amount_usd=100.0,
        recipient="0x" + "c" * 40,
        reason="(should be denied — too much money)",
    )
    parsed3 = json.loads(r3)
    print(json.dumps(parsed3, indent=2))
    print()

    # Summary
    hr()
    print("📊  Summary")
    hr()
    p1, p2 = json.loads(r1), json.loads(r2)
    ok1 = p1.get("success", False)
    ok2 = p2.get("success", False)
    deny3 = (
        not parsed3.get("success", True)
        and parsed3.get("errorCode") == "policy_denied"
    )
    print(f"  Coinbase CDP success:     {ok1}  tx={p1.get('txHash', 'n/a')[:16]}…")
    print(f"  HashKey Chain success:    {ok2}  tx={p2.get('txHash', 'n/a')[:16]}…")
    print(f"  Policy deny worked:       {deny3}  reason={parsed3.get('errorMessage', '')[:60]}")
    print()

    if ok1 and ok2 and deny3:
        print("🎉  All 3 scenarios behaved as expected.")
        sys.exit(0)
    else:
        print("⚠️  At least one scenario didn't match expectations.")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
