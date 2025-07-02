# Используем официальный образ Python
FROM python:3.11-slim

# Устанавливаем рабочую директорию внутри контейнера
WORKDIR /app

# Устанавливаем системные зависимости, включая ffmpeg
# RUN apt-get update && apt-get install -y ffmpeg
# ИЗМЕНЕНИЕ: Установка ffmpeg может быть сложной. Попробуем сначала без нее.
# Многие базовые образы уже могут содержать нужные библиотеки, либо ffmpeg-python подтянет статическую сборку.
# Если бот будет падать с ошибкой на ffmpeg, тогда раскомментируем строку ниже.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg

# Копируем файл с зависимостями
COPY requirements.txt .

# Устанавливаем зависимости Python
RUN pip install --no-cache-dir -r requirements.txt

# Копируем весь код нашего приложения в контейнер
COPY . .

# Команда для запуска нашего приложения
CMD ["python", "bot.py"]
