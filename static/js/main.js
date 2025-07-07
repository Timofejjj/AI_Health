// =======================================================
//        ГЛОБАЛЬНОЕ СОСТОЯНИЕ И UI
// =======================================================
const TIMER_STATE_KEY = 'timerState';

function getTimerState() { return JSON.parse(localStorage.getItem(TIMER_STATE_KEY) || 'null'); }
function setTimerState(state) { localStorage.setItem(TIMER_STATE_KEY, JSON.stringify(state)); }
function clearTimerState() { localStorage.removeItem(TIMER_STATE_KEY); }

function showModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.style.display = 'flex';
        setTimeout(() => modal.classList.add('visible'), 10);
    }
}
function hideModals() {
    document.querySelectorAll('.modal-overlay.visible').forEach(m => {
        m.classList.remove('visible');
        setTimeout(() => m.style.display = 'none', 200);
    });
}

function updatePersistentBar() {
    const bar = document.getElementById('persistent-timer-bar');
    const st = getTimerState();
    if (!bar) return;
    if (st && st.isWorkSessionActive) {
        bar.classList.add('visible');
        bar.querySelector('.task-name').textContent = st.taskName;
        bar.querySelector('#return-to-timer-btn').href = `/timer/${st.userId}?task=${encodeURIComponent(st.taskName)}`;
    } else {
        bar.classList.remove('visible');
    }
}

// =======================================================
//        API ЛОГИРОВАНИЕ
// =======================================================
function logSession(data) {
    if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        navigator.sendBeacon('/api/log_session', blob);
    }
}

// =======================================================
//        ИНФРАСТРУКТУРА МОДАЛОВ
// =======================================================
function initStartSessionModal() {
    const showBtn = document.getElementById('show-session-modal-btn');
    const modal = document.getElementById('start-session-modal');
    const confirm = document.getElementById('confirm-start-btn');
    const cancel = document.getElementById('cancel-start-btn');
    const input = document.getElementById('task-name-input');
    const uid = document.body.dataset.userId;
    if (showBtn) showBtn.addEventListener('click', () => showModal('start-session-modal'));
    if (cancel) cancel.addEventListener('click', hideModals);
    if (confirm) confirm.addEventListener('click', () => {
        const name = input.value.trim();
        if (name) window.location.href = `/timer/${uid}?task=${encodeURIComponent(name)}`;
    });
}

// =======================================================
//        ИНИЦИАЛИЗАЦИЯ FAB
// =======================================================
function initFabMenu() {
    const fab = document.getElementById('timer-fab');
    const menu = document.getElementById('timer-fab-menu');
    const btn = document.getElementById('fab-menu-session-btn');
    const modal = document.querySelector('.modal-overlay');

    if (fab && menu) {
        fab.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('visible'); });
        document.addEventListener('click', () => menu.classList.remove('visible'));
        menu.addEventListener('click', e => e.stopPropagation());
        if (btn) btn.addEventListener('click', e => {
            e.preventDefault();
            menu.classList.remove('visible');
            const st = getTimerState();
            if (st && st.isWorkSessionActive) {
                window.location.href = `/timer/${st.userId}?task=${encodeURIComponent(st.taskName)}`;
            } else if (modal) {
                modal.style.display = 'flex';
            }
        });
    }
}

function initModalClose() {
    const close = document.getElementById('close-modal-btn');
    if (close) close.addEventListener('click', () => document.querySelector('.modal-overlay').style.display = 'none');
}

// =======================================================
//        ТАЙМЕРНАЯ ЛОГИКА
// =======================================================
function initTimerPage() {
    const body = document.querySelector('body');
    const uid = body.dataset.userId;
    const params = new URLSearchParams(location.search);
    const taskName = params.get('task') || 'Без названия';
    const display = document.querySelector('.time-display');
    const startPause = document.querySelector('.button-primary');
    const stopBtn = document.querySelector('.button-secondary');

    let elapsed = 0;
    let running = false;
    let startTime = null;
    let interval = null;
    let pauseStart = null;
    let totalDuration = null; // Для Pomodoro

    function updateUI() {
        const mm = Math.floor(elapsed / 60);
        const ss = elapsed % 60;
        display.textContent = `${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
        startPause.textContent = running ? 'Пауза' : (elapsed ? 'Продолжить' : 'Старт');
        startPause.classList.toggle('paused', running);
        updatePersistentBar();
    }

    function start() {
        if (running) return;
        running = true;
        if (!startTime) startTime = new Date().toISOString();
        if (pauseStart) {
            logSession({ session_type: 'pause', userId: uid, task_name: taskName,
                start_time: pauseStart, end_time: new Date().toISOString(),
                duration_seconds: Math.floor((new Date() - new Date(pauseStart)) /1000)});
            pauseStart = null;
        }
        const base = Date.now() - elapsed * 1000;
        interval = setInterval(() => { elapsed = Math.floor((Date.now() - base)/1000); updateUI(); }, 250);
        setTimerState({ isWorkSessionActive:true, userId:uid, taskName, workSessionStartTime: startTime, totalElapsedSecondsAtStart:0, totalDurationSeconds: totalDuration });
        updateUI();
    }
    function pause() {
        if (!running) return;
        running = false;
        clearInterval(interval);
        pauseStart = new Date().toISOString();
        updateUI();
    }
    function stop() {
        clearInterval(interval);
        const st = getTimerState();
        if (st && st.isWorkSessionActive) {
            const final = elapsed;
            logSession({ session_type:'work', userId:uid, task_name:taskName,
                start_time:st.workSessionStartTime, end_time:new Date().toISOString(), duration_seconds: final });
        }
        clearTimerState();
        window.location.href = `/dashboard/${uid}`;
    }

    startPause.addEventListener('click', () => running ? pause() : start());
    stopBtn.addEventListener('click', stop);
    start();
}

// =======================================================
//        ДИНАМИКА И ЧАРТЫ
// =======================================================
function initDynamicsPage() {
    const uid = document.body.dataset.userId;
    const backBtn = document.getElementById('back-to-timer-from-dynamics');
    if (backBtn) {
        const st = getTimerState();
        if (st && st.isWorkSessionActive) {
            backBtn.style.display = 'inline-block';
            backBtn.href = `/timer/${st.userId}?task=${encodeURIComponent(st.taskName)}`;
        }
    }
    const weeksFilter = document.getElementById('weeks-filter');
    const dayPicker = document.getElementById('day-picker');
    const ctxDaily = document.getElementById('dailyActivityChart')?.getContext('2d');
    const ctxHourly = document.getElementById('hourlyActivityChart')?.getContext('2d');
    let dailyChart, hourlyChart, dataAll;

    async function fetchData() {
        const res = await fetch(`/api/dynamics_data/${uid}`);
        dataAll = await res.json();
        renderCalendars(dataAll.calendars);
        weeksFilter.innerHTML = '';
        for(let i=1;i<=dataAll.total_weeks;i++) weeksFilter.add(new Option(`${i} нед.`, i));
        weeksFilter.value = Math.min(4,dataAll.total_weeks);
        dayPicker.value = new Date().toISOString().split('T')[0];
        renderDaily(weeksFilter.value);
        renderHourly(dayPicker.value);
    }
    function renderCalendars(cals) {
        const cont = document.getElementById('calendars-container');
        cont.innerHTML = '';
        if (!cals || !Object.keys(cals).length) { cont.innerHTML = '<p>Нет данных по задачам.</p>'; return; }
        const today = new Date(); today.setHours(0,0,0,0);
        Object.entries(cals).forEach(([task, dates]) => {
            const div = document.createElement('div'); div.className = 'calendar';
            let html = `<div class="calendar-header">${task}</div><div class="calendar-body">`;
            ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].forEach(d=>html+=`<div class="calendar-day header">${d}</div>`);
            const date = new Date(today.getFullYear(), today.getMonth(),1);
            const offset = date.getDay()==0?6:date.getDay()-1;
            for(let i=0;i<offset;i++) html+=`<div class="calendar-day"></div>`;
            while(date.getMonth()===today.getMonth()){
                const ds = date.toISOString().split('T')[0];
                let cls='calendar-day'+(dates.includes(ds)?' active':'')+(date.getTime()===today.getTime()?' today':'');
                html+=`<div class="${cls}">${date.getDate()}</div>`;
                date.setDate(date.getDate()+1);
            }
            html += '</div>';
            div.innerHTML=html;
            cont.appendChild(div);
        });
    }
    function renderDaily(weeks) {
        const days = weeks*7;
        const labels = dataAll.activity_by_day.labels.slice(-days);
        const vals = dataAll.activity_by_day.data.slice(-days);
        if (dailyChart) dailyChart.destroy();
        dailyChart = new Chart(ctxDaily, { type:'bar', data:{ labels, datasets:[{ data:vals, label:'Часы работы' }]}, options:{ scales:{y:{ beginAtZero:true, max:15 }}} });
    }
    function renderHourly(day) {
        const arr = Array(24).fill(0);
        dataAll.activity_by_hour.filter(d=>d.start_time.startsWith(day)).forEach(s=>arr[s.hour]+=s.duration_hours);
        if (hourlyChart) hourlyChart.destroy();
        hourlyChart = new Chart(ctxHourly,{ type:'bar', data:{ labels:Array.from({length:24},(_,i)=>`${i}:00`),datasets:[{ data:arr, label:`Часы за ${day}` }]}, options:{ scales:{y:{ beginAtZero:true }}} });
    }

    weeksFilter.addEventListener('change', ()=>renderDaily(weeksFilter.value));
    dayPicker.addEventListener('change', ()=>renderHourly(dayPicker.value));

    fetchData();
}

// =======================================================
//        ИНИЦИАЛИЗАЦИЯ СТРАНИЦЫ
// =======================================================
document.addEventListener('DOMContentLoaded', () => {
    initStartSessionModal();
    initFabMenu();
    initModalClose();
    updatePersistentBar();
    if (document.querySelector('.timer-page')) initTimerPage();
    if (document.querySelector('.dynamics-page')) initDynamicsPage();
});
