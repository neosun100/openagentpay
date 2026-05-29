"""Smoke tests for openagentpay_semantic_kernel."""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from openagentpay_semantic_kernel import (
    OpenAgentPayClient,
    OpenAgentPayError,
    OpenAgentPayPlugin,
    PaymentResult,
)


def test_plugin_init():
    p = OpenAgentPayPlugin(
        api_url="https://demo", default_wallet_provider="coinbase-cdp"
    )
    assert hasattr(p, "pay")
    assert hasattr(p, "check_session_budget")


class _FakeResp:
    def __init__(self, status: int, j: Any, text: str = ""):
        self.status_code = status
        self._j = j
        self.text = text
    def json(self): return self._j


@pytest.fixture
def fake_http():
    h = MagicMock(spec=httpx.AsyncClient)
    h.post = AsyncMock()
    h.get = AsyncMock()
    h.aclose = AsyncMock()
    return h


@pytest.mark.asyncio
async def test_plugin_pay_validation_error_returns_json():
    p = OpenAgentPayPlugin(
        api_url="https://demo", default_wallet_provider="coinbase-cdp"
    )
    out = await p.pay(amount_usd=-1, recipient="0xR", reason="x")
    parsed = json.loads(out)
    assert parsed["success"] is False
    assert parsed["errorCode"] == "validation_error"


@pytest.mark.asyncio
async def test_plugin_pay_happy(fake_http):
    fake_http.post.side_effect = [
        _FakeResp(200, {"sessionId": "S"}),
        _FakeResp(200, {
            "success": True,
            "txHash": "0xtx-sk",
            "walletProvider": "coinbase-cdp",
            "recipient": "0xR",
        }),
    ]
    p = OpenAgentPayPlugin(api_url="https://x", default_wallet_provider="coinbase-cdp")
    p._client._http = fake_http
    out = await p.pay(amount_usd=0.001, recipient="0xR", reason="ok")
    parsed = json.loads(out)
    assert parsed["success"] is True
    assert parsed["txHash"] == "0xtx-sk"


@pytest.mark.asyncio
async def test_plugin_check_session_budget_no_session():
    p = OpenAgentPayPlugin(api_url="https://demo", default_wallet_provider="cdp")
    out = await p.check_session_budget()
    parsed = json.loads(out)
    assert parsed["sessionId"] is None
    assert parsed["remainingUsd"] is None


@pytest.mark.asyncio
async def test_plugin_check_session_budget_with_session(fake_http):
    """After a successful payment, checking budget returns remaining."""
    fake_http.post.side_effect = [
        _FakeResp(200, {"sessionId": "S-budget"}),
        _FakeResp(200, {"success": True, "txHash": "0xT"}),
    ]
    fake_http.get.return_value = _FakeResp(200, {
        "sessionId": "S-budget",
        "status": "active",
        "budgetAtomic": "5000000",       # $5
        "spentAtomic": "1000000",        # $1
        "decimals": 6,
        "currency": "USDC",
        "expiresAt": "2027-01-01T00:00:00Z",
    })
    p = OpenAgentPayPlugin(api_url="https://x", default_wallet_provider="cdp")
    p._client._http = fake_http
    await p.pay(amount_usd=0.001, recipient="0xR", reason="ok")
    snap = json.loads(await p.check_session_budget())
    assert snap["sessionId"] == "S-budget"
    assert snap["remainingUsd"] == 4.0  # 5 - 1


def test_payment_result_to_dict():
    r = PaymentResult(
        success=True,
        wallet_provider="coinbase-cdp",
        amount_usd=0.5,
        recipient="0xR",
        tx_hash="0xtx",
    )
    d = r.to_dict()
    assert d["txHash"] == "0xtx"
    assert d["amountUsd"] == 0.5
