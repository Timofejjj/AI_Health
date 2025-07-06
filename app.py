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

# --- Получение ключей и ID из переменных окружения ---
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID")
GOOGLE_CREDENTIALS_JSON_STR = os.getenv("GOOGLE_CREDENTIALS_JSON")


# --- ИНИЦИАЛИЗАЦИЯ СЕРВИСОВ ---
worksheet_thoughts = None
worksheet_analyses = None
worksheet_timer_logs = None

try:
    if not GOOGLE_CREDENTIALS_JSON_STR:
        raise ValueError("Переменная окружения GOOGLE_CREDENTIALS_JSON не установлена.")
    
    creds_info = json.loads(GOOGLE_CREDENTIALS_JSON_STR)
    scopes = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]
    creds = Credentials.from_service_account_info(creds_info, scopes=scopes)
    gc = gspread.authorize(creds)
    spreadsheet = gc.open_by_key(GOOGLE_SHEET_ID)
    worksheet_thoughts = spreadsheet.worksheet("thoughts")
    worksheet_analyses = spreadsheet.worksheet("analyses")
    worksheet_timer_logs = spreadsheet.worksheet("timer_logs")
    print("✅ Успешное подключение ко всем листам Google Sheets.")
except Exception as e:
    print(f"❌ ОШИБКА: Не удалось подключиться к Google Sheets: {e}")

try:
    genai.configure(api_key=GEMINI_API_KEY)
    gemini_model = genai.GenerativeModel('gemini-1.5-flash-latest')
    print("✅ Модель Gemini успешно настроена.")
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

def get_last_analysis_timestamp(analyses):
    if not analyses: return None
    analyses.sort(key=lambda x: parser.parse(x.get('analysis_timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    # Убедимся, что в поле 'thoughts_analyzed_until' есть данные
    if 'thoughts_analyzed_until' in analyses[0] and analyses[0]['thoughts_analyzed_until']:
        return parser.parse(analyses[0]['thoughts_analyzed_until'])
    return None

def get_new_thoughts(thoughts, last_analysis_time):
    if last_analysis_time is None: return thoughts
    return [t for t in thoughts if parser.parse(t.get('timestamp')) > last_analysis_time]

def generate_analysis_report(thoughts_list, timer_logs_list, start_date_of_period):
    if not gemini_model: return "Модель анализа недоступна."
    if not thoughts_list and not timer_logs_list: return "Нет новых данных для анализа."

    # Форматирование мыслей
    full_text = "Нет новых записей мыслей за этот период."
    if thoughts_list:
        full_text = "\n\n---\n\n".join([f"[{parser.isoparse(t['timestamp']).strftime('%Y-%m-%d %H:%M')}] {t['content']}" for t in thoughts_list])

    # Форматирование логов таймера
    timer_summary = "Нет данных о рабочих сессиях за этот период."
    if timer_logs_list:
        df = pd.DataFrame(timer_logs_list)
        df['start_time'] = pd.to_datetime(df['start_time'])
        # Убедимся что колонка 'duration_seconds' существует и имеет числовой тип
        if 'duration_seconds' in df.columns:
            df['duration_seconds'] = pd.to_numeric(df['duration_seconds'], errors='coerce').fillna(0)
            df['duration_minutes'] = (df['duration_seconds'] / 60).round(1)
            timer_lines = []
            for index, row in df.iterrows():
                timer_lines.append(
                    f"- Задача: '{row['task_name_raw']}', "
                    f"Начало: {row['start_time'].strftime('%Y-%m-%d %H:%M')}, "
                    f"Продолжительность: {row['duration_minutes']} мин."
                )
            timer_summary = "\n".join(timer_lines)

    # ВАШ ПРОМПТ ЗДЕСЬ. Он должен использовать переменные full_text и timer_summary
    prompt = f"""
# РОЛЬ И ЗАДАЧА
Ты — мой личный когнитивный аналитик и стратегический коуч. Твоя задача — провести комплексный анализ моих мыслей и моей рабочей активности, чтобы помочь мне выявить закономерности и получить рекомендации.

# ВХОДНЫЕ ДАННЫЕ

## 1. Мои текстовые мысли и заметки
{full_text}

## 2. Журнал моей рабочей активности (сессии таймера)
{timer_summary}

# КЛЮЧЕВЫЕ ДИРЕКТИВЫ ДЛЯ АНАЛИЗА
1.  **Синтез данных:** Проанализируй **ОБА** источника данных. Свяжи мои рабочие сессии с моими мыслями. Например, работал ли я над тем, о чем беспокоился? Были ли у меня продуктивные идеи во время или после определенных рабочих сессий? Есть ли корреляция между темами работы и темами моих размышлений?
2.  **Выявление паттернов:** Найди повторяющиеся темы как в мыслях, так и в задачах. Укажи на возможное избегание каких-либо задач, если это видно из логов.
3.  **Оценка состояния:** Основываясь на содержании мыслей (тревога, оптимизм, усталость) и характере работы (прокрастинация, фокус, многозадачность), дай общую оценку моего состояния за этот период.
4.  **Практические рекомендации:** Дай 1-2 конкретных совета, основанных на твоем анализе. Например: "Я заметил, что ты много беспокоишься о 'Проекте X', но не выделяешь на него время в таймере. Попробуй запланировать короткую 25-минутную сессию именно на него, чтобы снизить тревогу".

# СТРУКТУРА ОТВЕТА
# РОЛЬ И ЗАДАЧА

Ты — мой личный когнитивный аналитик и стратегический коуч. Твоя главная задача — провести глубокий, многоуровневый анализ моих мыслей, зафиксированных в виде текстовых и голосовых сообщений за {DAYS_TO_ANALYZE} {'день' if DAYS_TO_ANALYZE == 1 else 'дней'}. Цель — помочь мне понять себя, выявить скрытые закономерности, отследить психологическое состояние и получить практические рекомендации.

# ВХОДНЫЕ ДАННЫЕ

Анализируемый период: {date_range_str}

Транскрипты сообщений:
{full_text}

# КЛЮЧЕВЫЕ ДИРЕКТИВЫ ДЛЯ АНАЛИЗА

Действуй строго по следующим инструкциям. Твой ответ должен быть структурирован в соответствии с форматом, указанным в конце.

1.  Выявление скрытых связей и паттернов:
    *   Анализируй, как темы, поднятые в начале периода, влияют на мысли в конце.
    *   Находи связи между моими проблемами и идеями. Например, не является ли какая-то идея попыткой подсознательно решить другую проблему?
    *   Отмечай повторяющиеся слова, метафоры, образы или темы в течение всего периода.

2.  Структурный разбор мыслей:
    *   Четко раздели все мои высказывания на четыре категории:
        *   Проблемы и Тревоги: Все, что вызывает у меня беспокойство, страх, недовольство, фрустрацию.
        *   Идеи и Озарения: Любые новые мысли, креативные решения, планы, гипотезы.
        *   Собственные доводы и Убеждения: Мои аргументы, объяснения своей позиции, ценности, которые я транслирую.
        *   Факты и Наблюдения: Объективные констатации, описания событий без эмоциональной окраски.

3.  Анализ направленности мышления:
    *   Оцени общий вектор моих мыслей за период. Он был: конструктивным, деструктивным, стагнирующим, сфокусированным, рассеянным, оптимистичным, пессимистичным? Обоснуй свой вывод.

4.  Проактивный коучинг и прогнозирование (САМАЯ ВАЖНАЯ ЧАСТЬ):
    *   Советы: Для каждой выявленной «Проблемы» предложи 1-2 конкретных, действенных совета по ее решению или изменению моего отношения к ней.
    *   Фокус внимания: Укажи, на какие мысли, идеи или паттерны мне стоит обратить особое внимание в ближайшие дни.
    *   Мониторинг состояния (Критически важно): Замечай признаки ухудшения моего состояния (например, рост тревожности, апатии, самокритики, безнадежности). Формулируй это мягко, но прямо. Например: «Я замечаю, что за эту неделю риторика самообвинения усилилась».
    *   Прогноз: Основываясь на анализе, дай прогноз. Ответь на вопрос: «Если я ничего не изменю и буду продолжать мыслить в том же духе, что вероятнее всего произойдет в ближайшие 1-2 недели?».

# СТРУКТУРА ОТВЕТА

Предоставь свой анализ в строго следующем формате, используя Markdown для форматирования. Замени [ДАТА] на фактический диапазон дат.

---

### Отчет по когнитивному анализу за {date_range_str}

1. Краткое резюме и главная тема периода:
*(В 2-3 предложениях опиши ключевую мысль или эмоциональное состояние этого периода.)*

2. Структурный анализ мыслей:
*   Проблемы и Тревоги:
    *   - [Проблема 1]
    *   - [Проблема 2]
*   Идеи и Озарения:
    *   - [Идея 1]
    *   - [Идея 2]
*   Собственные доводы и Убеждения:
    *   - [Довод 1]
    *   - [Убеждение 1]
*   Факты и Наблюдения:
    *   - [Факт 1]

3. Скрытые связи и паттерны:
*   Связь 1: *(Например: «Утренняя тревога по поводу проекта Х напрямую связана с вечерней идеей о смене карьеры. Это защитный механизм.»)*
*   Повторяющийся паттерн: *(Например: «В течение дня 5 раз повторяется слово "должен", что указывает на сильное внутреннее давление.»)*

4. Направленность мышления:
*   Общий вектор: [Конструктивный/Деструктивный/и т.д.]
*   Обоснование: *(Почему ты так считаешь, с примерами из текста.)*

5. Рекомендации, предупреждения и прогноз:
*   Советы по решению проблем:
    *   По Проблеме 1: [Твой совет]
    *   По Проблеме 2: [Твой совет]
*   На что обратить внимание в ближайшие дни:
    *   [Твоя рекомендация]
*   Мониторинг состояния:
    *   [Твои наблюдения об ухудшении/улучшении моего состояния. Будь прямым, но деликатным.]
*   Прогноз на 1-2 недели (если ничего не менять):
    *   [Твой прогноз последствий текущего мыслительного тренда.]
---
"""
    try:
        response = gemini_model.generate_content(prompt)
        return response.text
    except Exception as e:
        print(f"Ошибка при генерации отчета Gemini: {e}")
        return f"Не удалось сгенерировать отчет. Ошибка API: {e}"

def normalize_task_name(task_name):
    name = task_name.strip().lower()
    if "ml" in name or "машин" in name:
        return "машинное обучение"
    if "проект" in name:
        return "работа над проектом"
    return name

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
            new_timer_logs = [log for log in all_timer_logs if last_analysis_time is None or ('start_time' in log and log['start_time'] and parser.parse(log['start_time']) > last_analysis_time)]
            
            if new_thoughts or new_timer_logs:
                analysis_result = generate_analysis_report(new_thoughts, new_timer_logs, last_analysis_time)
                try:
                    analysis_timestamp = datetime.now(timezone.utc).isoformat()
                    
                    # Определяем самую позднюю временную метку для сохранения в 'thoughts_analyzed_until'
                    latest_ts = datetime.min.replace(tzinfo=timezone.utc)
                    if new_thoughts:
                        latest_ts = max(latest_ts, max(parser.parse(t['timestamp']) for t in new_thoughts))
                    if new_timer_logs:
                        latest_ts = max(latest_ts, max(parser.parse(l['start_time']) for l in new_timer_logs))
                    
                    if latest_ts > datetime.min.replace(tzinfo=timezone.utc):
                       worksheet_analyses.append_row([str(user_id), analysis_timestamp, latest_ts.isoformat(), analysis_result])
                    else:
                        # Если нет новых данных, но анализ все равно был запущен (хотя логика выше это предотвращает)
                        flash("Не найдено новых данных для сохранения отметки времени анализа.", "error")

                except Exception as e:
                    flash(f"Не удалось сохранить отчет анализа в базу данных. {e}", "error")
            else:
                analysis_result = "Нет новых мыслей или рабочих сессий для анализа."

    return render_template('dashboard.html', user_id=user_id, greeting=greeting, analysis_result=analysis_result)

@app.route('/thoughts/<user_id>')
def thoughts_list(user_id):
    all_thoughts = get_data_from_sheet(worksheet_thoughts, user_id)
    all_thoughts.sort(key=lambda x: parser.parse(x.get('timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    return render_template('thoughts.html', user_id=user_id, thoughts=all_thoughts)

@app.route('/analyses/<user_id>')
def analyses_list(user_id):
    all_analyses = get_data_from_sheet(worksheet_analyses, user_id)
    all_analyses.sort(key=lambda x: parser.parse(x.get('analysis_timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    return render_template('analyses.html', user_id=user_id, analyses=all_analyses)

@app.route('/timer/<user_id>')
def timer(user_id):
    task_name = request.args.get('task', 'Без названия')
    return render_template('timer.html', user_id=user_id, task_name=task_name)

@app.route('/dynamics/<user_id>')
def dynamics(user_id):
    return render_template('dynamics.html', user_id=user_id)

@app.route('/api/log_session', methods=['POST'])
def log_timer_session():
    data = request.json
    user_id = data.get('user_id')
    task_name = data.get('task_name')
    start_time_iso = data.get('start_time')
    end_time_iso = data.get('end_time')

    if not all([user_id, task_name, start_time_iso, end_time_iso]):
        return jsonify({'status': 'error', 'message': 'Missing data'}), 400

    try:
        start_dt = parser.isoparse(start_time_iso)
        end_dt = parser.isoparse(end_time_iso)
        duration_seconds = (end_dt - start_dt).total_seconds()
        
        if duration_seconds < 10:
             return jsonify({'status': 'ok', 'message': 'Session too short, not logged.'})

        normalized_task = normalize_task_name(task_name)
        
        worksheet_timer_logs.append_row([
            user_id,
            task_name,
            normalized_task,
            start_time_iso,
            end_time_iso,
            int(duration_seconds)
        ])
        return jsonify({'status': 'success'})
    except Exception as e:
        print(f"Ошибка сохранения сессии таймера: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/dynamics_data/<user_id>')
def get_dynamics_data(user_id):
    try:
        records = get_data_from_sheet(worksheet_timer_logs, user_id)
        if not records:
            return jsonify({ 'calendars': {}, 'activity_by_day': {'labels': [], 'data': []}, 'activity_by_hour': {'labels': list(range(24)), 'data': [0]*24}})

        df = pd.DataFrame(records)
        df['start_time'] = pd.to_datetime(df['start_time'])
        df['duration_seconds'] = pd.to_numeric(df['duration_seconds'], errors='coerce').fillna(0)
        df['duration_minutes'] = df['duration_seconds'] / 60
        df['date'] = df['start_time'].dt.date
        df['hour'] = df['start_time'].dt.hour
        
        calendars = {}
        unique_tasks = df.groupby('task_name_normalized')['task_name_raw'].first()
        for norm_name, raw_name_example in unique_tasks.items():
            task_dates = df[df['task_name_normalized'] == norm_name]['start_time'].dt.strftime('%Y-%m-%d').unique().tolist()
            calendars[raw_name_example] = task_dates

        daily_activity = df.groupby('date')['duration_minutes'].sum().round().astype(int)
        daily_activity.index = pd.to_datetime(daily_activity.index)
        
        if not daily_activity.empty:
            all_days = pd.date_range(start=daily_activity.index.min(), end=daily_activity.index.max(), freq='D')
            daily_activity = daily_activity.reindex(all_days, fill_value=0)
        
        hourly_activity = df.groupby('hour')['duration_minutes'].sum().round().astype(int)
        hourly_data = [hourly_activity.get(h, 0) for h in range(24)]

        return jsonify({
            'calendars': calendars,
            'activity_by_day': { 'labels': daily_activity.index.strftime('%Y-%m-%d').tolist() if not daily_activity.empty else [], 'data': daily_activity.values.tolist() if not daily_activity.empty else [] },
            'activity_by_hour': { 'labels': [f"{h:02d}:00" for h in range(24)], 'data': hourly_data }
        })
    except Exception as e:
        print(f"Ошибка получения данных для динамики: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', 8080)))
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', 8080)))
