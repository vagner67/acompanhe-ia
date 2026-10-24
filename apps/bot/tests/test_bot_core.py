"""Testes da lógica pura do bot (unittest stdlib — roda sem aiogram instalado)."""
import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from bot_core import (  # noqa: E402
    INVESTIGA_VERDICT,
    OnboardingState,
    generate_otp,
    investiga_findings_summary,
    next_step,
    parse_investiga_target,
    terms_hash,
    validate_region,
    verify_otp,
)


class TestRegion(unittest.TestCase):
    def test_uf_valida(self):
        ok, uf = validate_region("mt", 5103403)
        self.assertTrue(ok)
        self.assertEqual(uf, "MT")

    def test_uf_invalida(self):
        ok, _ = validate_region("XX", 5103403)
        self.assertFalse(ok)

    def test_ibge_invalido(self):
        ok, _ = validate_region("MT", 123)
        self.assertFalse(ok)


class TestOtp(unittest.TestCase):
    def test_otp_6_digitos(self):
        self.assertEqual(len(generate_otp()), 6)
        self.assertTrue(generate_otp().isdigit())

    def test_verify_otp(self):
        self.assertTrue(verify_otp("123456", "123456"))
        self.assertFalse(verify_otp("123456", "123457"))
        self.assertFalse(verify_otp("123456", ""))


class TestTerms(unittest.TestCase):
    def test_terms_hash_estavel(self):
        self.assertEqual(terms_hash("abc"), terms_hash("abc"))
        self.assertNotEqual(terms_hash("abc"), terms_hash("abd"))


class TestFsm(unittest.TestCase):
    def test_ordem_onboarding(self):
        self.assertEqual(next_step("regiao"), "termos")
        self.assertEqual(next_step("termos"), "otp")
        self.assertEqual(next_step("otp"), "plano")
        self.assertEqual(next_step("plano"), "pronto")
        self.assertIsNone(next_step("pronto"))

    def test_state_immutable(self):
        s = OnboardingState(step="regiao")
        s2 = s.advance("termos", uf="MT", city_ibge=5103403)
        self.assertEqual(s.uf, None)
        self.assertEqual(s2.uf, "MT")
        self.assertEqual(s2.step, "termos")


if __name__ == "__main__":
    unittest.main()


# ————— Investiga (doc 11) —————

def test_parse_investiga_target_valido():
    ok, err, normalized = parse_investiga_target("username:octocat")
    assert ok and err == "" and normalized == "username:octocat"


def test_parse_investiga_target_tipo_invalido():
    ok, err, _ = parse_investiga_target("cpf:123")
    assert not ok and "Tipo inválido" in err


def test_parse_investiga_target_sem_dois_pontos():
    ok, err, _ = parse_investiga_target("octocat")
    assert not ok and "Formato" in err


def test_investiga_verdict_nunca_conclusivo():
    assert INVESTIGA_VERDICT == "LEAD — verificar manualmente"
    summary = investiga_findings_summary(2, 1, 1)
    assert "encontrados" in summary and "Veredicto" in summary
