// Strict vocabulary only. Never return the provider body, Error.message or token.
function setupProblem(error, phase) {
  const code =
    phase === 'save'
      ? 'save_failed'
      : phase === 'load'
        ? 'protected_config'
        : phase === 'identity'
          ? 'different_bot'
          : error.safeReason === 'tls_certificate'
            ? 'tls_certificate'
            : error.providerStatus === 401
              ? 'authorization'
              : error.providerStatus === 403
                ? 'permission'
                : error.providerStatus === 429
                  ? 'rate_limit'
                  : error.safeReason === 'network'
                    ? 'network'
                    : 'provider_response';
  const messages = {
    save_failed:
      'Не удалось сохранить токен. Проверьте формат и подтвердите замену, если он уже сохранён.',
    protected_config:
      'Windows не смогла открыть защищённую настройку. Используйте ту же учётную запись компьютера.',
    different_bot: 'Токен действителен, но относится не к боту «Картотека».',
    tls_certificate:
      'Не удалось проверить сертификат сервера MAX. Проверка защиты не отключалась; токен не подтверждён.',
    authorization: 'MAX отклонил авторизацию. Проверьте, что скопирован полный действующий токен.',
    permission: 'MAX запретил доступ к боту. Проверьте доступ и состояние бота в MAX для бизнеса.',
    rate_limit: 'MAX временно ограничил запросы. Повторите проверку позже.',
    network: 'Нет соединения с API MAX. Проверьте сеть и повторите попытку.',
    provider_response: 'MAX не вернул ожидаемые сведения о боте. Подключение не включено.',
  };
  return { code, message: messages[code] };
}
module.exports = { setupProblem };
