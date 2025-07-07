import os
import json
import locale
from datetime import datetime, timezone
from dateutil import parser

import pandas as pd
import gspread
import markdown
import google.generativeai as genai
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify
from google.oauth2.service_account import Credentials

# --- CONFIGURATION ---
app = Flask(__name__)
app.secret_key = os.urandom(24)

@app.template_filter('markdown')
def markdown_filter(s):
    return markdown.markdown(s or '', extensions=['fenced_code', 'tables'])

# Set locale for Russian dates
try:
    locale.setlocale(locale.LC_TIME, 'ru_RU.UTF-8')
except locale.Error:
    print("Предупреждение: Локаль 'ru_RU.UTF-8' не найдена.")

# --- INIT SERVICES ---
worksheet_thoughts = worksheet_analyses = worksheet_timer_logs = None

gc = spreadsheet = None
try:
    google_creds_json = os.getenv("GOOGLE_CREDENTIALS_JSON")
    if not google_creds_json:
        raise ValueError("GOOGLE_CREDENTIALS_JSON not set")
    creds_info = json.loads(google_creds_json)
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive"
    ]
    creds = Credentials.from_service_account_info(creds_info, scopes=scopes)
    gc = gspread.authorize(creds)
    spreadsheet = gc.open_by_key(os.getenv("GOOGLE_SHEET_ID"))
    worksheet_thoughts = spreadsheet.worksheet("thoughts")
    worksheet_analyses = spreadsheet.worksheet("analyses")
    worksheet_timer_logs = spreadsheet.worksheet("timer_logs")
    print("✅ Connected to Google Sheets.")
except Exception as e:
    print(f"❌ Google Sheets init error: {e}")

# Init Gemini model
gemini_model = None
try:
    key = os.getenv("GEMINI_API_KEY")
    if key:
        genai.configure(api_key=key)
        gemini_model = genai.GenerativeModel('gemini-1.5-flash-latest')
        print("✅ Gemini model configured.")
    else:
        print("⚠️ GEMINI_API_KEY not set; analysis disabled.")
except Exception as e:
    print(f"❌ Gemini init error: {e}")

# --- HELPERS ---
def get_dynamic_greeting():
    hour = (datetime.now(timezone.utc).hour + 3) % 24
    if 4 <= hour < 12:
        return "Доброе утро"
    if 12 <= hour < 17:
        return "Добрый день"
    return "Добрый вечер"


def normalize_task_name(name):
    s = str(name or '').strip().lower()
    if any(k in s for k in ['ml', 'машин']): return 'машинное обучение'
    if 'проект' in s: return 'работа над проектом'
    return s


def get_data_from_sheet(ws, user_id):
    if not ws: return []
    try:
        rows = ws.get_all_records()
        return [r for r in rows if str(r.get('user_id')) == str(user_id)]
    except Exception as e:
        print(f"Error reading {ws.title}: {e}")
        return []


def get_last_analysis_timestamp(analyses):
    if not analyses: return None
    analyses.sort(key=lambda x: parser.parse(x.get('analysis_timestamp', '1970-01-01T00:00:00Z')), reverse=True)
    last = analyses[0].get('thoughts_analyzed_until')
    return parser.parse(last) if last else None


def get_new_data(records, last_time, key):
    if not records: return []
    if last_time is None: return records
    out = []
    for r in records:
        ts = r.get(key)
        if not ts: continue
        try:
            if parser.parse(ts) > last_time:
                out.append(r)
        except Exception:
            print(f"Cannot parse date: {ts}")
    return out


def generate_analysis_report(thoughts, timers):
    if not gemini_model:
        return "Анализ недоступен"
    if not thoughts and not timers:
        return "Нет новых данных для анализа"

    text_thr = "\n".join(
        f"[{parser.isoparse(t['timestamp']).strftime('%Y-%m-%d %H:%M')}] {t['content']}"
        for t in thoughts
    ) or "Нет мыслей"

    if timers:
        df = pd.DataFrame(timers)
        df['start_time'] = pd.to_datetime(df['start_time'], errors='coerce')
        df['duration_minutes'] = (pd.to_numeric(df['duration_seconds'], errors='coerce')/60).round(1)
        timer_text = "\n".join(
            f"- {r['task_name']}: {r['duration_minutes']} мин"
            for _, r in df.iterrows()
        )
    else:
        timer_text = "Нет данных активности"

    prompt = f"""
# ЗАДАЧА
Провести анализ мыслей и активности.

# МЫСЛИ
{text_thr}

# АКТИВНОСТЬ
{timer_text}

# ОТВЕТ
1. Резюме
2. Связь мыслей и задач
3. Паттерны
4. Рекомендации
"""
    try:
        return gemini_model.generate_content(prompt).text
    except Exception as e:
        return f"Ошибка анализа: {e}"

# --- ROUTES ---
@app.route('/', methods=['GET', 'POST'])
def login():
    if request.method=='POST':
        uid = request.form.get('user_id')
        if uid: return redirect(url_for('dashboard', user_id=uid))
    return render_template('login.html')

@app.route('/dashboard/<user_id>', methods=['GET','POST'])
def dashboard(user_id):
    greet = get_dynamic_greeting()
    analysis = None
    if request.method=='POST':
        action = request.form.get('action')
        if action=='analyze':
            thr = get_data_from_sheet(worksheet_thoughts, user_id)
            tlogs = get_data_from_sheet(worksheet_timer_logs, user_id)
            prev = get_data_from_sheet(worksheet_analyses, user_id)
            last_ts = get_last_analysis_timestamp(prev)
            new_t = get_new_data(thr, last_ts, 'timestamp')
            new_l = get_new_data(tlogs, last_ts, 'start_time')
            if new_t or new_l:
                analysis = generate_analysis_report(new_t, new_l)
                all_ts = [parser.parse(x['timestamp']) for x in new_t if x.get('timestamp')] + [parser.parse(x['start_time']) for x in new_l]
                if all_ts:
                    latest = max(all_ts)
                    worksheet_analyses.append_row([user_id, datetime.now(timezone.utc).isoformat(), latest.isoformat(), analysis])
        else:
            th = request.form.get('thought')
            if th:
                worksheet_thoughts.append_row([user_id, datetime.now(timezone.utc).isoformat(), th])
                flash("Мысль сохранена!", "success")
            return redirect(url_for('dashboard', user_id=user_id))
    return render_template('dashboard.html', user_id=user_id, greeting=greet, analysis_result=analysis)

@app.route('/thoughts/<user_id>')
def thoughts_list(user_id):
    data = get_data_from_sheet(worksheet_thoughts, user_id)
    data.sort(key=lambda x: parser.parse(x.get('timestamp','1970-01-01T00:00:00Z')), reverse=True)
    return render_template('thoughts.html', user_id=user_id, thoughts=data)

@app.route('/analyses/<user_id>')
def analyses_list(user_id):
    data = get_data_from_sheet(worksheet_analyses, user_id)
    data.sort(key=lambda x: parser.parse(x.get('analysis_timestamp','1970-01-01T00:00:00Z')), reverse=True)
    return render_template('analyses.html', user_id=user_id, analyses=data)

@app.route('/timer/<user_id>')
def timer_page(user_id):
    task = request.args.get('task','Без названия')
    return render_template('timer.html', user_id=user_id, task_name=task)

@app.route('/api/log_session', methods=['POST'])
def log_timer_session():
    if not request.is_json:
        return jsonify({'status':'error','message':'Invalid content type'}),400
    data = request.json
    req = ['user_id','task_name','start_time','end_time','duration_seconds']
    if not all(k in data for k in req):
        return jsonify({'status':'error','message':f'Missing fields'}),400
    try:
        row=[data['user_id'], data['task_name'], normalize_task_name(data['task_name']), data['start_time'], data['end_time'], int(data['duration_seconds'])]
        worksheet_timer_logs.append_row(row)
        return jsonify({'status':'success'})
    except Exception as e:
        print(f"Error logging session: {e}")
        return jsonify({'status':'error','message':str(e)}),500

@app.route('/api/dynamics_data/<user_id>')
def get_dynamics_data(user_id):
    try:
        recs = get_data_from_sheet(worksheet_timer_logs, user_id)
        if not recs:
            return jsonify({'calendars':{},'total_weeks':0,'activity_by_day':{'labels':[],'data':[]},'activity_by_hour':[]})
        df = pd.DataFrame(recs)
        df['start_time']=pd.to_datetime(df['start_time'],errors='coerce')
        df.dropna(subset=['start_time'], inplace=True)
        df['session_type']=df.get('session_type','work')
        df['date']=df['start_time'].dt.date
        df['duration_hours']=pd.to_numeric(df['duration_seconds'],errors='coerce')/3600
        first=df['start_time'].min().date()
        last=datetime.now(timezone.utc).date()
        weeks=max(1,(last-first).days//7+1)
        daily=df.groupby('date')['duration_hours'].sum().reindex(pd.date_range(first,last).date, fill_value=0)
        calendars={t: df[df['task_name']==t]['start_time'].dt.strftime('%Y-%m-%d').unique().tolist() for t in df['task_name'].unique()}
        return jsonify({
            'calendars':calendars,
            'total_weeks':weeks,
            'activity_by_day':{'labels':[d.strftime('%Y-%m-%d') for d in daily.index], 'data':daily.tolist()},
            'activity_by_hour':df.to_dict('records')
        })
    except Exception as e:
        print(f"Error dynamics: {e}")
        return jsonify({}),500

if __name__=='__main__':
    app.run(host='0.0.0.0', port=int(os.getenv('PORT',8080)))
