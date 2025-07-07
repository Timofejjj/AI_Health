import os
import json
import locale
from datetime import datetime, timezone
import pandas as pd
import gspread
import markdown
import google.generativeai as genai
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify
from google.oauth2.service_account import Credentials
from dateutil import parser

# --- КОНФИГУРАЦИЯ ---
app = Flask(__name__)
app.secret_key = os.urandom(24)

@app.template_filter('markdown')
def markdown_filter(s):
    return markdown.markdown(s or '', extensions=['fenced_code', 'tables'])

try:
    locale.setlocale(locale.LC_TIME, 'ru_RU.UTF-8')
except locale.Error:
    print("Предупреждение: Локаль 'ru_RU.UTF-8' не найдена.")

# --- ИНИЦИАЛИЗАЦИЯ СЕРВИСОВ ---
worksheet_thoughts = None
worksheet_analyses = None
worksheet_timer_logs = None
gemini_model = None

try:
    google_creds_json = os.getenv("GOOGLE_CREDENTIALS_JSON")
    sheet_id = os.getenv("GOOGLE_SHEET_ID")
    if not google_creds_json or not sheet_id:
        raise ValueError("Переменные окружения GOOGLE_CREDENTIALS_JSON и GOOGLE_SHEET_ID должны быть установлены.")

    creds_info = json.loads(google_creds_json)
    scopes = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]
    creds = Credentials.from_service_account_info(creds_info, scopes=scopes)
    gc = gspread.authorize(creds)
    spreadsheet = gc.open_by_key(sheet_id)
    worksheet_thoughts = spreadsheet.worksheet("thoughts")
    worksheet_analyses = spreadsheet.worksheet("analyses")
    worksheet_timer_logs = spreadsheet.worksheet("timer_logs")
    print("✅ Успешное подключение к Google Sheets.")
except Exception as e:
    print(f"❌ ОШИБКА: Не удалось подключиться к Google Sheets: {e}")

try:
    gemini_api_key = os.getenv("GEMINI_API_KEY")
    if gemini_api_key:
        genai.configure(api_key=gemini_api_key)
        gemini_model = genai.GenerativeModel('gemini-1.5-flash-latest')
        print("✅ Модель Gemini успешно настроена.")
    else:
        print("⚠️  Предупреждение: GEMINI_API_KEY не установлен. Анализ будет недоступен.")
except Exception as e:
    print(f"❌ ОШИБКА: Не удалось настроить Gemini: {e}")

# --- ФУНКЦИИ-ПОМОЩНИКИ ---
def get_dynamic_greeting():
    hour = (datetime.now(timezone.utc).hour + 3) % 24
    if 4 <= hour < 12: return "Доброе утро"
    if 12 <= hour < 17: return "Добрый день"
    return "Добрый вечер"

def get_data_from_sheet(worksheet, user_id):
    if not worksheet: return []
    try:
        records = worksheet.get_all_records()
        return [r for r in records if str(r.get('user_id')) == str(user_id)]
    except Exception as e:
        print(f"Ошибка получения данных из {worksheet.title}: {e}")
        return []

def normalize_task_name_with_ai(new_task_name, existing_tasks):
    """
    Использует ИИ для сопоставления новой задачи с существующими.
    Если похожая задача найдена, возвращает её. Иначе возвращает новую.
    """
    if not gemini_model or not existing_tasks:
        return new_task_name  # Если нет ИИ или существующих задач, возвращаем как есть

    # Превращаем список задач в нумерованный список для промпта
    existing_tasks_str = "\n".join(f"- {task}" for task in set(existing_tasks))
    
    prompt = f"""
        Проанализируй название новой задачи и список уже существующих.
        
        Новая задача: "{new_task_name}"

        Список существующих задач:
        {existing_tasks_str}

        Если новая задача по смыслу является дубликатом одной из существующих (например, "ML" и "Работа над ML проектом"), верни точное название существующей задачи из списка.
        Если задача действительно новая и не похожа ни на одну из существующих, верни точное название новой задачи "{new_task_name}".
        Ответ должен содержать ТОЛЬКО одно название задачи и ничего больше.
    """
    try:
        response = gemini_model.generate_content(prompt)
        # Очищаем ответ от лишних символов, которые может добавить модель
        normalized_name = response.text.strip().replace("*", "").replace("`", "")
        return normalized_name
    except Exception as e:
        print(f"Ошибка нормализации с помощью ИИ: {e}")
        return new_task_name  # В случае ошибки возвращаем исходное название

def get_last_analysis_timestamp(analyses):
    if not analyses: return None
    analyses.sort(key=lambda x: parser.parse(x.get('analysis_timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    last = analyses[0].get('thoughts_analyzed_until')
    return parser.parse(last) if last else None

def get_new_data(records, last_time, time_key):
    if not records: return []
    if last_time is None: return records
    new = []
    for rec in records:
        ts = rec.get(time_key)
        if not ts: continue
        try:
            if parser.parse(ts) > last_time: new.append(rec)
        except Exception: print(f"Невозможно распарсить дату: {ts}")
    return new

def generate_analysis_report(thoughts, timers):
    if not gemini_model: return "Модель анализа недоступна."
    if not thoughts and not timers: return "Нет новых данных для анализа."

    thoughts_text = "\n".join(f"[{parser.isoparse(t['timestamp']).strftime('%Y-%m-%d %H:%M')}] {t['content']}" for t in thoughts if t.get('timestamp')) or "Нет новых записей мыслей."
    
    if timers:
        df = pd.DataFrame(timers)
        df['start_time'] = pd.to_datetime(df['start_time'], errors='coerce')
        df['duration_minutes'] = (pd.to_numeric(df['duration_seconds'], errors='coerce').fillna(0) / 60).round(1)
        timer_text = "\n".join(f"- Задача: '{row['task_name']}', {row['duration_minutes']} мин" for _, row in df.iterrows())
    else:
        timer_text = "Нет данных об активности."
    
    prompt = f"""
# ЗАДАЧА
Провести комплексный анализ моих мыслей и рабочей активности.

# МЫСЛИ
{thoughts_text}

# АКТИВНОСТЬ
{timer_text}

# ОТВЕТ
1. Краткое резюме и главная тема
2. Связь между работой и мыслями
3. Паттерны продуктивности
4. Рекомендации
"""
    try:
        resp = gemini_model.generate_content(prompt)
        return resp.text
    except Exception as e:
        return f"Ошибка генерации анализа: {e}"

# --- МАРШРУТЫ ---
@app.route('/', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        user_id = request.form.get('user_id')
        if user_id: return redirect(url_for('dashboard', user_id=user_id))
    return render_template('login.html')

@app.route('/dashboard/<user_id>', methods=['GET', 'POST'])
def dashboard(user_id):
    greeting = get_dynamic_greeting()
    analysis_result = None
    if request.method == 'POST':
        action = request.form.get('action')
        if action == 'analyze':
            thoughts = get_data_from_sheet(worksheet_thoughts, user_id)
            timers = get_data_from_sheet(worksheet_timer_logs, user_id)
            analyses = get_data_from_sheet(worksheet_analyses, user_id)
            last_ts = get_last_analysis_timestamp(analyses)
            new_thoughts = get_new_data(thoughts, last_ts, 'timestamp')
            new_timers = get_new_data(timers, last_ts, 'start_time')
            if new_thoughts or new_timers:
                analysis_result = generate_analysis_report(new_thoughts, new_timers)
                all_ts = [parser.parse(t['timestamp']) for t in new_thoughts if t.get('timestamp')] + [parser.parse(t['start_time']) for t in new_timers if t.get('start_time')]
                if all_ts:
                    latest = max(all_ts)
                    worksheet_analyses.append_row([str(user_id), datetime.now(timezone.utc).isoformat(), latest.isoformat(), analysis_result])
        else:
            thought = request.form.get('thought')
            if thought:
                worksheet_thoughts.append_row([str(user_id), datetime.now(timezone.utc).isoformat(), thought])
                flash("Мысль сохранена!", "success")
            return redirect(url_for('dashboard', user_id=user_id))
    return render_template('dashboard.html', user_id=user_id, greeting=greeting, analysis_result=analysis_result)

@app.route('/thoughts/<user_id>')
def thoughts_list(user_id):
    thoughts = get_data_from_sheet(worksheet_thoughts, user_id)
    thoughts.sort(key=lambda x: parser.parse(x.get('timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    return render_template('thoughts.html', user_id=user_id, thoughts=thoughts)

@app.route('/analyses/<user_id>')
def analyses_list(user_id):
    analyses = get_data_from_sheet(worksheet_analyses, user_id)
    analyses.sort(key=lambda x: parser.parse(x.get('analysis_timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    return render_template('analyses.html', user_id=user_id, analyses=analyses)

@app.route('/timer/<user_id>')
def timer_page(user_id):
    task = request.args.get('task', 'Без названия')
    return render_template('timer.html', user_id=user_id, task_name=task)

@app.route('/dynamics/<user_id>')
def dynamics(user_id):
    return render_template('dynamics.html', user_id=user_id)

# --- API МАРШРУТЫ ---
@app.route('/api/log_session', methods=['POST'])
def log_timer_session():
    if not request.is_json: return jsonify({'status': 'error', 'message': 'Invalid content type'}), 400
    data = request.json
    required = ['user_id', 'task_name', 'start_time', 'end_time', 'duration_seconds']
    if not all(k in data for k in required): return jsonify({'status': 'error', 'message': f'Missing fields: {required}'}), 400
    
    try:
        user_id = str(data['user_id'])
        new_task_name = str(data['task_name'])

        # Получаем список уже существующих задач для этого пользователя
        all_user_sessions = get_data_from_sheet(worksheet_timer_logs, user_id)
        existing_task_names = [row.get('task_name_raw') for row in all_user_sessions if row.get('task_name_raw')]

        # Нормализуем название с помощью ИИ
        normalized_task = normalize_task_name_with_ai(new_task_name, existing_task_names)

        duration = int(data['duration_seconds'])
        row = [
            user_id,
            new_task_name,      # task_name_raw
            normalized_task,    # task_name_normalized
            data['start_time'],
            data['end_time'],
            duration
        ]
        worksheet_timer_logs.append_row(row)
        return jsonify({'status': 'success'})
    except Exception as e:
        print(f"Ошибка сохранения сессии: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/dynamics_data/<user_id>')
def get_dynamics_data(user_id):
    try:
        records = get_data_from_sheet(worksheet_timer_logs, user_id)
        empty = {'calendars': {}, 'total_weeks': 0, 'activity_by_day': {'labels': [], 'data': []}, 'activity_by_hour': []}
        if not records: return jsonify(empty)
        
        df = pd.DataFrame(records)
        df['start_time'] = pd.to_datetime(df['start_time'], errors='coerce')
        df.dropna(subset=['start_time'], inplace=True)
        if df.empty: return jsonify(empty)
        
        if 'session_type' not in df.columns: df['session_type'] = 'work'
        work = df[df['session_type'] == 'work'].copy()
        if work.empty: return jsonify(empty)

        task_col = 'task_name_raw' if 'task_name_raw' in work.columns else 'task_name'
        calendars = {t: work[work[task_col]==t]['start_time'].dt.strftime('%Y-%m-%d').unique().tolist() for t in work[task_col].unique()}
        
        work['date'] = work['start_time'].dt.date
        work['hour'] = work['start_time'].dt.hour
        work['duration_hours'] = pd.to_numeric(work['duration_seconds'], errors='coerce').fillna(0) / 3600
        
        first = work['start_time'].min().date()
        last = datetime.now(timezone.utc).date()
        weeks = max(1, (last - first).days // 7 + 1)
        
        daily = work.groupby('date')['duration_hours'].sum()
        if daily.empty:
            all_days_index = []
            daily_data = []
        else:
            all_days = pd.date_range(start=daily.index.min(), end=daily.index.max(), freq='D')
            daily = daily.reindex(all_days, fill_value=0)
            all_days_index = [d.strftime('%Y-%m-%d') for d in daily.index]
            daily_data = daily.tolist()

        return jsonify({
            'calendars': calendars,
            'total_weeks': weeks,
            'activity_by_day': {'labels': all_days_index, 'data': daily_data},
            'activity_by_hour': work.to_dict('records')
        })
    except Exception as e:
        print(f"Критическая ошибка: {e}")
        return jsonify(empty), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', 8080)))
