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
from dateutil import parser, tz

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
    if not gemini_model or not existing_tasks:
        return new_task_name
    unique_existing_tasks = sorted(list(set(existing_tasks)))
    existing_tasks_str = "\n".join(f"- {task}" for task in unique_existing_tasks)
    prompt = f"""
        Ты — умный ассистент-организатор. Твоя задача — проанализировать название новой задачи и сопоставить его со списком уже существующих.
        **Новая задача:** "{new_task_name}"
        **Список существующих задач:**
        {existing_tasks_str}
        **Инструкции:**
        1. Внимательно проанализируй семантическое значение новой задачи.
        2. Если новая задача по смыслу является дубликатом или очень близким синонимом одной из существующих, верни **точное название существующей задачи из списка**.
        3. Если задача действительно новая и не похожа ни на одну из существующих, верни **точное название новой задачи**, то есть: "{new_task_name}".
        **Формат ответа:**
        Твой ответ должен содержать ТОЛЬКО одно название задачи и ничего больше.
    """
    try:
        response = gemini_model.generate_content(prompt)
        normalized_name = response.text.strip().replace("*", "").replace("`", "").replace("\"", "")
        if normalized_name in unique_existing_tasks:
             return normalized_name
        else:
             if normalized_name == new_task_name:
                 return new_task_name
             print(f"AI Normalization Warning: Model returned '{normalized_name}' which is not in existing tasks. Reverting to original '{new_task_name}'.")
             return new_task_name
    except Exception as e:
        print(f"Ошибка нормализации с помощью ИИ: {e}")
        return new_task_name

def get_last_analysis_timestamp(analyses):
    if not analyses: return None
    analyses.sort(key=lambda x: parser.parse(x.get('analysis_timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    last_utc_str = analyses[0].get('thoughts_analyzed_until')
    # Функция теперь всегда возвращает "осведомленное" время в UTC
    return parser.isoparse(last_utc_str) if last_utc_str else None

def get_new_data(records, last_time_utc, time_key, is_utc):
    if not records: return []
    if last_time_utc is None: return records
    
    new_records = []
    local_tz = tz.gettz('Europe/Moscow')

    for rec in records:
        ts_str = rec.get(time_key)
        if not ts_str: continue
        
        try:
            record_time_utc = None
            if is_utc:
                record_time_utc = parser.isoparse(ts_str)
            else:
                naive_time = parser.parse(ts_str)
                local_time = naive_time.replace(tzinfo=local_tz)
                record_time_utc = local_time.astimezone(timezone.utc)
            
            if record_time_utc > last_time_utc:
                new_records.append(rec)
        except Exception as e:
            print(f"Невозможно распарсить дату: '{ts_str}' в ключе '{time_key}'. Ошибка: {e}")
    return new_records

def generate_analysis_report(thoughts, timers):
    if not gemini_model: return "Модель анализа недоступна."
    
    local_tz = tz.gettz('Europe/Moscow')
    thoughts_text = "\n".join(f"[{parser.isoparse(t['timestamp']).astimezone(local_tz).strftime('%Y-%m-%d %H:%M')}] {t['content']}" for t in thoughts if t.get('timestamp')) or "Нет новых записей мыслей."
    
    timer_text = "Нет данных об активности."
    if timers:
        df = pd.DataFrame(timers)
        df['start_time'] = pd.to_datetime(df['start_time'], errors='coerce')
        df['duration_minutes'] = (pd.to_numeric(df['duration_seconds'], errors='coerce').fillna(0) / 60).round(1)
        
        sessions_summary = []
        for index, row in df.iterrows():
            session_info = f"- Задача: '{row.get('task_name_normalized', 'N/A')}', Длительность: {row['duration_minutes']} мин"
            if pd.notna(row.get('location')) and row.get('location') != '':
                session_info += f", Место: {row['location']}"
            if pd.notna(row.get('feeling_start')) and row.get('feeling_start') != '':
                session_info += f", Начало: {row['feeling_start']}"
            if pd.notna(row.get('feeling_end')) and row.get('feeling_end') != '':
                session_info += f", Конец: {row['feeling_end']}"
            sessions_summary.append(session_info)
        timer_text = "\n".join(sessions_summary)

    prompt = f"""
# РОЛЬ И ЗАДАЧА  
Ты — мой когнитивный аналитик и стратегический коуч. Твоя главная задача — провести многофакторный анализ мыслей ({thoughts_text}) и рабочих сессий ({timer_text}) за все дни. Цель — выявить скрытые причинно-следственные связи, спрогнозировать тренды и дать практические рекомендации.

# ВХОДНЫЕ ДАННЫЕ  
- Полный список мыслей: {thoughts_text}  
- История рабочих сессий (таймеров): {timer_text}  

# КЛЮЧЕВЫЕ ДИРЕКТИВЫ  

1.  Выявление скрытых связей и паттернов:
    *   Анализируй, как темы в начале периода влияют на мысли в конце
    *   Ищи причинно-следственные связи между проблемами и идеями
    *   Отмечай повторяющиеся слова/метафоры
    *   1.3 Анализ влияния рабочих сессий:
        - Как продолжительность/частота сессий коррелирует с:  
          • Эмоциональным состоянием (тревога ⇄ продуктивность)  
          • Качеством идей (озарения после глубокой работы vs. выгорание)
    *   1.4 Выявление циклов:  
        - Существуют ли паттерны: проблема → рабочая сессия → новое убеждение?  
        - Пример: "Тревога о deadline → марафонская сессия → убеждение 'Я должен работать больше'"

2.  Структурный разбор мыслей:  
    *(Без изменений, но добавляй метки времени если есть в данных)*

3.  Анализ направленности мышления:  
    *(Дополни критерий: "продуктивный/непродуктивный" на основе данных таймеров)*

4.  ПРОГНОЗИРУЮЩИЙ КОУЧИНГ (ОСНОВНОЙ ФОКУС):
    *   Советы: Для каждой проблемы → 1-2 решения с привязкой к расписанию сессий  
        *Пример: "При тревоге X — внедрить технику Pomodoro (4 сессии по 25 мин)"*
    *   Фокус внимания: Спрогнозируй 3 ключевые темы на следующую неделю
    *   Мониторинг: Контрольные точки для проверки прогноза (напр.: "Если после 3 длинных сессий подряд появятся мысли Y — это сигнал")
    *   Прогноз: 3 сценария развития на 1-2 недели:  
        - Оптимистичный (если усилить полезные паттерны)  
        - Нейтральный (без изменений)  
        - Пессимистичный (при усугублении рисков)  
    *   4.5 Анализ эффективности сессий:  
        - Какие типы сессий генерируют прорывные идеи?  
        - Рекомендация по идеальному расписанию на основе исторических данных

# СТРУКТУРА ОТВЕТА  


### Отчет по когнитивному анализу за {date_range_str}
3. Скрытые связи и паттерны:
   *   Мысль ⇄ Мысль: [Связь 1]  
   *   Сессия ⇄ Эмоция: [Связь 2]  
       *Пример: "Сессии >3ч → учащение самокритики (+27%)"*
   *   3.3 Циклы поведения:  
       - [Выявленный цикл, напр.: "Избегание проблемы → авральные сессии → чувство вины"]

4. Направленность мышления:  
   [Вектор] + Продуктивность сессий: [Высокая/Низкая/Нестабильная]

5. Рекомендации, предупреждения и прогноз:
   *   Советы: С привязкой к таймерам  
       *Пример: "Проблема Y: запускать N-мин сессии с фокусом на Z"*
   *   Фокус внимания: Конкретные триггеры для мониторинга  
       *Пример: "Отслеживать мысли после вечерних сессий"*
   *   Прогноз: 3 сценария  
       - 📈 Оптимистичный: [Если сделать A]  
       - ➡️ Нейтральный: [Текущий путь]  
       - 📉 Пессимистичный: [Если игнорировать B]  
   *   5.5 Идеальный график работы:  
       [Рекомендуемое расписание сессий на основе паттернов]
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
            if str(user.get('user_id')) == user_id:
                if str(user.get('password')) == password:
                    return redirect(url_for('dashboard', user_id=user_id))
                else:
                    flash("Неверный ID или пароль.", "danger")
                    return render_template('login.html')
        flash("Неверный ID или пароль.", "danger")
        return render_template('login.html')
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
            
            last_ts_utc = get_last_analysis_timestamp(analyses)
            
            new_thoughts = get_new_data(thoughts, last_ts_utc, 'timestamp', is_utc=True)
            new_timers = get_new_data(timers, last_ts_utc, 'start_time', is_utc=False)

            if new_thoughts or new_timers:
                analysis_result = generate_analysis_report(new_thoughts, new_timers)
                
                all_ts_utc = [parser.isoparse(t['timestamp']) for t in new_thoughts if t.get('timestamp')]
                
                local_tz = tz.gettz('Europe/Moscow')
                for t in new_timers:
                    if t.get('start_time'):
                        local_time = parser.parse(t['start_time']).replace(tzinfo=local_tz)
                        all_ts_utc.append(local_time.astimezone(timezone.utc))

                if all_ts_utc:
                    latest_utc = max(all_ts_utc)
                    worksheet_analyses.append_row([str(user_id), datetime.now(timezone.utc).isoformat(), latest_utc.isoformat(), analysis_result])
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
    if not all(k in data for k in required): 
        return jsonify({'status': 'error', 'message': f'Missing fields. Required: {required}'}), 400
    
    try:
        user_id = str(data['user_id'])
        new_task_name = str(data['task_name'])
        
        local_tz = tz.gettz('Europe/Moscow')
        start_time_utc = parser.isoparse(data['start_time'])
        end_time_utc = parser.isoparse(data['end_time'])
        start_time_local = start_time_utc.astimezone(local_tz)
        end_time_local = end_time_utc.astimezone(local_tz)
        start_time_str = start_time_local.strftime('%Y-%m-%d %H:%M:%S')
        end_time_str = end_time_local.strftime('%Y-%m-%d %H:%M:%S')
        
        normalized_task = new_task_name
        if data['session_type'] == 'Работа':
            all_user_sessions = get_data_from_sheet(worksheet_timer_logs, user_id)
            existing_task_names = [row.get('task_name_raw') for row in all_user_sessions if row.get('task_name_raw')]
            normalized_task = normalize_task_name_with_ai(new_task_name, existing_task_names)

        duration = int(data['duration_seconds'])

        row = [
            user_id,
            new_task_name,
            normalized_task,
            data.get('session_type', ''),
            data.get('location', ''),
            data.get('feeling_start', ''),
            data.get('feeling_end', ''),
            start_time_str,
            end_time_str,
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
        empty = {'calendars': {}, 'total_weeks': 1, 'activity_by_day': {'labels': [], 'data': []}, 'activity_by_hour': []}
        if not records: 
            return jsonify(empty)
        
        df = pd.DataFrame(records)
        if df.empty: 
            return jsonify(empty)

        required_cols = ['start_time', 'duration_seconds', 'session_type']
        if not all(col in df.columns for col in required_cols):
            print(f"Ошибка: отсутствуют необходимые колонки в Google Sheet. Требуются: {required_cols}")
            return jsonify(empty)

        df['start_time'] = pd.to_datetime(df['start_time'], errors='coerce')
        df.dropna(subset=['start_time'], inplace=True)
        if df.empty: 
            return jsonify(empty)
        
        work_sessions = df[df['session_type'] == 'Работа'].copy()
        if work_sessions.empty:
            return jsonify(empty)

        local_tz = tz.gettz('Europe/Moscow')
        work_sessions.loc[:, 'start_time_local'] = work_sessions['start_time'].dt.tz_localize(local_tz, ambiguous='infer')

        task_col = 'task_name_normalized' if 'task_name_normalized' in work_sessions.columns else 'task_name_raw'
        if task_col not in work_sessions.columns:
            work_sessions.loc[:, task_col] = "Без названия"

        calendars = {t: work_sessions[work_sessions[task_col]==t]['start_time_local'].dt.strftime('%Y-%m-%d').unique().tolist() for t in work_sessions[task_col].unique()}
        
        work_sessions.loc[:, 'date'] = work_sessions['start_time_local'].dt.date
        work_sessions.loc[:, 'duration_hours'] = pd.to_numeric(work_sessions['duration_seconds'], errors='coerce').fillna(0) / 3600
        
        first_date = work_sessions['start_time_local'].min().date()
        last_date = datetime.now(local_tz).date()

        weeks = max(1, (last_date - first_date).days // 7 + 1)
        
        daily = work_sessions.groupby('date')['duration_hours'].sum()
        all_days_range = pd.date_range(start=first_date, end=max(last_date, first_date), freq='D')
        daily = daily.reindex(all_days_range, fill_value=0)
        all_days_index = [d.strftime('%Y-%m-%d') for d in daily.index]
        daily_data = daily.tolist()

        hourly_output = pd.DataFrame()
        hourly_output['date_str'] = work_sessions['start_time_local'].dt.strftime('%Y-%m-%d')
        hourly_output['hour'] = work_sessions['start_time_local'].dt.hour
        hourly_output['duration_hours'] = work_sessions['duration_hours']
        
        return jsonify({
            'calendars': calendars,
            'total_weeks': weeks,
            'activity_by_day': {'labels': all_days_index, 'data': daily_data},
            'activity_by_hour': hourly_output.to_dict('records')
        })
    except Exception as e:
        print(f"Критическая ошибка в get_dynamics_data: {e}")
        return jsonify(empty), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', 8080)))
