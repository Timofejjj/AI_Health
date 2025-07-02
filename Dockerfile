# Используем максимально легкий базовый образ
FROM python:3.11-slim

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем и устанавливаем наши легкие зависимости
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Копируем код нашего приложения
COPY . .

# Команда для запуска
CMD ["python", "bot.py"]
