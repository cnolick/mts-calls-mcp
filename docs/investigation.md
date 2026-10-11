# Проверенный контракт «Мой МТС»

Исследование собственного аккаунта и неизменённого Android APK «Мой МТС» 6.77.
Никаких пользовательских токенов, номеров и текстов разговоров в репозитории нет.

## Источник

Пакет `ru.mts.mymts`, versionCode `150770030`, 22 DEX-файла.
SHA-256 базового APK:
`aafc0933f9d27057f204a8a3266ae1c9c04b48b6a064b860e0e88f6a2ec5c03a`.
APK скопирован с собственного телефона через разрешённый ADB. Его подпись
отдельно не проверялась. API установлен по Retrofit-аннотациям и точечной
декомпиляции через REA/JADX; контракт подтверждён живыми запросами.

## API звонков

База: `https://dialer.mts.ru/bff/`.

| Операция | Запрос |
|---|---|
| Список | GET `api/v1/calls?orderby=desc&limit=50&offset=0&offset_timestamp=0` |
| Расшифровка | POST `api/v1/calls/{call_id}/records/{record_id}/details` |
| Начать SMS-проверку записей | POST `api/v1/auth/activation/init`, без тела |
| Подтвердить | POST `api/v1/auth/activation/confirm`, `{"otp":"…","service_type":""}` |
| Обновить доступ к записям | POST `api/v1/auth/activation/refresh`, `{"service_type":""}` |

Тело details: `{"name":"","last_name":"","middle_name":"","summary_style_id":""}`.
`offset_timestamp` — сырой BFF_LAST_CALL_VERSION, а не Unix-время; исходное 0
работает. Native синхронизация использует asc; desc проверен живым запросом.

Заголовки: `Authorization: id_token <JWT>` (один ASCII-пробел), `X-Device-Id`,
`X-Profile-Id`, `X-Msisdn`, `X-Instance-Id`, `X-Callrec-Id`, `App-Version`,
`X-Trace-Id` и `User-Agent`. Trace ID — новый UUID на каждый запрос.
Device ID звонков — SDK UUID, instance ID — UUID клиента для номера.

Ответ details содержит `status`, `summary_status`, `transcription.messages`,
`messages_from_assistant` и `summary`. Реплики сохраняют text, owner,
owner_name, date. Это обычные входящие/исходящие разговоры, а не только
звонки, на которые ответил «Защитник».

Для неподготовленной записи POST details может запустить обработку и вернуть
processing. Поиск пропускает записи с известным transcription_status != done;
индивидуальный get_transcript отмечен readOnlyHint=false. MCP не выполняет
link, share, удаление, смену подписок или замену активного устройства.

## Авторизация и TLS

`GET https://auth.ssl.mts.ru/idToken` использует собственный x-user-token,
app-scoped Android ID в x-device-id, x-client-id=My_MTS, x-app-version и
x-app-os-version. Это отдельный контекст устройства от SDK звонков.

AuthSSL использует клиентский PKCS12. Его приватный ключ и passphrase
в репозиторий не включены. Calls использует отдельный TLS-клиент без
клиентского сертификата. Обе ветки проверяют сертификат сервера и hostname.
Для dialer добавлен публичный MTS Class 2 Root CA G2 из исходного APK;
[происхождение сертификата](../certs/README.md).

Собственный user_token получен штатным native getter основного профиля;
JWT — getter IdTokenSDK в контексте приложения. Ключ AndroidKeyStore
не экспортировался. Пользователь самостоятельно ввёл SMS для доступа
к записям; fallback no_otp на этом аккаунте был недостаточен.

ID обновляется перед истечением; Callrec — перед своим истечением.
Файл сессии заменяется атомарно с правами 0600, обновления внутри процесса
сериализованы. Ответ с другим профилем или номером отклоняется. При 401/403
есть одна попытка обновить ID. При отзыве сессии потребуется новый вход.
Бессрочная жизнь user_token не проверена и не гарантируется.

## Проверка

Живой stdio MCP подтвердил список 411 звонков, две непересекающиеся страницы,
готовую обычную расшифровку из 71 реплики и поиск. Оба refresh проверены
вне приложения. Эмулятор остановлен; API продолжает работать без телефона.

Удалённый HTTP MCP на Linux/Node 22 подтвердил доступ к тому же архиву
с другого IP. OpenClaw обнаруживает четыре инструмента через собственный
mcp.servers registry. Подробности развёртывания — [deployment.md](deployment.md).

Исследовательский guard в instrument ограничивает OkHttp основного процесса;
он не является гарантией перехвата всех транспортов приложения. Для Android30
использовалась Frida16.7.19: более новая 17.23.3 в этом образе аварийно завершалась.
UI-склейка через ADB остаётся резервным приблизительным способом, а API
возвращает исходные реплики. Приватные исходные артефакты исключены из Git.
