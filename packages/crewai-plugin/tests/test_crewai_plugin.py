"""Smoke tests for openagentpay_crewai."""
from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from openagentpay_crewai import (
    OpenAgentPayClient,
    OpenAgentPayCrewTool,
    OpenAgentPayError,
    PaymentResult,
    create_payment_tool,
)


def test_payment_result_round_trip():
    r = PaymentResult(
        success=False,
        wallet_provider="hashkey-chain",
        amount_usd=0.001,
        recipient="0xR",
        error_code="policy_denied",
        error_message="over cap",
    )
    d = r.to_dict()
    assert d["success"] is False
    assert d["errorCode"] == "policy_denied"
    assert d["walletProvider"] == "hashkey-chain"


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
    h.aclose = AsyncMock()
    return h


@pytest.mark.asyncio
async def test_client_pay_happy(fake_http):
    fake_http.post.side_effect = [
        _FakeResp(200, {"sessionId": "S1"}),
        _FakeResp(200, {"success": True, "txHash": "0xtx-crew"}),
    ]
    c = OpenAgentPayClient(api_url="https://x", default_wallet_provider="cdp", http_client=fake_http)
    r = await c.pay(amount_usd=0.001, recipient="0xR", reason="t")
    assert r.tx_hash == "0xtx-crew"


def test_create_payment_tool_returns_crew_tool():
    tool = create_payment_tool(api_url="https://x", default_wallet_provider="cdp")
    assert isinstance(tool, OpenAgentPayCrewTool)
    assert tool.name == "openagentpay_pay"
    assert "OpenAgentPay" in tool.description


@pytest.mark.asyncio
async def test_arun_validation_error():
    tool = create_payment_tool(api_url="https://x", default_wallet_provider="cdp")
    out = await tool._arun(amount_usd=-1, recipient="0xR", reason="bad")
    parsed = json.loads(out)
    assert parsed["success"] is False
    assert parsed["errorCode"] == "validation_error"


def test_run_sync_wrapper_works(monkeypatch):
    """_run dispatches to _arun via event loop. Validation errors should bubble through."""
    tool = create_payment_tool(api_url="https://x", default_wallet_provider="cdp")
    out = tool._run(amount_usd=-1, recipient="0xR", reason="bad")
    parsed = json.loads(out)
    assert parsed["success"] is False


@pytest.mark.asyncio
async def test_arun_handles_openagentpay_error(fake_http):
    """When the client raises, _arun catches and returns JSON."""
    fake_http.post.side_effect = httpx.ConnectError("net down")
    tool = OpenAgentPayCrewTool(api_url="https://x", default_wallet_provider="cdp")
    tool._client._http = fake_http  # inject mock
    out = await tool._arun(amount_usd=0.001, recipient="0xR", reason="t")
    parsed = json.loads(out)
    assert parsed["success"] is False
    assert "errorCode" in parsed
