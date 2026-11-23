# PUET.Pulse на серверах університету

Інструкція для IT-центру ПУЕТ: встановлення месенджера на власні сервери
університету (on-premise), як вимагає технічне завдання. Вона доповнює
покрокову інструкцію [SERVER_SETUP.md](SERVER_SETUP.md): більшість команд
однакові, а тут описано, що відрізняється на серверах університету. Сюди
належать віртуальні машини, внутрішня мережа, домен університету, Active
Directory, резервне копіювання на сховище ПУЕТ і моніторинг.

---

## 1. Два варіанти

| | Варіант А: один сервер | Варіант Б: сервер застосунку + сервер даних |
|---|---|---|
| Для кого | пілот і перший рік роботи, до ~5 000 активних людей | увесь університет, ліцей і коледжі |
| Віртуальні машини | 1 (+1 для дзвінків за потреби) | 2 (+1 для дзвінків) |
| Складність | найпростіше, усе на одній машині | дані окремо, їх легше захищати й масштабувати |
| Інструкція | [SERVER_SETUP.md](SERVER_SETUP.md), кроки 3–17, з урахуванням розділів 3–9 нижче | розділ 10 нижче |

Почніть з варіанта А. Перейти на Б можна пізніше, перенісши дані за
допомогою резервної копії (розділ 10.4).

## 2. Ресурси

| Машина | vCPU | RAM | Диск | ОС |
|---|---|---|---|---|
| А: усе в одному | 8 | 32 ГБ | 100 ГБ SSD (система) + 1 ТБ (дані, файли) | Ubuntu Server 24.04 LTS |
| Б: застосунок (nginx, API, веб) | 4 | 8 ГБ | 50 ГБ SSD | Ubuntu Server 24.04 LTS |
| Б: дані (PostgreSQL, Redis, MinIO, ClamAV, Keycloak) | 8 | 32 ГБ | 100 ГБ SSD + 1 ТБ і більше | Ubuntu Server 24.04 LTS |
| Дзвінки (LiveKit), за потреби | 8 | 8 ГБ | 30 ГБ | Ubuntu Server 24.04 LTS |

Гіпервізор будь-який: VMware, Proxmox, Hyper-V. Під PostgreSQL і MinIO
виділіть диски на SSD. Оцінку уточніть за навантаженням на пілоті.

## 3. Мережа

### 3.1. Зони

```
Інтернет ──> файрвол ПУЕТ ──> DMZ: застосунок (nginx :443) ──> внутрішня зона: дані
                         └──> DMZ: дзвінки (443, 7881/tcp, 50000-60000/udp)
Внутрішня зона: контролери домену (AD), сховище резервних копій, моніторинг
```

- Сервер застосунку і сервер дзвінків стоять у DMZ.
- Сервер даних стоїть у внутрішній зоні, з інтернету до нього доступу немає.
- Адміністрування лише з мережі IT-центру або через VPN.

### 3.2. Правила файрвола

| Звідки | Куди | Порти | Для чого |
|---|---|---|---|
| Інтернет | застосунок | 80, 443/tcp | месенджер, вхід (80 лише для перенаправлення й Let's Encrypt) |
| Інтернет | дзвінки | 443, 7881/tcp; 50000–60000/udp | відео й аудіо |
| застосунок | дані | 5432, 6379, 9000, 3310, 8081/tcp | база, Redis, файли, антивірус, Keycloak |
| дані (Keycloak) | контролери домену | 636/tcp (LDAPS) | облікові записи AD |
| дзвінки | застосунок | 443/tcp | вебхук дзвінків |
| ЄДЕБО-шлюз, HR, ERP, Деканат, ЕДО | застосунок | 443/tcp | вебхуки синхронізації |
| застосунок | системи ПУЕТ | 443/tcp | вихідні події ботів (Деканат, ЕДО) |
| мережа IT-центру | усі | 22/tcp | SSH для адміністраторів |
| усі | сховище копій | 22/tcp (rsync) або SMB | резервні копії |
| усі | інтернет | 443/tcp | оновлення ОС, образи Docker, антивірусні бази |

Якщо серверам не можна мати вихід в інтернет, потрібні внутрішнє дзеркало
Ubuntu, реєстр образів Docker і дзеркало баз ClamAV. Це можна налаштувати
пізніше, на час встановлення відкрийте доступ тимчасово.

### 3.3. DNS

У зовнішній зоні `puet.edu.ua` створіть записи A на зовнішню адресу
файрвола (NAT на сервери в DMZ):

| Ім'я | Куди |
|---|---|
| `pulse.puet.edu.ua` | сервер застосунку |
| `sso.puet.edu.ua` (або `sso.pulse.puet.edu.ua`) | сервер застосунку (nginx проксіює на Keycloak) |
| `meet.pulse.puet.edu.ua` | сервер дзвінків |

Якщо всередині університету працює split DNS, ті самі імена мають вказувати
на внутрішні адреси серверів.

## 4. Сертифікати TLS

Два способи:

- **Let's Encrypt.** Безкоштовно, як у SERVER_SETUP.md, крок 9. Порт 80 має
  бути відкритий з інтернету на сервер застосунку.
- **Сертифікат університету.** Wildcard `*.puet.edu.ua` або окремі сертифікати.
  Покладіть файли в `/etc/puet/tls/fullchain.pem` (сертифікат разом із
  проміжними) і `/etc/puet/tls/privkey.pem` (mode 600, owner root). Тоді в
  кроці 9 не запускайте certbot, а в командах `sed` залиште шлях
  `/etc/puet/tls/` без змін:
  ```bash
  sed -e "s|meet.pulse.puet.edu.ua|$MEET|g" -e "s|pulse.puet.edu.ua|$PULSE|g" \
      infra/nginx/pulse.conf | sudo tee /etc/nginx/conf.d/pulse.conf >/dev/null
  sed -e "s|sso.example.org|$SSO|g" -e "s|meet.example.org|$MEET|g" \
      -e "s|/etc/letsencrypt/live/pulse.example.org/|/etc/puet/tls/|g" \
      infra/single-server/nginx-extra.conf | sudo tee /etc/nginx/conf.d/pulse-extra.conf >/dev/null
  ```
  Нагадування про оновлення сертифіката додайте в моніторинг (розділ 8).

## 5. Підготовка машин

На кожній машині виконайте SERVER_SETUP.md, кроки 4–5, з такими змінами:

- Кроки для Oracle (iptables) пропустіть. Використовуйте `ufw` з правилами з
  розділу 3.2.
- Підключіть диск для даних і змонтуйте його в `/var/lib/docker`, до
  встановлення Docker:
  ```bash
  sudo mkfs.ext4 /dev/sdb && sudo mkdir -p /var/lib/docker
  echo "UUID=$(sudo blkid -s UUID -o value /dev/sdb) /var/lib/docker ext4 defaults,noatime 0 2" | sudo tee -a /etc/fstab
  sudo mount -a && df -h /var/lib/docker
  ```
- Встановіть синхронізацію часу з контролером домену: `sudo timedatectl set-ntp true`.
  Якщо в мережі є власний NTP, вкажіть його в `/etc/systemd/timesyncd.conf`.
  Точний час потрібен для підписів, TOTP і вебхуків.
- Встановіть агент моніторингу (Zabbix agent 2 або той, що прийнятий в
  університеті).

## 6. Keycloak і Active Directory

Месенджер не зберігає паролів: усі входять обліковим записом університету
через Keycloak, підключений до AD.

### 6.1. Реалм і клієнт

SERVER_SETUP.md, крок 10: скрипт `configure-realm.sh` створює реалм `puet`,
клієнт `puet-pulse` і налаштування двофакторної автентифікації.

### 6.2. Підключення AD

У консолі Keycloak (`https://<SSO>/admin/`) → реалм **puet** → **User
federation** → **Add LDAP providers**:

| Поле | Значення |
|---|---|
| Vendor | Active Directory |
| Connection URL | `ldaps://dc1.puet.local:636` (адреса контролера домену) |
| Use Truststore SPI | Always (сертифікат CA домену додайте в truststore Keycloak) |
| Bind type / Bind DN | simple / `CN=svc-pulse-ldap,OU=Service,DC=puet,DC=local` |
| Bind credentials | пароль службового облікового запису (лише читання) |
| Edit mode | READ_ONLY |
| Users DN | `OU=Users,DC=puet,DC=local` (ваш підрозділ з людьми) |
| Username LDAP attribute | `sAMAccountName` |
| RDN LDAP attribute | `cn` |
| UUID LDAP attribute | `objectGUID` |
| User object classes | `person, organizationalPerson, user` |
| User LDAP filter | `(&(mail=*)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))` — лише з поштою і не вимкнені |
| Synchronization | Periodic changed users sync: 3600 |

Натисніть **Test connection** і **Test authentication**, потім **Save** і
**Sync all users**.

Важливо: пошта в AD (`mail`) має збігатися з поштою, яку передає кадрова
система або ЄДЕБО. За нею месенджер знаходить людину під час першого входу.

Довірений сертифікат домену для LDAPS: покладіть `puet-ca.pem` поруч і додайте
до сервісу `keycloak` в `infra/single-server/docker-compose.server.yml`:

```yaml
    environment:
      KC_TRUSTSTORE_PATHS: /opt/keycloak/conf/truststores/puet-ca.pem
    volumes:
      - /etc/puet/tls/puet-ca.pem:/opt/keycloak/conf/truststores/puet-ca.pem:ro
```

### 6.3. Двофакторна автентифікація

Вона обов'язкова для ролей `SUPER_ADMIN`, `RECTORATE`, `INSTITUTE_DIRECTOR`,
`ADMIN_STAFF` (фінанси, кадри) і `TRUST_SERVICE_OFFICER`.

- Цим людям у Keycloak додайте **Required user actions → Configure OTP**. При
  наступному вході вони налаштують застосунок-автентифікатор.
- Для апаратних ключів (YubiKey тощо): Authentication → Required actions →
  увімкніть **Webauthn Register**, а у потоці `browser` → крок **WebAuthn
  Authenticator** → Alternative.
- Якщо таких людей багато, створіть в AD групу (наприклад, `Pulse-MFA`),
  підключіть її через LDAP group mapper і призначайте Configure OTP учасникам
  групи.

### 6.4. Вхід без пароля в мережі університету (за бажанням)

Якщо комп'ютери в домені, Keycloak може приймати вхід Kerberos (SPNEGO). Тоді
працівники входять без введення пароля. Налаштування описані в документації
Keycloak, розділ «Kerberos». Для привілейованих ролей другий фактор однаково
потрібен.

## 7. Інтеграції з системами університету

| Система | Що робити | Документ |
|---|---|---|
| Кадрова система | щоночі надсилати зміни працівників на `/api/integrations/hr/staff` | DEPLOYMENT.md, 3.6 |
| ЄДЕБО / Деканат | зміни студентів на `/api/integrations/edebo/students` | DEPLOYMENT.md, 3.6 |
| ERP (навантаження) | на початку семестру на `/api/integrations/teaching-load` | DEPLOYMENT.md, 3.6 |
| Звільнення, відрахування | одразу на `/api/integrations/offboarding` | DEPLOYMENT.md, 3.6 |
| ЕДО, розклад, Деканат (боти) | вебхуки й вихідні події | DEPLOYMENT.md, 3.4 |
| Шлюз КЕП (ІІТ EUSignCP) | встановити шлюз у внутрішній зоні, вказати `QES_GATEWAY_URL` | DEPLOYMENT.md, 3.4 |

Для кожної системи згенеруйте окремий ключ: `openssl rand -hex 32`. Додайте
його в `INTEGRATION_CLIENTS` у `/etc/puet/pulse.env` з переліком дозволених
типів даних. Видаліть клієнта `pilot`, щойно підключите справжні системи.
Поки адаптерів немає, людей можна завантажувати з файлів
(SERVER_SETUP.md, крок 12).

## 8. Моніторинг

Що стежити (Zabbix, Prometheus або Uptime Kuma):

| Перевірка | Як | Тривога |
|---|---|---|
| Месенджер працює | HTTP `https://pulse.puet.edu.ua/api/health` = 200 | 2 невдачі поспіль |
| Вхід працює | HTTP `https://<SSO>/realms/puet/.well-known/openid-configuration` = 200 | 2 невдачі поспіль |
| Сертифікат TLS | строк дії | менше 14 днів |
| Диск | `/var/lib/docker`, `/var/backups/puet` | понад 80% |
| Резервна копія | вік останньої теки в `/var/backups/puet` | старша за 26 годин |
| Контейнери | `docker compose ps` — усі healthy | будь-який unhealthy |
| Антивірус | ClamAV healthy, бази оновлювалися за 24 год | застарілі бази |
| API | `journalctl -u puet-pulse-api -p err` | помилки |

Журнал аудиту можна передавати в SIEM: `GET /api/admin/tenants/:tenantId/audit`.

## 9. Резервні копії і відновлення

1. Нічна копія: SERVER_SETUP.md, крок 15 (`backup.sh`).
2. Щоранку копіюйте теку `/var/backups/puet` на сховище резервних копій ПУЕТ,
   в іншому приміщенні:
   ```bash
   # /etc/cron.d/puet-offsite (сервер даних або варіант А)
   30 5 * * * root rsync -a --delete /var/backups/puet/ backup@nas.puet.local:/volume1/puet-pulse/
   ```
   Сховище має бути зашифрованим і доступним лише IT-центру: у копіях файли
   користувачів у відкритому вигляді.
3. Для бази з втратою не більше кількох хвилин налаштуйте pgBackRest з
   безперервним архівом WAL на те саме сховище.
4. Перед кожним оновленням робіть знімок (snapshot) віртуальної машини в
   гіпервізорі.
5. Ключ ЦСК (`/etc/puet/ca/ca.key.pem`) і файл налаштувань
   (`/etc/puet/pulse.env`) зберігайте ще й офлайн, на зашифрованому носії в
   сейфі.
6. **Раз на квартал перевіряйте відновлення** на тестовій машині: розгорніть
   з копії, увійдіть, відкрийте файл, перевірте ланцюжок аудиту.

## 10. Варіант Б: окремий сервер даних

### 10.1. Сервер даних

Підготуйте машину (розділ 5) і візьміть код (SERVER_SETUP.md, крок 6, без
`pnpm build`). Створіть налаштування (крок 7), вказавши адресу сервера
застосунку, а потім додайте внутрішню адресу сервера даних:

```bash
sudo sh infra/single-server/make-env.sh $PULSE $SSO $MEET
echo "DATA_BIND_IP=10.10.20.11" | sudo tee -a /etc/puet/pulse.env   # внутрішня адреса цього сервера
D="sudo docker compose --env-file /etc/puet/pulse.env -f docker-compose.yml \
   -f infra/single-server/docker-compose.server.yml -f infra/onprem/docker-compose.data.yml"
$D up -d postgres redis minio minio-init clamav
$D exec postgres createdb -U puet keycloak
$D up -d keycloak
```

Файрвол сервера даних (лише сервер застосунку, тут `10.10.10.11`):

```bash
sudo ufw default deny incoming
sudo ufw allow from <мережа IT-центру> to any port 22 proto tcp
for p in 5432 6379 9000 3310 8081; do sudo ufw allow from 10.10.10.11 to any port $p proto tcp; done
sudo ufw enable
```

Docker публікує порти в обхід `ufw`. Тому сервіси слухають лише внутрішню
адресу (`DATA_BIND_IP`), а мережевий файрвол ПУЕТ між зонами пропускає
трафік тільки від сервера застосунку.

### 10.2. Сервер застосунку

1. SERVER_SETUP.md, кроки 4–6 (система, Node.js, збирання). Docker тут не
   потрібен.
2. Скопіюйте `/etc/puet/pulse.env` з сервера даних (через `scp`, mode 640,
   root:puet-pulse). Замініть у ньому `127.0.0.1` на адресу сервера даних для
   `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `CLAMAV_HOST`:
   ```bash
   sudo sed -i 's/@127.0.0.1:/@10.10.20.11:/; s|http://127.0.0.1:9000|http://10.10.20.11:9000|; s/^CLAMAV_HOST=.*/CLAMAV_HOST=10.10.20.11/' /etc/puet/pulse.env
   ```
3. Міграції, структура, ЦСК: SERVER_SETUP.md, крок 8, без команд `$C`.
4. nginx і TLS: крок 9 і розділ 4. У `/etc/nginx/conf.d/pulse-extra.conf`
   замініть `127.0.0.1:8081` на `10.10.20.11:8081`.
5. Кроки 10–13 (Keycloak виконується на сервері даних командою `$D exec`).

### 10.3. Сервер дзвінків

Docker, потім:

```bash
docker run -d --name livekit --restart unless-stopped --network host \
  -e LIVEKIT_KEYS="<LIVEKIT_API_KEY>: <LIVEKIT_API_SECRET>" \
  -v /srv/livekit.yaml:/etc/livekit.yaml:ro livekit/livekit-server:v1.8.4 --config /etc/livekit.yaml
```

У `livekit.yaml` (за зразком `infra/livekit/livekit.yaml`) вебхук має вести
на `https://pulse.puet.edu.ua/api/calls/livekit/webhook`. nginx з TLS для
`meet.pulse.puet.edu.ua` — блок `meet` з `nginx-extra.conf`. У
`/etc/puet/pulse.env` сервера застосунку вкажіть `LIVEKIT_URL=https://meet.pulse.puet.edu.ua`
і перезапустіть API.

### 10.4. Перехід з варіанта А на Б

1. Повідомте користувачів про технічну перерву (30–60 хвилин).
2. На старому сервері зупиніть API (`sudo systemctl stop puet-pulse-api`) і
   зробіть резервну копію (`backup.sh`).
3. На новому сервері даних запустіть сервіси (10.1), відновіть бази
   (`pg_restore` для `puet_pulse` і `keycloak`) і файли (`mc mirror` у
   зворотний бік).
4. Перенесіть `/etc/puet` (налаштування, ЦСК, TLS) і налаштуйте сервер
   застосунку (10.2).
5. Перевірте вхід, файли й підписи. Тільки після цього вимкніть старий сервер.

## 11. Безпека перед запуском

- [ ] SSH лише за ключами, root-вхід вимкнено, доступ з мережі IT-центру.
- [ ] `unattended-upgrades` увімкнено на всіх машинах.
- [ ] Адмін-консоль Keycloak доступна лише з мережі IT-центру (`nginx-extra.conf`, `allow`).
- [ ] Тимчасового `kcadmin` замінено на персональних адміністраторів з TOTP.
- [ ] `/etc/puet/pulse.env` має mode 640, root:puet-pulse; `/etc/puet/ca` — лише puet-pulse.
- [ ] ssllabs.com показує A або A+.
- [ ] Резервна копія відновлена на тестовій машині хоча б раз.
- [ ] Незалежний тест на проникнення пройдено, критичні знахідки виправлено.
- [ ] Відповідальний за захист персональних даних погодив склад даних і строки зберігання.
- [ ] Регламент ЕДО ПУЕТ враховує статус УЕП внутрішніх підписів.

## 12. Хто що робить

| Роль | Завдання |
|---|---|
| Адміністратор серверів IT-центру | віртуальні машини, мережа, оновлення, резервні копії, моніторинг |
| Адміністратор домену | службовий обліковий запис LDAP, групи MFA, DNS, сертифікати |
| Адміністратор месенджера (`SUPER_ADMIN`) | структура, ролі, політики, журнал аудиту |
| Розробники інтеграцій | адаптери HR, ЄДЕБО, ERP, ЕДО до вебхуків месенджера |
| Відповідальний за захист персональних даних | погодження даних, строків, доступу |
