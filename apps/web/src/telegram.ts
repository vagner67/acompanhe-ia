/** Ponte com o WebView do Telegram (doc 03 §4). O initData vai APENAS ao server (nunca logar). */
interface TelegramWebApp {
  initData: string;
  ready: () => void;
  expand: () => void;
  themeParams: Record<string, string>;
  colorScheme: string;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function getTelegramWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

export function getInitData(): string {
  return getTelegramWebApp()?.initData ?? "";
}
