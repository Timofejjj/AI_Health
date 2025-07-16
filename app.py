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

# --- ИНИЦИАЛИЗАЦИЯ GOOGLE & GEMINI API ---
gemini_model = None
try:
    GOOGLE_CREDS_INFO = json.loads(os.getenv("GOOGLE_CREDENTIALS_JSON"))
    GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID")
    if not GOOGLE_CREDS_INFO or not GOOGLE_SHEET_ID:
        raise ValueError("Переменные GOOGLE_CREDENTIALS_JSON и GOOGLE_SHEET_ID должны быть установлены.")
    
    gemini_api_key = os.getenv("GEMINI_API_KEY")
    if gemini_api_key:
        import google.generativeai as genai
        genai.configure(api_key=gemini_api_key)
        gemini_model = genai.GenerativeModel('gemini-1.5-flash-latest')
        print("✅ Модель Gemini успешно настроена.")
    else:
        print("⚠️  Предупреждение: GEMINI_API_KEY не установлен. Анализ будет недоступен.")
except Exception as e:
    print(f"❌ КРИТИЧЕСКАЯ ОШИБКА при инициализации конфигурации: {e}")
    GOOGLE_CREDS_INFO = None

# --- ФУНКЦИИ-ПОМОЩНИКИ ДЛЯ GOOGLE SHEETS ---
def get_gspread_client():
    if not GOOGLE_CREDS_INFO: raise Exception("Учетные данные Google не были загружены.")
    scopes = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]
    creds = Credentials.from_service_account_info(GOOGLE_CREDS_INFO, scopes=scopes)
    return gspread.authorize(creds)

def get_worksheet(worksheet_name):
    try:
        gc = get_gspread_client()
        spreadsheet = gc.open_by_key(GOOGLE_SHEET_ID)
        return spreadsheet.worksheet(worksheet_name)
    except Exception as e:
        print(f"❌ Ошибка доступа к листу '{worksheet_name}': {e}"); return None

def get_data_from_sheet(worksheet_name, user_id=None):
    worksheet = get_worksheet(worksheet_name)
    if not worksheet: return []
    try:
        records = worksheet.get_all_records()
        if not user_id: return records
        return [r for r in records if str(r.get('user_id')) == str(user_id)]
    except Exception as e:
        print(f"Ошибка чтения данных из листа {worksheet_name}: {e}"); return []


# --- ГЕНЕРАЦИЯ АНАЛИТИЧЕСКОГО ОТЧЕТА ---
def generate_analysis_report(thoughts, timers, sports):
    if not gemini_model: return "Модель анализа недоступна."

    thoughts_text = "\n".join(f"- [{parser.isoparse(t['timestamp']).astimezone(MOSCOW_TZ).strftime('%d.%m %H:%M')}] {t['content']}" for t in thoughts) or "Нет данных о мыслях."
    timer_text_parts = []
    for t in timers:
        duration_min = round(int(t.get('duration_seconds', 0)) / 60)
        stimulus = f"Стимул: {t.get('stimulus_level_start', 'N/A')} -> {t.get('stimulus_level_end', 'N/A')}"
        overtime = f"Сверхурочно: {t.get('overtime_work', 0)}с" if t.get('session_type') == 'Работа' and t.get('overtime_work') else ""
        session_type = t.get('session_type', 'Работа')
        task_name = t.get('task_name_raw', 'Без названия') if session_type == 'Работа' else session_type
        timer_text_parts.append(f"- [{parser.parse(t['start_time']).strftime('%d.%m %H:%M')}] {task_name}: {duration_min} мин. ({stimulus}) {overtime}")
    timer_text = "\n".join(timer_text_parts) or "Нет данных о рабочих сессиях."
    sports_text_parts = []
    for s in sports:
        duration_min = round(int(s.get('duration_seconds', 0)) / 60)
        sports_text_parts.append(f"- [{parser.parse(s['start_time']).strftime('%d.%m %H:%M')}] {s.get('name', 'Тренировка')}: {duration_min} мин.")
    sports_text = "\n".join(sports_text_parts) or "Нет данных о спортивных активностях."
    prompt = f"""
# РОЛЬ И ЗАДАЧА
Ты — элитный аналитик производительности и благополучия. Твоя цель — провести **кросс-функциональный анализ** данных из трёх источников: ментального состояния (мысли), когнитивной работы (рабочие сессии) и физической активности (спорт). Ты должен выявить скрытые связи, паттерны и дать комплексные, действенные рекомендации.

# ВХОДНЫЕ ДАННЫЕ

### 1. Журнал мыслей:
{thoughts_text}

### 2. Рабочие сессии и перерывы:
{timer_text}

### 3. Спортивные активности:
{sports_text}

# КЛЮЧЕВЫЕ ДИРЕКТИВЫ АНАЛИЗА

1.  **КРОСС-ФУНКЦИОНАЛЬНЫЙ СИНТЕЗ (ГЛАВНОЕ):**
    *   **Спорт ⇄ Работа:** Найди корреляции между физической активностью и когнитивной производительностью. Утренняя тренировка повышает стимул перед работой? Длинные сессии снижают вероятность вечерней тренировки?
    *   **Мысли ⇄ Активность:** Как содержание мыслей (тревога, мотивация) влияет на желание работать или заниматься спортом? Как сессии (работа/спорт) влияют на последующие мысли?
    *   **Стимул как индикатор:** Проанализируй динамику "Уровня стимула". Что его повышает (короткие перерывы, спорт?), а что истощает (длинные сессии без пауз, определённые задачи)?

2.  **АНАЛИЗ ПРОИЗВОДИТЕЛЬНОСТИ И ЭНЕРГИИ:**
    *   **Паттерны "Пик-Спад":** Определи дни или периоды максимальной и минимальной продуктивности. Что им предшествовало (спорт, отдых, определённые мысли)?
    *   **Баланс "Работа-Отдых-Спорт":** Оцени, насколько сбалансирован мой график. Есть ли признаки выгорания (много сверхурочной работы, мало отдыха и спорта) или прокрастинации?
    *   **Эффективность перерывов:** Судя по уровню стимула "до" и "после", насколько эффективны были перерывы?

3.  **ИДЕНТИФИКАЦИЯ ПОВЕДЕНЧЕСКИХ ПЕТЕЛЬ:**
    *   Выяви повторяющиеся циклы. *Пример: "Тревожная мысль о проекте → Пропуск тренировки → Сверхурочная, но непродуктивная работа → Мысль об усталости и неэффективности".*

# СТРУКТУРА ОТВЕТА (используй Markdown)

### Комплексный анализ производительности

**1. Ключевые выводы и паттерны (Кросс-анализ)**
*   **Связь "Спорт-Работа":** [Твой вывод о том, как спорт влияет на работу и наоборот]
*   **Связь "Мысли-Действия":** [Твой вывод о том, как мысли влияют на активность и наоборот]
*   **Основной поведенческий цикл:** [Описание выявленной петли поведения или её отсутствия]

**2. Состояние производительности и энергии**
*   **Продуктивность:** [Оценка общей продуктивности, выявление пиков и спадов]
*   **Энергетический баланс:** [Оценка баланса работа/отдых/спорт, наличие признаков выгорания]

**3. Комплексные рекомендации и прогноз**
*   **Action-Point №1 (Синтез):** [Конкретный совет, объединяющий спорт/работу/мысли. *Пример: "Чтобы повысить стимул перед задачей X, попробуй 15-минутную тренировку..."*]
*   **Action-Point №2 (Оптимизация):** [Совет по оптимизации графика работы или отдыха на основе данных]
*   **На чем сфокусироваться:** [Одна ключевая вещь (привычка, задача, мысль), на которую стоит обратить внимание на следующей неделе]
*   **Прогноз:**
    *   📈 **Оптимистичный:** Что будет, если я последую советам?
    *   📉 **Пессимистичный:** Какие риски, если ничего не менять?
"""
    try:
        response = gemini_model.generate_content(prompt)
        return response.text
    except Exception as e:
        traceback.print_exc()
        return f"Ошибка при генерации анализа: {e}"

# --- ГЛАВНЫЕ МАРШРУТЫ И РЕДИРЕКТЫ ---
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

# --- Редиректы со старых URL на новый SPA-маршрут ---
@app.route('/dashboard/<user_id>')
@app.route('/dynamics/<user_id>')
@app.route('/thoughts/<user_id>')
@app.route('/analyses/<user_id>')
@app.route('/timer/<user_id>')
def redirect_to_app(user_id):
    return redirect(url_for('app_view', user_id=user_id))


# --- API ЭНДПОИНТЫ ---
@app.route('/api/thoughts/<user_id>', methods=['POST', 'GET'])
def handle_thoughts(user_id):
    if request.method == 'POST':
        data = request.json
        thought = data.get('thought')
        if not thought: return jsonify({'status': 'error', 'message': 'Пустая мысль'}), 400
        worksheet = get_worksheet("thoughts")
        if not worksheet: return jsonify({'status': 'error', 'message': 'Сервис недоступен'}), 503
        worksheet.append_row([str(user_id), datetime.now(timezone.utc).isoformat(), thought])
        return jsonify({'status': 'success'}), 201
    else: # GET
        thoughts = get_data_from_sheet("thoughts", user_id)
        thoughts.sort(key=lambda x: parser.parse(x.get('timestamp', '1970-01-01T00:00:00Z')), reverse=True)
        return jsonify(thoughts)

@app.route('/api/analyses/<user_id>', methods=['GET'])
def get_analyses(user_id):
    analyses = get_data_from_sheet("analyses", user_id)
    analyses.sort(key=lambda x: parser.parse(x.get('analysis_timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    return jsonify(analyses)

@app.route('/api/run_analysis/<user_id>', methods=['POST'])
def run_analysis(user_id):
    try:
        thoughts = get_data_from_sheet("thoughts", user_id)
        timers = get_data_from_sheet("timer_logs", user_id)
        sports = get_data_from_sheet("sports activity", user_id)
        
        if not thoughts and not timers and not sports:
            return jsonify({'status': 'info', 'message': 'Нет данных для анализа.'})

        report = generate_analysis_report(thoughts, timers, sports)
        
        worksheet_analyses = get_worksheet("analyses")
        if worksheet_analyses:
            worksheet_analyses.append_row([
                str(user_id), datetime.now(timezone.utc).isoformat(),
                datetime.now(timezone.utc).isoformat(), report
            ])
            return jsonify({'status': 'success', 'message': 'Анализ завершен и сохранен!'})
        else:
            return jsonify({'status': 'error', 'message': 'Не удалось сохранить отчет'}), 500
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/log_session', methods=['POST'])
def log_work_session():
    data = request.json
    try:
        worksheet = get_worksheet("timer_logs")
        if not worksheet:
             return jsonify({'status': 'error', 'message': 'Не удалось получить доступ к таблице логов'}), 500
        start_time_local = parser.isoparse(data['start_time']).astimezone(MOSCOW_TZ)
        end_time_local = parser.isoparse(data['end_time']).astimezone(MOSCOW_TZ)
        worksheet.append_row(values=[
            str(data['user_id']), str(data.get('task_name_raw', '')),
            str(data.get('task_name_normalized', '')), str(data.get('session_type', 'Работа')),
            str(data.get('location', '')), "", "",
            start_time_local.strftime('%Y-%m-%d %H:%M:%S'), end_time_local.strftime('%Y-%m-%d %H:%M:%S'),
            int(data['duration_seconds']), int(data.get('overtime_work', 0)),
            int(data.get('overtime_rest', 0)), data.get('stimulus_level_start', ''),
            data.get('stimulus_level_end', '')
        ])
        return jsonify({'status': 'success'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/log_sport_activity', methods=['POST'])
def log_sport_activity():
    data = request.json
    try:
        worksheet = get_worksheet("sports activity")
        if not worksheet: return jsonify({'status': 'error', 'message': 'Сервис недоступен'}), 500
        start_time_local = parser.isoparse(data['start_time']).astimezone(MOSCOW_TZ)
        end_time_local = parser.isoparse(data['end_time']).astimezone(MOSCOW_TZ)
        worksheet.append_row([
            str(data['user_id']), str(data['name']),
            start_time_local.strftime('%Y-%m-%d %H:%M:%S'),
            end_time_local.strftime('%Y-%m-%d %H:%M:%S'),
            int(data['duration_seconds'])
        ])
        return jsonify({'status': 'success'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', 8080)), debug=True)
