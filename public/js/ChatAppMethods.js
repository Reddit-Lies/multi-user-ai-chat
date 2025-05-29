// Voting and UI Methods for ChatApp
// This extends the main ChatApp class

ChatApp.prototype.startVotingCountdown = function(data) {
    this.votingSession = {
        timeRemaining: data.timeRemaining,
        requiredVotes: data.requiredVotes
    };
    
    this.submitPromptBtn.classList.add('hidden');
    this.countdownTimer.classList.remove('hidden');
    this.votingStatus.classList.remove('hidden');
    
    this.updateCountdownDisplay();
};

ChatApp.prototype.updateVotingCountdown = function(data) {
    if (this.votingSession) {
        this.votingSession.timeRemaining = data.timeRemaining;
        this.votingSession.requiredVotes = data.requiredVotes;
        this.updateCountdownDisplay();
    }
};

ChatApp.prototype.updateCountdownDisplay = function() {
    if (!this.votingSession) return;
    
    const seconds = Math.ceil(this.votingSession.timeRemaining / 1000);
    this.timerText.textContent = `Voting ends in: ${seconds}s`;
    
    if (seconds <= 0) {
        this.endVotingCountdown();
    }
};

ChatApp.prototype.endVotingCountdown = function(message) {
    this.votingSession = null;
    this.countdownTimer.classList.add('hidden');
    this.votingStatus.classList.add('hidden');
    this.submitPromptBtn.classList.remove('hidden');
    
    if (message && typeof message === 'string') {
        this.showNotification(message, 'info');
    }
};

ChatApp.prototype.updateVotingStatus = function(data) {
    if (!data) return;
    
    const requiredVotes = data.requiredVotes;
    const totalUsers = data.totalUsers;
    
    if (data.prompts && data.prompts.length > 0) {
        const maxVotes = Math.max(...data.prompts.map(p => p.votes));
        const votesNeeded = Math.max(0, requiredVotes - maxVotes);
        
        if (votesNeeded > 0) {
            this.votesNeeded.textContent = `${votesNeeded} more vote${votesNeeded !== 1 ? 's' : ''} needed (${requiredVotes} of ${totalUsers})`;
        } else {
            this.votesNeeded.textContent = `Ready to select! (${requiredVotes} of ${totalUsers} votes)`;
        }
    } else {
        this.votesNeeded.textContent = `${requiredVotes} of ${totalUsers} votes needed`;
    }
};

ChatApp.prototype.showClearVoteModal = function(data) {
    this.clearVoteText.textContent = `${data.proposer} has proposed to clear the chat. Do you want to clear all messages?`;
    this.hasVotedClear = false;
    this.clearVoteModal.classList.remove('hidden');
    this.updateClearVoteButtons();
};

ChatApp.prototype.updateClearVoteStatus = function(data) {
    this.yesCount.textContent = `Yes: ${data.yesVotes}`;
    this.noCount.textContent = `No: ${data.noVotes}`;
    
    // Check if current user has voted
    if (data.hasVoted && data.hasVoted.has && data.hasVoted.has(this.socket.id)) {
        this.hasVotedClear = true;
        this.updateClearVoteButtons();
    }
};

ChatApp.prototype.updateClearVoteButtons = function() {
    this.voteYesBtn.disabled = this.hasVotedClear;
    this.voteNoBtn.disabled = this.hasVotedClear;
    
    if (this.hasVotedClear) {
        this.voteYesBtn.textContent = 'Voted';
        this.voteNoBtn.textContent = 'Voted';
    }
};

ChatApp.prototype.voteClear = function(vote) {
    if (!this.hasVotedClear && this.isConnected) {
        this.socket.emit('clear_vote', vote);
        this.hasVotedClear = true;
        this.updateClearVoteButtons();
    }
};

ChatApp.prototype.hideClearVoteModal = function() {
    this.clearVoteModal.classList.add('hidden');
    this.hasVotedClear = false;
};

ChatApp.prototype.addMessage = function(type, sender, content, tokensUsed = 0, animate = true) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;
    if (!animate) messageDiv.style.animation = 'none';
    
    const timestamp = new Date().toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: false
    });
    
    // Create avatar for non-system messages
    if (type !== 'system') {
        const avatarDiv = document.createElement('div');
        avatarDiv.className = 'message-avatar';
        const avatarCanvas = document.createElement('canvas');
        avatarCanvas.width = 40;
        avatarCanvas.height = 40;
        jdenticon.update(avatarCanvas, type === 'ai' ? 'AI-Assistant' : sender);
        avatarDiv.appendChild(avatarCanvas);
        messageDiv.appendChild(avatarDiv);
    }

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'message-body';
    
    let headerText = '';
    if (type === 'system') {
        headerText = 'System';
    } else {
        headerText = `<span class="username">${this.escapeHtml(sender)}</span><span class="timestamp">${timestamp}</span>`;
    }
    
    bodyDiv.innerHTML = `
        <div class="message-header">${headerText}</div>
        <div class="message-content">${this.formatMessageContent(content)}</div>
    `;
    
    messageDiv.appendChild(bodyDiv);
    this.messages.appendChild(messageDiv);

    if (type === 'ai') {
        this.totalTokens += tokensUsed;
        this.updateTokenUsage();
        this.setButtonLoading(this.sendBtn, false);
        this.setButtonLoading(this.submitPromptBtn, false);
    }
    
    this.scrollToBottom();
};

ChatApp.prototype.formatMessageContent = function(content) {
    // Basic formatting: convert newlines to <br> and escape HTML
    return this.escapeHtml(content).replace(/\n/g, '<br>');
};

ChatApp.prototype.scrollToBottom = function() {
    // Always scroll to bottom for new messages, especially AI responses
    setTimeout(() => {
        this.messages.scrollTo({
            top: this.messages.scrollHeight,
            behavior: 'smooth'
        });
    }, 100);
};

ChatApp.prototype.updateUserCount = function(count) {
    this.userCount.textContent = `${count} user${count !== 1 ? 's' : ''} online`;
};

ChatApp.prototype.updateTokenUsage = function() {
    this.tokenUsage.textContent = `Tokens used: ${this.totalTokens.toLocaleString()}`;
};

ChatApp.prototype.renderPrompts = function(prompts) {
    this.promptList.innerHTML = '';
    if (prompts.length === 0) {
        this.promptList.innerHTML = '<p style="text-align: center; color: #9ca3af; font-style: italic; padding: 20px;">No prompts yet. Be the first to submit one!</p>';
        return;
    }
    
    prompts.forEach(prompt => {
        this.addPromptToList(prompt);
    });
};

ChatApp.prototype.addPromptToList = function(prompt) {
    const promptDiv = document.createElement('div');
    promptDiv.className = 'prompt';
    
    const isVoted = this.votedPrompts.has(prompt.id);
    const timeAgo = this.getTimeAgo(new Date(prompt.timestamp));
    
    promptDiv.innerHTML = `
        <div class="prompt-text">${this.escapeHtml(prompt.text)}</div>
        <div class="prompt-meta">
            <span>by ${this.escapeHtml(prompt.submitter)} • ${timeAgo}</span>
            <span class="prompt-votes">${prompt.votes} vote${prompt.votes !== 1 ? 's' : ''}</span>
        </div>
        <button class="vote-btn" data-prompt-id="${prompt.id}" ${isVoted ? 'disabled' : ''}>
            ${isVoted ? 'Voted' : 'Vote'}
        </button>
    `;
    
    this.promptList.appendChild(promptDiv);
};

ChatApp.prototype.getTimeAgo = function(date) {
    const now = new Date();
    const diff = now - date;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'just now';
};

ChatApp.prototype.setButtonLoading = function(button, loading) {
    const textSpan = button.querySelector('.btn-text');
    const loadingSpan = button.querySelector('.loading');
    
    if (loading) {
        textSpan.classList.add('hidden');
        loadingSpan.classList.remove('hidden');
        button.disabled = true;
    } else {
        textSpan.classList.remove('hidden');
        loadingSpan.classList.add('hidden');
        button.disabled = false;
    }
};

ChatApp.prototype.showNotification = function(message, type = 'info') {
    // Remove existing notifications
    const existingNotifications = document.querySelectorAll('.notification');
    existingNotifications.forEach(n => n.remove());
    
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
        if (notification.parentNode) {
            notification.style.animation = 'slideInRight 0.3s ease-out reverse';
            setTimeout(() => notification.remove(), 300);
        }
    }, 5000);
};

ChatApp.prototype.escapeHtml = function(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
};

// Disabled functions for direct messaging
ChatApp.prototype.adjustTextareaHeight = function() {
    return; // Not needed since messaging is disabled
};

ChatApp.prototype.handleTyping = function() {
    return; // Not needed since messaging is disabled
};

ChatApp.prototype.toggleEmojiPicker = function() {
    this.showNotification('Emoji picker disabled - direct messaging not available', 'info');
};

ChatApp.prototype.showEmojiPicker = function() {
    return;
};

ChatApp.prototype.hideEmojiPicker = function() {
    return;
};

ChatApp.prototype.insertEmoji = function(emoji) {
    return;
};
