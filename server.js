const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Fix: Serve static files from the correct directory
app.use(express.static(path.join(__dirname, 'public')));

// Enhanced data structures
const connectedUsers = new Map();
const conversationHistory = [];
const prompts = [];
let clearVoteSession = null;
const typingUsers = new Set();
let promptVotingSession = null;
const MAX_HISTORY = 150;
const MAX_PROMPTS = 20;
const USER_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const PROMPT_VOTING_TIME = 60 * 1000; // 60 seconds

// AI Configuration with fallback
const AI_CONFIG = {
    openai: {
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        model: 'gpt-3.5-turbo'
    },
    xai: {
        url: 'https://api.x.ai/v1/chat/completions',
        headers: {
            'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        model: 'grok-beta'
    },
    claude: {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
            'Authorization': `Bearer ${process.env.ANTHROPIC_API_KEY}`,
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01'
        },
        model: 'claude-3-haiku-20240307'
    }
};

const AI_PROVIDER = process.env.AI_PROVIDER || 'openai';

// Utility functions
function sanitizeMessage(message) {
    return message.trim().substring(0, 2000); // Limit message length
}

function isValidUsername(username) {
    return username && 
           username.trim().length >= 2 && 
           username.trim().length <= 20 && 
           /^[a-zA-Z0-9_\-\s]+$/.test(username.trim());
}

function getUsernameById(socketId) {
    const user = connectedUsers.get(socketId);
    return user ? user.username : 'Unknown User';
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);

    socket.on('join', (username) => {
        const sanitizedUsername = username.trim();
        
        if (!isValidUsername(sanitizedUsername)) {
            socket.emit('join_error', 'Username must be 2-20 characters and contain only letters, numbers, spaces, hyphens, and underscores.');
            return;
        }

        // Check for duplicate usernames
        const existingUser = Array.from(connectedUsers.values()).find(user => 
            user.username.toLowerCase() === sanitizedUsername.toLowerCase()
        );
        
        if (existingUser) {
            socket.emit('join_error', 'Username already taken. Please choose another.');
            return;
        }

        const userData = {
            id: socket.id,
            username: sanitizedUsername,
            joinedAt: new Date(),
            isActive: true,
            lastActivity: new Date(),
            timeoutTimer: null
        };

        connectedUsers.set(socket.id, userData);
        
        // Set up user timeout
        setupUserTimeout(socket.id);
        
        // Send initial data
        socket.emit('join_success');
        socket.emit('conversation_history', conversationHistory);
        socket.emit('prompts_list', serializePrompts());
        
        // Send current prompt voting session if active
        if (promptVotingSession) {
            socket.emit('prompt_voting_active', {
                timeRemaining: Math.max(0, promptVotingSession.endTime - Date.now()),
                prompts: serializePrompts(),
                requiredVotes: getRequiredVotes()
            });
        }
        
        // Notify all users
        const joinMessage = {
            id: `system_${Date.now()}`,
            type: 'system',
            username: 'System',
            content: `${sanitizedUsername} joined the chat`,
            timestamp: new Date()
        };
        
        conversationHistory.push(joinMessage);
        io.emit('new_message', joinMessage);
        io.emit('user_joined', { username: sanitizedUsername, userCount: connectedUsers.size });
        io.emit('user_count_update', connectedUsers.size);
        
        console.log(`User ${sanitizedUsername} joined. Total users: ${connectedUsers.size}`);
    });

    socket.on('user_message', async (data) => {
        // Users can no longer send direct messages to AI
        // All AI interactions must go through community prompts
        socket.emit('message_blocked', 'Direct messages to AI are not allowed. Please submit a community prompt instead.');
    });

    socket.on('user_activity', () => {
        updateUserActivity(socket.id);
    });

    socket.on('typing', () => {
        const user = connectedUsers.get(socket.id);
        if (user) {
            updateUserActivity(socket.id);
            typingUsers.add(socket.id);
            socket.broadcast.emit('user_typing', {
                count: typingUsers.size,
                users: Array.from(typingUsers).map(id => getUsernameById(id)).filter(Boolean)
            });
        }
    });

    socket.on('stop_typing', () => {
        typingUsers.delete(socket.id);
        socket.broadcast.emit('user_typing', {
            count: typingUsers.size,
            users: Array.from(typingUsers).map(id => getUsernameById(id)).filter(Boolean)
        });
    });

    socket.on('submit_prompt', (text) => {
        const user = connectedUsers.get(socket.id);
        if (!user || !text || typeof text !== 'string') return;

        updateUserActivity(socket.id);

        const sanitizedText = text.trim().substring(0, 500);
        if (!sanitizedText) return;

        // Check for duplicate prompts
        const isDuplicate = prompts.some(p => 
            p.text.toLowerCase() === sanitizedText.toLowerCase() ||
            p.submitter === user.username
        );

        if (isDuplicate) {
            socket.emit('prompt_error', 'You already have a pending prompt or this prompt already exists.');
            return;
        }

        const prompt = {
            id: `prompt_${Date.now()}_${socket.id}`,
            text: sanitizedText,
            submitter: user.username,
            submitterId: socket.id,
            votes: new Set(),
            timestamp: new Date()
        };

        prompts.push(prompt);
        managePromptsLimit();
        
        // Start voting session if this is the first prompt
        if (!promptVotingSession) {
            startPromptVoting();
        }
        
        io.emit('new_prompt', serializePrompt(prompt));
        io.emit('prompts_list', serializePrompts());
        updateVotingStatus();
    });

    socket.on('vote_prompt', (promptId) => {
        const user = connectedUsers.get(socket.id);
        const prompt = prompts.find(p => p.id === promptId);
        
        if (!user || !prompt) {
            socket.emit('vote_error', 'Prompt not found.');
            return;
        }

        updateUserActivity(socket.id);

        if (prompt.submitterId === socket.id) {
            socket.emit('vote_error', 'You cannot vote for your own prompt.');
            return;
        }

        if (prompt.votes.has(socket.id)) {
            socket.emit('vote_error', 'You have already voted for this prompt.');
            return;
        }

        prompt.votes.add(socket.id);
        io.emit('prompts_list', serializePrompts());
        updateVotingStatus();
        
        // Check if prompt should be selected (majority vote)
        const requiredVotes = getRequiredVotes();
        if (prompt.votes.size >= requiredVotes) {
            selectPrompt(prompt);
        }
    });

    socket.on('propose_clear', () => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;

        if (clearVoteSession) {
            socket.emit('clear_vote_error', 'A clear vote is already in progress.');
            return;
        }

        if (connectedUsers.size < 2) {
            socket.emit('clear_vote_error', 'Need at least 2 users to propose clearing chat.');
            return;
        }

        startClearVote(user.username);
    });

    socket.on('clear_vote', (vote) => {
        if (!clearVoteSession || (vote !== 'yes' && vote !== 'no')) return;

        const user = connectedUsers.get(socket.id);
        if (!user) return;

        // Remove previous vote if exists
        clearVoteSession.yesVotes.delete(socket.id);
        clearVoteSession.noVotes.delete(socket.id);

        // Add new vote
        if (vote === 'yes') {
            clearVoteSession.yesVotes.add(socket.id);
        } else {
            clearVoteSession.noVotes.add(socket.id);
        }

        const totalVotes = clearVoteSession.yesVotes.size + clearVoteSession.noVotes.size;
        const yesPercentage = clearVoteSession.yesVotes.size / connectedUsers.size;
        const noPercentage = clearVoteSession.noVotes.size / connectedUsers.size;

        // Update vote status
        io.emit('clear_vote_update', {
            yesVotes: clearVoteSession.yesVotes.size,
            noVotes: clearVoteSession.noVotes.size,
            totalUsers: connectedUsers.size,
            hasVoted: new Set([...clearVoteSession.yesVotes, ...clearVoteSession.noVotes])
        });

        // Check for decision
        if (yesPercentage >= 0.7) { // 70% yes votes required
            executeClearChat();
        } else if (noPercentage >= 0.4 || totalVotes === connectedUsers.size) { // 40% no votes or everyone voted
            endClearVote('rejected');
        }
    });

    socket.on('disconnect', () => {
        handleUserDisconnect(socket.id);
    });
});

// Enhanced AI response generation
async function generateAIResponse(userMessage, history) {
    const config = AI_CONFIG[AI_PROVIDER];
    
    if (!config) {
        throw new Error(`Unknown AI provider: ${AI_PROVIDER}`);
    }

    // Build conversation context
    const recentHistory = history
        .filter(msg => msg.type !== 'system')
        .slice(-8)
        .map(msg => ({
            role: msg.type === 'user' ? 'user' : 'assistant',
            content: msg.content
        }));

    if (AI_PROVIDER === 'claude') {
        return await generateClaudeResponse(userMessage, recentHistory, config);
    } else {
        return await generateOpenAIStyleResponse(userMessage, recentHistory, config);
    }
}

async function generateOpenAIStyleResponse(userMessage, recentHistory, config) {
    const messages = [
        { 
            role: 'system', 
            content: 'You are a helpful AI assistant in a multi-user chat room. Be conversational, friendly, and concise. Keep responses under 300 words unless specifically asked for detailed information.' 
        },
        ...recentHistory,
        { role: 'user', content: userMessage }
    ];

    const requestBody = {
        model: config.model,
        messages,
        temperature: 0.7,
        max_tokens: 400,
        presence_penalty: 0.1,
        frequency_penalty: 0.1
    };

    try {
        const response = await axios.post(config.url, requestBody, {
            headers: config.headers,
            timeout: 30000
        });

        return {
            content: response.data.choices[0].message.content.trim(),
            usage: response.data.usage || { total_tokens: 0 }
        };
    } catch (error) {
        console.error('AI API Error:', error.response?.data || error.message);
        throw error;
    }
}

async function generateClaudeResponse(userMessage, recentHistory, config) {
    const contextMessages = recentHistory.map(msg => `${msg.role}: ${msg.content}`).join('\n');
    const fullPrompt = contextMessages ? `${contextMessages}\nuser: ${userMessage}` : userMessage;

    const requestBody = {
        model: config.model,
        max_tokens: 400,
        messages: [{ role: 'user', content: fullPrompt }],
        system: 'You are a helpful AI assistant in a multi-user chat room. Be conversational, friendly, and concise.'
    };

    try {
        const response = await axios.post(config.url, requestBody, {
            headers: config.headers,
            timeout: 30000
        });

        return {
            content: response.data.content[0].text.trim(),
            usage: response.data.usage || { total_tokens: 0 }
        };
    } catch (error) {
        console.error('Claude API Error:', error.response?.data || error.message);
        throw error;
    }
}

// Prompt management
async function selectPrompt(prompt) {
    // Clear the voting session
    if (promptVotingSession) {
        clearTimeout(promptVotingSession.timer);
        promptVotingSession = null;
    }

    const systemMessage = {
        id: `system_${Date.now()}`,
        type: 'system',
        username: 'System',
        content: `🗳️ Selected prompt: "${prompt.text}" (${prompt.votes.size} votes)`,
        timestamp: new Date()
    };

    conversationHistory.push(systemMessage);
    io.emit('new_message', systemMessage);

    try {
        io.emit('ai_typing', true);
        const aiResponse = await generateAIResponse(prompt.text, conversationHistory);
        
        const aiMessageData = {
            id: `ai_${Date.now()}`,
            type: 'ai',
            username: 'AI Assistant',
            content: aiResponse.content,
            tokensUsed: aiResponse.usage?.total_tokens || 0,
            timestamp: new Date()
        };

        conversationHistory.push(aiMessageData);
        manageHistoryLimit();
        
        io.emit('ai_typing', false);
        io.emit('new_message', aiMessageData);
        
        // Clear prompts after selection
        prompts.length = 0;
        io.emit('prompts_list', []);
        io.emit('prompt_voting_end');
        
    } catch (error) {
        console.error('Error processing selected prompt:', error);
        io.emit('ai_typing', false);
        io.emit('ai_error', 'Sorry, I encountered an error processing the selected prompt.');
    }
}

// Clear chat functionality
function startClearVote(proposerUsername) {
    clearVoteSession = {
        id: Date.now(),
        proposer: proposerUsername,
        yesVotes: new Set(),
        noVotes: new Set(),
        startTime: new Date(),
        timeout: setTimeout(() => endClearVote('timeout'), 60000) // 1 minute timeout
    };

    io.emit('clear_vote_start', {
        proposer: proposerUsername,
        totalUsers: connectedUsers.size,
        timeLimit: 60
    });
}

function executeClearChat() {
    conversationHistory.length = 0;
    prompts.length = 0;
    
    const clearMessage = {
        id: `system_${Date.now()}`,
        type: 'system',
        username: 'System',
        content: '🧹 Chat has been cleared by community vote.',
        timestamp: new Date()
    };
    
    conversationHistory.push(clearMessage);
    
    io.emit('clear_chat');
    io.emit('new_message', clearMessage);
    io.emit('prompts_list', []);
    
    endClearVote('approved');
}

function endClearVote(result = 'timeout') {
    if (clearVoteSession) {
        clearTimeout(clearVoteSession.timeout);
        
        let message = '';
        switch(result) {
            case 'approved':
                message = '✅ Clear chat vote passed.';
                break;
            case 'rejected':
                message = '❌ Clear chat vote failed.';
                break;
            case 'timeout':
                message = '⏰ Clear chat vote timed out.';
                break;
        }
        
        if (message) {
            io.emit('system_notification', message);
        }
        
        clearVoteSession = null;
        io.emit('clear_vote_end');
    }
}

// User timeout management
function setupUserTimeout(socketId) {
    const user = connectedUsers.get(socketId);
    if (!user) return;

    clearTimeout(user.timeoutTimer);
    user.timeoutTimer = setTimeout(() => {
        timeoutUser(socketId);
    }, USER_TIMEOUT);
}

function updateUserActivity(socketId) {
    const user = connectedUsers.get(socketId);
    if (user) {
        user.lastActivity = new Date();
        setupUserTimeout(socketId);
    }
}

function timeoutUser(socketId) {
    const user = connectedUsers.get(socketId);
    if (user) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
            socket.emit('user_timeout', 'You have been disconnected due to inactivity.');
            socket.disconnect(true);
        }
    }
}

// Prompt voting system
function startPromptVoting() {
    if (promptVotingSession) return;

    promptVotingSession = {
        id: Date.now(),
        startTime: Date.now(),
        endTime: Date.now() + PROMPT_VOTING_TIME,
        timer: setTimeout(endPromptVoting, PROMPT_VOTING_TIME)
    };

    io.emit('prompt_voting_start', {
        timeRemaining: PROMPT_VOTING_TIME,
        requiredVotes: getRequiredVotes()
    });

    // Update clients every second with remaining time
    const updateTimer = setInterval(() => {
        if (!promptVotingSession) {
            clearInterval(updateTimer);
            return;
        }

        const timeRemaining = Math.max(0, promptVotingSession.endTime - Date.now());
        io.emit('prompt_voting_update', {
            timeRemaining,
            requiredVotes: getRequiredVotes()
        });

        if (timeRemaining <= 0) {
            clearInterval(updateTimer);
        }
    }, 1000);
}

function endPromptVoting() {
    if (!promptVotingSession) return;

    clearTimeout(promptVotingSession.timer);
    promptVotingSession = null;

    // Select the prompt with the most votes
    if (prompts.length > 0) {
        const maxVotes = Math.max(...prompts.map(p => p.votes.size));
        if (maxVotes > 0) {
            const topPrompt = prompts.find(p => p.votes.size === maxVotes);
            selectPrompt(topPrompt);
        } else {
            // No votes, clear prompts and notify
            prompts.length = 0;
            io.emit('prompts_list', []);
            io.emit('prompt_voting_end', 'No votes received. Prompts cleared.');
        }
    }

    io.emit('prompt_voting_end');
}

function getRequiredVotes() {
    return Math.ceil(connectedUsers.size / 2); // 50% of users
}

function updateVotingStatus() {
    if (promptVotingSession) {
        io.emit('voting_status_update', {
            requiredVotes: getRequiredVotes(),
            totalUsers: connectedUsers.size,
            prompts: serializePrompts()
        });
    }
}

function handleUserDisconnect(socketId) {
    const user = connectedUsers.get(socketId);
    if (user) {
        // Clear timeout timer
        clearTimeout(user.timeoutTimer);
        
        // Remove user from all collections
        connectedUsers.delete(socketId);
        typingUsers.delete(socketId);
        
        // Remove votes from prompts
        prompts.forEach(prompt => {
            prompt.votes.delete(socketId);
        });
        
        // Remove from clear vote session
        if (clearVoteSession) {
            clearVoteSession.yesVotes.delete(socketId);
            clearVoteSession.noVotes.delete(socketId);
            
            // Check if clear vote should still continue
            if (connectedUsers.size === 0) {
                endClearVote('cancelled');
            }
        }
        
        // Update voting status if voting is active
        if (promptVotingSession) {
            updateVotingStatus();
        }
        
        // Add leave message
        const leaveMessage = {
            id: `system_${Date.now()}`,
            type: 'system',
            username: 'System',
            content: `${user.username} left the chat`,
            timestamp: new Date()
        };
        
        conversationHistory.push(leaveMessage);
        io.emit('new_message', leaveMessage);
        io.emit('user_left', { username: user.username, userCount: connectedUsers.size });
        io.emit('user_count_update', connectedUsers.size);
        io.emit('user_typing', { count: typingUsers.size, users: [] });
        
        console.log(`User ${user.username} disconnected. Total users: ${connectedUsers.size}`);
    }
}

// Utility functions for data management
function manageHistoryLimit() {
    while (conversationHistory.length > MAX_HISTORY) {
        conversationHistory.shift();
    }
}

function managePromptsLimit() {
    while (prompts.length > MAX_PROMPTS) {
        prompts.shift();
    }
}

function serializePrompts() {
    return prompts.map(prompt => serializePrompt(prompt));
}

function serializePrompt(prompt) {
    return {
        id: prompt.id,
        text: prompt.text,
        submitter: prompt.submitter,
        votes: prompt.votes.size,
        timestamp: prompt.timestamp
    };
}

// Periodic cleanup
setInterval(() => {
    // Auto-select most voted prompt if there are prompts older than 5 minutes
    if (prompts.length > 0) {
        const oldPrompts = prompts.filter(p => 
            Date.now() - p.timestamp.getTime() > 300000 // 5 minutes
        );
        
        if (oldPrompts.length > 0) {
            const maxVotes = Math.max(...oldPrompts.map(p => p.votes.size));
            if (maxVotes > 0) {
                const topPrompt = oldPrompts.find(p => p.votes.size === maxVotes);
                selectPrompt(topPrompt);
            }
        }
    }
}, 120000); // Check every 2 minutes

// Server startup
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🤖 AI Provider: ${AI_PROVIDER}`);
    console.log(`📝 Visit http://localhost:${PORT} to start chatting`);
    
    // Validate AI configuration
    const config = AI_CONFIG[AI_PROVIDER];
    if (!config) {
        console.warn(`⚠️  Unknown AI provider: ${AI_PROVIDER}`);
    } else {
        console.log(`✅ AI configuration loaded for ${AI_PROVIDER}`);
    }
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    server.close(() => {
        console.log('✅ Server shutdown complete');
        process.exit(0);
    });
});
