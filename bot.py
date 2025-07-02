import os
import sqlite3
import whisper
from pydub import AudioSegment
import google.generativeai as genai
from datetime import datetime, timedelta, timezone
import telegram
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
import logging

# --- НАСТРОЙКА ---

# Включаем логирование для отладки на сервере
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)

# Загрузка ключей из переменных окружения (для Render)
BOT_TOKEN = os.environ.get('BOT_TOKEN')
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY')
WEBHOOK_URL = os.environ.get('WEBHOOK_URL')

# Основные настройки
DAYS_TO_ANALYZE = 5
DB_NAME = 'user_messages.db'
AUDIO_DIR = 'audio_files'

# Создаем папку для временных аудиофайлов, если ее нет
os.makedirs(AUDIO_DIR, exist_ok=True)


# --- ИНИЦИАЛИЗАЦИЯ СЕРВИСОВ ---

# Проверка наличия ключей
if not BOT_TOKEN or not GEMINI_API_KEY or not WEBHOOK_URL:
    logging.error("КРИТИЧЕСКАЯ ОШИБКА: Один или несколько ключей (BOT_TOKEN, GEMINI_API_KEY, WEBHOOK_URL) не найдены в переменных окружения.")
    exit()

# Настройка Google Gemini
try:
    genai.configure(api_key=GEMINI_API_KEY)
    gemini_model = genai.GenerativeModel('gemini-1.5-flash-latest')
    logging.info("✅ Модель Gemini успешно настроена.")
except Exception as e:
    logging.error(f"❌ Ошибка конфигурации Gemini: {e}")
    gemini_model = None

# ВАЖНЫЙ КОМПРОМИСС: Используем легкую модель Whisper для работы на бесплатных серверах
logging.info("Загрузка модели Whisper (base)...")
try:
    whisper_model = whisper.load_model("base")
    logging.info("✅ Модель Whisper загружена.")
except Exception as e:
    logging.error(f"❌ Ошибка загрузки модели Whisper: {e}")
    whisper_model = None

# --- РАБОТА С БАЗОЙ ДАННЫХ ---

def setup_database():
    """Создает таблицу в базе данных, если она еще не существует."""
    # check_same_thread=False важно для работы с асинхронной библиотекой
    conn = sqlite3.connect(DB_NAME, check_same_thread=False)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            timestamp DATETIME NOT NULL,
            content TEXT NOT NULL
        )
    ''')
    conn.commit()
    conn.close()
    logging.info(f"✅ База данных '{DB_NAME}' готова к работе.")


# --- ОБРАБОТЧИКИ КОМАНД И СООБЩЕНИЙ ---

async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Отправляет приветственное сообщение при команде /start."""
    welcome_text = """
👋 Привет! Я HealthAI, ваш личный когнитивный аналитик.

📝 **Что я делаю?**
Я помогаю вам анализировать ваши мысли и эмоции. Просто отправляйте мне свои размышления, идеи или тревоги текстом или голосовыми сообщениями в течение дня.

🧠 **Как получить анализ?**
Когда будете готовы, просто отправьте команду /analyze, и я подготовлю для вас подробный отчет на основе ваших записей за последние 5 дней.

🔒 **Конфиденциальность**
Все ваши записи хранятся анонимно и доступны только вам для вашего личного анализа.
"""
    await update.message.reply_text(welcome_text)


async def handle_text_or_voice(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Сохраняет текстовое или голосовое сообщение пользователя в базу данных."""
    user_id = update.message.from_user.id
    message_text = ""
    processing_message = await update.message.reply_text("🧠 Обрабатываю и сохраняю мысль...")

    if update.message.voice:
        ogg_path, wav_path = None, None
        try:
            voice_file = await update.message.voice.get_file()
            ogg_path = os.path.join(AUDIO_DIR, f"{voice_file.file_id}.ogg")
            await voice_file.download_to_drive(ogg_path)
            
            wav_path = ogg_path.rsplit('.', 1)[0] + '.wav'
            AudioSegment.from_file(ogg_path).export(wav_path, format="wav")
            
            result = whisper_model.transcribe(wav_path, language="ru")
            message_text = result.get('text', '').strip()

        except Exception as e:
            logging.error(f"Ошибка обработки голосового сообщения: {e}")
            await processing_message.edit_text(f"❌ Не удалось обработать голосовое сообщение. Попробуйте снова.")
            return
        finally:
            # Очистка временных файлов
            if ogg_path and os.path.exists(ogg_path): os.remove(ogg_path)
            if wav_path and os.path.exists(wav_path): os.remove(wav_path)

    elif update.message.text:
        message_text = update.message.text

    if message_text:
        try:
            conn = sqlite3.connect(DB_NAME, check_same_thread=False)
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO messages (user_id, timestamp, content) VALUES (?, ?, ?)",
                (user_id, datetime.now(timezone.utc), message_text)
            )
            conn.commit()
            conn.close()
            await processing_message.edit_text("✅ Мысль сохранена. Для анализа отправьте /analyze")
        except Exception as e:
            logging.error(f"Ошибка сохранения в БД: {e}")
            await processing_message.edit_text(f"❌ Произошла внутренняя ошибка. Не удалось сохранить мысль.")


async def analyze_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Запускает анализ сообщений пользователя за последние N дней."""
    user_id = update.message.from_user.id
    await update.message.reply_text("⏳ Начинаю анализ ваших записей за последние 5 дней... Это может занять несколько минут.")

    end_date = datetime.now(timezone.utc)
    start_date = end_date - timedelta(days=DAYS_TO_ANALYZE)
    date_range_str = f"период с {start_date.strftime('%d.%m.%Y')} по {end_date.strftime('%d.%m.%Y')}"

    try:
        conn = sqlite3.connect(DB_NAME, check_same_thread=False)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT content FROM messages WHERE user_id = ? AND timestamp BETWEEN ? AND ?",
            (user_id, start_date, end_date)
        )
        rows = cursor.fetchall()
        conn.close()
    except Exception as e:
        logging.error(f"Ошибка чтения из БД для анализа: {e}")
        await update.message.reply_text("❌ Произошла ошибка при доступе к вашим данным.")
        return

    if not rows:
        await update.message.reply_text(f"За последние {DAYS_TO_ANALYZE} дней не найдено записей для анализа. Просто отправляйте мне свои мысли текстом или голосом.")
        return

    all_texts = [row[0] for row in rows]
    full_text = "\n\n---\n\n".join(all_texts)

    prompt = f"""
# РОЛЬ И ЗАДАЧА

Ты — мой личный когнитивный аналитик и стратегический коуч. Твоя главная задача — провести глубокий, многоуровневый анализ моих мыслей, зафиксированных в виде текстовых и голосовых сообщений за {DAYS_TO_ANALYZE} {'день' if DAYS_TO_ANALYZE == 1 else 'дней'}. Цель — помочь мне понять себя, выявить скрытые закономерности, отследить психологическое состояние и получить практические рекомендации.

# ВХОДНЫЕ ДАННЫЕ

**Анализируемый период:** {date_range_str}

**Транскрипты сообщений:**
{full_text}

# КЛЮЧЕВЫЕ ДИРЕКТИВЫ ДЛЯ АНАЛИЗА

Действуй строго по следующим инструкциям. Твой ответ должен быть структурирован в соответствии с форматом, указанным в конце.

1.  **Выявление скрытых связей и паттернов:**
    *   Анализируй, как темы, поднятые в начале периода, влияют на мысли в конце.
    *   Находи связи между моими проблемами и идеями. Например, не является ли какая-то идея попыткой подсознательно решить другую проблему?
    *   Отмечай повторяющиеся слова, метафоры, образы или темы в течение всего периода.

2.  **Структурный разбор мыслей:**
    *   Четко раздели все мои высказывания на четыре категории:
        *   **Проблемы и Тревоги:** Все, что вызывает у меня беспокойство, страх, недовольство, фрустрацию.
        *   **Идеи и Озарения:** Любые новые мысли, креативные решения, планы, гипотезы.
        *   **Собственные доводы и Убеждения:** Мои аргументы, объяснения своей позиции, ценности, которые я транслирую.
        *   **Факты и Наблюдения:** Объективные констатации, описания событий без эмоциональной окраски.

3.  **Анализ направленности мышления:**
    *   Оцени общий вектор моих мыслей за период. Он был: конструктивным, деструктивным, стагнирующим, сфокусированным, рассеянным, оптимистичным, пессимистичным? Обоснуй свой вывод.

4.  **Проактивный коучинг и прогнозирование (САМАЯ ВАЖНАЯ ЧАСТЬ):**
    *   **Советы:** Для каждой выявленной «Проблемы» предложи 1-2 конкретных, действенных совета по ее решению или изменению моего отношения к ней.
    *   **Фокус внимания:** Укажи, на какие мысли, идеи или паттерны мне стоит обратить особое внимание в ближайшие дни.
    *   **Мониторинг состояния (Критически важно):** Замечай признаки ухудшения моего состояния (например, рост тревожности, апатии, самокритики, безнадежности). Формулируй это мягко, но прямо. Например: «Я замечаю, что за эту неделю риторика самообвинения усилилась».
    *   **Прогноз:** Основываясь на анализе, дай прогноз. Ответь на вопрос: «Если я ничего не изменю и буду продолжать мыслить в том же духе, что вероятнее всего произойдет в ближайшие 1-2 недели?».

# СТРУКТУРА ОТВЕТА

Предоставь свой анализ в строго следующем формате, используя Markdown для форматирования.

---

### **Отчет по когнитивному анализу за {date_range_str}**

**1. Краткое резюме и главная тема периода:**
*(В 2-3 предложениях опиши ключевую мысль или эмоциональное состояние этого периода.)*

**2. Структурный анализ мыслей:**
*   **Проблемы и Тревоги:**
    *   - [Проблема 1]
    *   - [Проблема 2]
*   **Идеи и Озарения:**
    *   - [Идея 1]
    *   - [Идея 2]
*   **Собственные доводы и Убеждения:**
    *   - [Довод 1]
    *   - [Убеждение 1]
*   **Факты и Наблюдения:**
    *   - [Факт 1]

**3. Скрытые связи и паттерны:**
*   **Связь 1:** *(Например: «Утренняя тревога по поводу проекта Х напрямую связана с вечерней идеей о смене карьеры. Это защитный механизм.»)*
*   **Повторяющийся паттерн:** *(Например: «В течение дня 5 раз повторяется слово "должен", что указывает на сильное внутреннее давление.»)*

**4. Направленность мышления:**
*   **Общий вектор:** [Конструктивный/Деструктивный/и т.д.]
*   **Обоснование:** *(Почему ты так считаешь, с примерами из текста.)*

**5. Рекомендации, предупреждения и прогноз:**
*   **Советы по решению проблем:**
    *   **По Проблеме 1:** [Твой совет]
    *   **По Проблеме 2:** [Твой совет]
*   **На что обратить внимание в ближайшие дни:**
    *   [Твоя рекомендация]
*   **Мониторинг состояния:**
    *   [Твои наблюдения об ухудшении/улучшении моего состояния. Будь прямым, но деликатным.]
*   **Прогноз на 1-2 недели (если ничего не менять):**
    *   [Твой прогноз последствий текущего мыслительного тренда.]

**Важное напоминание:** Я являюсь языковой моделью и не могу заменить профессионального психолога или психотерапевта. Этот анализ предназначен для саморефлексии. Если ты чувствуешь серьезное ухудшение состояния, пожалуйста, обратись к специалисту.

---
"""
    try:
        response = gemini_model.generate_content(prompt)
        summary = response.text
    except Exception as e:
        logging.error(f"Ошибка при обращении к Gemini API: {e}")
        await update.message.reply_text("❌ Произошла ошибка при генерации отчета. Попробуйте позже.")
        return

    final_message = f"**🗓️ Ваш персональный отчет**\n*(Период: {date_range_str})*\n\n{summary}"

    # Отправка длинных сообщений по частям
    try:
        if len(final_message) > 4096:
            for i in range(0, len(final_message), 4096):
                await update.message.reply_text(final_message[i:i+4096], parse_mode='Markdown')
        else:
            await update.message.reply_text(final_message, parse_mode='Markdown')
    except Exception as e:
        logging.error(f"Ошибка отправки сообщения в Telegram: {e}")
        await update.message.reply_text("❌ Не удалось отправить отчет. Попробуйте запросить анализ снова.")


# --- ОСНОВНАЯ ФУНКЦИЯ ЗАПУСКА ---
def main():
    """Настраивает и запускает бота."""
    if not all([BOT_TOKEN, GEMINI_API_KEY, WEBHOOK_URL, gemini_model, whisper_model]):
        logging.critical("Запуск невозможен. Проверьте логи на предмет ошибок инициализации.")
        return

    setup_database()
    
    application = Application.builder().token(BOT_TOKEN).build()

    # Регистрация обработчиков
    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(CommandHandler("analyze", analyze_command))
    application.add_handler(MessageHandler(filters.TEXT | filters.VOICE, handle_text_or_voice))

    # Запускаем бота через webhook для работы на сервере
    # Порт 8000 является стандартным для многих платформ
    application.run_webhook(
        listen="0.0.0.0",
        port=8000,
        url_path=BOT_TOKEN,
        webhook_url=f"https://{WEBHOOK_URL}/{BOT_TOKEN}"
    )

if __name__ == '__main__':
    main()