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
    # Добавляем расширения для поддержки таблиц и блоков кода
    return markdown.markdown(s or '', extensions=['fenced_code', 'tables'])

try:
    # Устанавливаем русскую локаль для корректного отображения дат
    locale.setlocale(locale.LC_TIME, 'ru_RU.UTF-8')
except locale.Error:
    print("Предупреждение: Локаль 'ru_RU.UTF-8' не найдена. Даты могут отображаться некорректно.")

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
        print("⚠️  Предупреждение: GEMINI_API_KEY не установлен. Анализ и нормализация задач будут недоступны.")
except Exception as e:
    print(f"❌ ОШИБКА: Не удалось настроить Gemini: {e}")

# --- ФУНКЦИИ-ПОМОЩНИКИ ---
def get_dynamic_greeting():
    # Приветствие в зависимости от времени (по МСК)
    hour = (datetime.now(timezone.utc).hour + 3) % 24
    if 4 <= hour < 12: return "Доброе утро"
    if 12 <= hour < 17: return "Добрый день"
    if 17 <= hour < 22: return "Добрый вечер"
    return "Доброй ночи"

def get_data_from_sheet(worksheet, user_id):
    if not worksheet: return []
    try:
        records = worksheet.get_all_records()
        # Фильтруем записи по user_id
        return [r for r in records if str(r.get('user_id')) == str(user_id)]
    except Exception as e:
        print(f"Ошибка получения данных из листа '{worksheet.title}': {e}")
        return []

def normalize_task_name_with_ai(new_task_name, existing_tasks):
    """
    Использует ИИ для сопоставления новой задачи с существующими.
    Если похожая задача найдена, возвращает её. Иначе возвращает новую.
    """
    if not gemini_model or not existing_tasks:
        return new_task_name  # Если нет ИИ или существующих задач, возвращаем как есть

    # Превращаем список уникальных задач в нумерованный список для промпта
    existing_tasks_str = "\n".join(f"- {task}" for task in set(existing_tasks))
    
    prompt = f"""
        Проанализируй название новой задачи и список уже существующих.
        
        Новая задача: "{new_task_name}"

        Список существующих задач:
        {existing_tasks_str}

        Если новая задача по смыслу является дубликатом одной из существующих (например, "ML" и "Работа над ML проектом", "Дизайн" и "Создание дизайна"), верни точное название существующей задачи из списка.
        Если задача действительно новая и не похожа ни на одну из существующих, верни точное название новой задачи "{new_task_name}".
        Ответ должен содержать ТОЛЬКО одно название задачи и ничего больше.
    """
    try:
        response = gemini_model.generate_content(prompt)
        # Очищаем ответ от лишних символов, которые может добавить модель (markdown, и т.д.)
        normalized_name = response.text.strip().replace("*", "").replace("`", "")
        print(f"AI Normalization: '{new_task_name}' -> '{normalized_name}'")
        return normalized_name
    except Exception as e:
        print(f"Ошибка нормализации с помощью ИИ: {e}")
        return new_task_name  # В случае ошибки возвращаем исходное название

def get_last_analysis_timestamp(analyses):
    if not analyses: return None
    try:
        analyses.sort(key=lambda x: parser.parse(x.get('analysis_timestamp', '1970-01-01T00:00:00Z')), reverse=True)
        last = analyses[0].get('thoughts_analyzed_until')
        return parser.parse(last) if last else None
    except (parser.ParserError, TypeError) as e:
        print(f"Ошибка парсинга даты последнего анализа: {e}")
        return None

def get_new_data(records, last_time, time_key):
    if not records: return []
    if last_time is None: return records # Если анализа не было, берем все данные
    new_records = []
    for rec in records:
        ts_str = rec.get(time_key)
        if not ts_str: continue
        try:
            # Убедимся, что время в UTC для корректного сравнения
            record_time = parser.parse(ts_str).astimezone(timezone.utc)
            if record_time > last_time.astimezone(timezone.utc):
                new_records.append(rec)
        except (parser.ParserError, TypeError) as e:
            print(f"Невозможно распарсить дату: {ts_str}. Ошибка: {e}")
    return new_records

def generate_analysis_report(thoughts, timers):
    if not gemini_model: return "Модель анализа недоступна."
    if not thoughts and not timers: return "Нет новых данных для анализа."

    thoughts_text = "\n".join(f"[{parser.isoparse(t['timestamp']).strftime('%Y-%m-%d %H:%M')}] {t['content']}" for t in thoughts if t.get('timestamp')) or "Нет новых записей мыслей."
    
    timer_text = "Нет данных об активности."
    if timers:
        df = pd.DataFrame(timers)
        df['duration_minutes'] = (pd.to_numeric(df['duration_seconds'], errors='coerce').fillna(0) / 60).round(1)
        # Группируем по нормализованному имени задачи
        task_col = 'task_name_normalized' if 'task_name_normalized' in df.columns else 'task_name_raw'
        grouped_timers = df.groupby(task_col)['duration_minutes'].sum().reset_index()
        timer_text = "\n".join(f"- Задача: '{row[task_col]}', Суммарно: {row['duration_minutes']} мин" for _, row in grouped_timers.iterrows())
    
    prompt = f"""
# ЗАДАЧА
Ты — мой личный ассистент и коуч по продуктивности. Проведи глубокий, но сжатый анализ моих недавних мыслей и рабочей активности. Твоя цель — помочь мне отрефлексировать и найти полезные инсайты.

# КОНТЕКСТ
Я записал(а) свои мысли и отслеживал(а) время, потраченное на разные задачи.

# ВХОДНЫЕ ДАННЫЕ

## Мои мысли (дневник)
{thoughts_text}

## Моя активность (трекер времени)
{timer_text}

# ФОРМАТ ОТВЕТА
Предоставь анализ в формате Markdown. Будь кратким, структурированным и эмпатичным.

1.  **Главное за период:** Одно-два предложения. Какая основная тема или эмоция проходит красной нитью через все записи?
2.  **Связь мыслей и дел:** Есть ли пересечения между тем, о чем я думаю, и тем, над чем работаю? Может, мои мысли мешают или помогают работе?
3.  **Паттерны продуктивности:** Когда я был(а) наиболее продуктивен(а)? Есть ли повторяющиеся отвлекающие факторы или, наоборот, условия для потока?
4.  **Рекомендация:** Один конкретный, действенный совет. На что мне стоит обратить внимание в следующий раз?
"""
    try:
        resp = gemini_model.generate_content(prompt)
        return resp.text
    except Exception as e:
        print(f"Ошибка генерации анализа: {e}")
        return f"К сожалению, при генерации анализа произошла ошибка: {e}"

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
                    latest_timestamp = max(all_ts)
                    worksheet_analyses.append_row([str(user_id), datetime.now(timezone.utc).isoformat(), latest_timestamp.isoformat(), analysis_result])
                    flash("Новый анализ готов!", "success")
                else:
                    flash("Нет новых данных для создания анализа.", "info")
            else:
                flash("Нет новых данных для анализа.", "info")

        else: # Сохранение мысли
            thought = request.form.get('thought')
            if thought:
                worksheet_thoughts.append_row([str(user_id), datetime.now(timezone.utc).isoformat(), thought])
                flash("Мысль сохранена!", "success")
        
        # После любого POST-запроса делаем редирект, чтобы избежать повторной отправки формы
        return redirect(url_for('dashboard', user_id=user_id))
        
    # GET-запрос
    return render_template('dashboard.html', user_id=user_id, greeting=greeting, analysis_result=analysis_result)

@app.route('/thoughts/<user_id>')
def thoughts_list(user_id):
    thoughts = get_data_from_sheet(worksheet_thoughts, user_id)
    if thoughts:
        thoughts.sort(key=lambda x: parser.parse(x.get('timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    return render_template('thoughts.html', user_id=user_id, thoughts=thoughts)

@app.route('/analyses/<user_id>')
def analyses_list(user_id):
    analyses = get_data_from_sheet(worksheet_analyses, user_id)
    if analyses:
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
    if not request.is_json: return jsonify({'status': 'error', 'message': 'Invalid content type, expected application/json'}), 400
    data = request.json
    required_keys = ['user_id', 'task_name', 'start_time', 'end_time', 'duration_seconds']
    if not all(k in data for k in required_keys): 
        return jsonify({'status': 'error', 'message': f'Missing one or more required fields: {required_keys}'}), 400
    
    try:
        user_id = str(data['user_id'])
        new_task_name_raw = str(data['task_name']).strip()

        # Получаем список уже существующих НОРМАЛИЗОВАННЫХ задач для этого пользователя
        all_user_sessions = get_data_from_sheet(worksheet_timer_logs, user_id)
        existing_task_names = [row.get('task_name_normalized') for row in all_user_sessions if row.get('task_name_normalized')]

        # Нормализуем название с помощью ИИ
        normalized_task = normalize_task_name_with_ai(new_task_name_raw, existing_task_names)

        duration = int(data['duration_seconds'])
        row_to_append = [
            user_id,
            new_task_name_raw,     # task_name_raw
            normalized_task,       # task_name_normalized
            data['start_time'],
            data['end_time'],
            duration
        ]
        worksheet_timer_logs.append_row(row_to_append)
        return jsonify({'status': 'success', 'message': 'Session logged successfully.'})
    except Exception as e:
        print(f"Критическая ошибка при сохранении сессии: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/dynamics_data/<user_id>')
def get_dynamics_data(user_id):
    empty_response = {'calendars': {}, 'total_weeks': 0, 'activity_by_day': {'labels': [], 'data': []}, 'activity_by_hour': []}
    try:
        records = get_data_from_sheet(worksheet_timer_logs, user_id)
        if not records: return jsonify(empty_response)
        
        df = pd.DataFrame(records)
        df['start_time'] = pd.to_datetime(df['start_time'], errors='coerce')
        df.dropna(subset=['start_time'], inplace=True)
        if df.empty: return jsonify(empty_response)
        
        # Используем нормализованное название задачи, если оно есть, иначе исходное
        if 'task_name_normalized' in df.columns and df['task_name_normalized'].notna().any():
            df['task_name_normalized'].fillna(df.get('task_name_raw', ''), inplace=True)
            task_col = 'task_name_normalized'
        else:
            task_col = 'task_name_raw' if 'task_name_raw' in df.columns else 'task_name'
        
        # Календари
        unique_tasks = df[task_col].unique()
        calendars = {task: df[df[task_col] == task]['start_time'].dt.strftime('%Y-%m-%d').unique().tolist() for task in unique_tasks}
        
        # Активность
        df['date'] = df['start_time'].dt.date
        df['hour'] = df['start_time'].dt.hour
        df['duration_hours'] = pd.to_numeric(df['duration_seconds'], errors='coerce').fillna(0) / 3600
        
        first_day = df['start_time'].min().date()
        last_day = datetime.now(timezone.utc).date()
        total_weeks = max(1, (last_day - first_day).days // 7 + 1)
        
        # Активность по дням
        daily_activity = df.groupby('date')['duration_hours'].sum()
        all_days_range = pd.date_range(start=daily_activity.index.min(), end=daily_activity.index.max(), freq='D')
        daily_activity = daily_activity.reindex(all_days_range, fill_value=0)
        daily_labels = [d.strftime('%Y-%m-%d') for d in daily_activity.index]
        daily_data = daily_activity.round(2).tolist()

        return jsonify({
            'calendars': calendars,
            'total_weeks': total_weeks,
            'activity_by_day': {'labels': daily_labels, 'data': daily_data},
            'activity_by_hour': df[['start_time', 'hour', 'duration_hours']].to_dict('records') # Отдаем только нужные данные
        })
    except Exception as e:
        print(f"Критическая ошибка в /api/dynamics_data: {e}")
        return jsonify(empty_response), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', 8080)), debug=True)
