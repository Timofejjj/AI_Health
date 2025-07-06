import os
import json
import gspread
import locale 
import google.generativeai as genai
from flask import Flask, render_template, request, redirect, url_for, flash
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
# ... (этот блок остается без изменений) ...
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID")
GOOGLE_CREDENTIALS_JSON_STR = os.getenv("GOOGLE_CREDENTIALS_JSON")


# --- ИНИЦИАЛИЗАЦИЯ СЕРВИСОВ ---
# ... (этот блок остается без изменений) ...
worksheet_thoughts = None
worksheet_analyses = None

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
    print("✅ Успешное подключение к Google Sheets.")
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
# ... (все функции-помощники остаются без изменений) ...
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
    except Exception: return []

def get_last_analysis_timestamp(analyses):
    if not analyses: return None
    analyses.sort(key=lambda x: parser.parse(x.get('analysis_timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    return parser.parse(analyses[0]['thoughts_analyzed_until'])

def get_new_thoughts(thoughts, last_analysis_time):
    if last_analysis_time is None: return thoughts
    return [t for t in thoughts if parser.parse(t.get('timestamp')) > last_analysis_time]

def generate_analysis_report(thoughts_list, start_date_of_period):
    # Ваш детализированный промпт остается здесь без изменений
    if not gemini_model: return "Модель анализа недоступна."
    if not thoughts_list: return "Нет новых мыслей для анализа."

    full_text = "\n\n---\n\n".join([t['content'] for t in thoughts_list])
    if start_date_of_period is None:
        start_date_of_period = min(parser.parse(t['timestamp']) for t in thoughts_list)

    end_date_of_period = datetime.now(timezone.utc)
    date_format = "%d %B %Y"
    start_str = start_date_of_period.strftime(date_format)
    end_str = end_date_of_period.strftime(date_format)
    date_range_str = f"с {start_str} по {end_str}"
    delta = end_date_of_period - start_date_of_period
    days_to_analyze = max(1, delta.days)
    
    if days_to_analyze % 10 == 1 and days_to_analyze % 100 != 11:
        day_word = 'день'
    elif 2 <= days_to_analyze % 10 <= 4 and (days_to_analyze % 100 < 10 or days_to_analyze % 100 >= 20):
        day_word = 'дня'
    else:
        day_word = 'дней'

    prompt = f"""
# РОЛЬ И ЗАДАЧА

Ты — мой личный когнитивный аналитик и стратегический коуч. Твоя главная задача — провести глубокий, многоуровневый анализ моих мыслей, зафиксированных в виде текстовых сообщений за последние {days_to_analyze} {day_word}. Цель — помочь мне понять себя, выявить скрытые закономерности, отследить психологическое состояние и получить практические рекомендации.

# ВХОДНЫЕ ДАННЫЕ

Анализируемый период: {date_range_str}

Транскрипты сообщений:
{full_text}

# КЛЮЧЕВЫЕ ДИРЕКТИВЫ ДЛЯ АНАЛИЗА

Действуй строго по следующим инструкциям. Твой ответ должен быть структурирован в соответствии с форматом, указанным в конце.

1.  **Выявление скрытых связей и паттернов:**
    *   Анализируй, как темы, поднятые в начале периода, влияют на мысли в конце.
    *   Находи связи между моими проблемами и идеями. Например, не является ли какая-то идея попыткой подсознательно решить другую проблему?
    *   Отмечай повторяющиеся слова, метафоры, образы или темы в течение всего периода.

2.  **Структурный разбор мыслей:**
    *   Четко раздели все мои высказывания на четыре категории:
        *   Проблемы и Тревоги: Все, что вызывает у меня беспокойство, страх, недовольство, фрустрацию.
        *   Идеи и Озарения: Любые новые мысли, креативные решения, планы, гипотезы.
        *   Собственные доводы и Убеждения: Мои аргументы, объяснения своей позиции, ценности, которые я транслирую.
        *   Факты и Наблюдения: Объективные констатации, описания событий без эмоциональной окраски.

3.  **Анализ направленности мышления:**
    *   Оцени общий вектор моих мыслей за период. Он был: конструктивным, деструктивным, стагнирующим, сфокусированным, рассеянным, оптимистичным, пессимистичным? Обоснуй свой вывод.

4.  **Проактивный коучинг и прогнозирование (САМАЯ ВАЖНАЯ ЧАСТЬ):**
    *   Советы: Для каждой выявленной «Проблемы» предложи 1-2 конкретных, действенных совета по ее решению или изменению моего отношения к ней.
    *   Фокус внимания: Укажи, на какие мысли, идеи или паттерны мне стоит обратить особое внимание в ближайшие дни.
    *   Мониторинг состояния (Критически важно): Замечай признаки ухудшения моего состояния (например, рост тревожности, апатии, самокритики, безнадежности). Формулируй это мягко, но прямо. Например: «Я замечаю, что за эту неделю риторика самообвинения усилилась».
    *   Прогноз: Основываясь на анализе, дай прогноз. Ответь на вопрос: «Если я ничего не изменю и буду продолжать мыслить в том же духе, что вероятнее всего произойдет в ближайшие 1-2 недели?».

# СТРУКТУРА ОТВЕТА

Предоставь свой анализ в строго следующем формате, используя Markdown для форматирования.

---

### Отчет по когнитивному анализу за {date_range_str}

1. **Краткое резюме и главная тема периода:**
*(В 2-3 предложениях опиши ключевую мысль или эмоциональное состояние этого периода.)*

2. **Структурный анализ мыслей:**
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

3. **Скрытые связи и паттерны:**
*   Связь 1: *(Например: «Утренняя тревога по поводу проекта Х напрямую связана с вечерней идеей о смене карьеры. Это защитный механизм.»)*
*   Повторяющийся паттерн: *(Например: «В течение дня 5 раз повторяется слово "должен", что указывает на сильное внутреннее давление.»)*

4. **Направленность мышления:**
*   Общий вектор: [Конструктивный/Деструктивный/и т.д.]
*   Обоснование: *(Почему ты так считаешь, с примерами из текста.)*

5. **Рекомендации, предупреждения и прогноз:**
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


# --- МАРШРУТЫ (URL) ПРИЛОЖЕНИЯ ---
# ... (маршруты login, dashboard, thoughts_list остаются без изменений) ...

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
            all_analyses = get_data_from_sheet(worksheet_analyses, user_id)
            last_analysis_time = get_last_analysis_timestamp(all_analyses)
            new_thoughts = get_new_thoughts(all_thoughts, last_analysis_time)

            if new_thoughts:
                new_thoughts.sort(key=lambda x: parser.parse(x.get('timestamp')), reverse=True)
                latest_thought_timestamp = new_thoughts[0]['timestamp']
                analysis_result = generate_analysis_report(new_thoughts, last_analysis_time)
                try:
                    analysis_timestamp = datetime.now(timezone.utc).isoformat()
                    worksheet_analyses.append_row([str(user_id), analysis_timestamp, latest_thought_timestamp, analysis_result])
                except Exception:
                    flash("Не удалось сохранить отчет анализа в базу данных.", "error")
            else:
                analysis_result = "Нет новых мыслей для анализа с момента последнего отчета."

    return render_template('dashboard.html', user_id=user_id, greeting=greeting, analysis_result=analysis_result)

@app.route('/thoughts/<user_id>')
def thoughts_list(user_id):
    all_thoughts = get_data_from_sheet(worksheet_thoughts, user_id)
    all_thoughts.sort(key=lambda x: parser.parse(x.get('timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    return render_template('thoughts.html', user_id=user_id, thoughts=all_thoughts)


# +++ НОВЫЙ МАРШРУТ ДЛЯ ИСТОРИИ АНАЛИЗОВ +++
@app.route('/analyses/<user_id>')
def analyses_list(user_id):
    """Страница со списком всех прошлых анализов."""
    all_analyses = get_data_from_sheet(worksheet_analyses, user_id)
    # Сортируем анализы от новых к старым
    all_analyses.sort(key=lambda x: parser.parse(x.get('analysis_timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    return render_template('analyses.html', user_id=user_id, analyses=all_analyses)


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', 8080)))
