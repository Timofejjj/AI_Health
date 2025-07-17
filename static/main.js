document.addEventListener('DOMContentLoaded', () => {

    // 1. Динамическое приветствие в зависимости от времени суток
    function setGreeting() {
        const greetingEl = document.querySelector('.greeting');
        if (!greetingEl) return;

        const userName = document.body.dataset.userId || 'Пользователь';
        const hour = new Date().getHours();
        let greetingText = '';

        if (hour >= 4 && hour < 12) {
            greetingText = 'Доброе утро';
        } else if (hour >= 12 && hour < 17) {
            greetingText = 'Добрый день';
        } else if (hour >= 17 && hour < 23) {
            greetingText = 'Добрый вечер';
        } else {
            greetingText = 'Доброй ночи';
        }
        
        greetingEl.textContent = `${greetingText}, ${userName}`;
    }

    // 2. Логика управления панелями (пока только заготовки)
    const leftPane = document.getElementById('thoughts-list-pane');
    const composePanel = document.getElementById('compose-thought-panel');
    
    // Функция для переключения левой панели
    function toggleLeftPane() {
        leftPane.classList.toggle('visible');
    }

    // Функция для переключения нижней панели
    function toggleComposePanel() {
        composePanel.classList.toggle('open');
        // При открытии можно сразу фокусироваться на поле ввода
        if (composePanel.classList.contains('open')) {
            document.getElementById('thought-input').focus();
        }
    }

    // Назначаем обработчики на кнопки
    document.body.addEventListener('click', (e) => {
        const target = e.target.closest('[data-action]');
        if (!target) return;

        const action = target.dataset.action;

        if (action === 'toggle-left-pane') {
            toggleLeftPane();
        }

        if (action === 'toggle-compose-panel') {
            toggleComposePanel();
        }
        
        // Другие действия будут добавлены здесь
    });


    // --- Инициализация ---
    setGreeting();

});
