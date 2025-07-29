# ============================================================================
# 1. ИМПОРТЫ
# ============================================================================
import os
import traceback
from datetime import datetime, timezone
from functools import wraps  # <-- НОВОЕ: для создания декораторов

from dateutil import parser
from flask import (Flask, flash, jsonify, redirect, render_template, request,
                   session, url_for)

# ============================================================================
# 2. ЗАГЛУШКИ ДЛЯ ВНЕШНИХ ФУНКЦИЙ
# ============================================================================
# Замените этот блок вашими реальными функциями для работы с Google Sheets
# и другой логикой. Они оставлены здесь, чтобы код был рабочим "из коробки".

class MockWorksheet:
    """Класс-заглушка для эмуляции работы с листом Google Sheets."""
    def append_row(self, values):
        print(f"ЗАГЛУШКА: Добавлена строка: {values}")

def get_worksheet(name):
    print(f"ЗАГЛУШКА: Запрошен лист '{name}'.")
    return MockWorksheet()

def get_data_from_sheet(sheet, user_id):
    print(f"ЗАГЛУШКА: Запрошены данные для пользователя '{user_id}' из листа '{sheet}'.")
    return []

def generate_analysis_report(thoughts, timers, sports):
    print("ЗАГЛУШКА: Генерируется аналитический отчет.")
    return "Это пример сгенерированного отчета на основе предоставленных данных."

class MoscowTimezone: pass
MOSCOW_TZ = MoscowTimezone()

# ============================================================================
# 3. ИНИЦИАЛИЗАЦИЯ И КОНФИГУРАЦИЯ ПРИЛОЖЕНИЯ
# ============================================================================

app = Flask(__name__)

# ВАЖНО: Секретный ключ необходим для безопасной работы сессий.
# В продакшене его нужно задавать через переменную окружения.
# Для разработки можно временно оставить строку.
app.secret_key = os.environ.get('FLASK_SECRET_KEY', 'замените-это-на-очень-длинный-и-случайный-ключ')

# --- Демонстрационная "база данных" пользователей ---
# В реальном приложении здесь будет подключение к БД, а пароли будут ХЕШИРОВАНЫ.
# Никогда не храните пароли в открытом виде!
DUMMY_USERS = {
    "user1": "password123",
    "testuser": "test",
    "admin": "adminpass"
}

# ============================================================================
# 4. ДЕКОРАТОР ДЛЯ ПРОВЕРКИ АУТЕНТИФИКАЦИИ
# ============================================================================

def login_required(f):
    """
    Декоратор для маршрутов, требующих входа в систему.
    Проверяет, есть ли user_id в сессии. Если нет - перенаправляет на /login.
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            flash('Для доступа к этой странице необходимо войти в систему.', 'warning')
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated_function

# ============================================================================
# 5. МАРШРУТЫ АУТЕНТИФИКАЦИИ (ВХОД И ВЫХОД)
# ============================================================================

@app.route('/login', methods=['GET', 'POST'])
def login():
    """Отображает форму входа и обрабатывает её данные."""
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']

        if username in DUMMY_USERS and DUMMY_USERS[username] == password:
            session['user_id'] = username
            session.permanent = True  # Делает сессию долговременной
            return redirect(url_for('app_view'))
        else:
            flash('Неверное имя пользователя или пароль.', 'error')
            return redirect(url_for('login'))

    return render_template('login.html')

@app.route('/logout')
@login_required
def logout():
    """Завершает сеанс пользователя и перенаправляет на страницу входа."""
    session.pop('user_id', None)
    flash('Вы успешно вышли из системы.', 'info')
    return redirect(url_for('login'))

# ============================================================================
# 6. ОСНОВНЫЕ МАРШРУТЫ ПРИЛОЖЕНИЯ
# ============================================================================

@app.route('/')
def root():
    """Корневой URL. Перенаправляет на приложение или на страницу входа."""
    if 'user_id' in session:
        return redirect(url_for('app_view'))
    return redirect(url_for('login'))

@app.route('/app')
@login_required
def app_view():
    """Главный экран приложения (SPA). Доступен только после входа."""
    user_id = session['user_id']
    greeting = "Добрый день" # Можно добавить логику приветствия по времени
    return render_template('home.html', user_id=user_id, greeting=greeting)

# --- Редиректы со старых URL ---
@app.route('/dashboard')
@app.route('/dynamics')
@app.route('/thoughts')
@app.route('/analyses')
@app.route('/timer')
@login_required
def redirect_to_app_simple():
    """Обрабатывает старые URL и перенаправляет на главный экран /app."""
    return redirect(url_for('app_view'))

# ============================================================================
# 7. API ЭНДПОИНТЫ (ЗАЩИЩЕНЫ ДЕКОРАТОРОМ)
# ============================================================================

@app.route('/api/thoughts', methods=['GET', 'POST'])
@login_required
def handle_thoughts():
    """API для работы с мыслями. ID пользователя берется из сессии."""
    user_id = session['user_id']
    if request.method == 'POST':
        data = request.json
        thought = data.get('thought')
        if not thought:
            return jsonify({'status': 'error', 'message': 'Пустая мысль'}), 400
        worksheet = get_worksheet("thoughts")
        worksheet.append_row([str(user_id), datetime.now(timezone.utc).isoformat(), thought])
        return jsonify({'status': 'success'}), 201
    else: # GET
        thoughts = get_data_from_sheet("thoughts", user_id)
        thoughts.sort(key=lambda x: parser.parse(x.get('timestamp', '1970-01-01T00:00:00Z')), reverse=True)
        return jsonify(thoughts)

@app.route('/api/analyses', methods=['GET'])
@login_required
def get_analyses():
    """API для получения истории анализов."""
    user_id = session['user_id']
    analyses = get_data_from_sheet("analyses", user_id)
    analyses.sort(key=lambda x: parser.parse(x.get('analysis_timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    return jsonify(analyses)

@app.route('/api/run_analysis', methods=['POST'])
@login_required
def run_analysis():
    """API для запуска генерации нового аналитического отчета."""
    user_id = session['user_id']
    try:
        thoughts = get_data_from_sheet("thoughts", user_id)
        timers = get_data_from_sheet("timer_logs", user_id)
        sports = get_data_from_sheet("sports activity", user_id)
        
        if not thoughts and not timers and not sports:
            return jsonify({'status': 'info', 'message': 'Нет данных для анализа.'})

        report = generate_analysis_report(thoughts, timers, sports)
        worksheet_analyses = get_worksheet("analyses")
        if worksheet_analyses:
            worksheet_analyses.append_row([str(user_id), datetime.now(timezone.utc).isoformat(), datetime.now(timezone.utc).isoformat(), report])
            return jsonify({'status': 'success', 'message': 'Анализ завершен и сохранен!'})
        else:
            return jsonify({'status': 'error', 'message': 'Не удалось сохранить отчет'}), 500
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500

# Другие API-эндпоинты (примеры)
@app.route('/api/log_session', methods=['POST'])
@login_required
def log_work_session():
    user_id = session['user_id']
    data = request.json
    # ... здесь ваша логика сохранения данных из data, используя безопасный user_id
    print(f"Логирование сессии для {user_id}: {data}")
    return jsonify({'status': 'success'})

@app.route('/api/log_sport_activity', methods=['POST'])
@login_required
def log_sport_activity():
    user_id = session['user_id']
    data = request.json
    # ... здесь ваша логика сохранения данных из data, используя безопасный user_id
    print(f"Логирование спорта для {user_id}: {data}")
    return jsonify({'status': 'success'})

# ============================================================================
# 8. ОБРАБОТЧИКИ ОШИБОК
# ============================================================================

@app.errorhandler(404)
def page_not_found(e):
    """Отображает кастомную страницу 404."""
    return render_template('404.html'), 404

# ============================================================================
# 9. ЗАПУСК ПРИЛОЖЕНИЯ
# ============================================================================

if __name__ == '__main__':
    # debug=True включает автоматическую перезагрузку при изменениях
    # и подробные отчеты об ошибках. Отключите в продакшене!
    app.run(debug=True)
