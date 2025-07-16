import os
import json
from datetime import datetime, timezone
import gspread
import markdown
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify
from google.oauth2.service_account import Credentials
from dateutil import parser, tz
import traceback

# --- КОНФИГУРАЦИЯ ---
app = Flask(__name__)
app.secret_key = os.urandom(24)
MOSCOW_TZ = tz.gettz('Europe/Moscow')

# --- ШАБЛОННЫЕ ФИЛЬТРЫ ---
@app.template_filter('markdown')
def markdown_filter(s):
    return markdown.markdown(s or '', extensions=['fenced_code', 'tables'])

@app.template_filter('format_datetime')
def format_datetime_filter(value):
    if not value: return ""
    try:
        utc_time = parser.isoparse(value)
        local_time = utc_time.astimezone(MOSCOW_TZ)
        return local_time.strftime('%d %B %Y, %H:%M')
    except (ValueError, TypeError):
        return value

# --- ИНИЦИАЛИЗАЦИЯ GOOGLE API ---
try:
    GOOGLE_CREDS_INFO = json.loads(os.getenv("GOOGLE_CREDENTIALS_JSON"))
    GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID")
    if not GOOGLE_CREDS_INFO or not GOOGLE_SHEET_ID:
        raise ValueError("Переменные окружения GOOGLE_CREDENTIALS_JSON и GOOGLE_SHEET_ID должны быть установлены.")
    
    gemini_api_key = os.getenv("GEMINI_API_KEY")
    if gemini_api_key:
        # genai.configure(api_key=gemini_api_key)
        # gemini_model = genai.GenerativeModel('gemini-1.5-flash-latest')
        print("API ключ Gemini найден, но инициализация модели закомментирована для экономии ресурсов.")
    else:
        print("⚠️  Предупреждение: GEMINI_API_KEY не установлен. Анализ будет недоступен.")
except Exception as e:
    print(f"❌ КРИТИЧЕСКАЯ ОШИБКА при инициализации конфигурации: {e}")
    GOOGLE_CREDS_INFO = None
    GOOGLE_SHEET_ID = None

# --- ФУНКЦИИ-ПОМОЩНИКИ ДЛЯ GOOGLE SHEETS ---
def get_gspread_client():
    if not GOOGLE_CREDS_INFO:
        raise Exception("Учетные данные Google не были загружены.")
    scopes = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]
    creds = Credentials.from_service_account_info(GOOGLE_CREDS_INFO, scopes=scopes)
    return gspread.authorize(creds)

def get_worksheet(worksheet_name):
    try:
        gc = get_gspread_client()
        spreadsheet = gc.open_by_key(GOOGLE_SHEET_ID)
        return spreadsheet.worksheet(worksheet_name)
    except Exception as e:
        print(f"❌ Ошибка доступа к листу '{worksheet_name}': {e}")
        traceback.print_exc()
        return None

def get_data_from_sheet(worksheet_name, user_id=None):
    worksheet = get_worksheet(worksheet_name)
    if not worksheet: return []
    try:
        records = worksheet.get_all_records()
        if not user_id: return records
        return [r for r in records if str(r.get('user_id')) == str(user_id)]
    except Exception as e:
        print(f"Ошибка чтения данных из листа {worksheet_name}: {e}")
        return []

# --- ГЛАВНЫЕ МАРШРУТЫ ---
@app.route('/', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        user_id = request.form.get('user_id')
        password = request.form.get('password')
        all_users = get_data_from_sheet("users")
        if not all_users:
            flash("Сервис аутентификации временно недоступен.", "danger")
            return render_template('login.html')
        user_found = next((user for user in all_users if str(user.get('user_id')) == user_id and str(user.get('password')) == password), None)
        if user_found:
            return redirect(url_for('app_view', user_id=user_id))
        else:
            flash("Неверный ID или пароль.", "danger")
    return render_template('login.html')

@app.route('/app/<user_id>')
def app_view(user_id):
    return render_template('app.html', user_id=user_id)


# --- API ЭНДПОИНТЫ ---

@app.route('/api/thoughts', methods=['POST'])
def add_thought(user_id):
    data = request.json
    thought = data.get('thought')
    if not thought:
        return jsonify({'status': 'error', 'message': 'Пустая мысль'}), 400
    
    worksheet = get_worksheet("thoughts")
    if not worksheet:
        return jsonify({'status': 'error', 'message': 'Сервис недоступен'}), 503
    
    worksheet.append_row([str(user_id), datetime.now(timezone.utc).isoformat(), thought])
    return jsonify({'status': 'success'}), 201

@app.route('/api/thoughts/<user_id>', methods=['GET'])
def get_thoughts(user_id):
    thoughts = get_data_from_sheet("thoughts", user_id)
    thoughts.sort(key=lambda x: parser.parse(x.get('timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    return jsonify(thoughts)

@app.route('/api/analyses/<user_id>', methods=['GET'])
def get_analyses(user_id):
    analyses = get_data_from_sheet("analyses", user_id)
    analyses.sort(key=lambda x: parser.parse(x.get('analysis_timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    return jsonify(analyses)


@app.route('/api/log_session', methods=['POST'])
def log_work_session():
    data = request.json
    try:
        worksheet = get_worksheet("timer_logs")
        if not worksheet:
             return jsonify({'status': 'error', 'message': 'Не удалось получить доступ к таблице логов'}), 500

        start_time_local = parser.isoparse(data['start_time']).astimezone(MOSCOW_TZ)
        end_time_local = parser.isoparse(data['end_time']).astimezone(MOSCOW_TZ)

        row = [
            str(data['user_id']),
            str(data.get('task_name_raw', '')),
            str(data.get('task_name_normalized', '')),
            str(data.get('session_type', 'Работа')),
            str(data.get('location', '')),
            "",  # feeling_start (больше не используется)
            "",  # feeling_end (больше не используется)
            start_time_local.strftime('%Y-%m-%d %H:%M:%S'),
            end_time_local.strftime('%Y-%m-%d %H:%M:%S'),
            int(data['duration_seconds']),
            int(data.get('overtime_work', 0)),
            int(data.get('overtime_rest', 0)),
            data.get('stimulus_level_start', ''),
            data.get('stimulus_level_end', '')
        ]
        worksheet.append_row(row)
        return jsonify({'status': 'success'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/log_sport_activity', methods=['POST'])
def log_sport_activity():
    data = request.json
    try:
        worksheet = get_worksheet("sports activity")
        if not worksheet:
             return jsonify({'status': 'error', 'message': 'Сервис недоступен'}), 500

        start_time_local = parser.isoparse(data['start_time']).astimezone(MOSCOW_TZ)
        end_time_local = parser.isoparse(data['end_time']).astimezone(MOSCOW_TZ)

        row = [
            str(data['user_id']),
            str(data['name']),
            start_time_local.strftime('%Y-%m-%d %H:%M:%S'),
            end_time_local.strftime('%Y-%m-%d %H:%M:%S'),
            int(data['duration_seconds'])
        ]
        worksheet.append_row(row)
        return jsonify({'status': 'success'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', 8080)), debug=True)
