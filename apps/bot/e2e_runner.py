"""
Instrumentação de TESTE E2E (23/10/2026) — NÃO é o app.

Roda os MESMOS handlers de `bot/main.py` (router importado do módulo real),
adicionando apenas log estruturado de cada update recebido (chat_id, tipo,
texto) para auditoria do teste fim a fim. Nada é simulado: cada update vem do
Telegram real e cada resposta sai pela API real do Telegram.

Uso: PYTHONPATH=/home/user/tools/bot-py:. BOT_TOKEN=... MINI_APP_URL=... python3 e2e_runner.py
"""
from __future__ import annotations

import asyncio
import logging
import os

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("e2e.update")

from aiogram import BaseMiddleware, Bot, Dispatcher  # noqa: E402
from aiogram.client.default import DefaultBotProperties  # noqa: E402
from aiogram.types import CallbackQuery, MenuButtonWebApp, Message, TelegramObject, WebAppInfo  # noqa: E402

import bot.main as app_main  # noqa: E402  — handlers REAIS


class LogUpdates(BaseMiddleware):
    async def __call__(self, handler, event: TelegramObject, data):
        if isinstance(event, Message):
            log.info(
                "E2E_UPDATE type=message chat_id=%s from_id=%s text=%r",
                event.chat.id,
                event.from_user.id if event.from_user else None,
                event.text,
            )
        elif isinstance(event, CallbackQuery):
            log.info(
                "E2E_UPDATE type=callback chat_id=%s from_id=%s data=%r",
                event.message.chat.id if event.message else None,
                event.from_user.id if event.from_user else None,
                event.data,
            )
        return await handler(event, data)


async def main() -> None:
    token = os.environ["BOT_TOKEN"]
    bot = Bot(token, default=DefaultBotProperties(parse_mode=None))
    dp = Dispatcher()
    app_main.router.message.middleware(LogUpdates())
    app_main.router.callback_query.middleware(LogUpdates())
    dp.include_router(app_main.router)
    url = os.environ.get("MINI_APP_URL", "https://example.com")
    await bot.set_chat_menu_button(
        menu_button=MenuButtonWebApp(text="Acompanhe.IA", web_app=WebAppInfo(url=url))
    )
    log.info("e2e_runner: menu button -> %s", url)
    log.info("e2e_runner: polling com handlers REAIS de bot/main.py")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
