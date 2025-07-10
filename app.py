import os
import json
import locale
from datetime import datetime, timezone
import pandas as pd
import numpy as np
import gspread
import markdown
import google.generativeai as genai
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify
from google.oauth2.service_account import Credentials
from dateutil import parser, tz
import traceback

# --- КОНФИГУРАЦИЯ ---
app = Flask(__name__)
app.secret_key = os.urandom(24)
MOSCOW_TZ = tz.gettz('Europe/Moscow')

@app.template_filter('markdown')
def markdown_filter(s):
    return markdown.markdown(s or '', extensions=['fenced_code', 'tables'])

@app.template_filter('format_datetime')
def format_datetime(value):
    if not value: return ""
    try:
        utc_time = parser.isoparse(value)
        local_time = utc_time.astimezone(MOSCOW_TZ)
        return local_time.strftime('%Y-%m-%d %H:%M')
    except (ValueError, TypeError):
        return value

try:
    locale.setlocale(locale.LC_TIME, 'ru_RU.UTF-8')
except locale.Error:
    print("Предупреждение: Локаль 'ru_RU.UTF-8' не найдена.")

# --- ИНИЦИАЛИЗАЦИЯ СЕРВИСОВ ---
worksheet_thoughts = None
worksheet_analyses = None
worksheet_timer_logs = None
worksheet_users = None
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
    worksheet_users = spreadsheet.worksheet("users")
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
    if not gemini_model or not existing_tasks: return new_task_name
    unique_existing_tasks = sorted(list(set(existing_tasks)))
    existing_tasks_str = "\n".join(f"- {task}" for task in unique_existing_tasks)
    prompt = f"""Ты — умный ассистент-организатор. Твоя задача — проанализировать название новой задачи и сопоставить его со списком уже существующих.
**Новая задача:** "{new_task_name}"
**Список существующих задач:**
{existing_tasks_str}
**Инструкции:**
1. Внимательно проанализируй семантическое значение новой задачи.
2. Если новая задача по смыслу является дубликатом или очень близким синонимом одной из существующих, верни **точное название существующей задачи из списка**.
3. Если задача действительно новая и не похожа ни на одну из существующих, верни **точное название новой задачи**, то есть: "{new_task_name}".
**Формат ответа:**
Твой ответ должен содержать ТОЛЬКО одно название задачи и ничего больше."""
    try:
        response = gemini_model.generate_content(prompt)
        normalized_name = response.text.strip().replace("*", "").replace("`", "").replace("\"", "")
        if normalized_name in unique_existing_tasks: return normalized_name
        if normalized_name == new_task_name: return new_task_name
        print(f"AI Normalization Warning: Model returned '{normalized_name}' which is not in existing tasks. Reverting to original '{new_task_name}'.")
        return new_task_name
    except Exception as e:
        print(f"Ошибка нормализации с помощью ИИ: {e}")
        return new_task_name

def get_last_analysis_timestamp_utc(analyses):
    if not analyses: return None
    analyses.sort(key=lambda x: parser.parse(x.get('analysis_timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    last_utc_str = analyses[0].get('thoughts_analyzed_until')
    return parser.isoparse(last_utc_str) if last_utc_str else None

def get_new_data(records, last_time_utc, time_key, is_utc):
    if not records: return []
    if last_time_utc is None: return records
    new_records = []
    for rec in records:
        ts_str = rec.get(time_key)
        if not ts_str: continue
        try:
            record_time_utc = None
            if is_utc:
                record_time_utc = parser.isoparse(ts_str)
            else:
                naive_time = parser.parse(ts_str)
                local_time = naive_time.replace(tzinfo=MOSCOW_TZ)
                record_time_utc = local_time.astimezone(timezone.utc)
            if record_time_utc > last_time_utc: new_records.append(rec)
        except Exception as e:
            print(f"Невозможно распарсить дату: '{ts_str}' в ключе '{time_key}'. Ошибка: {e}")
    return new_records

def generate_analysis_report(thoughts, timers):
    if not gemini_model: return "Модель анализа недоступна."
    all_dates = []
    if thoughts:
        for t in thoughts:
            if t.get('timestamp'):
                try: all_dates.append(parser.isoparse(t['timestamp']))
                except (parser.ParserError, TypeError): pass
    if timers:
        for t in timers:
            if t.get('start_time'):
                try:
                    naive_time = parser.parse(t['start_time'])
                    local_time = naive_time.replace(tzinfo=MOSCOW_TZ)
                    all_dates.append(local_time.astimezone(timezone.utc))
                except (parser.ParserError, TypeError): pass
    date_range_str = "текущий период"
    if all_dates:
        min_date = min(all_dates).astimezone(MOSCOW_TZ)
        max_date = max(all_dates).astimezone(MOSCOW_TZ)
        if min_date.date() == max_date.date(): date_range_str = min_date.strftime('%d %B %Y г.')
        else: date_range_str = f"период с {min_date.strftime('%d %B')} по {max_date.strftime('%d %B %Y г.')}"
    thoughts_text = "\n".join(f"[{parser.isoparse(t['timestamp']).astimezone(MOSCOW_TZ).strftime('%Y-%m-%d %H:%M')}] {t['content']}" for t in thoughts if t.get('timestamp')) or "Нет новых записей мыслей."
    timer_text = "Нет данных об активности."
    if timers:
        df = pd.DataFrame(timers)
        df['start_time'] = pd.to_datetime(df['start_time'], errors='coerce')
        df['duration_minutes'] = (pd.to_numeric(df['duration_seconds'], errors='coerce').fillna(0) / 60).round(1)
        sessions_summary = []
        for index, row in df.iterrows():
            task_name_display = row.get('task_name_normalized', row.get('task_name_raw', 'N/A'))
            session_info = f"- Задача: '{task_name_display}', Длительность: {row['duration_minutes']} мин"
            if pd.notna(row.get('location')) and row.get('location') != '': session_info += f", Место: {row['location']}"
            if pd.notna(row.get('feeling_start')) and row.get('feeling_start') != '': session_info += f", Начало: {row['feeling_start']}"
            if pd.notna(row.get('feeling_end')) and row.get('feeling_end') != '': session_info += f", Конец: {row['feeling_end']}"
            sessions_summary.append(session_info)
        timer_text = "\n".join(sessions_summary)
    
    prompt = f"""
# РОЛЬ И ЗАДАЧА
Ты — мой когнитивный аналитик и стратегический коуч. Твоя главная задача — провести многофакторный анализ моих мыслей и рабочих сессий за указанный период. Цель — выявить скрытые причинно-следственные связи, спрогнозировать тренды и дать практические рекомендации.

# ВХОДНЫЕ ДАННЫЕ
- Анализируемый период: {date_range_str}
- Список мыслей с метками времени (в формате ГГГГ-ММ-ДД ЧЧ:ММ):
{thoughts_text}
- История рабочих сессий (таймеров):
{timer_text}

# КЛЮЧЕВЫЕ ДИРЕКТИВЫ

1.  **Выявление скрытых связей и паттернов**:
    *   Проанализируй, как темы в начале периода влияют на мысли в конце.
    *   Найди причинно-следственные связи между проблемами и идеями.
    *   Как продолжительность/частота сессий коррелирует с эмоциональным состоянием (например, тревога после долгих сессий) или качеством идей?
    *   Выяви циклы поведения, если они есть (например, "Тревога о дедлайне → марафонская сессия → убеждение 'Я должен работать больше'").

2.  **Анализ направленности мышления**:
    *   Определи основной вектор мышления: решение проблем, генерация идей, рефлексия, тревога и т.д.
    *   Оцени продуктивность сессий на основе данных: высокая, низкая, нестабильная?

3.  **ПРОГНОЗИРУЮЩИЙ КОУЧИНГ (ОСНОВНОЙ ФОКУС)**:
    *   **Конкретные советы**: Для каждой выявленной проблемы дай 1-2 практических решения с привязкой к рабочим сессиям. *Пример: "При тревоге X попробуй внедрить 3 сессии по 25 минут с 5-минутными перерывами, чтобы снизить когнитивную нагрузку."*
    *   **Фокус внимания**: Спрогнозируй 2-3 ключевые темы или задачи, на которых мне стоит сфокусироваться на следующей неделе.
    *   **Прогноз развития**: Опиши 3 сценария на ближайшие 1-2 недели:
        -   **📈 Оптимистичный**: Что произойдет, если я последую твоим советам и усилю полезные паттерны?
        -   **➡️ Нейтральный**: Что будет, если я продолжу действовать как сейчас?
        -   **📉 Пессимистичный**: Какие риски возникнут, если я буду игнорировать выявленные проблемы?
    *   **Идеальный график работы**: На основе анализа, какой график сессий (длительность, частота) был наиболее эффективным для меня? Дай рекомендацию.

# СТРУКТУРА ОТВЕТА (используй Markdown)

### Отчет по когнитивному анализу за {date_range_str}

**1. Скрытые связи и паттерны**
*   **Мысль ⇄ Мысль**: [Твоя находка о связи между мыслями]
*   **Сессия ⇄ Эмоция**: [Твоя находка о влиянии работы на состояние]
*   **Циклы поведения**: [Описание выявленного цикла или его отсутствия]

**2. Направленность мышления и продуктивность**
*   **Основной вектор**: [Направленность мышления]
*   **Продуктивность сессий**: [Оценка продуктивности]

**3. Рекомендации, предупреждения и прогноз**
*   **Практические советы**:
    *   *Проблема 1*: [Совет 1]
    *   *Проблема 2*: [Совет 2]
*   **Фокус на следующую неделю**: [Ключевые темы/задачи]
*   **Прогноз развития**:
    *   📈 **Оптимистичный**: [Описание]
    *   ➡️ **Нейтральный**: [Описание]
    *   📉 **Пессимистичный**: [Описание]
*   **Рекомендуемый график работы**: [Твоя рекомендация по расписанию]
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
        password = request.form.get('password')
        if not worksheet_users:
            flash("Сервис пользователей недоступен.", "danger")
            return render_template('login.html')
        users = worksheet_users.get_all_records()
        for user in users:
            if str(user.get('user_id')) == user_id and str(user.get('password')) == password:
                return redirect(url_for('dashboard', user_id=user_id))
        flash("Неверный ID или пароль.", "danger")
    return render_template('login.html')

@app.route('/dashboard/<user_id>', methods=['GET', 'POST'])
def dashboard(user_id):
    greeting = get_dynamic_greeting()
    analysis_result = None
    if request.method == 'POST':
        action = request.form.get('action')
        if action == 'analyze':
            try:
                thoughts = get_data_from_sheet(worksheet_thoughts, user_id)
                timers = get_data_from_sheet(worksheet_timer_logs, user_id)
                analyses = get_data_from_sheet(worksheet_analyses, user_id)
                last_ts_utc = get_last_analysis_timestamp_utc(analyses)
                new_thoughts = get_new_data(thoughts, last_ts_utc, 'timestamp', is_utc=True)
                new_timers = get_new_data(timers, last_ts_utc, 'start_time', is_utc=False)
                if new_thoughts or new_timers:
                    analysis_result = generate_analysis_report(new_thoughts, new_timers)
                    all_ts_utc = [parser.isoparse(t['timestamp']) for t in new_thoughts if t.get('timestamp')]
                    for t in new_timers:
                        if t.get('start_time'):
                            local_time = parser.parse(t['start_time']).replace(tzinfo=MOSCOW_TZ)
                            all_ts_utc.append(local_time.astimezone(timezone.utc))
                    if all_ts_utc:
                        latest_utc = max(all_ts_utc)
                        worksheet_analyses.append_row([str(user_id), datetime.now(timezone.utc).isoformat(), latest_utc.isoformat(), analysis_result])
                else: flash("Нет новых данных для анализа.", "success")
            except Exception as e:
                print(f"Критическая ошибка при анализе: {e}")
                flash(f"Произошла ошибка при анализе: {e}", "danger")
                return redirect(url_for('dashboard', user_id=user_id))
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
    required = ['user_id', 'task_name', 'start_time', 'end_time', 'duration_seconds', 'session_type']
    if not all(k in data for k in required): return jsonify({'status': 'error', 'message': f'Missing fields. Required: {required}'}), 400
    try:
        user_id = str(data['user_id'])
        session_type = data.get('session_type', '')
        task_name_raw = str(data['task_name'])
        start_time_utc = parser.isoparse(data['start_time'])
        end_time_utc = parser.isoparse(data['end_time'])
        start_time_local = start_time_utc.astimezone(MOSCOW_TZ)
        end_time_local = end_time_utc.astimezone(MOSCOW_TZ)
        start_time_str = start_time_local.strftime('%Y-%m-%d %H:%M:%S')
        end_time_str = end_time_local.strftime('%Y-%m-%d %H:%M:%S')
        
        normalized_task = task_name_raw
        if session_type == 'Работа':
            all_user_sessions = get_data_from_sheet(worksheet_timer_logs, user_id)
            existing_task_names = [row.get('task_name_raw') for row in all_user_sessions if row.get('task_name_raw')]
            normalized_task = normalize_task_name_with_ai(task_name_raw, existing_task_names)
        
        duration = int(data['duration_seconds'])
        feeling_start = data.get('feeling_start', '')
        feeling_end = data.get('feeling_end', '')
        location = data.get('location', '')
        
        row = [user_id, task_name_raw, normalized_task, session_type, location, feeling_start, feeling_end, start_time_str, end_time_str, duration]
        worksheet_timer_logs.append_row(row)
        return jsonify({'status': 'success'})
    except Exception as e:
        print(f"Ошибка сохранения сессии: {e}")
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/dynamics_data/<user_id>')
def get_dynamics_data(user_id):
    try:
        records = get_data_from_sheet(worksheet_timer_logs, user_id)
        empty_response = {'calendars': {}, 'total_weeks': 1, 'activity_by_day': {'labels': [], 'data': []}, 'work_sessions_list': []}
        if not records: return jsonify(empty_response)
        
        df = pd.DataFrame(records)
        if df.empty: return jsonify(empty_response)

        required_cols = ['start_time', 'end_time', 'session_type', 'duration_seconds']
        for col in required_cols:
            if col not in df.columns or df[col].isnull().all():
                return jsonify(empty_response)

        df['start_time'] = pd.to_datetime(df['start_time'], errors='coerce')
        df['end_time'] = pd.to_datetime(df['end_time'], errors='coerce')
        df.dropna(subset=['start_time', 'end_time'], inplace=True)
        if df.empty: return jsonify(empty_response)
        
        df['start_time_local'] = df['start_time'].dt.tz_localize(MOSCOW_TZ, ambiguous='infer', nonexistent='shift_forward')
        df['end_time_local'] = df['end_time'].dt.tz_localize(MOSCOW_TZ, ambiguous='infer', nonexistent='shift_forward')
        
        work_sessions = df[df['session_type'] == 'Работа'].copy()

        # Данные для календарей и графика дневной активности (только по рабочим сессиям)
        calendars = {}
        daily_data = []
        all_days_index = []
        weeks = 1
        if not work_sessions.empty:
            task_col = 'task_name_normalized' if 'task_name_normalized' in work_sessions.columns and not work_sessions['task_name_normalized'].isnull().all() else 'task_name_raw'
            if task_col not in work_sessions.columns: work_sessions[task_col] = "Без названия"
            work_sessions[task_col] = work_sessions[task_col].fillna('Без названия')

            calendars = {t: work_sessions[work_sessions[task_col]==t]['start_time_local'].dt.strftime('%Y-%m-%d').unique().tolist() for t in work_sessions[task_col].unique()}
            
            work_sessions['date'] = work_sessions['start_time_local'].dt.date
            work_sessions['duration_hours'] = pd.to_numeric(work_sessions['duration_seconds'], errors='coerce').fillna(0) / 3600
            
            first_date = work_sessions['start_time_local'].min().date()
            last_date = datetime.now(MOSCOW_TZ).date()
            weeks = max(1, (last_date - first_date).days // 7 + 1)
            
            daily = work_sessions.groupby('date')['duration_hours'].sum()
            all_days_range = pd.date_range(start=first_date, end=max(last_date, first_date), freq='D')
            daily = daily.reindex(all_days_range, fill_value=0)
            all_days_index = [d.strftime('%Y-%m-%d') for d in daily.index]
            daily_data = daily.tolist()

        # Данные для Gantt-графика (ВСЕ сессии: работа и перерывы)
        gantt_df = df.copy()
        
        task_col_for_gantt = 'task_name_normalized' if 'task_name_normalized' in gantt_df.columns and not gantt_df['task_name_normalized'].isnull().all() else 'task_name_raw'
        if task_col_for_gantt not in gantt_df.columns: gantt_df[task_col_for_gantt] = "Без названия"
        gantt_df[task_col_for_gantt] = gantt_df[task_col_for_gantt].fillna("Без названия")

        cols_to_get = [task_col_for_gantt, 'start_time_local', 'end_time_local', 'session_type', 'feeling_start', 'feeling_end']
        sessions_for_json = gantt_df[cols_to_get].copy()
        
        for col in ['feeling_start', 'feeling_end']:
            if col in sessions_for_json.columns:
                sessions_for_json[col] = sessions_for_json[col].fillna('')

        sessions_for_json.rename(columns={
            task_col_for_gantt: 'task_name',
            'start_time_local': 'start_time',
            'end_time_local': 'end_time'
        }, inplace=True)
        
        work_sessions_list = sessions_for_json.to_dict('records')
        
        return jsonify({
            'calendars': calendars,
            'total_weeks': weeks,
            'activity_by_day': {'labels': all_days_index, 'data': daily_data},
            'work_sessions_list': work_sessions_list
        })
    except Exception as e:
        print(f"Критическая ошибка в get_dynamics_data: {e}")
        traceback.print_exc()
        return jsonify(status="error", message=str(e)), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', 8080)))
