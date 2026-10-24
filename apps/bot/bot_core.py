"""Lógica pura do bot — sem dependência do aiogram para permitir testes unitários (doc 03 §3)."""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass

UFS = {
    "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG",
    "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
}

TERMS_VERSION = "2026-10-21"  # versionar o texto dos termos LGPD (A2)


def terms_hash(terms_text: str) -> str:
    """Hash do texto dos termos — grava versão + hash no consentimento (doc 03 §1 passo 4)."""
    return hashlib.sha256(terms_text.encode("utf-8")).hexdigest()


def validate_region(uf: str, city_ibge: int) -> tuple[bool, str]:
    uf = uf.strip().upper()
    if uf not in UFS:
        return False, f"UF inválida: {uf!r}"
    if not (1_000_000 <= city_ibge <= 9_999_999):
        return False, f"código IBGE inválido: {city_ibge!r}"
    return True, uf


def generate_otp(digits: int = 6) -> str:
    return "".join(secrets.choice("0123456789") for _ in range(digits))


def verify_otp(expected: str, provided: str) -> bool:
    """Comparação constant-time — doc 02 §1 (OTP)."""
    return hmac.compare_digest(expected.encode(), provided.encode())


_PHONE_RE = re.compile(r"^\+?[1-9]\d{7,14}$")


def valid_phone_e164(phone: str) -> bool:
    return bool(_PHONE_RE.match(phone.strip()))


@dataclass(frozen=True)
class OnboardingState:
    """Estados do FSM de onboarding (doc 03 §3): /start → região → termos → OTP → plano."""

    step: str
    uf: str | None = None
    city_ibge: int | None = None
    terms_version: str | None = None
    terms_accepted: bool = False
    otp_issued: bool = False
    plan_code: str | None = None

    def advance(self, step: str, **kwargs) -> "OnboardingState":
        data = {"step": step, **{
            "uf": self.uf, "city_ibge": self.city_ibge,
            "terms_version": self.terms_version, "terms_accepted": self.terms_accepted,
            "otp_issued": self.otp_issued, "plan_code": self.plan_code,
        }, **kwargs}
        return OnboardingState(**data)  # type: ignore[arg-type]


ONBOARDING_ORDER = ["regiao", "termos", "otp", "plano", "pronto"]


def next_step(current: str) -> str | None:
    if current == "pronto":
        return None
    idx = ONBOARDING_ORDER.index(current)
    return ONBOARDING_ORDER[idx + 1]


# ————— Investiga — OSINT avançado (doc 11) —————
# Regra de ouro: a ferramenta gera LEADS; o ser humano conclui.

INVESTIGA_VERDICT = "LEAD — verificar manualmente"

INVESTIGA_PLAN_BUTTONS = [
    ("AnotA R$ 14,90", "anota"),
    ("Consulta Jurídica R$ 39,90", "juridica"),
    ("Licitação R$ 49,90", "licitacao"),
    ("Concurso R$ 24,90", "concurso"),
    ("Investiga R$ 59,90", "investiga"),
]

INVESTIGA_KINDS = ("username", "email", "phone", "domain")


def parse_investiga_target(text: str) -> tuple[bool, str, str]:
    """Parse 'tipo:valor' (ex.: 'username:octocat'). Retorna (ok, erro, kind/value)."""
    raw = (text or "").strip()
    if ":" not in raw:
        return False, "Formato: tipo:valor (tipos: username, email, phone, domain)", ""
    kind, _, value = raw.partition(":")
    kind = kind.strip().lower()
    value = value.strip()
    if kind not in INVESTIGA_KINDS:
        return False, f"Tipo inválido: {kind!r}. Use: {', '.join(INVESTIGA_KINDS)}", ""
    if len(value) < 2 or len(value) > 320:
        return False, "Valor fora da faixa (2–320 caracteres)", ""
    return True, "", f"{kind}:{value}"


def investiga_findings_summary(found: int, not_found: int, unknown: int) -> str:
    """Resumo factual do relatório — sem conclusão, com o veredicto humano."""
    return (
        f"Achados: {found} encontrados · {not_found} ausentes · {unknown} inconclusivos\n"
        f"Veredicto: {INVESTIGA_VERDICT}"
    )
