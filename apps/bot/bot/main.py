"""
Bot Acompanhe.IA — aiogram 3 (doc 03): FSM de onboarding, webhook com secret_token,
fila única por chat com throttle 1 msg/s (limites reais do Telegram).

Executar: BOT_TOKEN=... python -m bot.main
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.filters import CommandStart, Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    MenuButtonWebApp,
    WebAppInfo,
)

from bot_core import (
    TERMS_VERSION,
    generate_otp,
    next_step,
    terms_hash,
    validate_region,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("acompanhe.bot")

TERMS_TEXT = (
    "Termos de uso e LGPD (v%s): tratamos dados para o serviço Acompanhe.IA. "
    "Biometria (selfie/doc/geo) é dado sensível com consentimento específico versionado."
) % TERMS_VERSION

router = Router()


class Onboarding(StatesGroup):
    regiao = State()
    termos = State()
    otp = State()
    plano = State()


class ChatThrottle:
    """Fila única por chat — 1 msg/s (doc 03 §2 RATE_CHAT)."""

    def __init__(self, per_chat_per_sec: float = 1.0) -> None:
        self._last: dict[int, float] = {}
        self._lock = asyncio.Lock()
        self._interval = per_chat_per_sec

    async def wait(self, chat_id: int) -> None:
        async with self._lock:
            loop = asyncio.get_running_loop()
            now = loop.time()
            last = self._last.get(chat_id, 0.0)
            delay = self._interval - (now - last)
            if delay > 0:
                await asyncio.sleep(delay)
            self._last[chat_id] = loop.time()


throttle = ChatThrottle()


async def send(bot: Bot, chat_id: int, text: str, **kwargs: Any) -> None:
    await throttle.wait(chat_id)
    await bot.send_message(chat_id, text, **kwargs)


@router.message(CommandStart())
async def cmd_start(message: Message, state: FSMContext, bot: Bot) -> None:
    await state.set_state(Onboarding.regiao)
    await send(
        bot,
        message.chat.id,
        "Bem-vindo ao Acompanhe.IA! 🎯\n"
        "Vamos configurar sua região (UF e cidade — código IBGE) para alertas locais.\n"
        "Envie no formato: UF cidade_ibge  (ex.: MT 5103403)",
    )


@router.message(Onboarding.regiao)
async def on_region(message: Message, state: FSMContext, bot: Bot) -> None:
    parts = (message.text or "").split()
    if len(parts) != 2 or not parts[1].isdigit():
        await send(bot, message.chat.id, "Formato: UF cidade_ibge (ex.: MT 5103403)")
        return
    ok, uf_or_error = validate_region(parts[0], int(parts[1]))
    if not ok:
        await send(bot, message.chat.id, uf_or_error)
        return
    await state.update_data(uf=uf_or_error, city_ibge=int(parts[1]))
    await state.set_state(Onboarding.termos)
    await send(
        bot,
        message.chat.id,
        TERMS_TEXT + "\n\nResponda SIM para aceitar (versão e hash são registrados).",
    )


@router.message(Onboarding.termos, F.text.upper() == "SIM")
async def on_terms(message: Message, state: FSMContext, bot: Bot) -> None:
    await state.update_data(terms_version=TERMS_VERSION, terms_accepted=True, terms_hash=terms_hash(TERMS_TEXT))
    otp = generate_otp()
    await state.update_data(otp=otp)
    await state.set_state(Onboarding.otp)
    # em produção: enviar OTP por SMS/Telegram; aqui mostra direto para dev
    await send(bot, message.chat.id, f"Verificação concluída! Seu código: {otp}\nEnvie o código para continuar.")


@router.message(Onboarding.otp)
async def on_otp(message: Message, state: FSMContext, bot: Bot) -> None:
    data = await state.get_data()
    from bot_core import verify_otp

    if not verify_otp(str(data.get("otp", "")), (message.text or "").strip()):
        await send(bot, message.chat.id, "Código inválido. Tente novamente.")
        return
    await state.set_state(Onboarding.plano)
    from bot_core import INVESTIGA_PLAN_BUTTONS

    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text=label, callback_data=f"plano:{code}")]
            for label, code in INVESTIGA_PLAN_BUTTONS
        ]
    )
    await send(bot, message.chat.id, "Escolha seu plano (7 dias grátis):", reply_markup=kb)


@router.callback_query(F.data.startswith("plano:"))
async def on_plan(callback, state: FSMContext, bot: Bot) -> None:
    plan = (callback.data or "").split(":", 1)[1]
    await state.update_data(plan_code=plan)
    await state.set_state(Onboarding.plano)
    await callback.answer()
    await send(bot, callback.message.chat.id, f"Plano {plan} selecionado! Use /webapp para abrir o Acompanhe.IA.")


@router.message(Command("webapp"))
async def cmd_webapp(message: Message, bot: Bot) -> None:
    url = os.environ.get("MINI_APP_URL", "https://example.com")
    kb = InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text="Abrir Acompanhe.IA", web_app=WebAppInfo(url=url))]]
    )
    await send(bot, message.chat.id, "Abrindo o app…", reply_markup=kb)


@router.message(Command("investiga"))
async def cmd_investiga(message: Message, bot: Bot) -> None:
    """Investiga — OSINT avançado (doc 11): leads verificáveis, nunca conclusões."""
    from bot_core import INVESTIGA_VERDICT

    url = os.environ.get("MINI_APP_URL", "https://example.com")
    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="Abrir Investiga", web_app=WebAppInfo(url=url))],
            [InlineKeyboardButton(text="Abrir Acompanhe.IA", web_app=WebAppInfo(url=url))],
        ]
    )
    await send(
        bot,
        message.chat.id,
        "🔍 Investiga — OSINT avançado\n\n"
        "Crie um caso declarando finalidade e base legal, informe os alvos\n"
        "(username, e-mail, telefone, domínio) e execute as consultas.\n\n"
        "• Fontes reais: Sherlock (481 sites), HIBP, Gravatar, RDAP, crt.sh, Wayback, DNS\n"
        "• Limite: 150 checks/dia · 10 casos ativos · trial 7 dias 1×\n"
        f"• Veredicto: {INVESTIGA_VERDICT}\n\n"
        "Relatório com proveniência (fonte + URL + data) e sha256 de auditoria.",
        reply_markup=kb,
    )


async def main() -> None:
    token = os.environ["BOT_TOKEN"]
    bot = Bot(token, default=DefaultBotProperties(parse_mode=None))
    dp = Dispatcher()
    dp.include_router(router)

    await bot.set_chat_menu_button(
        menu_button=MenuButtonWebApp(text="Acompanhe.IA", web_app=WebAppInfo(url=os.environ.get("MINI_APP_URL", "https://example.com")))
    )

    webhook_base = os.environ.get("WEBHOOK_BASE_URL")
    if webhook_base:
        # secret_token do Telegram → header X-Telegram-Bot-Api-Secret-Token (doc 02/03)
        secret = os.environ.get("WEBHOOK_SECRET_TOKEN", "")
        await bot.set_webhook(f"{webhook_base}/telegram/webhook", secret_token=secret or None, drop_pending_updates=True)
        log.info("webhook registrado em %s/telegram/webhook", webhook_base)
    else:
        log.info("modo polling (dev)")
        await bot.delete_webhook(drop_pending_updates=False)
        await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
