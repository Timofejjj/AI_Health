# Используем легкий базовый образ
FROM python:3.11-slim

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем и устанавливаем зависимости
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Копируем код нашего приложения
COPY . .

# --- ВАЖНОЕ ИЗМЕНЕНИЕ ---
# Эта команда будет выполняться при запуске контейнера.
# Она использует переменную окружения $PORT, которую предоставляет Koyeb.
CMD gunicorn --worker-class uvicorn.workers.UvicornWorker --bind 0.0.0.0:$PORT bot:flask_app
