# Dashboard — Аналитика списаний

## Деплой на Railway (5 минут)

### 1. Загрузите код на GitHub
1. [github.com](https://github.com) → New repository → `dashboard` → Create
2. Загрузите все файлы из этой папки

### 2. Деплой на Railway
1. [railway.app](https://railway.app) → Login with GitHub
2. New Project → Deploy from GitHub repo → выберите `dashboard`

### 3. Установите пароли (обязательно!)
Railway → Settings → Variables → добавьте:
```
ADMIN_PASSWORD = пароль_администратора
VIEW_PASSWORD  = пароль_для_просмотра
```

### 4. Получите ссылку
Railway → Settings → Domains → Generate Domain

---

## Пароли по умолчанию
| Роль | Пароль | Что может |
|------|--------|-----------|
| Просмотр | `view2026` | Открыть дашборд, смотреть данные |
| Администратор | `admin2026` | Всё + загружать и удалять периоды |

**Обязательно смените пароли через переменные Railway!**

---

## Локальный запуск
```bash
npm install
node server.js
# http://localhost:3000
```

## Структура
```
├── server.js        — API сервер
├── package.json
├── railway.json
├── public/
│   └── index.html   — дашборд
└── data/
    └── periods.json — данные (создаётся автоматически)
```
