# PUET.Pulse для Android

Застосунок PUET.Pulse для смартфонів і планшетів Android 7.0+ (API 24).

## Як влаштовано

Це **Trusted Web Activity** (бібліотека Google `androidbrowserhelper`): застосунок
відкриває веб-клієнт PUET.Pulse одного сервера на весь екран у рушії Chrome,
без адресного рядка. Власного коду, WebView чи «мосту» JavaScript ↔ Android
немає, тому:

- сторінка працює рівно як у браузері, під CSP сервера; правила CLAUDE.md
  (сесія в HttpOnly-cookie, нічого в URL, PDF.js без eval) діють без змін;
- **E2EE працює**: vodozemac (WebAssembly), WebCrypto і IndexedDB — це ті самі
  механізми, що в Chrome; ключі пристрою зберігаються у сховищі Chrome для
  сайту сервера. Якщо користувач очистить дані Chrome для цього сайту, ключі
  відновлюються з резервної копії (майстер-пароль), як у браузері;
- дзвінки (камера, мікрофон) — дозвіл запитує браузер для сайту; демонстрація
  екрана на Android у браузері недоступна (обмеження Chrome для Android);
- сповіщення сторінки передаються застосунку (notification delegation), тому
  показуються з іконкою PUET.Pulse; на Android 13+ застосунок запитує дозвіл.

Єдиний дозвіл — `POST_NOTIFICATIONS`; резервне копіювання вимкнене,
нешифрований трафік заборонений. Якщо на телефоні немає браузера з підтримкою
TWA (Chrome, Edge, Samsung Internet тощо), сторінка відкривається у Custom Tab з
адресним рядком, але ніколи у WebView.

## Що потрібно на сервері: Digital Asset Links

Щоб Android довіряв застосунку і не показував адресний рядок, сервер має
віддавати `https://<сервер>/.well-known/assetlinks.json` з відбитком SHA-256
ключа підпису:

```bash
scripts/assetlinks.sh --keystore puet-release.jks --alias puet-pulse > assetlinks.json
# або відбитки вручну (наприклад, ключ підпису з Google Play Console > App integrity):
scripts/assetlinks.sh AB:CD:…:EF 12:34:…:56 > assetlinks.json
```

Покладіть файл у `/srv/puet-pulse/web/.well-known/assetlinks.json`; приклад
nginx (`infra/nginx/pulse.conf`) віддає його як `application/json` і повертає
404, якщо файлу немає. CI-збірка з ключем також кладе готовий `assetlinks.json`
поруч з APK.

## Збірка

CI: `.github/workflows/clients.yml` (job «Android app»). Без ключа будується
тестовий APK (debug-підпис, адресний рядок видно); з ключем — підписані
`PUET.Pulse-X.Y.Z.apk` (пряме встановлення / MDM) і `.aab` (Google Play).

Секрети GitHub: `ANDROID_KEYSTORE_BASE64` (base64 файлу `.jks`),
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`;
змінна `PULSE_URL` (адреса сервера, лише https без порту).

Ключ створюється один раз і зберігається поза репозиторієм (його втрата
означає, що оновлення APK не встановляться поверх старої версії):

```bash
keytool -genkeypair -v -keystore puet-release.jks -alias puet-pulse \
  -keyalg RSA -keysize 4096 -validity 10000 -dname "O=PUET, C=UA"
base64 -w0 puet-release.jks   # -> секрет ANDROID_KEYSTORE_BASE64
```

Локально (Android Studio або JDK 17 + Android SDK):

```bash
cd apps/android
PULSE_URL=https://pulse.puet.edu.ua ./gradlew assembleDebug
# підписаний реліз:
ANDROID_KEYSTORE_FILE=… ANDROID_KEYSTORE_PASSWORD=… ANDROID_KEY_ALIAS=puet-pulse \
ANDROID_KEY_PASSWORD=… PULSE_VERSION_CODE=2 PULSE_VERSION_NAME=0.1.1 ./gradlew assembleRelease bundleRelease
```

`PULSE_VERSION_CODE` має зростати з кожним випуском (у CI це номер запуску).
