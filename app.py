import os
import json
import gspread
import google.generativeai as genai
from flask import Flask, render_template, request, redirect, url_for, flash
from datetime import datetime, timezone
from dateutil import parser
from google.oauth2.service_account import Credentials # Важный новый импорт

# --- КОНФИГУРАЦИЯ ---
app = Flask(__name__)
app.secret_key = os.urandom(24)

# --- Получение ключей и ID из переменных окружения Railway
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID")
# Эта переменная будет содержать ВЕСЬ текст из вашего файла credentials.json
GOOGLE_CREDENTIALS_JSON_STR = os.getenv("GOOGLE_CREDENTIALS_JSON")

# --- ИНИЦИАЛИЗАЦИЯ СЕРВИСОВ ---
worksheet_thoughts = None
worksheet_analyses = None

# НОВЫЙ, УНИВЕРСАЛЬНЫЙ СПОСОБ ИНИЦИАЛИЗАЦИИ GSPREAD ДЛЯ RAILWAY
try:
    if not GOOGLE_CREDENTIALS_JSON_STR:
        raise ValueError("Переменная окружения GOOGLE_CREDENTIALS_JSON не установлена.")
    
    # 1. Превращаем строку из переменной окружения обратно в словарь Python
    creds_info = json.loads(GOOGLE_CREDENTIALS_JSON_STR)
    
    # 2. Определяем права доступа, которые нужны нашему приложению
    scopes = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]
    
    # 3. Создаем объект учетных данных из словаря
    creds = Credentials.from_service_account_info(creds_info, scopes=scopes)
    
    # 4. Авторизуем gspread с помощью этих учетных данных
    gc = gspread.authorize(creds)
    
    # 5. Открываем нашу таблицу и листы
    spreadsheet = gc.open_by_key(GOOGLE_SHEET_ID)
    worksheet_thoughts = spreadsheet.worksheet("thoughts")
    worksheet_analyses = spreadsheet.worksheet("analyses")
    print("✅ Успешное подключение к Google Sheets через JSON из переменной окружения.")

except Exception as e:
    print(f"❌ ОШИБКА: Не удалось подключиться к Google Sheets: {e}")

# Инициализация Gemini остается без изменений
try:
    genai.configure(api_key=GEMINI_API_KEY)
    gemini_model = genai.GenerativeModel('gemini-1.5-flash-latest')
    print("✅ Модель Gemini успешно настроена.")
except Exception as e:
    print(f"❌ ОШИБКА: Не удалось настроить Gemini: {e}")
    gemini_model = None

# --- ФУНКЦИИ-ПОМОЩНИКИ (без изменений) ---

def get_data_from_sheet(worksheet, user_id):
    """Универсальная функция для получения данных пользователя из листа."""
    if not worksheet: return []
    try:
        all_records = worksheet.get_all_records()
        user_records = [row for row in all_records if str(row.get('user_id')) == str(user_id)]
        return user_records
    except Exception as e:
        print(f"Ошибка при чтении из листа '{worksheet.title}': {e}")
        return []

def get_last_analysis_timestamp(analyses):
    """Находит временную метку последней проанализированной мысли."""
    if not analyses:
        return None
    analyses.sort(key=lambda x: parser.parse(x.get('analysis_timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    last_analysis = analyses[0]
    return parser.parse(last_analysis['thoughts_analyzed_until'])

def get_new_thoughts(thoughts, last_analysis_time):
    """Фильтрует мысли, которые новее, чем последний анализ."""
    if last_analysis_time is None:
        return thoughts
    
    new_thoughts_list = [
        t for t in thoughts 
        if parser.parse(t.get('timestamp')) > last_analysis_time
    ]
    return new_thoughts_list

def generate_analysis_report(thoughts_list):
    """Генерирует отчет по списку мыслей."""
    if not gemini_model or not thoughts_list:
        return "Недостаточно данных или модель не настроена."

    full_text = "\n\n---\n\n".join([t['content'] for t in thoughts_list])
    
    prompt = f"""
# РОЛЬ И ЗАДАЧА
Ты — мой личный когнитивный аналитик. Твоя задача — провести глубокий анализ моих мыслей, зафиксированных с момента нашего последнего разговора.

# ВХОДНЫЕ ДАННЫЕ
Новые мысли для анализа:
{full_text}

# СТРУКТУРА ОТВЕТА
Предоставь свой анализ в лаконичном, но емком формате.

### Анализ новых мыслей

1. **Главная тема этого периода:** (В 1-2 предложениях опиши, что больше всего меня занимало)

2. **Ключевые инсайты и паттерны:**
    *   - (Выявленная проблема или тревога)
    *   - (Новая идея или озарение)
    *   - (Повторяющийся паттерн мышления)

3. **Практическая рекомендация:** (Один конкретный совет, что мне стоит сделать или о чем подумать дальше)
"""
    try:
        response = gemini_model.generate_content(prompt)
        return response.text
    except Exception as e:
        print(f"Ошибка при генерации отчета Gemini: {e}")
        return f"Не удалось сгенерировать отчет. Ошибка: {e}"

# --- МАРШРУТЫ (URL) ВЕБ-ПРИЛОЖЕНИЯ (без изменений) ---

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/dashboard/<user_id>', methods=['GET', 'POST'])
def dashboard(user_id):
    if not worksheet_thoughts or not worksheet_analyses:
        flash("Сервис временно недоступен: нет подключения к базе данных.", "error")
        return render_template('dashboard.html', user_id=user_id, thoughts=[], analyses=[])

    if request.method == 'POST':
        thought_content = request.form.get('thought')
        if thought_content:
            try:
                timestamp = datetime.now(timezone.utc).isoformat()
                worksheet_thoughts.append_row([str(user_id), timestamp, thought_content])
                flash("Мысль успешно сохранена!", "success")
            except Exception as e:
                flash(f"Не удалось сохранить мысль: {e}", "error")
        return redirect(url_for('dashboard', user_id=user_id))

    thoughts = get_data_from_sheet(worksheet_thoughts, user_id)
    analyses = get_data_from_sheet(worksheet_analyses, user_id)
    
    thoughts.sort(key=lambda x: parser.parse(x.get('timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    analyses.sort(key=lambda x: parser.parse(x.get('analysis_timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    
    return render_template('dashboard.html', user_id=user_id, thoughts=thoughts, analyses=analyses)

@app.route('/analyze/<user_id>', methods=['POST'])
def analyze(user_id):
    if not all([worksheet_thoughts, worksheet_analyses, gemini_model]):
        flash("Сервис анализа недоступен.", "error")
        return redirect(url_for('dashboard', user_id=user_id))

    all_thoughts = get_data_from_sheet(worksheet_thoughts, user_id)
    all_analyses = get_data_from_sheet(worksheet_analyses, user_id)

    last_analysis_time = get_last_analysis_timestamp(all_analyses)
    new_thoughts_to_analyze = get_new_thoughts(all_thoughts, last_analysis_time)

    if not new_thoughts_to_analyze:
        flash("Нет новых мыслей для анализа с момента последнего отчета.", "success")
        return redirect(url_for('dashboard', user_id=user_id))

    new_thoughts_to_analyze.sort(key=lambda x: parser.parse(x.get('timestamp')), reverse=True)
    latest_thought_timestamp = new_thoughts_to_analyze[0]['timestamp']

    report = generate_analysis_report(new_thoughts_to_analyze)
    
    try:
        analysis_timestamp = datetime.now(timezone.utc).isoformat()
        row_to_insert = [str(user_id), analysis_timestamp, latest_thought_timestamp, report]
        worksheet_analyses.append_row(row_to_insert)
        flash("Новый анализ успешно создан!", "success")
    except Exception as e:
        flash(f"Не удалось сохранить отчет: {e}", "error")

    return redirect(url_for('dashboard', user_id=user_id))

if __name__ == '__main__':
    # Railway автоматически предоставит переменную PORT
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', 8080)))