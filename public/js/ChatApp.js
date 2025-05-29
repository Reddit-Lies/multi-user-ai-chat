class ChatApp {
    constructor() {
        this.socket = null;
        this.username = '';
        this.isConnected = false;
        this.totalTokens = 0;
        this.votedPrompts = new Set();
        this.isTyping = false;
        this.typingTimer = null;
        this.hasVotedClear = false;
        this.activityTimer = null;
        this.votingSession = null;
        this.initializeElements();
        this.setupEventListeners();
        this.setupActivityTracking();
    }

    initializeElements() {
        // Main containers
        this.usernameSetup = document.getElementById('usernameSetup');
        this.content = document.querySelector('.content');
        this.messages = document.getElementById('messages');
        
        // Input elements
        this.messageInput = document.getElementById('messageInput');
        this.messageForm = document.getElementById('messageForm');
        this.sendBtn = document.getElementById('sendBtn');
        this.usernameInput = document.getElementById('usernameInput');
        this.joinBtn = document.getElementById('joinBtn');
        
        // Prompt elements
        this.promptInput = document.getElementById('promptInput');
        this.submitPromptBtn = document.getElementById('submitPromptBtn');
        this.promptList = document.getElementById('promptList');
        
        // Status elements
        this.userCount = document.getElementById('userCount');
        this.aiTypingIndicator = document.getElementById('aiTypingIndicator');
        this.userTypingIndicator = document.getElementById('userTypingIndicator');
        this.tokenUsage = document.getElementById('tokenUsage');
        this.clearChatBtn = document.getElementById('clearChatBtn');
        
        // Clear vote modal
        this.clearVoteModal = document.getElementById('clearVoteModal');
        this.clearVoteText = document.getElementById('clearVoteText');
        this.voteYesBtn = document.getElementById('voteYesBtn');
        this.voteNoBtn = document.getElementById('voteNoBtn');
        this.yesCount = document.getElementById('yesCount');
        this.noCount = document.getElementById('noCount');
        
        // Voting system elements
        this.countdownTimer = document.getElementById('countdownTimer');
        this.timerText = document.getElementById('timerText');
        this.votingStatus = document.getElementById('votingStatus');
        this.votesNeeded = document.getElementById('votesNeeded');
        
        // Emoji picker
        this.emojiBtn = document.getElementById('emojiBtn');
        this.emojiPicker = document.getElementById('emojiPicker');
    }

    setupEventListeners() {
        // Join chat
        this.joinBtn.addEventListener('click', () => this.joinChat());
        this.usernameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.joinChat();
        });

        // Message input is disabled for direct messaging
        this.messageForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.showNotification('Direct messaging is disabled. Use community prompts instead!', 'warning');
        });

        // Prompt submission
        this.submitPromptBtn.addEventListener('click', () => this.submitPrompt());
        this.promptInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.submitPrompt();
            }
        });

        // Activity tracking for prompt input
        this.promptInput.addEventListener('input', () => {
            this.trackActivity();
        });

        // Prompt voting
        this.promptList.addEventListener('click', (e) => {
            if (e.target.classList.contains('vote-btn')) {
                this.votePrompt(e.target.dataset.promptId);
                this.trackActivity();
            }
        });

        // Clear chat
        this.clearChatBtn.addEventListener('click', () => {
            this.proposeClearChat();
            this.trackActivity();
        });

        // Clear vote modal
        this.voteYesBtn.addEventListener('click', () => {
            this.voteClear('yes');
            this.trackActivity();
        });
        this.voteNoBtn.addEventListener('click', () => {
            this.voteClear('no');
            this.trackActivity();
        });

        // General activity tracking
        document.addEventListener('click', () => this.trackActivity());
        document.addEventListener('keypress', () => this.trackActivity());
        document.addEventListener('scroll', () => this.trackActivity());
    }

    setupActivityTracking() {
        // Track user activity to prevent timeout
        this.trackActivity();
        
        // Set up periodic activity check
        setInterval(() => {
            if (this.isConnected) {
                this.socket.emit('user_activity');
            }
        }, 30000); // Send activity signal every 30 seconds
    }

    trackActivity() {
        if (this.isConnected && this.socket) {
            this.socket.emit('user_activity');
        }
    }

    joinChat() {
        const username = this.usernameInput.value.trim();
        if (!username) {
            this.showNotification('Please enter a username', 'error');
            return;
        }

        if (username.length < 2 || username.length > 20) {
            this.showNotification('Username must be 2-20 characters long', 'error');
            return;
        }

        if (!/^[a-zA-Z0-9_\-\s]+$/.test(username)) {
            this.showNotification('Username can only contain letters, numbers, spaces, hyphens, and underscores', 'error');
            return;
        }

        this.setButtonLoading(this.joinBtn, true);
        this.username = username;
        this.connectToServer();
    }

    connectToServer() {
        this.socket = io();
        
        this.socket.on('connect', () => {
            this.isConnected = true;
            this.socket.emit('join', this.username);
        });

        this.socket.on('join_success', () => {
            this.setButtonLoading(this.joinBtn, false);
            this.usernameSetup.classList.add('hidden');
            this.content.classList.remove('hidden');
            this.content.classList.add('fade-in');
            this.messageInput.focus();
            this.showNotification(`Welcome, ${this.username}!`, 'success');
        });

        this.socket.on('join_error', (error) => {
            this.setButtonLoading(this.joinBtn, false);
            this.showNotification(error, 'error');
        });

        this.socket.on('disconnect', () => {
            this.isConnected = false;
            this.showNotification('Lost connection to server. Refresh to reconnect.', 'error');
        });

        this.socket.on('conversation_history', (history) => {
            history.forEach(msg => {
                this.addMessage(msg.type, msg.username, msg.content, msg.tokensUsed || 0, false);
            });
            this.scrollToBottom();
        });

        this.socket.on('new_message', (messageData) => {
            this.addMessage(messageData.type, messageData.username, messageData.content, messageData.tokensUsed || 0);
        });

        this.socket.on('user_joined', (data) => {
            this.updateUserCount(data.userCount);
        });

        this.socket.on('user_left', (data) => {
            this.updateUserCount(data.userCount);
        });

        this.socket.on('user_count_update', (count) => {
            this.updateUserCount(count);
        });

        this.socket.on('ai_typing', (isTyping) => {
            this.aiTypingIndicator.style.display = isTyping ? 'flex' : 'none';
        });

        this.socket.on('user_typing', (data) => {
            const count = data.count || 0;
            const users = data.users || [];
            
            if (count > 0) {
                const userList = users.length <= 3 ? users.join(', ') : `${users.slice(0, 2).join(', ')} and ${users.length - 2} others`;
                this.userTypingIndicator.textContent = `${userList} ${count === 1 ? 'is' : 'are'} typing...`;
            } else {
                this.userTypingIndicator.textContent = '';
            }
        });

        this.socket.on('prompts_list', (prompts) => {
            this.renderPrompts(prompts);
        });

        this.socket.on('new_prompt', (prompt) => {
            this.addPromptToList(prompt);
        });

        this.socket.on('prompt_error', (error) => {
            this.showNotification(error, 'error');
            this.setButtonLoading(this.submitPromptBtn, false);
        });

        this.socket.on('vote_error', (error) => {
            this.showNotification(error, 'error');
        });

        this.socket.on('clear_chat', () => {
            this.messages.innerHTML = '';
            this.totalTokens = 0;
            this.updateTokenUsage();
        });

        this.socket.on('clear_vote_start', (data) => {
            this.showClearVoteModal(data);
        });

        this.socket.on('clear_vote_update', (data) => {
            this.updateClearVoteStatus(data);
        });

        this.socket.on('clear_vote_end', () => {
            this.hideClearVoteModal();
        });

        this.socket.on('clear_vote_error', (error) => {
            this.showNotification(error, 'error');
        });

        this.socket.on('system_notification', (message) => {
            this.showNotification(message, 'info');
        });

        this.socket.on('ai_error', (error) => {
            this.showNotification(error, 'error');
            this.setButtonLoading(this.sendBtn, false);
        });

        this.socket.on('user_timeout', (message) => {
            this.showNotification(message, 'warning');
            setTimeout(() => {
                window.location.reload();
            }, 3000);
        });

        this.socket.on('message_blocked', (message) => {
            this.showNotification(message, 'info');
        });

        this.socket.on('prompt_voting_start', (data) => {
            this.startVotingCountdown(data);
        });

        this.socket.on('prompt_voting_update', (data) => {
            this.updateVotingCountdown(data);
        });

        this.socket.on('prompt_voting_end', (message) => {
            this.endVotingCountdown(message);
        });

        this.socket.on('voting_status_update', (data) => {
            this.updateVotingStatus(data);
        });

        this.socket.on('prompt_voting_active', (data) => {
            this.startVotingCountdown(data);
            this.updateVotingStatus(data);
        });

        this.socket.on('connect_error', () => {
            this.setButtonLoading(this.joinBtn, false);
            this.showNotification('Failed to connect to server. Please try again.', 'error');
        });
    }

    // Direct messaging is disabled
    sendMessage() {
        this.showNotification('Direct messaging is disabled. Please use community prompts!', 'warning');
    }

    submitPrompt() {
        const promptText = this.promptInput.value.trim();
        if (!promptText) {
            this.showNotification('Please enter a prompt', 'error');
            return;
        }

        if (promptText.length > 500) {
            this.showNotification('Prompt too long. Maximum 500 characters.', 'error');
            return;
        }

        if (!this.isConnected) {
            this.showNotification('Not connected to server', 'error');
            return;
        }

        this.setButtonLoading(this.submitPromptBtn, true);
        this.socket.emit('submit_prompt', promptText);
        this.promptInput.value = '';
    }

    votePrompt(promptId) {
        if (!this.votedPrompts.has(promptId) && this.isConnected) {
            this.socket.emit('vote_prompt', promptId);
            this.votedPrompts.add(promptId);
            
            // Disable the button immediately for better UX
            const btn = this.promptList.querySelector(`[data-prompt-id="${promptId}"]`);
            if (btn) {
                btn.disabled = true;
                btn.textContent = 'Voted';
            }
        }
    }

    proposeClearChat() {
        if (this.isConnected) {
            this.socket.emit('propose_clear');
        }
    }

    // Voting countdown methods will be in the next file...
