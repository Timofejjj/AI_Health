import os
import datetime
import time

import gspread
import markdown
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify
from google.oauth2.service_account import Credentials
from dateutil import parser, tz
import traceback


# --- GLOBAL VARS ---

app = Flask(__name__)

app.secret_key = os.urandom(24)

# --- MOSCOW_TZ ---
MOSCOW_TZ = tz.gettz('Europe/Moscow')

# --- MARKDOWN ---
# @app.template_filter('markdown')
def markdown_filter(s):
    return markdown.markdown(
        s, extensions=['fenced_code', 'tables']
    )

# --- ИНИЦИАЛИЗАЦИЯ GOOGLE & GEMINI ---
gemini_model = None

try:
    # Загружаем учетные данные
    GOOGLE_CREDS_INFO = json.loads(os.getenv("GOOGLE_CREDENTIALS_JSON"))
    GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID")
    if not GOOGLE_CREDS_INFO or not GOOGLE_SHEET_ID:
        raise ValueError("Необходимо установить переменные окружения GOOGLE_CREDENTIALS_JSON и GOOGLE_SHEET_ID")

    # Настройки Gemini API, если ключ доступен
    GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
    if GEMINI_API_KEY:
        import google.generativeai as genai

        genai.configure(api_key=GEMINI_API_KEY)
        gemini_model = genai.GenerativeModel("gemini-1.5-flash-latest")
        print("✅ Модель Gemini успешно загружена.")
    else:
        print("⚠️ Предупреждение: GEMINI_API_KEY не установлен. Анализ будет недоступен.")
except Exception as e:
    print(f"❌ Критическая ошибка при инициализации конфигурации: {e}")
    GOOGLE_CREDS_INFO = None

# --- ФУНКЦИИ-ПОМОЩНИКИ ДЛЯ GOOGLE SHEETS ---
def get_gspread_client():
    """Авторизовывает клиент gspread."""
    if not GOOGLE_CREDS_INFO:
        raise Exception("Учетные данные Google не были загружены.")

    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive"
    ]
    creds = Credentials.from_service_account_info(GOOGLE_CREDS_INFO, scopes=scopes)
    return gspread.authorize(creds)

def get_worksheet(worksheet_name):
    """Получает доступ к конкретному листу в Google Таблице."""
    try:
        gc = get_gspread_client()
        spreadsheet = gc.open_by_key(GOOGLE_SHEET_ID)
        return spreadsheet.worksheet(worksheet_name)
    except Exception as e:
        print(f"❌ Ошибка доступа к листу '{worksheet_name}': {e}")
        return None

def get_data_from_sheet(worksheet_name, user_id=None):
    """Получает все записи с листа или записи для конкретного пользователя."""
    worksheet = get_worksheet(worksheet_name)
    if not worksheet:
        return []

    try:
        records = worksheet.get_all_records()
        if not user_id:
            return records

        # Фильтруем записи по user_id, приводя оба значения к строке для надежности
        return [r for r in records if str(r.get("user_id")) == str(user_id)]
    except Exception as e:
        print(f"Ошибка чтения данных из листа '{worksheet_name}': {e}")
        return []

# --- ГЕНЕРАЦИЯ АНАЛИТИЧЕСКОГО ОТЧЕТА ---
def generate_analysis_report(thoughts, timer_logs, sports):
    """Создает промпт и генерирует отчет с помощью Gemini API."""
    if not gemini_model:
        return

    # Логика анализа недоступна. Проверьте конфигурацию GEMINI_API_KEY.
    # Формирование данных для промпта
    thoughts_text = "\n".join([
        f"- {parser.parse(t['timestamp']).astimezone(MOSCOW_TZ).strftime('%Y-%m-%d %H:%M')}: {t['content']}" for t in thoughts
    ]) or "Нет данных о мыслях"

    timer_text_parts = []
    for t in timer_logs:
        duration_min = round(int(t.get("duration_seconds", 0)) / 60)
        stimulus_level = t.get("stimulus_level_start", "н/д") + " → " + t.get("stimulus_level_end", "н/д")
        session_type = t.get("session_type", "Работа")
        task_name = t.get("task_name_raw", "Без названия") if session_type == "Работа" else session_type
        timer_text_parts.append(
            f"- {parser.parse(t['start_time']).astimezone(MOSCOW_TZ).strftime('%Y-%m-%d %H:%M')}: "
            f"{task_name} ({duration_min} мин, стимул: {stimulus_level})"
        )
    timer_text = "\n".join(timer_text_parts) or "Нет данных о рабочих сессиях."

    sports_text_parts = []
    for s in sports:
        duration_min = round(int(s.get("duration_seconds", 0)) / 60)
        sports_text_parts.append(
            f"- {parser.parse(s['start_time']).astimezone(MOSCOW_TZ).strftime('%Y-%m-%d %H:%M')}: "
            f"{s.get('name', 'Тренировка')} ({duration_min} мин)"
        )
    sports_text = "\n".join(sports_text_parts) or "Нет данных о спортивных активностях."

    # Промпт для Gemini
    # РОЛЬ И ЗАДАЧА
    prompt = f"""
Ты — персональный ассистент по производительности и благополучию. Твоя цель — предоставить глубокий "кросс-функциональный анализ" данных из трёх источников: ежедневные заметки/мысли (thoughts), когнитивной работы (рабочие сессии) и физической активности (спорт). Ты должен выявить скрытые связи и паттерны, дать конкретные, действенные рекомендации.

# ВХОДНЫЕ ДАННЫЕ

### 1. Журнал мыслей:
{thoughts_text}

### 2. Рабочие сессии и стимуляция:
{timer_text}

### 3. Спортивные активности:
{sports_text}

# КЛЮЧЕВЫЕ ДИРЕКТИВЫ АНАЛИЗА

### 1. **КРОСС-ФУНКЦИОНАЛЬНЫЙ СИНТЕЗ (ГЛАВНОЕ)**
- **Связь "Работа-Спорт"**: Найди корреляции между физической активностью и когнитивной производительностью. Утренняя пробежка повышает фокус перед работой? Данные сессии говорят про усталость вечером в дни тренировок?
- **Связь "Мысли-Работа/Спорт"**: Как содержание мыслей (тревога, мотивация) влияет на производительность и как занятия спортом влияют на ментальное состояние?
- **Стимул как индикатор**: Проанализируй динамику "уровня стимула". Что его повышает (кофе, музыка, спорт), а что истощает (длинные сессии без пауз, определённые задачи)?

- **Взаимосвязь производительности и энергии**:
- **Паттерн "Пик-Спад"**: Есть ли чёткие периоды максимальной и минимальной продуктивности? Что им предшествует (работа, спорт, отдых, определённые мысли)?
- **"Энергетический Отклик-Спорт"**: Оцени, насколько энергетический спад глубже и дольше по времени в выходные (много сверхурочной работы, мало спорта) в сравнении с предстоящими.

### 2. **АНАЛИЗ ПОВЕДЕНЧЕСКИХ ПЕТЕЛЬ**
- Выяви поведенческие циклы. **Пример**: "Тревожная мысль → Прокрастинация → Работа в стрессе и сверхурочно, но неэффективная работа → Мысли об усталости и неэффективности".

# СТРУКТУРА ОТВЕТА (используй Markdown)

### Комплексный анализ производительности

- **Основные выводы и паттерны (Кросс-анализ)**
- **Связь "Спорт-Работа"**: [Твой вывод о том, как спорт влияет на работу и наоборот]
- **Связь "Мысли-Деятельность"**: [Твой вывод о том, как мысли влияют на активность и наоборот]
- **Основной поведенческий цикл**: [Опиши выявленный тобой цикл поведения или его отсутствие]

### 2. Состояние
- **Корреляция усталости и энергии**
- **Продуктивность**: [Оцени общую продуктивность, выяви пики и спады]
- **Энергетический баланс**: [Оцени баланс работа/отдых/спорт, наличие признаков выгорания]

### 3. Комплексные рекомендации и Action Points
- **Action-Point #1 (Синтез)**: [Конкретный совет, связывающий спорт/работу/мысли. **Пример**: "Чтобы повысить утренний фокус после сна, попробуй 15-минутную пробежку..."]
- **Action-Point #2 (Оптимизация)**: [Совет по оптимизации рабочих процессов или отдыха на основе данных]
- **Action-Point #3 (Предотвращение)**: [Проактивный совет для предотвращения выгорания, стресса...]
"""
    try:
        response = gemini_model.generate_content(prompt)
        return response.text
    except Exception as e:
        traceback.print_exc()
        return f"Ошибка при генерации анализа: {e}"

# --- ГЛАВНЫЙ МАРШРУТ И АУТЕНТИФИКАЦИЯ ---
@app.route("/", methods=["GET", "POST"])
def login():
    """Страница входа в систему."""
    if request.method == "POST":
        # Простая аутентификация
        user_id = request.form.get("user_id")
        password = request.form.get("password")
        all_users = get_data_from_sheet("users")

        if not all_users:
            flash("Ошибка аутентификации. Сервис временно недоступен.", "danger")
            return render_template("login.html")

        user_found = next((user for user in all_users if str(user["user_id"]) == user_id and str(user["password"]) == password), None)

        if user_found:
            # Успешный вход
            return redirect(url_for("app_view", user_id=user_id))
        else:
            flash("Неверный ID или пароль.", "error")

    return render_template("login.html")

@app.route("/app/<user_id>")
def app_view(user_id):
    """Отображает главную страницу SPA-приложения."""
    now = datetime.datetime.now(MOSCOW_TZ)
    hour = now.hour
    greeting = "Доброе утро"
    if 4 <= hour < 12:
        greeting = "Доброе утро"
    elif 12 <= hour < 17:
        greeting = "Добрый день"
    elif 17 <= hour < 23:
        greeting = "Добрый вечер"
    else:
        greeting = "Доброй ночи"

    return render_template("app.html", user_id=user_id, greeting=greeting)

# --- Редиректы со старых URL на новый SPA-маршрут для обратной совместимости ---
@app.route("/dashboard/<user_id>")
@app.route("/dynamics/<user_id>")
@app.route("/thoughts/<user_id>")
@app.route("/analytics/<user_id>")
@app.route("/timer/<user_id>")
def redirect_to_app(user_id):
    return redirect(url_for("app_view", user_id=user_id))

# --- API ЭНДПОИНТЫ ---
@app.route("/api/thoughts/<user_id>", methods=["POST", "GET"])
def handle_thoughts(user_id):
    """API для работы с мыслями: получение списка и добавление новой."""
    if request.method == "POST":
        data = request.json
        thought = data.get("thought")
        if not thought:
            return jsonify({"status": "error", "message": "Пустая мысль"}), 400

        worksheet = get_worksheet("thoughts")
        if not worksheet:
            return jsonify({"status": "error", "message": "Лист недоступен"}), 503

        worksheet.append_row([str(user_id), datetime.now(timezone.utc).isoformat(), thought])
        return jsonify({"status": "success"})

    elif request.method == "GET":
        thoughts = get_data_from_sheet("thoughts", user_id)
        # Сортируем по дате, от новой к старой
        thoughts.sort(key=lambda x: parser.parse(x.get("timestamp", "1970-01-01T00:00:00Z")), reverse=True)
        return jsonify(thoughts)

@app.route("/api/analyses/<user_id>", methods=["GET"])
def get_analyses(user_id):
    """API для получения списка сгенерированных отчетов."""
    analyses = get_data_from_sheet("analyses", user_id)
    analyses.sort(key=lambda x: parser.parse(x.get("created_at", "1970-01-01T00:00:00Z")), reverse=True)
    return jsonify(analyses)

@app.route("/api/run_analysis/<user_id>", methods=["POST"])
def run_analysis(user_id):
    """API для запуска генерации аналитического отчета."""
    try:
        thoughts = get_data_from_sheet("thoughts", user_id)
        timer_logs = get_data_from_sheet("timer_logs", user_id)
        sports = get_data_from_sheet("sports_activity", user_id)
        if not thoughts and not timer_logs and not sports:
            return jsonify({"status": "info", "message": "Нет данных для анализа"})

        report = generate_analysis_report(thoughts, timer_logs, sports)
        if report:
            worksheet_analyses = get_worksheet("analyses")
            if worksheet_analyses:
                worksheet_analyses.append_row([
                    str(user_id),
                    datetime.now(timezone.utc).isoformat(),
                    report
                ])
            else: # Совместимость старой структуры
                 # ...
                pass
            return jsonify({"status": "success", "message": "Анализ завершен и сохранен"})
        else:
            return jsonify({"status": "error", "message": "Не удалось сгенерировать анализ"})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route("/api/log_session", methods=["POST"])
def log_session():
    """API для сохранения данных о рабочей сессии (примеры)."""
    try:
        data = request.json
        worksheet = get_worksheet("timer_logs")
        if not worksheet:
            return jsonify({"status": "error", "message": "Не удалось получить доступ к таблице логов"}), 500

        worksheet.append_row([
            str(data["user_id"]),
            str(data.get("task_name_raw", "")),
            str(data.get("task_name_normalized", "")),
            str(data.get("session_type", "Работа")),
            str(data.get("location", "")),
            "", # В будущем для geocoding and commitments
            parser.isoparse(data["start_time"]).astimezone(MOSCOW_TZ).strftime('%Y-%m-%d %H:%M'),
            parser.isoparse(data["end_time"]).astimezone(MOSCOW_TZ).strftime('%Y-%m-%d %H:%M'),
            int(data["duration_seconds"]),
            int(data.get("overtime_work", 0)),
            int(data.get("overtime_rest", 0)),
            data.get("stimulus_level_start", ""),
            data.get("stimulus_level_end", "")
        ])
        return jsonify({"status": "success"})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route("/api/log_sport_activity", methods=["POST"])
def log_sport_activity():
    data = request.json
    try:
        worksheet = get_worksheet("sports_activity")
        if not worksheet:
            return jsonify({"status": "error", "message": "Сервис недоступен"}), 500

        worksheet.append_row([
            str(data["user_id"]),
            str(data["name"]),
            parser.isoparse(data["start_time"]),
            parser.isoparse(data["end_time"]),
            int(data["duration_seconds"])
        ])
        return jsonify({"status": "success"})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500

@app.errorhandler(404)
def page_not_found(e):
    return render_template("404.html"), 404

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)), debug=True)
