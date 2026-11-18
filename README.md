# Элементар · Планер — запуск на planer.elementaros.ru

Что внутри:

```
server.js            сервер (Node.js 18+, без зависимостей)
public/index.html    сам планер
.env.example         настройки: код дизайнера, код команды
deploy/planer.service  автозапуск через systemd
deploy/Caddyfile     HTTPS и домен через Caddy
```

Данные (задачи, комментарии, люди) хранятся в одном файле `data/db.json`. Бэкап — это просто копия этого файла.

## 1. DNS

У регистратора домена `elementaros.ru` добавь запись:

```
planer   A   <IP твоего VPS>
```

Подожди, пока запись начнёт отвечать: `ping planer.elementaros.ru` должен показать IP сервера.

## 2. Node.js и Caddy на сервере (Ubuntu/Debian)

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Caddy (сам выпускает и продлевает HTTPS-сертификат)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Если на сервере уже стоит nginx на 80/443 — смотри раздел «Если уже есть nginx» внизу.

## 3. Планер

```bash
sudo useradd --system --home /opt/planer --shell /usr/sbin/nologin planer
sudo mkdir -p /opt/planer
# скопируй содержимое архива в /opt/planer (например, scp с компьютера):
#   scp -r planer-site/* planer-site/.env.example root@<IP>:/opt/planer/
cd /opt/planer
sudo cp .env.example .env
sudo nano .env            # впиши DESIGNER_CODE и, если нужно, TEAM_CODE
sudo mkdir -p data
sudo chown -R planer:planer /opt/planer
sudo chmod 600 /opt/planer/.env

sudo cp deploy/planer.service /etc/systemd/system/planer.service
sudo systemctl daemon-reload
sudo systemctl enable --now planer
sudo systemctl status planer     # должно быть active (running)
```

## 4. Домен и HTTPS

```bash
sudo cp /opt/planer/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Открой https://planer.elementaros.ru — появится экран входа.

## 5. Первый вход

- Ты: имя и фамилия + **код дизайнера** из `.env`. Рядом с именем появится плашка «дизайнер».
- Бренд-менеджеры: имя и фамилия + **код команды** (если задан). Без регистрации.
- Один и тот же человек с одинаковым именем на разных устройствах — это один пользователь.

## Обновление

Заменяешь `public/index.html` и/или `server.js`, затем:

```bash
sudo systemctl restart planer
```

Данные в `data/` при этом не трогаются.

## Бэкап

```bash
sudo cp /opt/planer/data/db.json ~/planer-backup-$(date +%F).json
```

## Если уже есть nginx

Вместо Caddy добавь сайт в nginx (сертификат — через certbot):

```nginx
server {
  server_name planer.elementaros.ru;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection '';
    proxy_buffering off;          # нужно для живого обновления доски
    proxy_read_timeout 1h;
  }
}
```

```bash
sudo certbot --nginx -d planer.elementaros.ru
```

## Что важно знать

- Вход по имени без пароля: кто знает адрес и код команды, может войти под любым именем. Для команды внутри компании этого обычно хватает; если нужно строже — меняется на пароли.
- Если сменить `TEAM_CODE` в `.env` и перезапустить планер, всех бренд-менеджеров попросит войти заново (тебя — нет).
- Логи: `journalctl -u planer -f`.
