// Application Initialization and Global Event Handlers

// Initialize the chat application
const chatApp = new ChatApp();

// Service Worker registration for PWA functionality (optional)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {
            // Service worker registration failed, but app should still work
            console.log('Service worker registration failed');
        });
    });
}

// Handle page visibility change
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // Page is hidden - user switched tabs or minimized
        if (chatApp.socket && chatApp.isConnected) {
            chatApp.socket.emit('user_away');
        }
    } else {
        // Page is visible - user came back
        if (chatApp.socket && chatApp.isConnected) {
            chatApp.socket.emit('user_back');
            chatApp.trackActivity();
        }
    }
});

// Handle beforeunload to clean up
window.addEventListener('beforeunload', () => {
    if (chatApp.socket && chatApp.isConnected) {
        chatApp.socket.emit('user_leaving');
    }
});

// Global error handler
window.addEventListener('error', (event) => {
    console.error('Global error:', event.error);
    if (chatApp && chatApp.showNotification) {
        chatApp.showNotification('An unexpected error occurred. Please refresh if issues persist.', 'error');
    }
});

// Handle connection issues
window.addEventListener('online', () => {
    if (chatApp && chatApp.showNotification) {
        chatApp.showNotification('Connection restored', 'success');
    }
});

window.addEventListener('offline', () => {
    if (chatApp && chatApp.showNotification) {
        chatApp.showNotification('Connection lost. Please check your internet.', 'warning');
    }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + Enter to submit prompt
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if (chatApp.promptInput === document.activeElement) {
            e.preventDefault();
            chatApp.submitPrompt();
        }
    }
    
    // Escape to close modals
    if (e.key === 'Escape') {
        if (!chatApp.clearVoteModal.classList.contains('hidden')) {
            chatApp.hideClearVoteModal();
        }
    }
    
    // Track activity for any key press
    if (chatApp && chatApp.trackActivity) {
        chatApp.trackActivity();
    }
});

// Prevent context menu on certain elements for better UX
document.addEventListener('contextmenu', (e) => {
    if (e.target.classList.contains('message-avatar') || 
        e.target.classList.contains('vote-btn') ||
        e.target.classList.contains('clear-chat-btn')) {
        e.preventDefault();
    }
});

// Handle focus management for accessibility
document.addEventListener('focusin', (e) => {
    if (chatApp && chatApp.trackActivity) {
        chatApp.trackActivity();
    }
});

// Auto-focus username input when page loads
window.addEventListener('load', () => {
    if (chatApp && chatApp.usernameInput) {
        chatApp.usernameInput.focus();
    }
});

// Handle mobile viewport changes
let vh = window.innerHeight * 0.01;
document.documentElement.style.setProperty('--vh', `${vh}px`);

window.addEventListener('resize', () => {
    let vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);
});

// Debug mode toggle (for development)
if (window.location.search.includes('debug=true')) {
    window.chatAppDebug = chatApp;
    console.log('Debug mode enabled. Access chatApp via window.chatAppDebug');
}

// Performance monitoring
if ('performance' in window) {
    window.addEventListener('load', () => {
        setTimeout(() => {
            const perfData = performance.getEntriesByType('navigation')[0];
            console.log(`Page load time: ${perfData.loadEventEnd - perfData.loadEventStart}ms`);
        }, 0);
    });
}

// Theme detection (optional - for future dark mode support)
if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.body.classList.add('dark-mode-preferred');
}

// Accessibility improvements
document.addEventListener('keydown', (e) => {
    // Skip to main content with Alt+S
    if (e.altKey && e.key === 's') {
        e.preventDefault();
        const messages = document.getElementById('messages');
        if (messages) {
            messages.focus();
            messages.scrollTop = messages.scrollHeight;
        }
    }
});

// Console welcome message
console.log(`
🤖 Multi-User AI Chat
Version: 2.0.0
Status: Ready

Features:
- Community-driven AI prompts
- Real-time voting system
- User activity timeout (5 min)
- Mobile-responsive design
- Modern UI/UX

Enjoy chatting!
`);

export { chatApp };
