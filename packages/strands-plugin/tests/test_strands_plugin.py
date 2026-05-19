"""
Comprehensive unit + integration tests for openagentpay-strands.

Coverage:
    - OpenAgentPayClient HTTP client (mocked via respx)
    - Session lifecycle (lazy creation, reuse, recreation on 404)
    - Pay happy path (success response)
    - Pay governance deny path (returns PaymentResult with errorCode)
    - Pay HTTP errors (4xx/5xx → OpenAgentPayError raised)
    - Pay validation (negative amount, empty recipient, missing reason)
    - PaymentResult.to_dict shape (LLM-facing JSON)
    - create_payment_tool factory
    - Tool function returns valid JSON for LLM
    - Tool handles errors gracefully (no exceptions to LLM)
"""
from __future__ import annotations

import json

import httpx
import pytest
import respx

from openagentpay_strands import (
    OpenAgentPayClient,
    OpenAgentPayError,
    PaymentResult,
    create_payment_tool,
)


API_URL = "https://test.openagentpay.example"


# ============================================================================
#  PaymentResult
# ============================================================================


def test_payment_result_to_dict_success() -> None:
    r = PaymentResult(
        success=True,
        wallet_provider="coinbase-cdp",
        amount_usd=0.001,
        recipient="0xabc",
        tx_hash="0xtx",
        explorer_url="https://explorer/tx/0xtx",
        network="base-sepolia",
    )
    d = r.to_dict()
    assert d["success"] is True
    assert d["walletProvider"] == "coinbase-cdp"
    assert d["txHash"] == "0xtx"
    assert "errorCode" not in d


def test_payment_result_to_dict_failure() -> None:
    r = PaymentResult(
        success=False,
        wallet_provider="coinbase-cdp",
        amount_usd=100.0,
        recipient="0xabc",
        error_code="policy_denied",
        error_message="amount exceeds maxAtomic",
    )
    d = r.to_dict()
    assert d["success"] is False
    assert d["errorCode"] == "policy_denied"
    assert "txHash" not in d


# ============================================================================
#  OpenAgentPayError
# ============================================================================


def test_error_repr() -> None:
    e = OpenAgentPayError("oops", code="abc", http_status=503)
    s = repr(e)
    assert "abc" in s
    assert "503" in s


# ============================================================================
#  OpenAgentPayClient — list_wallets / get_governance
# ============================================================================


@respx.mock
async def test_list_wallets() -> None:
    respx.get(f"{API_URL}/api/wallets").mock(
        return_value=httpx.Response(
            200,
            json={
                "wallets": [
                    {"walletProvider": "hashkey-chain", "displayName": "HK"},
                    {"walletProvider": "coinbase-cdp", "displayName": "CDP"},
                ],
                "defaultProvider": "hashkey-chain",
            },
        )
    )
    async with OpenAgentPayClient(api_url=API_URL) as c:
        wallets = await c.list_wallets()
    assert len(wallets) == 2
    assert wallets[0]["walletProvider"] == "hashkey-chain"


@respx.mock
async def test_list_wallets_404_raises() -> None:
    respx.get(f"{API_URL}/api/wallets").mock(return_value=httpx.Response(503, text="oops"))
    async with OpenAgentPayClient(api_url=API_URL) as c:
        with pytest.raises(OpenAgentPayError) as ei:
            await c.list_wallets()
    assert ei.value.http_status == 503
    assert ei.value.code == "http_error"


@respx.mock
async def test_get_governance() -> None:
    respx.get(f"{API_URL}/api/governance").mock(
        return_value=httpx.Response(
            200,
            json={
                "policies": [{"name": "amountThreshold(50000000)"}],
                "compliance": {"enabled": True, "checker": "Static"},
                "auditLog": [],
                "auditCount": 0,
            },
        )
    )
    async with OpenAgentPayClient(api_url=API_URL) as c:
        g = await c.get_governance()
    assert len(g["policies"]) == 1
    assert g["compliance"]["enabled"] is True


# ============================================================================
#  OpenAgentPayClient — pay
# ============================================================================


def _mock_session_and_pay(
    *,
    pay_status: int = 200,
    pay_body: dict | None = None,
) -> None:
    """Set up respx mocks for a typical pay flow (session create + pay)."""
    respx.post(f"{API_URL}/api/session").mock(
        return_value=httpx.Response(
            200,
            json={
                "sessionId": "payment-session-test-123",
                "budgetUsd": 5,
                "expiryMinutes": 30,
                "createdAt": "2026-05-19T17:00:00Z",
                "expiresAt": "2026-05-19T17:30:00Z",
            },
        )
    )
    if pay_body is None:
        pay_body = {
            "success": True,
            "txHash": "0xMOCKTX",
            "explorerUrl": "https://explorer/tx/0xMOCKTX",
            "walletProvider": "coinbase-cdp",
            "network": "base-sepolia",
            "amountUsdc": 0.001,
            "payer": "0xPAYER",
            "recipient": "0xRECIP",
        }
    respx.post(f"{API_URL}/api/pay").mock(
        return_value=httpx.Response(pay_status, json=pay_body)
    )


@respx.mock
async def test_pay_happy_path() -> None:
    _mock_session_and_pay()
    async with OpenAgentPayClient(
        api_url=API_URL, default_wallet_provider="coinbase-cdp"
    ) as c:
        r = await c.pay(amount_usd=0.001, recipient="0xRECIP", reason="test")
    assert r.success is True
    assert r.tx_hash == "0xMOCKTX"
    assert r.wallet_provider == "coinbase-cdp"


@respx.mock
async def test_pay_creates_session_lazily_once() -> None:
    """Two calls in a row should reuse the same session."""
    _mock_session_and_pay()
    async with OpenAgentPayClient(
        api_url=API_URL, default_wallet_provider="coinbase-cdp"
    ) as c:
        await c.pay(amount_usd=0.001, recipient="0xa", reason="r1")
        await c.pay(amount_usd=0.001, recipient="0xb", reason="r2")
        assert c._session_creations == 1


@respx.mock
async def test_pay_recreates_session_after_404() -> None:
    """If /api/pay returns 404, session cache is invalidated."""
    respx.post(f"{API_URL}/api/session").mock(
        side_effect=[
            httpx.Response(
                200,
                json={"sessionId": "s1", "expiresAt": "x", "createdAt": "x", "budgetUsd": 5, "expiryMinutes": 30},
            ),
            httpx.Response(
                200,
                json={"sessionId": "s2", "expiresAt": "x", "createdAt": "x", "budgetUsd": 5, "expiryMinutes": 30},
            ),
        ]
    )
    respx.post(f"{API_URL}/api/pay").mock(
        side_effect=[
            httpx.Response(404, json={"code": "NOT_FOUND", "message": "Session not found"}),
            httpx.Response(
                200,
                json={
                    "success": True,
                    "txHash": "0xTX2",
                    "walletProvider": "cdp",
                    "amountUsdc": 0.001,
                    "payer": "0xP",
                    "recipient": "0xR",
                },
            ),
        ]
    )

    async with OpenAgentPayClient(
        api_url=API_URL, default_wallet_provider="cdp"
    ) as c:
        # First call → 404 raises (we re-create on next call)
        with pytest.raises(OpenAgentPayError) as ei:
            await c.pay(amount_usd=0.001, recipient="0xR", reason="r1")
        assert ei.value.http_status == 404

        # Second call → fresh session, success
        r2 = await c.pay(amount_usd=0.001, recipient="0xR", reason="r2")
        assert r2.success is True
        assert r2.tx_hash == "0xTX2"
        # Session was recreated
        assert c._session_creations == 2


@respx.mock
async def test_pay_governance_deny_returns_payment_result() -> None:
    """policy_denied surfaces as PaymentResult.success=False, not an exception."""
    _mock_session_and_pay(
        pay_body={
            "success": False,
            "walletProvider": "cdp",
            "amountUsdc": 100,
            "payer": "0xP",
            "recipient": "0xR",
            "errorCode": "policy_denied",
            "errorMessage": "amount 100000000 exceeds maxAtomic 50000000",
        }
    )
    async with OpenAgentPayClient(
        api_url=API_URL, default_wallet_provider="cdp"
    ) as c:
        r = await c.pay(amount_usd=100, recipient="0xR", reason="too much")
    assert r.success is False
    assert r.error_code == "policy_denied"
    assert "exceeds maxAtomic" in (r.error_message or "")
    assert r.tx_hash is None


@respx.mock
async def test_pay_5xx_raises() -> None:
    _mock_session_and_pay(pay_status=503, pay_body={"code": "INTERNAL", "message": "down"})
    async with OpenAgentPayClient(
        api_url=API_URL, default_wallet_provider="cdp"
    ) as c:
        with pytest.raises(OpenAgentPayError) as ei:
            await c.pay(amount_usd=0.001, recipient="0xR", reason="r")
    assert ei.value.http_status == 503


@respx.mock
async def test_pay_validation() -> None:
    async with OpenAgentPayClient(
        api_url=API_URL, default_wallet_provider="cdp"
    ) as c:
        with pytest.raises(ValueError, match="amount_usd"):
            await c.pay(amount_usd=-1, recipient="0x", reason="x")
        with pytest.raises(ValueError, match="recipient"):
            await c.pay(amount_usd=1, recipient="", reason="x")
        with pytest.raises(ValueError, match="reason"):
            await c.pay(amount_usd=1, recipient="0xa", reason="")


async def test_pay_requires_wallet_provider() -> None:
    """If no default and no override, should raise ValueError."""
    async with OpenAgentPayClient(api_url=API_URL) as c:
        with pytest.raises(ValueError, match="wallet_provider"):
            await c.pay(amount_usd=1, recipient="0xa", reason="r")


def test_client_requires_api_url() -> None:
    with pytest.raises(ValueError, match="api_url"):
        OpenAgentPayClient(api_url="")


# ============================================================================
#  Tool factory
# ============================================================================


def test_create_payment_tool_returns_callable() -> None:
    tool = create_payment_tool(
        api_url=API_URL,
        default_wallet_provider="cdp",
    )
    assert callable(tool)


def test_create_payment_tool_has_docstring() -> None:
    tool = create_payment_tool(api_url=API_URL, default_wallet_provider="cdp")
    assert tool.__doc__ is not None
    assert "OpenAgentPay" in tool.__doc__
    assert "Args:" in tool.__doc__


def test_create_payment_tool_name_default() -> None:
    tool = create_payment_tool(api_url=API_URL, default_wallet_provider="cdp")
    assert tool.__name__ == "openagentpay_pay"


def test_create_payment_tool_name_custom() -> None:
    tool = create_payment_tool(
        api_url=API_URL,
        default_wallet_provider="cdp",
        name="pay_for_research",
    )
    assert tool.__name__ == "pay_for_research"


@respx.mock
async def test_tool_returns_json_string_on_success() -> None:
    _mock_session_and_pay()
    tool = create_payment_tool(
        api_url=API_URL,
        default_wallet_provider="coinbase-cdp",
    )
    result_str = await tool(
        amount_usd=0.001,
        recipient="0xRECIP",
        reason="market data",
    )
    assert isinstance(result_str, str)
    parsed = json.loads(result_str)
    assert parsed["success"] is True
    assert parsed["txHash"] == "0xMOCKTX"


@respx.mock
async def test_tool_returns_json_string_on_governance_deny() -> None:
    _mock_session_and_pay(
        pay_body={
            "success": False,
            "walletProvider": "cdp",
            "amountUsdc": 100,
            "payer": "0xP",
            "recipient": "0xR",
            "errorCode": "policy_denied",
            "errorMessage": "exceeds cap",
        }
    )
    tool = create_payment_tool(api_url=API_URL, default_wallet_provider="cdp")
    result_str = await tool(amount_usd=100, recipient="0xR", reason="too much")
    parsed = json.loads(result_str)
    assert parsed["success"] is False
    assert parsed["errorCode"] == "policy_denied"


@respx.mock
async def test_tool_returns_json_string_on_http_error() -> None:
    """Tool must NEVER raise to caller — convert all errors to JSON."""
    respx.post(f"{API_URL}/api/session").mock(
        return_value=httpx.Response(503, text="down")
    )
    tool = create_payment_tool(api_url=API_URL, default_wallet_provider="cdp")
    result_str = await tool(amount_usd=0.001, recipient="0xR", reason="r")
    parsed = json.loads(result_str)
    assert parsed["success"] is False
    assert parsed["errorCode"] == "session_creation_failed"


async def test_tool_returns_json_string_on_validation_error() -> None:
    """ValueError from client.pay() should also be converted to JSON."""
    tool = create_payment_tool(api_url=API_URL, default_wallet_provider="cdp")
    result_str = await tool(amount_usd=-1, recipient="0xR", reason="r")
    parsed = json.loads(result_str)
    assert parsed["success"] is False
    assert parsed["errorCode"] == "validation_error"


# ============================================================================
#  has_strands_sdk introspection
# ============================================================================


def test_has_strands_sdk_returns_bool() -> None:
    from openagentpay_strands.tool import has_strands_sdk

    assert isinstance(has_strands_sdk(), bool)
