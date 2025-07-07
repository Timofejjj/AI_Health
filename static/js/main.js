// =======================================================
//        ГЛОБАЛЬНОЕ СОСТОЯНИЕ И UI
// =======================================================
const TIMER_STATE_KEY = 'persistentTimerState';
let globalUserId = null; // Будет установлен при загрузке страницы

// Функции для работы с localStorage
function getTimerState() {
    try {
        const state = localStorage.getItem(TIMER_STATE_KEY);
        return state ? JSON.parse(state) : null;
    } catch (e) {
        console.error("Could not parse timer state from localStorage", e);
        return null;
    }
}

function setTimerState(state) {
    localStorage.setItem(TIMER_STATE_KEY, JSON.stringify(state));
}

function clearTimerState() {
    localStorage.removeItem(TIMER_STATE_KEY);
}

// Функции для модальных окон
function showModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.add('visible');
    }
}

function hideModals() {
    document.querySelectorAll('.modal-overlay.visible').forEach(m => {
        m.classList.remove('visible');
    });
}

// Обновление плавающей панели таймера
function updatePersistentBar() {
    const bar = document.getElementById('persistent-timer-bar');
    const state = getTimerState();
    if (!bar) return;

    // Очищаем предыдущий интервал, чтобы избежать дублирования
    if (bar.intervalId) {
        clearInterval(bar.intervalId);
        bar.intervalId = null;
    }

    // Показываем панель, если есть активный таймер и мы НЕ на странице таймера
    if (state && state.isActive && !document.querySelector('.timer-page')) {
        bar.classList.add('visible');
        bar.querySelector('.task-name').textContent = state.taskName;
        const link = bar.querySelector('a');
        link.href = `/timer/${state.userId}?task=${encodeURIComponent(state.taskName)}`;

        const timeDisplay = bar.querySelector('.time-display');

        const updateBarTime = () => {
            const elapsedSeconds = Math.floor((Date.now() - state.startTime) / 1000);
            const remaining = state.totalDuration - elapsedSeconds;
            const isOvertime = remaining < 0;

            const displaySeconds = Math.abs(remaining);
            const minutes = String(Math.floor(displaySeconds / 60)).padStart(2, '0');
            const seconds = String(displaySeconds % 60).padStart(2, '0');

            timeDisplay.textContent = `${isOvertime ? '+' : ''}${minutes}:${seconds}`;
        };

        updateBarTime();
        bar.intervalId = setInterval(updateBarTime, 1000);
    } else {
        bar.classList.remove('visible');
    }
}

// =======================================================
//        API ЛОГИРОВАНИЕ
// =======================================================
function logSession(data) {
    // Используем sendBeacon для надежной отправки данных при закрытии страницы
    if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        navigator.sendBeacon('/api/log_session', blob);
    } else {
        // Fallback для старых браузеров
        fetch('/api/log_session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
            keepalive: true // Попытка сохранить запрос живым при уходе со страницы
        }).catch(error => console.error('Failed to log session with fetch:', error));
    }
}

// =======================================================
//        ИНФРАСТРУКТУРА FAB И МОДАЛОВ
// =======================================================
function initFabAndModals() {
    const fab = document.querySelector('.fab');
    const menu = document.getElementById('timer-fab-menu');
    const startSessionBtn = document.getElementById('fab-menu-session-btn');
    const taskModal = document.getElementById('task-modal');
    const taskForm = document.getElementById('task-form');
    const taskInput = document.getElementById('task-name-input');
    
    if (fab && menu) {
        fab.addEventListener('click', e => {
            e.stopPropagation();
            menu.classList.toggle('visible');
        });
        document.addEventListener('click', () => menu.classList.remove('visible'));
        menu.addEventListener('click', e => e.stopPropagation());
    }

    if (startSessionBtn) {
        startSessionBtn.addEventListener('click', e => {
            e.preventDefault();
            menu.classList.remove('visible');
            const state = getTimerState();
            // Если таймер уже запущен, переходим к нему
            if (state && state.isActive) {
                window.location.href = `/timer/${state.userId}?task=${encodeURIComponent(state.taskName)}`;
            } else if (taskModal) {
                // Иначе показываем модальное окно для новой задачи
                showModal('task-modal');
            }
        });
    }

    if (taskForm && taskInput) {
        taskForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const taskName = taskInput.value.trim();
            if (taskName && globalUserId) {
                hideModals();
                window.location.href = `/timer/${globalUserId}?task=${encodeURIComponent(taskName)}`;
            } else if (!taskName) {
                alert('Пожалуйста, введите название задачи.');
            }
        });
    }

    // Закрытие модальных окон
    document.querySelectorAll('.modal-overlay, .modal-cancel-btn').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target === el) hideModals();
        });
    });
}


// =======================================================
//        ТАЙМЕРНАЯ ЛОГИКА
// =======================================================
function initTimerPage() {
    // --- Состояние таймера для текущей страницы ---
    const pageState = {
        userId: document.body.dataset.userId,
        taskName: new URLSearchParams(location.search).get('task') || 'Без названия',
        totalDuration: 25 * 60, // Длительность в секундах, по умолчанию 25 мин
        elapsedSeconds: 0,
        startTime: null, // Время старта сессии (timestamp)
        isRunning: false,
        timerInterval: null
    };

    // --- DOM элементы ---
    const taskNameEl = document.querySelector('.timer-header h1');
    const timeDisplay = document.querySelector('.time-display');
    const startPauseBtn = document.querySelector('.control-btn-main');
    const stopBtn = document.querySelector('.control-btn-secondary');
    const decreaseBtn = document.getElementById('decrease-time-btn');
    const increaseBtn = document.getElementById('increase-time-btn');
    const presets = document.querySelectorAll('.time-preset-btn');
    const progressBar = document.querySelector('.timer-progress .progress-bar');
    const circumference = progressBar ? 2 * Math.PI * progressBar.r.baseVal.value : 0;
    
    if (taskNameEl) taskNameEl.textContent = pageState.taskName;

    function updateUI() {
        const remaining = pageState.totalDuration - pageState.elapsedSeconds;
        const isOvertime = remaining < 0;

        const displaySeconds = Math.abs(remaining);
        const minutes = String(Math.floor(displaySeconds / 60)).padStart(2, '0');
        const seconds = String(displaySeconds % 60).padStart(2, '0');
        
        timeDisplay.textContent = `${isOvertime ? '+' : ''}${minutes}:${seconds}`;
        timeDisplay.classList.toggle('overtime', isOvertime);

        if (progressBar) {
            const progress = isOvertime ? 1 : pageState.elapsedSeconds / pageState.totalDuration;
            progressBar.style.strokeDashoffset = circumference * (1 - progress);
            progressBar.classList.toggle('overtime', isOvertime);
        }

        startPauseBtn.textContent = pageState.isRunning ? 'Пауза' : (pageState.elapsedSeconds > 0 ? 'Продолжить' : 'Старт');
        startPauseBtn.classList.toggle('running', pageState.isRunning);
        startPauseBtn.classList.toggle('paused', !pageState.isRunning);
        
        const isEditable = !pageState.isRunning && pageState.elapsedSeconds === 0;
        [decreaseBtn, increaseBtn, ...presets].forEach(el => el.disabled = !isEditable);
    }

    function setDuration(minutes) {
        if (pageState.isRunning || pageState.elapsedSeconds > 0) return;
        pageState.totalDuration = Math.max(60, Math.min(180 * 60, minutes * 60));
        updateUI();
    }

    function start() {
        if (pageState.isRunning) return;
        
        pageState.isRunning = true;
        const now = Date.now();
        // Если это первый запуск, устанавливаем время старта
        if (!pageState.startTime) {
            pageState.startTime = now;
        }

        const baseTime = now - pageState.elapsedSeconds * 1000;

        pageState.timerInterval = setInterval(() => {
            pageState.elapsedSeconds = Math.floor((Date.now() - baseTime) / 1000);
            updateUI();
        }, 250);
        
        // Сохраняем состояние для персистентности
        setTimerState({
            isActive: true,
            userId: pageState.userId,
            taskName: pageState.taskName,
            startTime: pageState.startTime, // Сохраняем начальное время
            totalDuration: pageState.totalDuration,
        });

        updateUI();
    }

    function pause() {
        if (!pageState.isRunning) return;
        pageState.isRunning = false;
        clearInterval(pageState.timerInterval);
        // При паузе состояние в localStorage не меняем, чтобы плашка продолжала работать
        updateUI();
    }

    function stop() {
        clearInterval(pageState.timerInterval);
        
        if (pageState.startTime) { // Логируем сессию, только если она была начата
            logSession({
                user_id: pageState.userId,
                task_name: pageState.taskName,
                start_time: new Date(pageState.startTime).toISOString(),
                end_time: new Date().toISOString(),
                duration_seconds: pageState.elapsedSeconds
            });
        }
        
        clearTimerState(); // Очищаем состояние
        pageState.isRunning = false;
        
        window.location.href = `/dashboard/${pageState.userId}`;
    }

    // --- Инициализация и обработчики событий ---
    startPauseBtn.addEventListener('click', () => pageState.isRunning ? pause() : start());
    stopBtn.addEventListener('click', stop);
    decreaseBtn.addEventListener('click', () => setDuration(pageState.totalDuration / 60 - 5));
    increaseBtn.addEventListener('click', () => setDuration(pageState.totalDuration / 60 + 5));
    presets.forEach(btn => btn.addEventListener('click', () => setDuration(parseInt(btn.dataset.minutes))));
    
    // Попытка сохранить сессию при уходе со страницы
    window.addEventListener('beforeunload', () => { 
        if (pageState.isRunning) {
            // При работающем таймере, мы не вызываем stop(), так как sendBeacon в stop()
            // не успеет отработать надежно. Вместо этого, состояние уже сохранено в localStorage
            // и пользователь сможет вернуться. Завершение сессии происходит только по кнопке "Стоп".
            // Если нужна 100% гарантия сохранения, то нужно логировать сессии периодически,
            // а не только в конце.
        }
    });
    
    // --- Восстановление состояния при загрузке страницы ---
    const persistentState = getTimerState();
    if (persistentState && persistentState.isActive && persistentState.taskName === pageState.taskName) {
        console.log("Восстановление состояния таймера...");
        pageState.startTime = persistentState.startTime;
        pageState.totalDuration = persistentState.totalDuration;
        pageState.elapsedSeconds = Math.floor((Date.now() - pageState.startTime) / 1000);
        start(); // Запускаем таймер с восстановленным состоянием
    } else {
        updateUI(); // Иначе просто отрисовываем UI по умолчанию
    }
}

// =======================================================
//        ДИНАМИКА И ЧАРТЫ
// =======================================================
function initDynamicsPage() {
    const uid = document.body.dataset.userId;
    const weeksFilter = document.getElementById('weeks-filter');
    const dayPicker = document.getElementById('day-picker');
    const ctxDaily = document.getElementById('dailyActivityChart')?.getContext('2d');
    const ctxHourly = document.getElementById('hourlyActivityChart')?.getContext('2d');
    let dailyChart, hourlyChart, dataAll;

    async function fetchData() {
        try {
            const res = await fetch(`/api/dynamics_data/${uid}`);
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            dataAll = await res.json();
            
            renderCalendars(dataAll.calendars);
            
            weeksFilter.innerHTML = '';
            for (let i = 1; i <= dataAll.total_weeks; i++) weeksFilter.add(new Option(`${i} нед.`, i));
            weeksFilter.value = Math.min(4, dataAll.total_weeks || 1);
            
            dayPicker.value = new Date().toISOString().split('T')[0];
            
            renderDailyChart(weeksFilter.value);
            renderHourlyChart(dayPicker.value);

        } catch (e) {
            console.error('Failed to fetch dynamics data:', e);
            document.getElementById('charts-container').innerHTML = '<p>Не удалось загрузить данные для аналитики.</p>';
        }
    }

    function renderCalendars(cals) {
        const cont = document.getElementById('calendars-container');
        cont.innerHTML = '';
        if (!cals || Object.keys(cals).length === 0) {
            cont.innerHTML = '<p>Нет данных по задачам для отображения календарей.</p>';
            return;
        }
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        Object.entries(cals).forEach(([task, dates]) => {
            if (!task) return; // Пропускаем пустые названия задач
            const div = document.createElement('div');
            div.className = 'calendar';
            let html = `<div class="calendar-header">${task}</div><div class="calendar-body">`;
            ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].forEach(d => html += `<div class="calendar-day header">${d}</div>`);
            
            const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
            const offset = monthStart.getDay() === 0 ? 6 : monthStart.getDay() - 1;
            for (let i = 0; i < offset; i++) html += `<div class="calendar-day"></div>`;
            
            let currentDate = new Date(monthStart);
            while (currentDate.getMonth() === today.getMonth()) {
                const ds = currentDate.toISOString().split('T')[0];
                let cls = 'calendar-day';
                if (dates.includes(ds)) cls += ' active';
                if (currentDate.getTime() === today.getTime()) cls += ' today';
                
                html += `<div class="${cls}">${currentDate.getDate()}</div>`;
                currentDate.setDate(currentDate.getDate() + 1);
            }
            html += '</div>';
            div.innerHTML = html;
            cont.appendChild(div);
        });
    }

    function renderDailyChart(weeks) {
        if (!ctxDaily || !dataAll.activity_by_day.labels.length) return;
        const days = weeks * 7;
        const labels = dataAll.activity_by_day.labels.slice(-days);
        const vals = dataAll.activity_by_day.data.slice(-days);
        if (dailyChart) dailyChart.destroy();
        dailyChart = new Chart(ctxDaily, {
            type: 'bar',
            data: {
                labels,
                datasets: [{ data: vals, label: 'Часы работы', backgroundColor: 'rgba(0, 122, 255, 0.6)', borderWidth: 0 }]
            },
            options: { scales: { y: { beginAtZero: true, suggestedMax: 8 } }, plugins: { legend: { display: false } }, responsive: true, maintainAspectRatio: false }
        });
    }

    function renderHourlyChart(day) {
        if (!ctxHourly || !dataAll.activity_by_hour.length) return;
        const hourlyData = Array(24).fill(0);
        dataAll.activity_by_hour.forEach(s => {
            const startDate = new Date(s.start_time);
            if (startDate.toISOString().startsWith(day)) {
                hourlyData[startDate.getUTCHours()] += s.duration_hours;
            }
        });

        if (hourlyChart) hourlyChart.destroy();
        hourlyChart = new Chart(ctxHourly, {
            type: 'bar',
            data: {
                labels: Array.from({ length: 24 }, (_, i) => `${i}:00`),
                datasets: [{ data: hourlyData, label: `Часы за ${day}`, backgroundColor: 'rgba(52, 199, 89, 0.6)', borderWidth: 0 }]
            },
            options: { scales: { y: { beginAtZero: true } }, plugins: { legend: { display: false } }, responsive: true, maintainAspectRatio: false }
        });
    }

    weeksFilter.addEventListener('change', () => renderDailyChart(weeksFilter.value));
    dayPicker.addEventListener('change', () => renderHourlyChart(dayPicker.value));

    fetchData();
}

// =======================================================
//        ИНИЦИАЛИЗАЦИЯ СТРАНИЦЫ
// =======================================================
document.addEventListener('DOMContentLoaded', () => {
    globalUserId = document.body.dataset.userId;
    
    // Глобальная инициализация для всех страниц
    initFabAndModals();
    updatePersistentBar(); // Проверяем и показываем плашку при загрузке

    // Инициализация для конкретных страниц
    if (document.querySelector('.timer-page')) initTimerPage();
    if (document.querySelector('.dynamics-page')) initDynamicsPage();
});
