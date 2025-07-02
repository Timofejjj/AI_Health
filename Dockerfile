# --- ЭТАП 1: СБОРКА ЗАВИСИМОСТЕЙ ---
# Мы используем полноценный образ python для установки, так как у него есть все нужные инструменты
FROM python:3.11-slim as builder

# Устанавливаем системные зависимости, необходимые для некоторых Python библиотек
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Создаем виртуальное окружение. Это стандартная лучшая практика.
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Устанавливаем зависимости в виртуальное окружение
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt


# --- ЭТАП 2: ФИНАЛЬНЫЙ ОБРАЗ ---
# Теперь мы берем максимально легкий образ за основу
FROM python:3.11-slim

# Устанавливаем только ffmpeg, без инструментов для сборки
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Копируем виртуальное окружение с уже установленными зависимостями из этапа сборки
COPY --from=builder /opt/venv /opt/venv

# Копируем код нашего приложения
COPY . .

# Указываем Python использовать наше виртуальное окружение
ENV PATH="/opt/venv/bin:$PATH"

# Команда для запуска нашего приложения
CMD ["python", "bot.py"]
