document.addEventListener('DOMContentLoaded', () => {
  // Динамическое приветствие в зависимости от времени суток
  function setGreeting() {
    const greetingEl = document.querySelector('.greeting');
    if (!greetingEl) return;

    const userName = document.body.dataset.userId || 'Тимофей';
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

  // Логика управления панелями
  const sidebar = document.querySelector('.sidebar');
  const bottomPanel = document.getElementById('compose-thought-panel');

  function toggleSidebar() {
    sidebar.classList.toggle('visible');
  }

  function toggleBottomPanel() {
    bottomPanel.classList.toggle('open');
    if (bottomPanel.classList.contains('open')) {
      document.getElementById('thought-input').focus();
    }
  }

  // Назначаем обработчики на кнопки
  document.body.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;

    if (action === 'toggle-sidebar') {
      toggleSidebar();
    }

    if (action === 'toggle-compose-panel') {
      toggleBottomPanel();
    }
  });

  // Инициализация
  setGreeting();
});
