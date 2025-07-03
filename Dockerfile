# Используем легкий базовый образ
FROM python:3.11-slim

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем и устанавливаем зависимости
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Копируем код нашего приложения
COPY . .

# --- ФИНАЛЬНАЯ И ПРАВИЛЬНАЯ КОМАНДА ЗАПУСКА ---
# Эта форма ("exec form" с shell-оберткой) гарантирует, что переменная $PORT
# будет правильно подставлена средой выполнения Koyeb.
CMD ["/bin/sh", "-c", "gunicorn -w 1 -k uvicorn.workers.UvicornWorker -b 0.0.0.0:$PORT bot:api"]
