# PUET.Pulse на одному сервері: покрокова інструкція

Ця інструкція встановлює весь месенджер на **один сервер**: веб-клієнт, API,
базу даних, сховище файлів, антивірус, вхід через Keycloak з двофакторною
автентифікацією і дзвінки. Такий сервер підходить для **пілоту** на кілька
сотень людей. Схему для всього університету описано в
[DEPLOYMENT.md](DEPLOYMENT.md), розділ 3.

Приклади нижче використовують безкоштовний сервер Oracle Cloud. Так само все
працює на будь-якому сервері з Ubuntu 24.04: власному сервері університету,
віртуальній машині в серверній або орендованому VPS.

Час: 2–3 години, якщо робити це вперше.

---

## Крок 0. Який сервер обрати

### Безкоштовний варіант: Oracle Cloud Always Free

Серед безкоштовних хмар тільки Oracle дає достатньо ресурсів. Станом на
листопад 2026 це віртуальна машина на процесорі ARM (Ampere A1):

| Ресурс | Безкоштовно назавжди |
|---|---|
| Процесор | 2 OCPU (ядра ARM) |
| Пам'ять | 12 ГБ |
| Диск | 200 ГБ сумарно |
| Вихідний трафік | 10 ТБ на місяць |

Цього вистачає, щоб усе з цієї інструкції працювало на одній машині.

**Що треба знати перед реєстрацією:**

- **Ліміти змінюються.** У червні 2026 Oracle без оголошення зменшила
  безкоштовний ліміт удвічі: було 4 ядра і 24 ГБ, стало 2 і 12. Ліміт можуть
  змінити знову.
- **Простій.** Безкоштовну машину, яка 7 днів майже не працює (процесор,
  мережа й пам'ять нижче 20%), Oracle може забрати. Робочий пілот з
  користувачами зазвичай вище цього порогу. Обліковий запис типу Pay As You Go
  знімає цей ризик, і безкоштовні ресурси в ньому лишаються безкоштовними. Але
  для нього потрібна банківська картка. Обов'язково налаштуйте ліміт бюджету,
  щоб випадково не створити платний ресурс.
- **Картка.** Навіть для безкоштовного облікового запису Oracle просить
  картку для перевірки. Гроші з неї не знімаються.
- **«Out of host capacity».** Машин ARM часто бракує. Якщо створити машину не
  вдається, спробуйте іншу зону доступності (Availability Domain) або
  повторіть пізніше.
- **Домашній регіон** обирається один раз і назавжди. Найближчий до України:
  Germany Central (Frankfurt).

### Важливо: персональні дані

Технічне завдання вимагає розміщення **на серверах університету**
(on-premise). Хмара Oracle — це сервер іншої компанії за кордоном. Тому:

- використовуйте безкоштовну хмару для **тестування і демонстрацій**, або для
  пілоту з мінімумом реальних даних: лише ім'я, службова пошта, підрозділ;
- перед завантаженням реальних людей отримайте згоду відповідального за
  захист персональних даних ПУЕТ;
- **не підключайте ліцей (неповнолітніх)** і служби довіри в хмарі;
- для робочого запуску встановіть месенджер на сервер університету за цією ж
  інструкцією (кроки 3–17 однакові).

Безкоштовна альтернатива, яка відповідає ТЗ: будь-який сервер або потужний ПК
у серверній ПУЕТ з Ubuntu 24.04, 4+ ядрами, 12+ ГБ пам'яті, публічною
IP-адресою або пробросом портів 80, 443, 7881 і UDP 50000–60000.

---

## Крок 1. Створіть машину в Oracle Cloud

1. Зареєструйтеся на https://www.oracle.com/cloud/free/. Домашній регіон:
   Germany Central (Frankfurt).
2. Відкрийте **Compute → Instances → Create instance**.
3. **Image:** Canonical Ubuntu 24.04. **Shape:** Ampere → `VM.Standard.A1.Flex`,
   2 OCPU, 12 GB memory.
4. **Networking:** Create new virtual cloud network, public subnet,
   **Assign a public IPv4 address**.
5. **SSH keys:** завантажте свій відкритий ключ. Створити ключ на своєму
   комп'ютері: `ssh-keygen -t ed25519`. Відкритий ключ лежить у
   `~/.ssh/id_ed25519.pub`.
6. **Boot volume:** Specify a custom boot volume size, 150 GB.
7. Натисніть **Create** і запишіть **Public IP address** машини.

## Крок 2. Відкрийте порти в Oracle

**Networking → Virtual cloud networks →** ваша мережа **→ Security Lists →
Default Security List → Add Ingress Rules.** Для кожного правила: Source CIDR
`0.0.0.0/0`.

| Протокол | Порти | Для чого |
|---|---|---|
| TCP | 80 | отримання сертифіката Let's Encrypt, перенаправлення на HTTPS |
| TCP | 443 | месенджер, вхід, дзвінки (wss) |
| TCP | 7881 | дзвінки через TCP, коли UDP закритий |
| UDP | 50000-60000 | аудіо і відео дзвінків |

Порт 22 (SSH) Oracle відкриває сама.

## Крок 3. Доменні імена

Потрібні три імені, що вказують на IP сервера:

| Ім'я | Приклад |
|---|---|
| месенджер | `pulse.puet.edu.ua` |
| вхід (Keycloak) | `sso.pulse.puet.edu.ua` |
| дзвінки (LiveKit) | `meet.pulse.puet.edu.ua` |

**Найкраще:** попросіть адміністратора DNS університету створити три записи
типу A на IP сервера.

**Безкоштовно для тесту:** зареєструйте ім'я на https://www.duckdns.org
(наприклад, `puet-pulse.duckdns.org`) і вкажіть IP сервера. DuckDNS також
відповідає на піддомени, тому `sso.puet-pulse.duckdns.org` і
`meet.puet-pulse.duckdns.org` працюють одразу.

Перевірте на своєму комп'ютері, що всі три імені вказують на IP сервера:
`nslookup sso.puet-pulse.duckdns.org`.

Далі в командах підставте свої імена:

```bash
PULSE=puet-pulse.duckdns.org
SSO=sso.puet-pulse.duckdns.org
MEET=meet.puet-pulse.duckdns.org
```

## Крок 4. Підготуйте систему

Підключіться до сервера: `ssh ubuntu@<IP>`. Усі наступні команди виконуються
на сервері.

> **Вставляйте команди по одній.** Якщо ви підключаєтеся з Windows (PowerShell
> або Windows Terminal), вставка кількох рядків одразу може склеїти їх, і
> частина команд мовчки не виконається. Копіюйте один рядок, натискайте Enter,
> дочекайтеся завершення, потім беріть наступний. Рядки з `#` наприкінці
> містять лише коментар, його можна не копіювати.

```bash
sudo apt update && sudo apt -y full-upgrade
sudo timedatectl set-timezone Europe/Kyiv
sudo apt -y install git curl ca-certificates nginx certbot unattended-upgrades fail2ban
nginx -v && certbot --version                            # обидві команди мають вивести версію
sudo useradd --system --home /srv/puet-pulse --shell /usr/sbin/nologin puet-pulse   # службовий користувач месенджера
sudo dpkg-reconfigure -plow unattended-upgrades          # автоматичні оновлення безпеки

# Файл підкачки на 4 ГБ (запас пам'яті під час збирання й оновлення антивірусних баз)
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Образ Ubuntu в Oracle має власний файрвол (iptables), який закриває все,
крім SSH. Відкрийте ті самі порти, що в кроці 2:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 7881 -j ACCEPT
sudo iptables -I INPUT 6 -p udp --dport 50000:60000 -j ACCEPT
sudo netfilter-persistent save
```

На власному сервері університету замість цього використовуйте `ufw`:
`sudo ufw allow OpenSSH && sudo ufw allow 80,443,7881/tcp && sudo ufw allow 50000:60000/udp && sudo ufw enable`.

Вхід по SSH лише за ключем:

```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

## Крок 5. Встановіть Docker і Node.js

```bash
curl -fsSL https://get.docker.com | sudo sh                 # Docker Engine + Compose
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs                                   # Node.js 22
sudo corepack enable                                         # pnpm
docker --version && node --version
```

## Крок 6. Завантажте і зберіть месенджер

```bash
id puet-pulse                                    # перевірка: користувач з кроку 4 існує
sudo mkdir -p /srv/puet-pulse && sudo chown ubuntu: /srv/puet-pulse
git clone https://github.com/wasilews2009/PUET.Pulse.git /srv/puet-pulse/app
cd /srv/puet-pulse/app
git checkout claude/project-thread-l63ox0        # до злиття PR #1; після злиття: main
pnpm install --frozen-lockfile
pnpm build                                       # 5–10 хвилин
```

Якщо репозиторій приватний, додайте серверу ключ лише для читання: на сервері
`ssh-keygen -t ed25519`, вміст `~/.ssh/id_ed25519.pub` вставте в GitHub →
Settings репозиторію → Deploy keys. Потім клонуйте за адресою
`git@github.com:wasilews2009/PUET.Pulse.git`.

## Крок 7. Налаштування і секрети

Скрипт створює `/etc/puet/pulse.env` з випадковими паролями й ключами:

```bash
sudo sh infra/single-server/make-env.sh $PULSE $SSO $MEET
```

Він виведе ключ LiveKit. Запишіть його в `infra/single-server/livekit.yaml`,
рядок `api_key:` у розділі `webhook`:

```bash
sed -i "s/CHANGE_ME_LIVEKIT_API_KEY/<ключ, який вивів скрипт>/" infra/single-server/livekit.yaml
```

Файл `/etc/puet/pulse.env` можуть читати лише root і служба месенджера. Не надсилайте його нікому
і не додавайте в git. Зробіть його копію в надійному місці: без нього не можна
відновити сервер.

Для зручності:

```bash
C="sudo docker compose --env-file /etc/puet/pulse.env -f docker-compose.yml -f infra/single-server/docker-compose.server.yml"
E="sudo PULSE_ENV_FILE=/etc/puet/pulse.env"
```

Змінні `C` і `E` діють, поки відкрите вікно терміналу. Після нового
підключення виконайте ці два рядки знову, разом з `PULSE=...`, `SSO=...` і
`MEET=...` з кроку 3, у теці `/srv/puet-pulse/app`.

## Крок 8. Запустіть бази і сервіси

```bash
$C up -d postgres redis minio minio-init clamav
$C exec postgres createdb -U puet keycloak       # окрема база для Keycloak
$C up -d keycloak
$C ps                                            # усі сервіси "running" або "healthy"
```

ClamAV при першому запуску завантажує антивірусні бази, до 5 хвилин.
Образи MinIO беруться з `pgsty/minio` і `pgsty/mc` (спільнотні збірки того самого коду):
сам MinIO образів більше не публікує.
Усі образи мають збірки для ARM (arm64) і x86 (amd64).

Створіть таблиці, структуру ПУЕТ і внутрішній ЦСК для електронних підписів:

```bash
$E pnpm db:deploy
$E pnpm db:seed
$E pnpm pki:init-ca /etc/puet/ca
sudo chown -R puet-pulse: /etc/puet/ca             # ключ ЦСК читає лише служба месенджера
```

Приватний ключ ЦСК `/etc/puet/ca/ca.key.pem` скопіюйте на зашифрований носій і
зберігайте офлайн.

## Крок 9. Сертифікати HTTPS і nginx

```bash
sudo certbot certonly --standalone -d $PULSE -d $SSO -d $MEET \
  --agree-tos -m <ваша пошта> --no-eff-email \
  --pre-hook "systemctl stop nginx" --post-hook "systemctl start nginx"
```

Certbot сам оновлюватиме сертифікат кожні 2–3 місяці.

Конфігурація nginx з прикладів репозиторію, з вашими іменами:

```bash
sed -e "s|meet.pulse.puet.edu.ua|$MEET|g" -e "s|pulse.puet.edu.ua|$PULSE|g" \
    -e "s|/etc/puet/tls/|/etc/letsencrypt/live/$PULSE/|g" \
    infra/nginx/pulse.conf | sudo tee /etc/nginx/conf.d/pulse.conf >/dev/null
sed -e "s|sso.example.org|$SSO|g" -e "s|meet.example.org|$MEET|g" -e "s|pulse.example.org|$PULSE|g" \
    infra/single-server/nginx-extra.conf | sudo tee /etc/nginx/conf.d/pulse-extra.conf >/dev/null
curl -4 -s ifconfig.me; echo                     # ваша IP-адреса, з якої ви зараз працюєте
```

Відкрийте `/etc/nginx/conf.d/pulse-extra.conf` (`sudo nano ...`) і в рядку
`allow 203.0.113.10;` вкажіть IP-адресу вашого комп'ютера (не сервера), щоб
адмін-консоль Keycloak відкривалася лише вам. Тоді:

```bash
sudo rm -f /etc/nginx/sites-enabled/default
sudo mkdir -p /srv/puet-pulse/web && sudo cp -r apps/web/dist/. /srv/puet-pulse/web/
sudo nginx -t && sudo systemctl reload nginx
```

## Крок 10. Вхід через Keycloak

Створіть реалм `puet` з клієнтом месенджера і налаштуваннями двофакторної
автентифікації:

```bash
val() { sudo grep "^$1=" /etc/puet/pulse.env | cut -d= -f2-; }
$C exec -e KC_ADMIN_PASSWORD="$(val KC_BOOTSTRAP_ADMIN_PASSWORD)" -e PULSE_HOST="$PULSE" \
  -e OIDC_CLIENT_SECRET="$(val OIDC_CLIENT_SECRET)" keycloak sh /opt/pulse/configure-realm.sh
```

Має з'явитися `Realm puet created`.

Пароль адміністратора Keycloak: `val KC_BOOTSTRAP_ADMIN_PASSWORD`.
Адмін-консоль: `https://<SSO>/admin/` (логін `kcadmin`). Одразу створіть у
реалмі **master** власного адміністратора з TOTP і видаліть тимчасового
`kcadmin`.

Облікові записи людей у реалмі **puet**:

- **Є AD / LDAP:** User federation → Add LDAP provider. Попросіть IT-центр
  дані для підключення (адреса, Bind DN, база користувачів). Пошта в AD має
  збігатися з поштою з кадрової системи.
- **Пілот без AD:** Users → Create new user. Вкажіть Email (ту саму, що у файлі
  з кроку 12), Email verified: On. Потім Credentials → Set password,
  Temporary: On.
- Адміністраторам, керівникам, фінансам, кадрам і службам довіри додайте в
  користувача Required user actions → **Configure OTP**.

## Крок 11. API як служба

```bash
sudo cp infra/systemd/puet-pulse-api.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now puet-pulse-api
curl -s http://127.0.0.1:3000/health; echo       # {"status":"ok","service":"puet-pulse-api"}
curl -s https://$PULSE/api/health; echo          # те саме через HTTPS
```

Якщо не працює, дивіться журнал: `sudo journalctl -u puet-pulse-api -n 50`.

## Крок 12. Учасники пілоту

Поки кадрову систему, ЄДЕБО і ERP не підключено, людей можна завантажити з
файлів JSON. Вони проходять ті самі перевірки, що й справжня синхронізація.
Канали груп, курсів і підрозділів створюються автоматично.

`staff.json`, працівники:

```json
{ "records": [
  { "hrId": "HR-0001", "corporateId": "PUET-0001", "email": "i.petrenko@puet.edu.ua",
    "fullNameUk": "Іван Петренко", "fullNameEn": "Ivan Petrenko", "position": "Інженер IT-центру",
    "orgUnitCodes": ["IT_CENTER"] },
  { "hrId": "HR-0002", "corporateId": "PUET-0002", "email": "o.koval@puet.edu.ua",
    "fullNameUk": "Олена Коваль", "position": "Доцент",
    "primaryDepartmentCode": "COMPUTER_SCIENCE_IT", "departmentCodes": ["COMPUTER_SCIENCE_IT"],
    "roles": [{ "role": "LECTURER", "departmentCode": "COMPUTER_SCIENCE_IT" }] }
] }
```

`students.json`, студенти:

```json
{ "records": [
  { "edeboId": "E-1001", "corporateId": "S-1001", "email": "a.shevchenko@stud.puet.edu.ua",
    "fullNameUk": "Андрій Шевченко", "birthDate": "2005-04-12", "educationLevel": "BACHELOR",
    "instituteCode": "NNI_DAYTIME", "groupCode": "КН-21", "courseYear": 2 }
] }
```

`load.json`, навантаження семестру (курс і його канал):

```json
{ "semester": { "code": "2026-1", "startsOn": "2026-09-01", "endsOn": "2027-01-31", "isCurrent": true },
  "offerings": [
    { "externalId": "WEB-2026-1", "departmentCode": "COMPUTER_SCIENCE_IT",
      "discipline": { "code": "WEB", "nameUk": "Вебтехнології", "nameEn": "Web technologies" },
      "lecturerHrIds": ["HR-0002"], "groupCodes": ["КН-21"] }
  ] }
```

Коди інститутів, кафедр і підрозділів дивіться в
`packages/database/prisma/seed-data.ts` або в адмін-панелі на вкладці
«Структура». Усі поля описано в `apps/api/src/integrations/schemas.ts`.

```bash
$E pnpm sync:send hr/staff /home/ubuntu/staff.json
$E pnpm sync:send edebo/students /home/ubuntu/students.json
$E pnpm sync:send teaching-load /home/ubuntu/load.json
```

Відповідь `HTTP 200` з `"errors":[]` означає успіх. При помилці API вкаже
номер запису й поле.

Хто вибуває з пілоту: файл з `{"records":[{"hrId":"HR-0002","reason":"DISMISSED"}]}`
→ `$E pnpm sync:send offboarding <файл>`. Доступ закривається одразу.

## Крок 13. Перший адміністратор

```bash
$E pnpm admin:bootstrap PUET-0001                # службовий ID працівника з staff.json
```

Ця людина входить на `https://<PULSE>`, налаштовує TOTP і відкриває
«Адміністрування». Інших адміністраторів призначають там.

## Крок 14. Дзвінки (за бажанням)

```bash
$C --profile calls up -d livekit
```

Перевірка: у будь-якому чаті натисніть «Почати відеодзвінок», приєднайтеся з
другого пристрою. Якщо відео немає, перевірте UDP 50000–60000 у кроках 2 і 4.
Двох ядер вистачає приблизно на 2–3 одночасні дзвінки по 10 людей.

## Крок 15. Резервні копії

```bash
sudo crontab -e
# додайте рядок (щоночі о 02:30):
30 2 * * * sh /srv/puet-pulse/app/infra/single-server/backup.sh >> /var/log/puet-backup.log 2>&1
```

Перший запуск вручну: `sudo sh infra/single-server/backup.sh`. Копії
зберігаються 14 днів у `/var/backups/puet`. У них є файли користувачів у
відкритому вигляді, тому копіюйте їх із сервера лише в зашифроване сховище
університету, наприклад `rclone` або `rsync` на сервер ПУЕТ щодня. Копія на тому
самому диску не врятує, якщо загине сам сервер.

Відновлення бази з копії:

```bash
$C exec -T postgres pg_restore -U puet -d puet_pulse --clean < /var/backups/puet/<дата>/puet_pulse.dump
```

## Крок 16. Перевірка

1. `https://<PULSE>` відкривається, у браузері замок без попереджень.
2. Вхід працівника з `staff.json`: Keycloak просить змінити тимчасовий пароль.
3. Адміністратор: TOTP, потім «Адміністрування» → «Журнал аудиту» →
   «Перевірити ланцюжок хешів».
4. Пройдіть сценарії з [DEPLOYMENT.md](DEPLOYMENT.md), розділ 2.
5. https://www.ssllabs.com/ssltest/ для `<PULSE>`: оцінка A або A+.

## Крок 17. Оновлення

```bash
cd /srv/puet-pulse/app
sudo sh infra/single-server/backup.sh            # спершу резервна копія
git pull && pnpm install --frozen-lockfile && pnpm build
$E pnpm db:deploy && $E pnpm db:seed
sudo cp -r apps/web/dist/. /srv/puet-pulse/web/
sudo systemctl restart puet-pulse-api
$C pull && $C up -d                              # нові образи бази, Keycloak, антивірусу
```

---

## Якщо щось не працює

| Ознака | Що перевірити |
|---|---|
| Сайт не відкривається | `sudo nginx -t`, `sudo systemctl status nginx`; порти 80/443 у кроках 2 і 4; DNS вказує на IP сервера |
| «Сервіс входу тимчасово недоступний» | `$C ps` — Keycloak запущено; `curl -s https://<SSO>/realms/puet/.well-known/openid-configuration` |
| «Вхід неможливий» після Keycloak | людини немає в месенджері (крок 12) або пошта в Keycloak інша; людину звільнено |
| Адміністратора просять увійти вдруге | так і має бути при першому вході: месенджер просить другий фактор |
| Файли «у карантині» довго | `$C logs clamav` — бази ще завантажуються; `$C ps` — clamav "healthy" |
| API не стартує | `sudo journalctl -u puet-pulse-api -n 50`; там назва змінної з помилкою |
| Немає звуку чи відео в дзвінку | UDP 50000–60000 у кроках 2 і 4; `$C --profile calls logs livekit` |
| Машину Oracle зупинено | ліміти або простій (крок 0); перезапустіть у консолі Oracle, усі дані на диску зберігаються |
