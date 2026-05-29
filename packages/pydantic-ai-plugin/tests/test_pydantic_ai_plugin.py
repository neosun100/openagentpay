"""Tests for openagentpay-pydantic-ai."""
from __future__ import annotations

import asyncio
import json

import pytest

from openagentpay_pydantic_ai import (
    OpenAgentPayClient,
    OpenAgentPayError,
    PaymentInput,
    PaymentResult,
    create_payment_tool,
    has_pydantic_ai_sdk,
)


def test_payment_input_validates_positive_amount():
    with pytest.raises(Exception):
        PaymentInput(amount_usd=0, recipient="0xa", reason="bad")


def test_payment_input_validates_recipient_nonempty():
    with pytest.raises(Exception):
        PaymentInput(amount_usd=1.0, recipient="", reason="bad")


def test_payment_input_round_trip():
    inp = PaymentInput(amount_usd=1.5, recipient="0xMerchant", reason="api")
    assert inp.amount_usd == 1.5
    assert inp.wallet_provider is None


def test_payment_result_to_dict_drops_none():
    r = PaymentResult(
        success=True,
        wallet_provider="fake",
        amount_usd=1,
        recipient="0xa",
    )
    d = r.to_dict()
    assert "tx_hash" not in d
    assert d["success"] is True


def test_has_pydantic_ai_sdk_returns_bool():
    assert isinstance(has_pydantic_ai_sdk(), bool)


def test_create_payment_tool_returns_async_callable():
    tool = create_payment_tool(api_url="http://localhost:8788", user_id="alice")
    assert asyncio.iscoroutinefunction(tool)


def test_payment_tool_returns_failure_on_error(monkeypatch):
    """If the underlying client raises, the tool returns a typed PaymentResult."""

    class FakeClient:
        async def pay(self, **kwargs):
            raise OpenAgentPayError("nope", code="rejected", http_status=400)

    monkeypatch.setattr(
        "openagentpay_pydantic_ai.tool.OpenAgentPayClient", lambda **_kw: FakeClient()
    )
    tool = create_payment_tool(api_url="x", user_id="y")
    result = asyncio.run(
        tool(PaymentInput(amount_usd=1, recipient="0xa", reason="x"))
    )
    assert result.success is False
    assert result.error_code == "rejected"


def test_payment_tool_returns_success_on_ok(monkeypatch):
    class FakeClient:
        async def pay(self, **kwargs):
            return {
                "success": True,
                "txHash": "0xfake",
                "explorerUrl": "https://example/tx/0xfake",
                "walletProvider": "hashkey",
            }

    monkeypatch.setattr(
        "openagentpay_pydantic_ai.tool.OpenAgentPayClient", lambda **_kw: FakeClient()
    )
    tool = create_payment_tool(api_url="x", user_id="y")
    result = asyncio.run(
        tool(PaymentInput(amount_usd=2.5, recipient="0xMerchant", reason="x"))
    )
    assert result.success is True
    assert result.tx_hash == "0xfake"
    assert result.wallet_provider == "hashkey"
