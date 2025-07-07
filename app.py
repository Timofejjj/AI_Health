import os
import json
import gspread
import locale 
import pandas as pd
import google.generativeai as genai
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify
from datetime import datetime, timezone, timedelta
from dateutil import parser
from google.oauth2.service_account import Credentials

# --- КОНФИГУРАЦИЯ ---
app = Flask(__name__)
app.secret_key = os.urandom(24)

try:
    locale.setlocale(locale.LC_TIME, 'ru_RU.UTF-8')
except locale.Error:
    print("Предупреждение: Локаль 'ru_RU.UTF-8' не найдена. Даты могут отображаться на английском.")

# --- ИНИЦИАЛИЗАЦИЯ СЕРВИСОВ ---
worksheet_thoughts = None
worksheet_analyses = None
worksheet_timer_logs = None

try:
    if not os.getenv("GOOGLE_CREDENTIALS_JSON"):
        raise ValueError("Переменная окружения GOOGLE_CREDENTIALS_JSON не установлена.")
    
    creds_info = json.loads(os.getenv("GOOGLE_CREDENTIALS_JSON"))
    scopes = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]
    creds = Credentials.from_service_account_info(creds_info, scopes=scopes)
    gc = gspread.authorize(creds)
    spreadsheet = gc.open_by_key(os.getenv("GOOGLE_SHEET_ID"))
    worksheet_thoughts = spreadsheet.worksheet("thoughts")
    worksheet_analyses = spreadsheet.worksheet("analyses")
    worksheet_timer_logs = spreadsheet.worksheet("timer_logs")
    print("✅ Успешное подключение к Google Sheets.")
except Exception as e:
    print(f"❌ ОШИБКА: Не удалось подключиться к Google Sheets: {e}")

try:
    if os.getenv("GEMINI_API_KEY"):
        genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
        gemini_model = genai.GenerativeModel('gemini-1.5-flash-latest')
        print("✅ Модель Gemini успешно настроена.")
    else:
        gemini_model = None
        print("⚠️  Предупреждение: GEMINI_API_KEY не установлен. Анализ будет недоступен.")
except Exception as e:
    print(f"❌ ОШИБКА: Не удалось настроить Gemini: {e}")
    gemini_model = None


# --- ФУНКЦИИ-ПОМОЩНИКИ ---
def get_dynamic_greeting():
    hour = (datetime.now(timezone.utc).hour + 3) % 24 
    if 4 <= hour < 12: return "Доброе утро"
    if 12 <= hour < 17: return "Добрый день"
    if 17 <= hour < 23: return "Добрый вечер"
    return "Доброй ночи"

def get_data_from_sheet(worksheet, user_id):
    if not worksheet: return []
    try:
        all_records = worksheet.get_all_records()
        return [row for row in all_records if str(row.get('user_id')) == str(user_id)]
    except Exception as e:
        print(f"Ошибка получения данных из листа {worksheet.title}: {e}")
        return []

# ИСПРАВЛЕНИЕ: Функция стала более устойчивой к отсутствию данных
def get_last_analysis_timestamp(analyses):
    if not analyses: return None
    analyses.sort(key=lambda x: parser.parse(x.get('analysis_timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    # Проверяем, что запись существует и содержит непустое поле
    if 'thoughts_analyzed_until' in analyses[0] and analyses[0]['thoughts_analyzed_until']:
        return parser.parse(analyses[0]['thoughts_analyzed_until'])
    return None

def get_new_thoughts(thoughts, last_analysis_time):
    if last_analysis_time is None: return thoughts
    new_thoughts = []
    for t in thoughts:
        if t.get('timestamp'):
            try:
                if parser.parse(t['timestamp']) > last_analysis_time:
                    new_thoughts.append(t)
            except (parser.ParserError, TypeError):
                print(f"Предупреждение: не удалось разобрать дату для мысли: {t}")
    return new_thoughts

def generate_analysis_report(thoughts_list, timer_logs_list):
    if not gemini_model: return "Модель анализа недоступна, так как ключ API не настроен."
    if not thoughts_list and not timer_logs_list: return "Нет новых данных для анализа."

    full_text = "Нет новых записей мыслей за этот период."
    if thoughts_list:
        full_text = "\n".join([f"[{parser.isoparse(t['timestamp']).strftime('%Y-%m-%d %H:%M')}] {t['content']}" for t in thoughts_list])

    timer_summary = "Нет данных об активности за этот период."
    if timer_logs_list:
        df = pd.DataFrame(timer_logs_list)
        df['start_time'] = pd.to_datetime(df['start_time'], errors='coerce')
        df.dropna(subset=['start_time'], inplace=True)
        df['duration_seconds'] = pd.to_numeric(df['duration_seconds'], errors='coerce').fillna(0)
        df['duration_minutes'] = (df['duration_seconds'] / 60).round(1)
        
        summary_lines = []
        for _, row in df.iterrows():
            session_info = f"- Тип: {row['session_type']}, Задача: '{row.get('task_name', 'Без названия')}', Продолжительность: {row['duration_minutes']} мин, Время: {row['start_time'].strftime('%H:%M')}"
            summary_lines.append(session_info)
        timer_summary = "\n".join(summary_lines)

    prompt = f"""
# ЗАДАЧА
Ты — мой личный когнитивный аналитик. Твоя задача — провести комплексный анализ моих мыслей и журнала активности, чтобы выявить закономерности и дать рекомендации.
# ВХОДНЫЕ ДАННЫЕ
## 1. Мои текстовые мысли:
{full_text}
## 2. Журнал моей активности (Работа и Паузы):
{timer_summary}
# АНАЛИЗ И СТРУКТУРА ОТВЕТА
### 1. Группировка задач и главная тема периода:
*   **Сгруппируй задачи:** Внимательно изучи названия задач в журнале активности. Если видишь похожие по смыслу задачи (например, "Работа над ML", "ML-проект", "Обучение модели"), объедини их в одну логическую группу (например, "Проект по Машинному обучению"). Выведи сгруппированный список.
*   **Главный инсайт:** В 2-3 предложениях опиши ключевую мысль или эмоциональное состояние этого периода, синтезируя данные из мыслей и сгруппированной активности.
### 2. Связь между работой и мыслями:
Проанализируй, как темы работы коррелируют с темами размышлений. Например: "Я вижу, что ты много беспокоишься о 'Проекте X', но сессий по этой задаче не было. Это может быть признаком избегания".
### 3. Анализ паттернов продуктивности:
Оцени соотношение времени работы и пауз. Есть ли признаки выгорания (длинные, частые паузы), высокой концентрации (длинные рабочие сессии) или прокрастинации (короткая работа, затем длинная пауза)?
### 4. Рекомендации:
Дай 1-2 конкретных, действенных совета, основанных на твоем комплексном анализе.
"""
    try:
        response = gemini_model.generate_content(prompt)
        return response.text
    except Exception as e:
        return f"Ошибка при генерации отчета Gemini: {e}"

# --- МАРШРУТЫ (URL) ПРИЛОЖЕНИЯ ---

@app.route('/', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        user_id = request.form.get('user_id')
        if user_id:
            return redirect(url_for('dashboard', user_id=user_id))
    return render_template('login.html')

@app.route('/dashboard/<user_id>', methods=['GET', 'POST'])
def dashboard(user_id):
    greeting = get_dynamic_greeting()
    analysis_result = None

    if request.method == 'POST':
        action = request.form.get('action')
        if action == 'save_thought':
            thought_content = request.form.get('thought')
            if thought_content:
                try:
                    timestamp = datetime.now(timezone.utc).isoformat()
                    worksheet_thoughts.append_row([str(user_id), timestamp, thought_content])
                    flash("Мысль сохранена!", "success")
                except Exception as e:
                    flash(f"Ошибка сохранения: {e}", "error")
            return redirect(url_for('dashboard', user_id=user_id))

        elif action == 'analyze':
            all_thoughts = get_data_from_sheet(worksheet_thoughts, user_id)
            all_timer_logs = get_data_from_sheet(worksheet_timer_logs, user_id)
            all_analyses = get_data_from_sheet(worksheet_analyses, user_id)
            
            last_analysis_time = get_last_analysis_timestamp(all_analyses)
            
            new_thoughts = get_new_thoughts(all_thoughts, last_analysis_time)
            new_timer_logs = [log for log in all_timer_logs if log.get('start_time') and (last_analysis_time is None or parser.parse(log['start_time']) > last_analysis_time)]
            
            if new_thoughts or new_timer_logs:
                analysis_result = generate_analysis_report(new_thoughts, new_timer_logs)
                try:
                    analysis_timestamp = datetime.now(timezone.utc).isoformat()
                    
                    # ИСПРАВЛЕНИЕ: Безопасный поиск максимальной даты
                    all_new_timestamps = []
                    if new_thoughts:
                        all_new_timestamps.extend(parser.parse(t['timestamp']) for t in new_thoughts if t.get('timestamp'))
                    if new_timer_logs:
                        all_new_timestamps.extend(parser.parse(l['start_time']) for l in new_timer_logs if l.get('start_time'))

                    if all_new_timestamps:
                        latest_ts = max(all_new_timestamps)
                        worksheet_analyses.append_row([str(user_id), analysis_timestamp, latest_ts.isoformat(), analysis_result])
                    else:
                        # Эта ветка теперь маловероятна, но остается для надежности
                        flash("Не найдено новых данных для сохранения отметки времени анализа.", "error")
                except Exception as e:
                    flash(f"Не удалось сохранить отчет анализа: {e}", "error")
            else:
                analysis_result = "Нет новых мыслей или рабочих сессий для анализа."

    return render_template('dashboard.html', user_id=user_id, greeting=greeting, analysis_result=analysis_result)

@app.route('/timer/<user_id>')
def timer(user_id):
    return render_template('timer.html', user_id=user_id, task_name=request.args.get('task', 'Без названия'))

@app.route('/dynamics/<user_id>')
def dynamics(user_id):
    return render_template('dynamics.html', user_id=user_id)

@app.route('/api/log_session', methods=['POST'])
def log_timer_session():
    if not request.is_json:
        return jsonify({'status': 'error', 'message': 'Invalid content type'}), 400
    
    data = request.json
    required_fields = ['user_id', 'session_type', 'task_name', 'start_time', 'end_time', 'duration_seconds']
    if not all(field in data for field in required_fields):
        return jsonify({'status': 'error', 'message': 'Missing data fields'}), 400

    try:
        duration = int(data.get('duration_seconds'))
        if duration < 1:
            return jsonify({'status': 'ok', 'message': 'Session too short'})
        
        worksheet_timer_logs.append_row([
            str(data.get('user_id')),
            str(data.get('session_type')),
            str(data.get('task_name')),
            str(data.get('start_time')),
            str(data.get('end_time')),
            duration
        ])
        return jsonify({'status': 'success'})
    except Exception as e:
        print(f"Ошибка сохранения сессии в Google Sheets: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

# ИСПРАВЛЕНИЕ: Усилена защита от пустых и некорректных данных
@app.route('/api/dynamics_data/<user_id>')
def get_dynamics_data(user_id):
    try:
        records = get_data_from_sheet(worksheet_timer_logs, user_id)
        if not records:
            return jsonify({'total_weeks': 0, 'activity_by_day': {'labels': [], 'data': []}, 'activity_by_hour': []})

        df = pd.DataFrame(records)
        df['start_time'] = pd.to_datetime(df['start_time'], errors='coerce')
        df['duration_seconds'] = pd.to_numeric(df['duration_seconds'], errors='coerce').fillna(0)
        df.dropna(subset=['start_time'], inplace=True)

        if df.empty:
            return jsonify({'total_weeks': 0, 'activity_by_day': {'labels': [], 'data': []}, 'activity_by_hour': []})

        work_df = df[df['session_type'] == 'work'].copy()
        if work_df.empty:
             return jsonify({'total_weeks': 0, 'activity_by_day': {'labels': [], 'data': []}, 'activity_by_hour': []})

        work_df.loc[:, 'date'] = work_df['start_time'].dt.date
        work_df.loc[:, 'hour'] = work_df['start_time'].dt.hour
        work_df.loc[:, 'duration_hours'] = work_df['duration_seconds'] / 3600

        first_day = work_df['start_time'].min().date()
        last_day = datetime.now(timezone.utc).date()
        total_weeks = max(1, (last_day - first_day).days // 7 + 1)
        
        daily_activity = work_df.groupby('date')['duration_hours'].sum()
        
        if not daily_activity.empty:
            all_days = pd.date_range(start=daily_activity.index.min(), end=daily_activity.index.max(), freq='D')
            daily_activity = daily_activity.reindex(all_days.date, fill_value=0)
        
        return jsonify({
            'total_weeks': total_weeks,
            'activity_by_day': {
                'labels': daily_activity.index.strftime('%Y-%m-%d').tolist() if not daily_activity.empty else [],
                'data': daily_activity.values.tolist() if not daily_activity.empty else []
            },
            'activity_by_hour': work_df.to_dict('records')
        })
    except Exception as e:
        print(f"Критическая ошибка в /api/dynamics_data: {e}")
        return jsonify({'total_weeks': 0, 'activity_by_day': {'labels': [], 'data': []}, 'activity_by_hour': []}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', 8080)))
