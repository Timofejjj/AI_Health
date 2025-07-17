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

    // 2. Логика управления панелями
    const leftPane = document.getElementById('thoughts-list-pane');
    const composePanel = document.getElementById('compose-thought-panel');
    
    // Функция для переключения левой панели
    function toggleLeftPane() {
        leftPane.classList.toggle('visible');
        if (leftPane.classList.contains('visible')) {
            loadThoughts();
        }
    }

    // Функция для переключения нижней панели
    function toggleComposePanel() {
        composePanel.classList.toggle('open');
        if (composePanel.classList.contains('open')) {
            document.getElementById('thought-input').focus();
        }
    }

    // 3. Загрузка списка мыслей
    async function loadThoughts() {
        const userId = document.body.dataset.userId;
        try {
            const response = await fetch(`/api/thoughts/${userId}`);
            const thoughts = await response.json();
            const thoughtsList = document.getElementById('thoughts-list');
            thoughtsList.innerHTML = '';
            thoughts.forEach(thought => {
                const item = document.createElement('div');
                item.classList.add('list-item');
                item.innerHTML = `
                    <div class="item-meta">${new Date(thought.timestamp).toLocaleString()}</div>
                    <div class="item-content">${thought.content}</div>
                `;
                thoughtsList.appendChild(item);
            });
        } catch (error) {
            console.error('Ошибка загрузки мыслей:', error);
        }
    }

    // 4. Отправка новой мысли
    async function submitThought() {
        const thoughtInput = document.getElementById('thought-input');
        const thought = thoughtInput.value.trim();
        if (!thought) return;
        const userId = document.body.dataset.userId;
        try {
            const response = await fetch(`/api/thoughts/${userId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ thought })
            });
            if (response.ok) {
                thoughtInput.value = '';
                toggleComposePanel(); // Закрываем панель
                if (leftPane.classList.contains('visible')) {
                    loadThoughts(); // Обновляем список, если панель открыта
                }
            } else {
                console.error('Ошибка отправки мысли');
            }
        } catch (error) {
            console.error('Ошибка отправки мысли:', error);
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

        if (action === 'submit-thought') {
            submitThought();
        }
    });

    // --- Инициализация ---
    setGreeting();
});
