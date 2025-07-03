import os
import sqlite3
import google.generativeai as genai
from datetime import datetime, timedelta, timezone
import telegram
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
import logging
import asyncio
import threading
from flask import Flask, request
from deepgram import DeepgramClient, PrerecordedOptions

# --- 1. CONFIGURATION ---
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)
BOT_TOKEN = os.environ.get('BOT_TOKEN')
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY')
WEBHOOK_URL = os.environ.get('WEBHOOK_URL')
DEEPGRAM_API_KEY = os.environ.get('DEEPGRAM_API_KEY')
PORT = int(os.environ.get('PORT', 8000))

if not all([BOT_TOKEN, GEMINI_API_KEY, WEBHOOK_URL, DEEPGRAM_API_KEY]):
    logging.critical("CRITICAL ERROR: One or more environment variables are missing.")
    exit(1)

DAYS_TO_ANALYZE = 5
DB_NAME = 'user_messages.db'
AUDIO_DIR = 'audio_files'
os.makedirs(AUDIO_DIR, exist_ok=True)

# --- 2. SERVICE INITIALIZATION ---
genai.configure(api_key=GEMINI_API_KEY)
gemini_model = genai.GenerativeModel('gemini-1.5-flash-latest')
deepgram = DeepgramClient(DEEPGRAM_API_KEY)
# Создаем приложение, но не запускаем его здесь
application = Application.builder().token(BOT_TOKEN).build()
flask_app = Flask(__name__)
logging.info("All services initialized.")

# --- 3. FLASK ROUTES & WEBHOOK ---
@flask_app.route('/health')
def health_check():
    """Эндпоинт для UptimeRobot, чтобы бот не засыпал."""
    return "OK", 200

@flask_app.route(f'/{BOT_TOKEN}', methods=['POST'])
async def telegram_webhook() -> str:
    """Принимает обновления от Telegram и передает их в python-telegram-bot."""
    try:
        update_data = request.get_json(force=True)
        update = Update.de_json(data=update_data, bot=application.bot)
        await application.process_update(update)
        return "OK", 200
    except Exception as e:
        logging.error(f"Error processing webhook: {e}")
        return "Error", 500

# --- 4. TELEGRAM BOT HANDLERS ---
def setup_database():
    conn = sqlite3.connect(DB_NAME, check_same_thread=False)
    cursor = conn.cursor()
    cursor.execute('''CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, user_id INTEGER, timestamp DATETIME, content TEXT)''')
    conn.commit()
    conn.close()
    logging.info(f"Database '{DB_NAME}' is ready.")

async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
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
    user_id = update.message.from_user.id
    message_text = ""
    processing_message = await update.message.reply_text("🧠 Обрабатываю и сохраняю мысль...")
    if update.message.voice:
        ogg_path = None
        try:
            voice_file = await update.message.voice.get_file()
            ogg_path = os.path.join(AUDIO_DIR, f"{voice_file.file_id}.ogg")
            await voice_file.download_to_drive(ogg_path)
            with open(ogg_path, "rb") as audio: buffer_data = audio.read()
            payload = {"buffer": buffer_data}
            options = PrerecordedOptions(model="nova-2", smart_format=True, language="ru")
            response = await deepgram.listen.rest.v("1").transcribe_file(payload, options)
            if response.results and response.results.channels and response.results.channels[0].alternatives:
                message_text = response.results.channels[0].alternatives[0].transcript
                logging.info(f"Deepgram recognized: {message_text[:100]}...")
            else:
                logging.warning("Deepgram returned an empty result.")
                message_text = ""
        except Exception as e:
            logging.error(f"Error processing voice message: {e}")
            await processing_message.edit_text("❌ Не удалось обработать голосовое сообщение.")
            return
        finally:
            if ogg_path and os.path.exists(ogg_path): os.remove(ogg_path)
    elif update.message.text:
        message_text = update.message.text
        
    if message_text:
        try:
            conn = sqlite3.connect(DB_NAME, check_same_thread=False)
            cursor = conn.cursor()
            cursor.execute("INSERT INTO messages (user_id, timestamp, content) VALUES (?, ?, ?)", (user_id, datetime.now(timezone.utc), message_text))
            conn.commit()
            conn.close()
            await processing_message.edit_text("✅ Мысль сохранена.")
        except Exception as e:
            logging.error(f"DB save error: {e}")
            await processing_message.edit_text("❌ Внутренняя ошибка сохранения.")
    else:
        await processing_message.edit_text("⚠️ Речь не распознана.")

async def analyze_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.message.from_user.id
    await update.message.reply_text("⏳ Начинаю анализ ваших записей... Это может занять несколько минут.")
    
    end_date = datetime.now(timezone.utc)
    start_date = end_date - timedelta(days=DAYS_TO_ANALYZE)
    date_range_str = f"период с {start_date.strftime('%d.%m.%Y')} по {end_date.strftime('%d.%m.%Y')}"
    
    conn = sqlite3.connect(DB_NAME, check_same_thread=False)
    cursor = conn.cursor()
    cursor.execute("SELECT content FROM messages WHERE user_id = ? AND timestamp BETWEEN ? AND ?", (user_id, start_date, end_date))
    rows = cursor.fetchall()
    conn.close()

    if not rows:
        await update.message.reply_text(f"За последние {DAYS_TO_ANALYZE} дней не найдено записей.")
        return

    all_texts = [row[0] for row in rows]
    full_text = "\n\n---\n\n".join(reversed(all_texts))

    prompt = f"""
# РОЛЬ И ЗАДАЧА

Ты — мой личный когнитивный аналитик и стратегический коуч. Твоя главная задача — провести глубокий, многоуровневый анализ моих мыслей, зафиксированных в виде текстовых и голосовых сообщений за {DAYS_TO_ANALYZE} {'день' if DAYS_TO_ANALYZE == 1 else 'дней'}. Цель — помочь мне понять себя, выявить скрытые закономерности, отследить психологическое состояние и получить практические рекомендации.

# ВХОДНЫЕ ДАННЫЕ

**Анализируемый период:** {date_range_str}

**Транскрипты сообщений (от старых к новым):**
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
        response = await gemini_model.generate_content_async(prompt)
        summary = response.text
    except Exception as e:
        logging.error(f"Error calling Gemini API: {e}")
        await update.message.reply_text("❌ Ошибка генерации отчета.")
        return
    final_message = f"**🗓️ Ваш персональный отчет**\n*(Период: {date_range_str})*\n\n{summary}"
    try:
        if len(final_message) > 4096:
            for i in range(0, len(final_message), 4096): await update.message.reply_text(final_message[i:i+4096], parse_mode='Markdown')
        else: await update.message.reply_text(final_message, parse_mode='Markdown')
    except Exception as e:
        logging.error(f"Error sending message to Telegram: {e}")
        await update.message.reply_text("❌ Не удалось отправить отчет.")

# --- 5. MAIN APPLICATION LOGIC ---
async def initialize_bot():
    """Настраивает все, что нужно для работы бота, но не запускает его."""
    setup_database()
    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(CommandHandler("analyze", analyze_command))
    application.add_handler(MessageHandler(filters.TEXT | filters.VOICE, handle_text_or_voice))
    await application.bot.set_webhook(url=f"https://{WEBHOOK_URL}/{BOT_TOKEN}")
    logging.info("Telegram bot handlers and webhook are set.")

if __name__ == '__main__':
    # Инициализируем бота асинхронно
    loop = asyncio.get_event_loop()
    if loop.is_running():
        logging.warning("Asyncio loop is already running.")
    else:
        loop.run_until_complete(initialize_bot())
    
    # Запускаем Flask сервер, который будет основным процессом
    flask_app.run(host='0.0.0.0', port=PORT, debug=False)
