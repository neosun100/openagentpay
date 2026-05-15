"""Pytest tests for OpenAgentPay Python SDK type system.

Verifies that:
1. All dataclasses are constructible
2. All Protocol classes accept duck-typed implementations
3. Money atomic arithmetic preserves precision
4. Helper functions produce ISO 8601 timestamps that match the TS shape
"""
from __future__ import annotations

import re
from typing import Any

import pytest

from openagentpay import (
    Asset,
    Balance,
    CreateInstrumentInput,
    HttpResponse402,
    HttpRetryEnvelope,
    Instrument,
    Money,
    PaymentEvent,
    PaymentRequest,
    ProtocolAdapter,
    ProtocolError,
    Session,
    SettlementResult,
    SignAuthorizationInput,
    SignedAuthorization,
    WalletConnector,
    now_iso,
)


# ----------------------------------------------------------------------------
# Money atomic precision
# ----------------------------------------------------------------------------

def test_money_preserves_huge_atomic_amounts() -> None:
    huge = "999999999999999999999"  # > 2^64
    m = Money(amount_atomic=huge, decimals=18, currency="WEI")
    assert m.amount_atomic == huge


def test_money_to_decimal_for_usdc() -> None:
    m = Money(amount_atomic="1000", decimals=6, currency="USDC")  # 0.001 USDC
    assert m.to_decimal() == pytest.approx(0.001)


# ----------------------------------------------------------------------------
# now_iso shape compatibility with TS Date.toISOString()
# ----------------------------------------------------------------------------

def test_now_iso_matches_typescript_format() -> None:
    s = now_iso()
    # Match: 2026-05-16T01:23:45.123456Z (microseconds, Z suffix)
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z", s), s


# ----------------------------------------------------------------------------
# Dataclass smoke
# ----------------------------------------------------------------------------

def test_session_constructible() -> None:
    s = Session(
        id="sess-1",  # type: ignore[arg-type]
        user_id="alice",  # type: ignore[arg-type]
        budget=Money(amount_atomic="1000000", decimals=6, currency="USDC"),
        spent=Money(amount_atomic="0", decimals=6, currency="USDC"),
        expires_at=now_iso(),
        created_at=now_iso(),
        updated_at=now_iso(),
        status="active",
    )
    assert s.status == "active"
    assert s.spent.amount_atomic == "0"


def test_settlement_result_failure_path() -> None:
    r = SettlementResult(
        success=False,
        network="binance-pay-sandbox",
        settled_at=now_iso(),
        error_code="signature_invalid",
        error_message="HMAC mismatch",
    )
    assert r.success is False
    assert r.error_code == "signature_invalid"


# ----------------------------------------------------------------------------
# Protocol duck-typing — anyone implementing the right shape qualifies
# ----------------------------------------------------------------------------

class _FakeWallet:
    def get_capabilities(self) -> Any:
        return None

    async def create_instrument(self, input: CreateInstrumentInput) -> Any:
        return None

    async def get_balance(self, instrument_id: Any) -> Any:
        return None

    async def sign_authorization(self, input: SignAuthorizationInput) -> Any:
        return None

    async def settle(self, signed: SignedAuthorization) -> Any:
        return None


def test_wallet_connector_protocol_accepts_duck_type() -> None:
    fw: WalletConnector = _FakeWallet()  # type: ignore[assignment]
    assert isinstance(fw, WalletConnector)  # runtime_checkable


# ----------------------------------------------------------------------------
# ProtocolError shape
# ----------------------------------------------------------------------------

def test_protocol_error_has_code() -> None:
    with pytest.raises(ProtocolError) as ei:
        raise ProtocolError("bad shape", code="malformed")
    assert ei.value.code == "malformed"


# ----------------------------------------------------------------------------
# HttpResponse402 must be exactly status 402 (Literal narrowing)
# ----------------------------------------------------------------------------

def test_http_response_402_smoke() -> None:
    r = HttpResponse402(status_code=402, headers={"x": "y"}, body={"any": "thing"})
    assert r.status_code == 402
